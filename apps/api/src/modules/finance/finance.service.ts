import { BadGatewayException, BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import type { z } from 'zod';
import { balanceLogListQuerySchema, rechargeOrderListQuerySchema } from '@shiye/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { XuiService } from '../xui/xui.service.js';
import { DatabaseLockService } from '../../shared/database-lock.service.js';

@Injectable()
export class FinanceService {
  private readonly logger = new Logger(FinanceService.name);
  private renewalRecoveryRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly xui: XuiService,
    private readonly locks: DatabaseLockService
  ) {}

  async rechargeOrders(query: z.infer<typeof rechargeOrderListQuerySchema>) {
    await this.prisma.rechargeOrder.updateMany({ where: { status: 'pending', expiresAt: { lte: new Date() } }, data: { status: 'closed' } });
    const page = query.page;
    const pageSize = query.pageSize;
    const keyword = query.keyword?.trim();
    const where: Prisma.RechargeOrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.provider ? { provider: query.provider } : {}),
      ...createdAtRange(query.from, query.to),
      ...(keyword ? {
        OR: [
          { tradeNo: { contains: keyword } },
          { customer: { name: { contains: keyword } } },
          { customer: { loginUsername: { contains: keyword } } }
        ]
      } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.rechargeOrder.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { customer: { select: { id: true, name: true, loginUsername: true } } }
      }),
      this.prisma.rechargeOrder.count({ where })
    ]);
    return { items, page, pageSize, total };
  }

  async balanceLogs(query: z.infer<typeof balanceLogListQuerySchema>) {
    const page = query.page;
    const pageSize = query.pageSize;
    const keyword = query.keyword?.trim();
    const where: Prisma.BalanceLogWhereInput = {
      ...(query.type ? { type: query.type } : {}),
      ...createdAtRange(query.from, query.to),
      ...(keyword ? {
        OR: [
          { operator: { contains: keyword } },
          { remark: { contains: keyword } },
          { customer: { name: { contains: keyword } } },
          { customer: { loginUsername: { contains: keyword } } }
        ]
      } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.balanceLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { customer: { select: { id: true, name: true, loginUsername: true } } }
      }),
      this.prisma.balanceLog.count({ where })
    ]);
    return { items, page, pageSize, total };
  }

  async clearRechargeOrderHistory() {
    const result = await this.prisma.rechargeOrder.deleteMany({ where: { status: { not: 'pending' } } });
    return { deleted: result.count };
  }

  async clearRechargeOrderHistoryRange(from: Date | undefined, to: Date) {
    const result = await this.prisma.rechargeOrder.deleteMany({
      where: {
        status: { not: 'pending' },
        createdAt: { ...(from ? { gte: from } : {}), lt: to }
      }
    });
    return { deleted: result.count, from, to };
  }

  async clearBalanceLogHistory() {
    await this.assertNoPendingRenewalsForHistoryClear();
    const result = await this.prisma.balanceLog.deleteMany({});
    return { deleted: result.count };
  }

  async clearBalanceLogHistoryRange(from: Date | undefined, to: Date) {
    await this.assertNoPendingRenewalsForHistoryClear();
    const result = await this.prisma.balanceLog.deleteMany({
      where: { createdAt: { ...(from ? { gte: from } : {}), lt: to } }
    });
    return { deleted: result.count, from, to };
  }

  async renewCustomerNode(customerId: string, customerNodeId: string, months: number, operator: string, requestId: string) {
    return this.withRenewalLock(customerNodeId, async () => {
      const idempotencyKey = `renewal:${customerId}:${customerNodeId}:${requestId}`;
      const existing = await this.prisma.renewalLog.findUnique({ where: { idempotencyKey } });
      if (existing) return this.resumeExistingRenewal(existing.id, customerId, customerNodeId, months, operator);

      const anotherPending = await this.prisma.renewalLog.findFirst({
        where: { customerNodeId, status: 'pending' },
        select: { id: true }
      });
      if (anotherPending) {
        throw new BadRequestException('该节点存在待确认续费，请等待系统自动恢复后再操作');
      }

      const preflight = await this.prisma.customerNode.findFirst({
        where: { id: customerNodeId, customerId },
        include: { serviceNode: true, customer: true }
      });
      if (!preflight) throw new NotFoundException('用户节点不存在');
      this.assertRenewalAllowed(preflight);
      const now = new Date();

      return this.prisma.$transaction(async (tx) => {
        const customerNode = await tx.customerNode.findFirst({
          where: { id: customerNodeId, customerId },
          include: { serviceNode: true, customer: true }
        });
        if (!customerNode) throw new NotFoundException('用户节点不存在');
        this.assertRenewalAllowed(customerNode);

        const priceMonthly = new Prisma.Decimal(customerNode.serviceNode.priceMonthly);
        const amount = priceMonthly.mul(months);
        const baseDate = latestDate(now, customerNode.expireAt);
        const afterExpireAt = addMonths(baseDate, months);
        const beforeBalance = new Prisma.Decimal(customerNode.customer.balance);
        if (beforeBalance.lessThan(amount)) throw new BadRequestException('余额不足');

        const beforeExpireAt = customerNode.expireAt;
        const debited = await tx.customer.updateMany({
          where: { id: customerId, status: 'active', balance: { gte: amount } },
          data: { balance: { decrement: amount } }
        });
        if (debited.count !== 1) throw new BadRequestException('余额不足');
        const updatedCustomer = await tx.customer.findUnique({ where: { id: customerId }, select: { balance: true } });
        if (!updatedCustomer) throw new NotFoundException('用户不存在');
        const afterBalance = new Prisma.Decimal(updatedCustomer.balance);
        const actualBeforeBalance = afterBalance.plus(amount);
        const sync = { remoteWrite: false, scope: 'local-authorization' };
        const updatedNode = await tx.customerNode.update({
          where: { id: customerNode.id },
          data: { expireAt: afterExpireAt, status: 'active', disabledReason: null },
          include: { serviceNode: { include: { server: true } } }
        });
        const renewalLog = await tx.renewalLog.create({
          data: {
            idempotencyKey,
            customerId,
            customerNodeId,
            months,
            amount,
            status: 'success',
            beforeExpireAt,
            afterExpireAt,
            detail: toJsonValue({
              operator,
              requestId,
              phase: 'completed',
              serviceNodeName: customerNode.serviceNode.name,
              serviceNodeId: customerNode.serviceNodeId,
              afterBalance: afterBalance.toString(),
              sync
            })
          }
        });
        const balanceLog = await tx.balanceLog.create({
          data: {
            customerId,
            type: 'renewal',
            amount: amount.negated(),
            beforeBalance: actualBeforeBalance,
            afterBalance,
            operator,
            remark: `续费 ${customerNode.serviceNode.name} ${months} 个月`,
            detail: toJsonValue({
              renewalLogId: renewalLog.id,
              customerNodeId,
              serviceNodeId: customerNode.serviceNodeId,
              months,
              syncStatus: 'local-only',
              completedAt: new Date().toISOString()
            })
          }
        });
        await tx.renewalLog.update({ where: { id: renewalLog.id }, data: { balanceLogId: balanceLog.id } });
        return { node: updatedNode, renewalLog: { ...renewalLog, balanceLogId: balanceLog.id }, amount, afterBalance, sync };
      });
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverPendingRenewals() {
    if (this.renewalRecoveryRunning) return;
    this.renewalRecoveryRunning = true;
    try {
      const staleBefore = new Date(Date.now() - 60_000);
      const pending = await this.prisma.renewalLog.findMany({
        where: { status: 'pending', updatedAt: { lte: staleBefore } },
        orderBy: { updatedAt: 'asc' },
        take: 20,
        select: { id: true, customerId: true, customerNodeId: true, months: true }
      });
      for (const renewal of pending) {
        if (!renewal.customerNodeId) continue;
        await this.withRenewalLock(renewal.customerNodeId, () =>
          this.resumeExistingRenewal(renewal.id, renewal.customerId, renewal.customerNodeId!, renewal.months, 'system:renewal-recovery')
        ).catch((error) => this.logger.warn(`续费恢复 ${renewal.id} 未完成：${errorMessage(error)}`));
      }
    } finally {
      this.renewalRecoveryRunning = false;
    }
  }

  private async resumeExistingRenewal(id: string, customerId: string, customerNodeId: string, months: number, operator: string) {
    const renewal = await this.prisma.renewalLog.findUnique({ where: { id } });
    if (!renewal || renewal.customerId !== customerId || renewal.customerNodeId !== customerNodeId || renewal.months !== months) {
      throw new BadRequestException('续费请求标识与原请求不一致');
    }
    if (renewal.status === 'success') return this.completedRenewalResult(renewal.id, customerNodeId);
    if (renewal.status === 'failed') throw new BadRequestException(renewalFailureMessage(renewal.detail));
    const pending = await this.pendingRenewalFromLog(renewal.id);
    return this.completePendingRenewal(customerId, pending, operator);
  }

  private async completePendingRenewal(customerId: string, pending: PendingRenewal, operator: string) {
    const targetEnable = renewalTargetEnable(pending.customerNode, pending.remoteBefore.enable);
    let currentRemote: Awaited<ReturnType<XuiService['customerNodeRemoteState']>>;
    try {
      currentRemote = await this.xui.customerNodeRemoteState(customerId, pending.customerNode.id);
    } catch (error) {
      await this.notePendingRecovery(pending, operator, 'remote-state-unavailable', error);
      throw new BadGatewayException(`暂时无法确认 3x-ui 续费状态，本次请求不会重复扣款，系统将自动恢复：${errorMessage(error)}`);
    }

    if (remoteMatches(currentRemote, pending.afterExpireAt, targetEnable)) {
      return this.finalizeRenewal(customerId, pending, operator, { recovered: true, state: currentRemote });
    }
    if (!remoteMatchesSnapshot(currentRemote, pending.remoteBefore)) {
      if (pending.detail.remoteWriteStarted !== true) {
        const changedBeforeWrite = new Error('远端客户端在本次续费写入前已发生变化');
        await this.refundOrMarkForReconciliation(customerId, pending, operator, changedBeforeWrite);
        throw new BadGatewayException('远端客户端状态已变化，本次续费未写入并已退款，请刷新后重试');
      }
      await this.markRenewalForReconciliation(pending, operator, new Error('远端客户端状态已被其他操作修改'), currentRemote);
      throw new BadGatewayException('远端客户端状态与续费前记录不一致，需要人工核对，本次未自动退款');
    }

    await this.markRemoteWriteStarted(pending, operator);
    let syncResult: Awaited<ReturnType<XuiService['updateCustomerNodeExpiry']>>;
    try {
      syncResult = await this.xui.updateCustomerNodeExpiry(customerId, pending.customerNode.id, pending.afterExpireAt, targetEnable, true);
      if (syncResult.skipped) throw new BadRequestException('该用户绑定为只读引用，不能通过本系统续费远端账号');
    } catch (error) {
      const resolution = await this.resolveRemoteUpdateFailure(customerId, pending, operator, error);
      if (resolution === 'applied') return this.finalizeRenewal(customerId, pending, operator, { recovered: true, error: errorMessage(error) });
      if (resolution === 'refunded') throw error;
      throw new BadGatewayException(`暂时无法确认 3x-ui 续费结果，本次请求不会重复扣款，系统将自动恢复：${errorMessage(error)}`);
    }

    return this.finalizeRenewal(customerId, pending, operator, syncResult);
  }

  private async finalizeRenewal(customerId: string, pending: PendingRenewal, operator: string, sync: unknown) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const latest = await tx.renewalLog.findUnique({ where: { id: pending.renewalLog.id } });
        if (latest?.status === 'success') {
          const node = await tx.customerNode.findUnique({
            where: { id: pending.customerNode.id },
            include: { serviceNode: { include: { server: true } } }
          });
          return { node, renewalLog: latest, amount: pending.amount, afterBalance: pending.afterBalance, sync: jsonObject(latest.detail).sync };
        }
        if (!latest || latest.status !== 'pending') throw new BadRequestException('续费记录当前不可完成');
        const updatedNode = await tx.customerNode.update({
          where: { id: pending.customerNode.id },
          data: { expireAt: pending.afterExpireAt, status: 'active', disabledReason: null, lastSyncedAt: new Date() },
          include: { serviceNode: { include: { server: true } } }
        });
        const renewalLog = await tx.renewalLog.update({
          where: { id: pending.renewalLog.id },
          data: {
            status: 'success',
            detail: toJsonValue({
              ...jsonObject(latest.detail),
              operator,
              phase: 'completed',
              balanceLogId: pending.balanceLog.id,
              sync
            })
          }
        });
        const debitLog = await tx.balanceLog.findUnique({ where: { id: pending.balanceLog.id } });
        if (!debitLog) throw new BadGatewayException('续费扣款流水不存在，无法完成本地续费');
        await tx.balanceLog.update({
          where: { id: pending.balanceLog.id },
          data: {
            detail: toJsonValue({
              ...jsonObject(debitLog.detail),
              renewalLogId: pending.renewalLog.id,
              customerNodeId: pending.customerNode.id,
              serviceNodeId: pending.customerNode.serviceNodeId,
              syncStatus: 'success',
              completedAt: new Date().toISOString()
            })
          }
        });
        return { node: updatedNode, renewalLog, amount: pending.amount, afterBalance: pending.afterBalance, sync };
      });
    } catch (localError) {
      let committed: Awaited<ReturnType<typeof this.prisma.renewalLog.findUnique>>;
      try {
        committed = await this.prisma.renewalLog.findUnique({ where: { id: pending.renewalLog.id } });
      } catch (verificationError) {
        throw new BadGatewayException(`续费已同步到 3x-ui，但暂时无法确认本地事务结果，系统将自动恢复：${errorMessage(verificationError)}`);
      }
      if (committed?.status === 'success') return this.completedRenewalResult(pending.renewalLog.id, pending.customerNode.id);
      if (!committed || committed.status !== 'pending') {
        throw new BadGatewayException('续费已同步到 3x-ui，但本地续费记录状态异常，需要人工核对');
      }

      let rollbackError: unknown;
      try {
        await this.xui.updateCustomerNodeExpiry(
          customerId,
          pending.customerNode.id,
          pending.remoteBefore.expiryTime > 0 ? new Date(pending.remoteBefore.expiryTime) : null,
          pending.remoteBefore.enable,
          true
        );
      } catch (error) {
        rollbackError = error;
      }

      let rollbackState: Awaited<ReturnType<XuiService['customerNodeRemoteState']>> | null = null;
      try {
        rollbackState = await this.xui.customerNodeRemoteState(customerId, pending.customerNode.id);
      } catch (error) {
        rollbackError = rollbackError
          ? new Error(`${errorMessage(rollbackError)}；回读失败：${errorMessage(error)}`)
          : error;
      }
      if (rollbackState && remoteMatchesSnapshot(rollbackState, pending.remoteBefore)) {
        await this.refundOrMarkForReconciliation(customerId, pending, operator, localError);
        throw localError;
      }

      const rollbackEvidence = rollbackState || rollbackError || new Error('远端回滚结果无法确认');
      await this.markRenewalForReconciliation(pending, operator, localError, rollbackEvidence).catch(() => undefined);
      throw new BadGatewayException(`续费已同步到 3x-ui，但本地保存后无法确认远端已回滚，需要人工核对：${diagnosticMessage(rollbackEvidence)}`);
    }
  }

  private async resolveRemoteUpdateFailure(customerId: string, pending: PendingRenewal, operator: string, error: unknown) {
    const state = await this.xui.customerNodeRemoteState(customerId, pending.customerNode.id).catch(() => null);
    if (state && remoteMatches(state, pending.afterExpireAt, renewalTargetEnable(pending.customerNode, pending.remoteBefore.enable))) return 'applied' as const;
    if (state && remoteMatchesSnapshot(state, pending.remoteBefore)) {
      await this.refundOrMarkForReconciliation(customerId, pending, operator, error);
      return 'refunded' as const;
    }
    if (state) {
      await this.markRenewalForReconciliation(pending, operator, error, state);
      return 'reconciliation' as const;
    }
    await this.notePendingRecovery(pending, operator, 'remote-result-unknown', error);
    return 'pending' as const;
  }

  private async notePendingRecovery(pending: PendingRenewal, operator: string, phase: string, error: unknown) {
    const detail = { ...pending.detail, operator, phase, recoveryRequired: true, error: errorMessage(error) };
    await this.prisma.renewalLog.updateMany({
      where: { id: pending.renewalLog.id, status: 'pending' },
      data: { detail: toJsonValue(detail) }
    });
    pending.detail = detail;
  }

  private async markRemoteWriteStarted(pending: PendingRenewal, operator: string) {
    const detail = { ...pending.detail, operator, phase: 'remote-update-started', remoteWriteStarted: true };
    const marked = await this.prisma.renewalLog.updateMany({
      where: { id: pending.renewalLog.id, status: 'pending' },
      data: { detail: toJsonValue(detail) }
    });
    if (marked.count !== 1) throw new BadRequestException('续费记录当前不可写入远端');
    pending.detail = detail;
  }

  private assertRenewalAllowed(node: RenewalNode) {
    if (node.customer.status !== 'active') throw new BadRequestException('用户账号已停用，不能续费');
    if (!node.serviceNode.enabled) throw new BadRequestException('服务节点已停用，不能续费');
    if (node.disabledReason === 'admin') throw new BadRequestException('该节点已被管理员停用，不能由用户续费恢复');
    if (node.disabledReason === 'traffic_exceeded') throw new BadRequestException('该节点因流量用尽停用，续费只延长有效期，不会重置流量，请联系管理员处理流量额度');
    if (node.status === 'disabled' && node.disabledReason !== 'expired') throw new BadRequestException('该节点不是因到期停用，不能通过续费自动恢复');
  }

  private async assertNoPendingRenewalsForHistoryClear() {
    const pending = await this.prisma.renewalLog.count({ where: { status: 'pending' } });
    if (pending > 0) throw new BadRequestException('存在待处理续费，完成自动恢复或人工对账后才能清理余额流水');
  }

  private async pendingRenewalFromLog(id: string): Promise<PendingRenewal> {
    const renewal = await this.prisma.renewalLog.findUnique({
      where: { id },
      include: { customerNode: { include: { serviceNode: true, customer: true } } }
    });
    if (!renewal || renewal.status !== 'pending') throw new BadRequestException('续费记录当前不可恢复');
    if (!renewal.customerNode || !renewal.afterExpireAt || !renewal.balanceLogId) {
      throw new BadGatewayException('续费恢复信息不完整，需要人工核对');
    }
    const balanceLog = await this.prisma.balanceLog.findUnique({ where: { id: renewal.balanceLogId } });
    if (!balanceLog) throw new BadGatewayException('续费余额记录不存在，需要人工核对');
    const detail = jsonObject(renewal.detail);
    const remote = jsonObject(detail.remoteBefore);
    return {
      amount: new Prisma.Decimal(renewal.amount),
      afterBalance: new Prisma.Decimal(balanceLog.afterBalance),
      renewalLog: { id: renewal.id },
      balanceLog: { id: balanceLog.id },
      customerNode: renewal.customerNode,
      beforeExpireAt: renewal.beforeExpireAt,
      afterExpireAt: renewal.afterExpireAt,
      remoteBefore: {
        expiryTime: positiveNumber(remote.expiryTime),
        enable: booleanValue(remote.enable)
      },
      detail
    };
  }

  private async completedRenewalResult(id: string, customerNodeId: string) {
    const renewalLog = await this.prisma.renewalLog.findUnique({ where: { id } });
    const node = await this.prisma.customerNode.findUnique({
      where: { id: customerNodeId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!renewalLog || renewalLog.status !== 'success' || !node) throw new BadGatewayException('续费完成记录不完整');
    const balanceLog = renewalLog.balanceLogId
      ? await this.prisma.balanceLog.findUnique({ where: { id: renewalLog.balanceLogId } })
      : null;
    return {
      node,
      renewalLog,
      amount: renewalLog.amount,
      afterBalance: balanceLog?.afterBalance,
      sync: jsonObject(renewalLog.detail).sync,
      idempotent: true
    };
  }

  private async withRenewalLock<T>(customerNodeId: string, operation: () => Promise<T>) {
    const node = await this.prisma.customerNode.findUnique({ where: { id: customerNodeId }, select: { serviceNodeId: true } });
    if (!node) throw new NotFoundException('用户节点不存在');
    return this.locks.withLock(this.locks.serviceNodeKey(node.serviceNodeId), () =>
      this.locks.withLock(this.locks.customerNodeKey(customerNodeId), operation)
    );
  }

  private async markRenewalForReconciliation(pending: PendingRenewal, operator: string, localError: unknown, rollbackError: unknown) {
    await this.prisma.$transaction(async (tx) => {
      const marked = await tx.renewalLog.updateMany({
        where: { id: pending.renewalLog.id, status: 'pending' },
        data: {
          status: 'failed',
          detail: toJsonValue({
            ...pending.detail,
            operator,
            phase: 'reconciliation-required',
            balanceLogId: pending.balanceLog.id,
            refunded: false,
            reconciliationRequired: true,
            localError: errorMessage(localError),
            rollbackError: diagnosticMessage(rollbackError)
          })
        }
      });
      if (marked.count !== 1) return;
      const debitLog = await tx.balanceLog.findUnique({ where: { id: pending.balanceLog.id } });
      await tx.balanceLog.update({
        where: { id: pending.balanceLog.id },
        data: {
          detail: toJsonValue({
            ...jsonObject(debitLog?.detail),
            renewalLogId: pending.renewalLog.id,
            customerNodeId: pending.customerNode.id,
            serviceNodeId: pending.customerNode.serviceNodeId,
            syncStatus: 'reconciliation-required',
            localError: errorMessage(localError),
            rollbackError: diagnosticMessage(rollbackError)
          })
        }
      });
    });
  }

  private async refundOrMarkForReconciliation(customerId: string, pending: PendingRenewal, operator: string, error: unknown) {
    try {
      await this.refundFailedRenewal(customerId, pending, operator, error);
    } catch (refundError) {
      await this.markRenewalForReconciliation(pending, operator, error, refundError).catch(() => undefined);
      throw new BadGatewayException(`续费退款失败，需要人工核对：${errorMessage(refundError)}`);
    }
  }

  private async refundFailedRenewal(customerId: string, pending: PendingRenewal, operator: string, error: unknown) {
    const message = errorMessage(error);
    await this.prisma.$transaction(async (tx) => {
      const marked = await tx.renewalLog.updateMany({
        where: { id: pending.renewalLog.id, status: 'pending' },
        data: {
          status: 'failed',
          detail: toJsonValue({
            ...pending.detail,
            operator,
            phase: 'refunded',
            balanceLogId: pending.balanceLog.id,
            refunded: true,
            error: message
          })
        }
      });
      if (marked.count !== 1) return;
      const customers = await tx.$queryRaw<Array<{ balance: Prisma.Decimal }>>`
        SELECT balance FROM customers WHERE id = ${customerId} FOR UPDATE
      `;
      const customer = customers[0];
      if (!customer) throw new NotFoundException('用户不存在，无法完成续费退款');

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const updated = await tx.customer.update({ where: { id: customerId }, data: { balance: { increment: pending.amount } }, select: { balance: true } });
      const afterBalance = new Prisma.Decimal(updated.balance);
      const debitLog = await tx.balanceLog.findUnique({ where: { id: pending.balanceLog.id } });
      await tx.balanceLog.update({
        where: { id: pending.balanceLog.id },
        data: {
          detail: toJsonValue({
            ...jsonObject(debitLog?.detail),
            renewalLogId: pending.renewalLog.id,
            customerNodeId: pending.customerNode.id,
            serviceNodeId: pending.customerNode.serviceNodeId,
            syncStatus: 'refunded',
            refundedAt: new Date().toISOString(),
            reason: message
          })
        }
      });
      await tx.balanceLog.create({
        data: {
          customerId,
          type: 'refund',
          amount: pending.amount,
          beforeBalance,
          afterBalance,
          operator,
          remark: `续费同步失败退款 ${pending.customerNode.serviceNode.name}`,
          detail: toJsonValue({ renewalLogId: pending.renewalLog.id, originalBalanceLogId: pending.balanceLog.id, reason: message })
        }
      });
    });
  }
}

type PendingRenewal = {
  amount: Prisma.Decimal;
  afterBalance: Prisma.Decimal;
  renewalLog: { id: string };
  balanceLog: { id: string };
  customerNode: RenewalNode & { id: string; serviceNodeId: string };
  beforeExpireAt: Date | null;
  afterExpireAt: Date;
  remoteBefore: { expiryTime: number; enable: boolean };
  detail: Record<string, unknown>;
};

type RenewalNode = {
  status: 'active' | 'disabled';
  disabledReason: 'expired' | 'traffic_exceeded' | 'admin' | null;
  remoteControl: 'reference' | 'subscription_managed' | 'fully_managed';
  customer: { status: 'active' | 'disabled' };
  serviceNode: { name: string; enabled: boolean; priceMonthly: Prisma.Decimal };
};

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() < day) next.setDate(0);
  return next;
}

