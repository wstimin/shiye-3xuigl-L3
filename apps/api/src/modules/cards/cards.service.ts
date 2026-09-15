import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { cardGenerateSchema, cardIntegrationSchema, cardListQuerySchema, cardRedeemSchema, cardTemplateUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';
import { ShiyeCardClient } from './shiye-client.js';

const CARD_INTEGRATION_KEY = 'card:integration';

type CardIntegrationStore = {
  enabled?: boolean;
  baseUrl?: string;
  appKey?: string;
  appSecretEnc?: string | null;
};

@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  // —— 十夜卡密对接：admin 读写对接配置 / 连通性测试 ——

  async getIntegration() {
    const stored = await this.readIntegrationStore();
    return {
      enabled: Boolean(stored.enabled),
      baseUrl: String(stored.baseUrl || ''),
      appKey: String(stored.appKey || ''),
      appSecretSet: Boolean(stored.appSecretEnc)
    };
  }

  async updateIntegration(input: z.infer<typeof cardIntegrationSchema>) {
    const stored = await this.readIntegrationStore();
    const appSecret = (input.appSecret ?? '').trim();
    const next: CardIntegrationStore = {
      enabled: input.enabled,
      baseUrl: (input.baseUrl ?? '').trim(),
      appKey: (input.appKey ?? '').trim(),
      // appSecret 明文经 EncryptionService 加密后落库；留空则保留原值
      appSecretEnc: appSecret ? this.encryption.encrypt(appSecret) : stored.appSecretEnc || null
    };
    if (next.enabled) {
      if (!next.baseUrl) throw new BadRequestException('请填写十夜卡密服务器地址');
      if (!next.appKey) throw new BadRequestException('请填写 app_key');
      if (!next.appSecretEnc) throw new BadRequestException('请填写 app_secret');
    }
    await this.prisma.systemSetting.upsert({
      where: { key: CARD_INTEGRATION_KEY },
      create: { key: CARD_INTEGRATION_KEY, value: asJsonRecord(next) },
      update: { value: asJsonRecord(next) }
    });
    return this.getIntegration();
  }

  async testIntegration(): Promise<{ ok: boolean; message: string }> {
    const client = await this.loadCardsClient();
    if (!client) return { ok: false, message: '请先在「十夜卡密对接设置」中保存并启用对接配置' };
    // 1. 连通性（无需签名）
    const statusRes = await client.status();
    if (statusRes.code !== 0) return { ok: false, message: `连通性检查失败：${statusRes.message || '无法连接服务器'}` };
    // 2. 凭证校验：用一张不存在的卡调 verify；返回 2001 表示鉴权通过（否则 1001）
    const probe = await client.verify('SHIYETEST0001');
    if (probe.code === 1001) {
      return { ok: false, message: `鉴权失败：${probe.message || '签名无效'}（请检查 app_key / app_secret / IP 白名单）` };
    }
    return { ok: true, message: '连接正常，凭证有效，可开始兑换十夜金额卡' };
  }

  private async readIntegrationStore(): Promise<CardIntegrationStore> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: CARD_INTEGRATION_KEY } });
    return row && typeof row.value === 'object' && row.value !== null ? row.value as CardIntegrationStore : {};
  }

  private async loadCardsClient(): Promise<ShiyeCardClient | null> {
    const info = await this.getIntegration();
    if (!info.enabled || !info.baseUrl || !info.appKey || !info.appSecretSet) return null;
    const stored = await this.readIntegrationStore();
    const secret = stored.appSecretEnc ? this.encryption.decrypt(stored.appSecretEnc) : null;
    if (!secret) return null;
    return new ShiyeCardClient({ baseUrl: info.baseUrl, appKey: info.appKey, appSecret: secret });
  }

  // —— 以下为原有业务逻辑 ——

  async list(query: z.infer<typeof cardListQuerySchema>) {
    const page = query.page;
    const pageSize = query.pageSize;
    const keyword = query.keyword?.trim();
    const where: Prisma.CardWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(keyword ? {
        OR: [
          { codeHash: hashCardCode(keyword) },
          { codePreview: { contains: keyword } },
          { batch: { is: { name: { contains: keyword } } } },
          { batch: { is: { template: { is: { name: { contains: keyword } } } } } },
          { usedBy: { is: { name: { contains: keyword } } } },
          { usedBy: { is: { loginUsername: { contains: keyword } } } }
        ]
      } : {})
    };
    const [total, batches, templates, allCount, unusedCount, usedCount, disabledCount] = await this.prisma.$transaction([
      this.prisma.card.count({ where }),
      this.prisma.cardBatch.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          template: true,
          _count: { select: { cards: true } },
          cards: {
            orderBy: { createdAt: 'asc' },
            select: { id: true, codeEnc: true, codePreview: true, amount: true, status: true, usedAt: true, createdAt: true, usedBy: { select: { id: true, name: true, loginUsername: true } } }
          }
        }
      }),
      this.prisma.cardTemplate.findMany({ orderBy: { createdAt: 'desc' } }),
      this.prisma.card.count(),
      this.prisma.card.count({ where: { status: 'unused' } }),
      this.prisma.card.count({ where: { status: 'used' } }),
      this.prisma.card.count({ where: { status: 'disabled' } })
    ]);
    const resolvedPage = Math.min(page, Math.max(1, Math.ceil(total / pageSize)));
    const items = await this.prisma.card.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (resolvedPage - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        codePreview: true,
        amount: true,
        status: true,
        usedAt: true,
        createdAt: true,
        batch: { select: { id: true, name: true, templateId: true } },
        usedBy: { select: { id: true, name: true, loginUsername: true } }
      }
    });

    return {
      items,
      batches: batches.map((batch) => ({
        ...batch,
        cards: batch.cards.map((card) => ({
          id: card.id,
          code: this.decryptCardCode(card.codeEnc),
          codePreview: card.codePreview,
          amount: card.amount,
          status: card.status,
          usedAt: card.usedAt,
          createdAt: card.createdAt,
          usedBy: card.usedBy
        }))
      })),
      templates,
      page: resolvedPage,
      pageSize,
      total,
      statusCounts: { all: allCount, unused: unusedCount, used: usedCount, disabled: disabledCount }
    };
  }

  templates() {
    return this.prisma.cardTemplate.findMany({ orderBy: [{ enabled: 'desc' }, { createdAt: 'desc' }] });
  }

  createTemplate(input: z.infer<typeof cardTemplateUpsertSchema>) {
    return this.prisma.cardTemplate.create({
      data: {
        name: input.name,
        amount: new Prisma.Decimal(input.amount),
        quantity: input.quantity,
        prefix: input.prefix || null,
        enabled: input.enabled,
        remark: input.remark || null
      }
    });
  }

  async updateTemplate(id: string, input: Partial<z.infer<typeof cardTemplateUpsertSchema>>) {
    await this.ensureTemplate(id);
    return this.prisma.cardTemplate.update({
      where: { id },
      data: {
        name: input.name,
        amount: input.amount === undefined ? undefined : new Prisma.Decimal(input.amount),
        quantity: input.quantity,
        prefix: input.prefix === undefined ? undefined : input.prefix || null,
        enabled: input.enabled,
        remark: input.remark === undefined ? undefined : input.remark || null
      }
    });
  }

  async deleteTemplate(id: string) {
    await this.ensureTemplate(id);
    await this.prisma.cardTemplate.delete({ where: { id } });
    return { deleted: true, id };
  }

  async generate(input: z.infer<typeof cardGenerateSchema>) {
    const template = input.templateId ? await this.prisma.cardTemplate.findUnique({ where: { id: input.templateId } }) : null;
    if (input.templateId && !template) throw new NotFoundException('卡密模板不存在');
    if (template && !template.enabled) throw new BadRequestException('卡密模板已停用');

    const amount = new Prisma.Decimal(template?.amount ?? input.amount);
    const quantity = template?.quantity ?? input.quantity;
    const prefix = template?.prefix || input.prefix || '';
    const codes = Array.from({ length: quantity }, () => generateCardCode(prefix));
    const batch = await this.prisma.cardBatch.create({
      data: {
        templateId: template?.id || null,
        name: input.name || template?.name || 'Card batch',
        amount,
        quantity,
        prefix: prefix || null,
        cards: {
          createMany: {
            data: codes.map((code) => ({
              codeHash: hashCardCode(code),
              codeEnc: this.encryption.encrypt(code),
              codePreview: previewCode(code),
              amount
            }))
          }
        }
      },
      include: { cards: true }
    });

    return {
      batchId: batch.id,
      generated: codes.length,
      codes
    };
  }

  // 兑换入口：先查本地卡池，查不到则走十夜卡密系统（对接文档场景 A 用 activate）
  async redeem(customerId: string, input: z.infer<typeof cardRedeemSchema>) {
    const localCode = normalizeCardCode(input.code);
    const existing = await this.prisma.card.findUnique({ where: { codeHash: hashCardCode(localCode) }, select: { id: true } });
    if (existing) return this.redeemLocalCard(customerId, localCode);
    return this.redeemExternalCard(customerId, input.code);
  }

  /** 本地卡池兑换：沿用原逻辑不变（查卡 → 原子 claim → 加余额 → 记流水） */
  private async redeemLocalCard(customerId: string, code: string) {
    const codeHash = hashCardCode(code);

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.card.findUnique({ where: { codeHash } });
      if (!card) throw new NotFoundException('卡密不存在');
      if (card.status !== 'unused') throw new BadRequestException('卡密已使用或已禁用');

      const customers = await tx.$queryRaw<Array<{ id: string; loginUsername: string; status: string; balance: Prisma.Decimal }>>`
        SELECT id, loginUsername, status, balance FROM customers WHERE id = ${customerId} FOR UPDATE
      `;
      const customer = customers[0];
      if (!customer || customer.status !== 'active') throw new NotFoundException('用户不存在或已禁用');

      const claimed = await tx.card.updateMany({
        where: { id: card.id, status: 'unused' },
        data: { status: 'used', usedById: customerId, usedAt: new Date() }
      });
      if (claimed.count !== 1) throw new BadRequestException('卡密已被兑换');

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const amount = new Prisma.Decimal(card.amount);
      const updatedCustomer = await tx.customer.update({
        where: { id: customerId },
        data: { balance: { increment: amount } },
        select: {
          id: true,
          name: true,
          loginUsername: true,
          balance: true,
          status: true
        }
      });
      const afterBalance = new Prisma.Decimal(updatedCustomer.balance);

      await tx.balanceLog.create({
        data: {
          customerId,
          type: 'card_redeem',
          amount,
          beforeBalance,
          afterBalance,
          operator: customer.loginUsername,
          remark: `兑换卡密 ${card.codePreview}`,
          detail: { cardId: card.id, codePreview: card.codePreview }
        }
      });

      return { customer: updatedCustomer, amount };
    });
  }

  /** 十夜卡密兑换：调 API activate → 取金额卡面额 → 加本地余额（核销由本平台落地） */
  private async redeemExternalCard(customerId: string, rawCode: string) {
    const code = rawCode.trim().toUpperCase();
    const client = await this.loadCardsClient();
    if (!client) throw new NotFoundException('卡密不存在');

    const result = await client.activate(code);
    if (result.code !== 0) {
      const message = result.code === -1
        ? '卡密服务暂不可用，请稍后重试'
        : result.code === 1001
          ? '卡密服务鉴权失败，请联系管理员'
          : result.message || '兑换失败，请稍后重试';
      throw new BadRequestException(message);
    }
    // 按对接文档：activate 返回 type 为 money 时报告面额，余额由对方平台核销
    const data = result.data as { type?: string; amount?: number | string; card?: string } | null | undefined;
    if (data?.type && data.type !== 'money') {
      throw new BadRequestException('该卡类型不适用于本项目，请使用金额卡');
    }
    const amount = new Prisma.Decimal(data?.amount ?? 0);
    if (amount.lte(0)) throw new BadRequestException('卡面额异常，请联系客服');

    const displayCard = data?.card || code;
    return this.prisma.$transaction(async (tx) => {
      const customers = await tx.$queryRaw<Array<{ id: string; loginUsername: string; status: string; balance: Prisma.Decimal }>>`
        SELECT id, loginUsername, status, balance FROM customers WHERE id = ${customerId} FOR UPDATE
      `;
      const customer = customers[0];
      if (!customer || customer.status !== 'active') throw new NotFoundException('用户不存在或已禁用');

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const updatedCustomer = await tx.customer.update({
        where: { id: customerId },
        data: { balance: { increment: amount } },
        select: {
          id: true,
          name: true,
          loginUsername: true,
          balance: true,
          status: true
        }
      });
      const afterBalance = new Prisma.Decimal(updatedCustomer.balance);

      await tx.balanceLog.create({
        data: {
          customerId,
          type: 'card_redeem',
          amount,
          beforeBalance,
          afterBalance,
          operator: customer.loginUsername,
          remark: `兑换十夜卡密 ${previewCode(displayCard)}`,
          detail: { source: 'shiye', code: displayCard }
        }
      });

      return { customer: updatedCustomer, amount };
    });
  }

  async deleteCard(id: string) {
    const card = await this.prisma.card.findUnique({ where: { id } });
    if (!card) throw new NotFoundException('卡密不存在');
    if (card.status === 'used') throw new BadRequestException('已使用的卡密不能删除');
    await this.prisma.card.delete({ where: { id } });
    return { deleted: true, id };
  }

  async deleteBatch(id: string) {
    const batch = await this.prisma.cardBatch.findUnique({ where: { id }, include: { cards: { select: { status: true } } } });
    if (!batch) throw new NotFoundException('卡密批次不存在');
    if (batch.cards.some((card) => card.status === 'used')) throw new BadRequestException('包含已使用卡密的批次不能删除');
    await this.prisma.$transaction([
      this.prisma.card.deleteMany({ where: { batchId: id } }),
      this.prisma.cardBatch.delete({ where: { id } })
    ]);
    return { deleted: true, id };
  }

  async deleteUnusedTemplateCards(templateId: string) {
    await this.ensureTemplate(templateId);
    const batches = await this.prisma.cardBatch.findMany({ where: { templateId }, select: { id: true } });
    const batchIds = batches.map((batch) => batch.id);
    if (batchIds.length === 0) return { deleted: true, templateId, deletedCards: 0, deletedBatches: 0 };

    const [deletedCards, deletedBatches] = await this.prisma.$transaction([
      this.prisma.card.deleteMany({ where: { batchId: { in: batchIds }, status: 'unused' } }),
      this.prisma.cardBatch.deleteMany({ where: { templateId, cards: { none: {} } } })
    ]);
    return { deleted: true, templateId, deletedCards: deletedCards.count, deletedBatches: deletedBatches.count };
  }

  async deleteUsedCards() {
    const [deletedCards, deletedBatches] = await this.prisma.$transaction([
      this.prisma.card.deleteMany({ where: { status: 'used' } }),
      this.prisma.cardBatch.deleteMany({ where: { cards: { none: {} } } })
    ]);
    return { deleted: true, deletedCards: deletedCards.count, deletedBatches: deletedBatches.count };
  }

  async deleteUsedBatchCards(batchId: string) {
    const batch = await this.prisma.cardBatch.findUnique({ where: { id: batchId }, select: { id: true } });
    if (!batch) throw new NotFoundException('卡密批次不存在');
    const [deletedCards, deletedBatches] = await this.prisma.$transaction([
      this.prisma.card.deleteMany({ where: { batchId, status: 'used' } }),
      this.prisma.cardBatch.deleteMany({ where: { id: batchId, cards: { none: {} } } })
    ]);
    return { deleted: true, batchId, deletedCards: deletedCards.count, deletedBatches: deletedBatches.count };
  }

  private async ensureTemplate(id: string) {
    const exists = await this.prisma.cardTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('卡密模板不存在');
  }

  private decryptCardCode(value: string | null) {
    if (!value) return null;
    try {
      return this.encryption.decrypt(value);
    } catch {
      return null;
    }
  }
}

function generateCardCode(prefix = '') {
  const head = prefix ? `${prefix.toUpperCase()}-` : '';
  const body = crypto.randomBytes(12).toString('base64url').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return `${head}${body.match(/.{1,4}/g)?.join('-') || body}`;
}

function hashCardCode(code: string) {
  const secret = process.env.CARD_HASH_SECRET || process.env.ENCRYPTION_KEY || 'dev-card-secret';
  return crypto.createHmac('sha256', secret).update(normalizeCardCode(code)).digest('hex');
}

function normalizeCardCode(code: string) {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

function previewCode(code: string) {
  const normalized = normalizeCardCode(code);
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

function asJsonRecord(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
