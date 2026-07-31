import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createConnection, type RowDataPacket } from 'mysql2/promise';
import type { z } from 'zod';
import { balanceLogListQuerySchema, rechargeOrderListQuerySchema } from '@shiye/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { XuiService } from '../xui/xui.service.js';

@Injectable()
export class FinanceService {
  constructor(private readonly prisma: PrismaService, private readonly xui: XuiService) {}

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
    const result = await this.prisma.balanceLog.deleteMany({});
    return { deleted: result.count };
  }

  async clearBalanceLogHistoryRange(from: Date | undefined, to: Date) {
    const result = await this.prisma.balanceLog.deleteMany({
      where: { createdAt: { ...(from ? { gte: from } : {}), lt: to } }
    });
    return { deleted: result.count, from, to };
  }

  async renewCustomerNode(customerId: string, customerNodeId: string, months: number, operator: string) {
    return this.withRenewalLock(customerNodeId, async () => {
      const pending = await this.prisma.$transaction(async (tx) => {
        const customerNode = await tx.customerNode.findFirst({
          where: { id: customerNodeId, customerId },
          include: { serviceNode: true, customer: true }
        });
        if (!customerNode) throw new NotFoundException('用户节点不存在');

        const priceMonthly = new Prisma.Decimal(customerNode.serviceNode.priceMonthly);
        const amount = priceMonthly.mul(months);
        const beforeBalance = new Prisma.Decimal(customerNode.customer.balance);
        if (beforeBalance.lessThan(amount)) throw new BadRequestException('余额不足');

        const now = new Date();
        const beforeExpireAt = customerNode.expireAt;
        const baseDate = beforeExpireAt && beforeExpireAt > now ? beforeExpireAt : now;
        const afterExpireAt = addMonths(baseDate, months);
        const debited = await tx.customer.updateMany({
          where: { id: customerId, balance: { gte: amount } },
          data: { balance: { decrement: amount } }
        });
        if (debited.count !== 1) throw new BadRequestException('余额不足');
        const updatedCustomer = await tx.customer.findUnique({ where: { id: customerId }, select: { balance: true } });
        if (!updatedCustomer) throw new NotFoundException('用户不存在');
        const afterBalance = new Prisma.Decimal(updatedCustomer.balance);
        const actualBeforeBalance = afterBalance.plus(amount);
        const renewalLog = await tx.renewalLog.create({
          data: {
            customerId,
            customerNodeId,
            months,
            amount,
            status: 'pending',
            beforeExpireAt,
            afterExpireAt,
            detail: toJsonValue({ operator, serviceNodeName: customerNode.serviceNode.name, serviceNodeId: customerNode.serviceNodeId })
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
            detail: toJsonValue({ renewalLogId: renewalLog.id, customerNodeId, serviceNodeId: customerNode.serviceNodeId, months, syncStatus: 'pending' })
          }
        });

        return { customerNode, amount, afterBalance, beforeExpireAt, afterExpireAt, renewalLog, balanceLog };
      });

      let syncResult: Awaited<ReturnType<XuiService['syncCustomerNode']>>;
      try {
        syncResult = await this.xui.syncCustomerNode(customerId, customerNodeId, {
          expireAt: pending.afterExpireAt,
          status: 'active',
          createIfMissing: false,
          requireExisting: true,
          persistLocal: false
        });
      } catch (error) {
        await this.refundOrMarkForReconciliation(customerId, pending, operator, error);
        throw error;
      }

      try {
        return await this.prisma.$transaction(async (tx) => {
          const localPatch = 'localPatch' in syncResult ? syncResult.localPatch : {};
          const updatedNode = await tx.customerNode.update({
            where: { id: customerNodeId },
            data: { ...localPatch, expireAt: pending.afterExpireAt, status: 'active', lastSyncedAt: new Date() },
            include: { serviceNode: { include: { server: true } } }
          });
          const renewalLog = await tx.renewalLog.update({
            where: { id: pending.renewalLog.id },
            data: {
              status: 'success',
              detail: toJsonValue({
                operator,
                serviceNodeName: pending.customerNode.serviceNode.name,
                serviceNodeId: pending.customerNode.serviceNodeId,
                balanceLogId: pending.balanceLog.id,
                syncRoute: syncResult.route,
                sync: syncResult.detail
              })
            }
          });

          return { node: updatedNode, renewalLog, amount: pending.amount, afterBalance: pending.afterBalance, sync: syncResult.detail };
        });
      } catch (localError) {
        try {
          await this.xui.syncCustomerNode(customerId, customerNodeId, {
            expireAt: pending.beforeExpireAt,
            status: pending.customerNode.status,
            createIfMissing: false,
            requireExisting: true,
            persistLocal: false
          });
        } catch (rollbackError) {
          await this.markRenewalForReconciliation(pending, operator, localError, rollbackError).catch(() => undefined);
          throw new BadGatewayException(`续费已同步到 3x-ui，但本地保存和远端回滚都失败，需要人工核对：${errorMessage(rollbackError)}`);
        }
        await this.refundOrMarkForReconciliation(customerId, pending, operator, localError);
        throw localError;
      }
    });
  }

  private async withRenewalLock<T>(customerNodeId: string, operation: () => Promise<T>) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new BadGatewayException('DATABASE_URL 未配置，无法执行续费锁');
    const connection = await createConnection(databaseUrl);
    const lockName = `shiye:renew:${customerNodeId}`.slice(0, 64);
    let acquired = false;
    try {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, 30) AS acquired', [lockName]);
      acquired = Number(rows[0]?.acquired) === 1;
      if (!acquired) throw new BadRequestException('该节点正在续费，请稍后重试');
      return await operation();
    } finally {
      if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
      await connection.end().catch(() => undefined);
    }
  }

  private async markRenewalForReconciliation(pending: PendingRenewal, operator: string, localError: unknown, rollbackError: unknown) {
    await this.prisma.$transaction([
      this.prisma.renewalLog.update({
        where: { id: pending.renewalLog.id },
        data: {
          status: 'failed',
          detail: toJsonValue({
            operator,
            serviceNodeName: pending.customerNode.serviceNode.name,
            serviceNodeId: pending.customerNode.serviceNodeId,
            balanceLogId: pending.balanceLog.id,
            refunded: false,
            reconciliationRequired: true,
            localError: errorMessage(localError),
            rollbackError: errorMessage(rollbackError)
          })
        }
      }),
      this.prisma.balanceLog.update({
        where: { id: pending.balanceLog.id },
        data: {
          detail: toJsonValue({
            renewalLogId: pending.renewalLog.id,
            serviceNodeId: pending.customerNode.serviceNodeId,
            syncStatus: 'reconciliation-required',
            localError: errorMessage(localError),
            rollbackError: errorMessage(rollbackError)
          })
        }
      })
    ]);
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
      const customer = await tx.customer.findUnique({ where: { id: customerId }, select: { balance: true } });
      if (!customer) return;

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const afterBalance = beforeBalance.plus(pending.amount);
      await tx.customer.update({ where: { id: customerId }, data: { balance: afterBalance } });
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
      await tx.renewalLog.update({
        where: { id: pending.renewalLog.id },
        data: {
          status: 'failed',
          detail: toJsonValue({
            operator,
            serviceNodeName: pending.customerNode.serviceNode.name,
            serviceNodeId: pending.customerNode.serviceNodeId,
            balanceLogId: pending.balanceLog.id,
            refunded: true,
            error: message
          })
        }
      });
    });
  }
}

type PendingRenewal = {
  amount: Prisma.Decimal;
  renewalLog: { id: string };
  balanceLog: { id: string };
  customerNode: { status: 'active' | 'disabled'; serviceNode: { name: string }; serviceNodeId: string };
  beforeExpireAt: Date | null;
};

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  const day = next.getDate();
  next.setMonth(next.getMonth() + months);
  if (next.getDate() < day) next.setDate(0);
  return next;
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function createdAtRange(from?: Date, to?: Date) {
  if (!from && !to) return {};
  return { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lt: to } : {}) } };
}