function latestDate(...dates: Array<Date | null | undefined>) {
  return new Date(Math.max(...dates.filter((date): date is Date => Boolean(date)).map((date) => date.getTime())));
}

function remoteMatches(state: { expiryTime: number; enable: boolean }, expireAt: Date, enable: boolean) {
  return Math.abs(state.expiryTime - expireAt.getTime()) <= 1000 && state.enable === enable;
}

function remoteMatchesSnapshot(state: { expiryTime: number; enable: boolean }, snapshot: { expiryTime: number; enable: boolean }) {
  return Math.abs(state.expiryTime - snapshot.expiryTime) <= 1000 && state.enable === snapshot.enable;
}

function renewalTargetEnable(node: Pick<RenewalNode, 'status' | 'disabledReason'>, remoteEnable: boolean) {
  return node.status === 'disabled' && node.disabledReason === 'expired' ? true : remoteEnable;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function positiveNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function booleanValue(value: unknown) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  return String(value).toLowerCase() === 'true' || value === '1';
}

function renewalFailureMessage(value: unknown) {
  const detail = jsonObject(value);
  return String(detail.error || detail.localError || '该续费请求已经失败，请刷新节点状态后重新发起');
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function diagnosticMessage(value: unknown) {
  if (value instanceof Error) return value.message;
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function createdAtRange(from?: Date, to?: Date) {
  if (!from && !to) return {};
  return { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } };
}
