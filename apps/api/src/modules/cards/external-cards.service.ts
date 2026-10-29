import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';
import { DatabaseLockService } from '../../shared/database-lock.service.js';
import type { ShiyeCardClient, ShiyeCardResult } from './shiye-client.js';

@Injectable()
export class ExternalCardsService {
  private readonly logger = new Logger(ExternalCardsService.name);
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService, private readonly locks: DatabaseLockService) {}

  async redeem(customerId: string, rawCode: string, client: Pick<ShiyeCardClient, 'activate'>) {
    const code = rawCode.trim().toUpperCase();
    const codeHash = createHash('sha256').update(code).digest('hex');
    return this.locks.withLock(`card:${codeHash.slice(0, 40)}`, async () => {
      const customer = await this.prisma.customer.findUnique({ where: { id: customerId } });
      if (!customer || customer.status !== 'active') throw new NotFoundException('用户不存在或已禁用');
      let receipt = await this.prisma.externalCardRedemption.findUnique({ where: { codeHash } });
      if (receipt && receipt.customerId !== customerId) throw new BadRequestException('卡密已被其他账户提交兑换');
      if (receipt?.status === 'completed' || receipt?.status === 'activated') return this.credit(receipt.id);
      if (receipt && receipt.status !== 'failed')
        throw new BadRequestException('这张卡的核销结果待确认，请联系管理员在卡密管理中核实，无需重复兑换');
      receipt = await this.prisma.externalCardRedemption.upsert({
        where: { codeHash },
        create: { codeHash, codeEnc: this.encryption.encrypt(code), codePreview: `${code.slice(0, 4)}…${code.slice(-4)}`, customerId },
        update: { status: 'processing', lastError: null }
      });
      let result: ShiyeCardResult;
      try { result = await client.activate(code); }
      catch { result = { code: -1, message: '卡密服务响应中断，核销结果待确认' }; }
      if (result.code !== 0) {
        const message = result.code === -1 ? '核销结果待确认，请联系管理员核实' : result.message || '卡密兑换失败';
        await this.prisma.externalCardRedemption.update({ where: { id: receipt.id }, data: { status: result.code === -1 || (result.code >= 500 && result.code <= 599) ? 'uncertain' : 'failed', lastError: message } });
        throw new BadRequestException(message);
      }
      const data = result.data;
      const amount = validAmount(data?.amount);
      if ((data?.type && data.type !== 'money') || !amount) {
        await this.prisma.externalCardRedemption.update({ where: { id: receipt.id }, data: { status: 'uncertain', lastError: '远端已核销，但卡类型或面额异常，请核实后处理' } });
        throw new BadRequestException('远端已核销，请联系管理员核实面额后补入余额');
      }
      // Save the remote receipt before attempting the separately retryable credit.
      await this.prisma.externalCardRedemption.update({ where: { id: receipt.id }, data: { status: 'activated', amount, lastError: null } });
      try { return await this.credit(receipt.id); }
      catch {
        throw new BadRequestException('核销已确认，余额正在补入；系统会自动重试，也可使用同一卡密重试，不会再次核销');
      }
    });
  }

  async credit(id: string, operator = 'system') {
    return this.prisma.$transaction(async tx => {
      const receipts = await tx.$queryRaw<Array<{ id: string; customerId: string; status: string; amount: Prisma.Decimal }>>`
        SELECT id, customerId, status, amount FROM external_card_redemptions WHERE id = ${id} FOR UPDATE`;
      const receipt = receipts[0];
      if (!receipt || !['activated', 'completed'].includes(receipt.status)) throw new BadRequestException('核销尚未确认，不能入账');
      const customers = await tx.$queryRaw<Array<{ id: string; loginUsername: string; status: string; balance: Prisma.Decimal }>>`
        SELECT id, loginUsername, status, balance FROM customers WHERE id = ${receipt.customerId} FOR UPDATE`;
      const customer = customers[0];
      if (!customer) throw new NotFoundException('用户不存在，请先核实账户');
      if (receipt.status === 'completed') return { customer, amount: receipt.amount, replayed: true };
      if (customer.status !== 'active') throw new BadRequestException('账户已停用，启用后系统将补入已核销余额');
      const amount = validAmount(receipt.amount);
      if (!amount) throw new BadRequestException('核销面额异常，请先核实');
      const updated = await tx.customer.update({ where: { id: customer.id }, data: { balance: { increment: amount } }, select: { id: true, name: true, loginUsername: true, balance: true, status: true } });
      await tx.balanceLog.create({ data: { customerId: customer.id, type: 'card_redeem', amount, beforeBalance: customer.balance, afterBalance: updated.balance, operator, remark: '外部卡密兑换到账', detail: { source: 'shiye', redemptionId: id } } });
      await tx.externalCardRedemption.update({ where: { id }, data: { status: 'completed', lastError: null } });
      return { customer: updated, amount, replayed: false };
    });
  }

  async list() {
    const receipts = await this.prisma.externalCardRedemption.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
    const customers = await this.prisma.customer.findMany({ where: { id: { in: receipts.map(row => row.customerId) } }, select: { id: true, name: true, loginUsername: true } });
    return receipts.map(({ codeEnc, codeHash, ...row }) => ({ ...row, code: this.encryption.decrypt(codeEnc), customer: customers.find(customer => customer.id === row.customerId) }));
  }

  async resolve(id: string, rawAmount: unknown, operator: string) {
    const receipt = await this.prisma.externalCardRedemption.findUnique({ where: { id } });
    if (!receipt) throw new NotFoundException('兑换记录不存在');
    return this.locks.withLock(`card:${receipt.codeHash.slice(0, 40)}`, async () => {
      const current = await this.prisma.externalCardRedemption.findUniqueOrThrow({ where: { id } });
      if (current.status === 'completed' || current.status === 'activated') return this.credit(id, operator);
      if (!['uncertain', 'processing'].includes(current.status)) throw new BadRequestException('该记录无需核销补账');
      const amount = validAmount(rawAmount);
      if (!amount) throw new BadRequestException('请输入核实后的金额，最多两位小数');
      await this.prisma.externalCardRedemption.update({ where: { id }, data: { status: 'activated', amount, lastError: `管理员 ${operator} 已核实远端核销与面额` } });
      return this.credit(id, operator);
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverCredits() {
    const pending = await this.prisma.externalCardRedemption.findMany({ where: { status: 'activated' }, orderBy: { updatedAt: 'asc' }, take: 20 });
    for (const receipt of pending) {
      try { await this.locks.withLock(`card:${receipt.codeHash.slice(0, 40)}`, () => this.credit(receipt.id)); }
      catch { this.logger.warn(`卡密入账等待重试：${receipt.id}`); }
    }
  }
}

function validAmount(value: unknown): Prisma.Decimal | null {
  try {
    const amount = new Prisma.Decimal(String(value));
    return amount.isFinite() && amount.gt(0) && amount.lte('99999999.99') && amount.decimalPlaces() <= 2 ? amount : null;
  } catch { return null; }
}
