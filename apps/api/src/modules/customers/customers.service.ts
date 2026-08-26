import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { z } from 'zod';
import { balanceAdjustSchema, customerListQuerySchema, customerUpsertSchema } from '@shiye/shared';
import bcrypt from 'bcryptjs';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';

@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async list(query: z.infer<typeof customerListQuerySchema>) {
    const page = query.page;
    const pageSize = query.pageSize;
    const keyword = query.keyword?.trim();
    const where: Prisma.CustomerWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...buildBalanceFilter(query.balanceMin, query.balanceMax),
      ...(keyword ? {
        OR: [
          { name: { contains: keyword } },
          { loginUsername: { contains: keyword } },
          { email: { contains: keyword } },
          { phone: { contains: keyword } },
          { remark: { contains: keyword } },
          { nodes: { some: { clientName: { contains: keyword } } } },
          { nodes: { some: { xuiEmail: { contains: keyword } } } },
          { nodes: { some: { serviceNode: { name: { contains: keyword } } } } },
          { nodes: { some: { serviceNode: { server: { name: { contains: keyword } } } } } }
        ]
      } : {})
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.customer.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: customerSelect
      }),
      this.prisma.customer.count({ where })
    ]);
    return { items, page, pageSize, total };
  }

  async create(input: z.infer<typeof customerUpsertSchema>) {
    const password = input.loginPassword || randomPassword();
    const loginPasswordHash = await bcrypt.hash(password, 12);
    return this.prisma.customer.create({
      data: {
        name: input.name,
        loginUsername: input.loginUsername,
        loginPasswordHash,
        loginPasswordEnc: this.encryption.encrypt(password),
        email: input.email || null,
        phone: input.phone || null,
        balance: new Prisma.Decimal(input.balance || 0),
        status: input.status,
        remark: input.remark || null
      },
      select: customerSelect
    });
  }

  async update(id: string, input: Partial<z.infer<typeof customerUpsertSchema>>) {
    await this.ensureExists(id);
    if (input.balance !== undefined) throw new BadRequestException('余额不能通过用户资料接口修改，请使用余额调整功能');
    const loginPasswordHash = input.loginPassword ? await bcrypt.hash(input.loginPassword, 12) : undefined;
    const loginPasswordEnc = input.loginPassword ? this.encryption.encrypt(input.loginPassword) : undefined;
    return this.prisma.customer.update({
      where: { id },
      data: {
        name: input.name,
        loginUsername: input.loginUsername,
        loginPasswordHash,
        loginPasswordEnc,
        email: input.email === undefined ? undefined : input.email || null,
        phone: input.phone === undefined ? undefined : input.phone || null,
        status: input.status,
        remark: input.remark === undefined ? undefined : input.remark || null
      },
      select: customerSelect
    });
  }

  async secrets(id: string) {
    const customer = await this.prisma.customer.findUnique({ where: { id }, select: { id: true, loginPasswordEnc: true } });
    if (!customer) throw new NotFoundException('用户不存在');
    return { id: customer.id, loginPassword: this.encryption.decryptNullable(customer.loginPasswordEnc) || '' };
  }

  async remove(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: { id: true, nodes: { select: { id: true } } }
    });
    if (!customer) throw new NotFoundException('用户不存在');
    const pendingRenewal = await this.prisma.renewalLog.findFirst({
      where: { customerId: id, status: 'pending' },
      select: { id: true }
    });
    if (pendingRenewal) throw new BadRequestException('该用户存在待处理续费，完成自动恢复或人工对账后才能删除');
    const [rechargeOrders, balanceLogs, renewalLogs, usedCards] = await this.prisma.$transaction([
      this.prisma.rechargeOrder.count({ where: { customerId: id } }),
      this.prisma.balanceLog.count({ where: { customerId: id } }),
      this.prisma.renewalLog.count({ where: { customerId: id } }),
      this.prisma.card.count({ where: { usedById: id } })
    ]);
    if (rechargeOrders || balanceLogs || renewalLogs || usedCards) {
      throw new BadRequestException('该用户已有充值、余额、续费或卡密财务历史，不能硬删除；请改为停用账号');
    }

    await this.prisma.customer.delete({ where: { id } });
    return {
      deleted: true,
      id,
      unboundNodes: customer.nodes.length,
      remoteCleanup: { skipped: true, reason: '面板用户删除仅影响本地账号，远端 3x-ui 客户端仍归服务节点管理' }
    };
  }

  async adjustBalance(id: string, input: z.infer<typeof balanceAdjustSchema>, operator = 'admin') {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string; balance: Prisma.Decimal }>>`
        SELECT id, balance FROM customers WHERE id = ${id} FOR UPDATE
      `;
      const customer = rows[0];
      if (!customer) throw new NotFoundException('用户不存在');

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const amount = new Prisma.Decimal(input.amount);
      const afterBalance = input.mode === 'set'
        ? amount
        : input.mode === 'subtract'
          ? beforeBalance.minus(amount)
          : beforeBalance.plus(amount);

      if (afterBalance.lessThan(0)) throw new BadRequestException('余额不能小于 0');

      const updated = await tx.customer.update({ where: { id }, data: { balance: afterBalance }, select: customerSelect });
      await tx.balanceLog.create({
        data: {
          customerId: id,
          type: input.mode === 'set' ? 'admin_set' : input.mode === 'subtract' ? 'admin_subtract' : 'admin_add',
          amount: input.mode === 'subtract' ? amount.negated() : amount,
          beforeBalance,
          afterBalance,
          operator,
          remark: input.remark || null,
          detail: { mode: input.mode }
        }
      });

      return updated;
    });
  }

  async userDashboard(customerId: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      select: customerSelect
    });
    if (!customer) throw new NotFoundException('用户不存在');

    const [nodes, balanceLogs, renewalLogs] = await this.prisma.$transaction([
      this.prisma.customerNode.findMany({ where: { customerId }, include: { serviceNode: true }, orderBy: { createdAt: 'desc' } }),
      this.prisma.balanceLog.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 50 }),
      this.prisma.renewalLog.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' }, take: 50 })
    ]);

    return { customer, nodes, balanceLogs, renewalLogs };
  }

  private async ensureExists(id: string) {
    const exists = await this.prisma.customer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('用户不存在');
  }
}

const customerSelect = {
  id: true,
  name: true,
  loginUsername: true,
  email: true,
  phone: true,
  balance: true,
  status: true,
  remark: true,
  nodes: {
    select: {
      id: true,
      clientName: true,
      xuiEmail: true,
      uuid: true,
      expireAt: true,
      trafficLimitGb: true,
      usedTrafficGb: true,
      status: true,
      remoteControl: true,
      lastSyncedAt: true,
      serviceNode: { select: { id: true, name: true, ownership: true, server: { select: { id: true, name: true } } } }
    },
    orderBy: { createdAt: 'desc' }
  },
  createdAt: true,
  updatedAt: true
} satisfies Prisma.CustomerSelect;

function randomPassword() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}

function buildBalanceFilter(balanceMin?: number, balanceMax?: number): Pick<Prisma.CustomerWhereInput, 'balance'> {
  if (balanceMin === undefined && balanceMax === undefined) return {};
  return {
    balance: {
      ...(balanceMin === undefined ? {} : { gte: new Prisma.Decimal(balanceMin) }),
      ...(balanceMax === undefined ? {} : { lte: new Prisma.Decimal(balanceMax) })
    }
  };
}
