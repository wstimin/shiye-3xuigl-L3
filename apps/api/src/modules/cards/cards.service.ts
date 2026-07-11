import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { cardGenerateSchema, cardRedeemSchema, cardTemplateUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import crypto from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';

@Injectable()
export class CardsService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async list() {
    const [items, batches, templates, total] = await this.prisma.$transaction([
      this.prisma.card.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
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
      }),
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
      this.prisma.card.count()
    ]);

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
      page: 1,
      pageSize: 100,
      total
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
    if (input.templateId && !template) throw new NotFoundException('Card template not found');
    if (template && !template.enabled) throw new BadRequestException('Card template is disabled');

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

  async redeem(customerId: string, input: z.infer<typeof cardRedeemSchema>) {
    const codeHash = hashCardCode(input.code);

    return this.prisma.$transaction(async (tx) => {
      const card = await tx.card.findUnique({ where: { codeHash } });
      if (!card) throw new NotFoundException('卡密不存在');
      if (card.status !== 'unused') throw new BadRequestException('卡密已使用或已禁用');

      const customer = await tx.customer.findUnique({ where: { id: customerId } });
      if (!customer || customer.status !== 'active') throw new NotFoundException('用户不存在或已禁用');

      const claimed = await tx.card.updateMany({
        where: { id: card.id, status: 'unused' },
        data: { status: 'used', usedById: customerId, usedAt: new Date() }
      });
      if (claimed.count !== 1) throw new BadRequestException('卡密已被兑换');

      const beforeBalance = new Prisma.Decimal(customer.balance);
      const amount = new Prisma.Decimal(card.amount);
      const afterBalance = beforeBalance.plus(amount);

      const updatedCustomer = await tx.customer.update({
        where: { id: customerId },
        data: { balance: afterBalance },
        select: {
          id: true,
          name: true,
          loginUsername: true,
          balance: true,
          status: true
        }
      });

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

  async deleteCard(id: string) {
    const card = await this.prisma.card.findUnique({ where: { id } });
    if (!card) throw new NotFoundException('Card not found');
    if (card.status === 'used') throw new BadRequestException('Used cards cannot be deleted');
    await this.prisma.card.delete({ where: { id } });
    return { deleted: true, id };
  }

  async deleteBatch(id: string) {
    const batch = await this.prisma.cardBatch.findUnique({ where: { id }, include: { cards: { select: { status: true } } } });
    if (!batch) throw new NotFoundException('Card batch not found');
    if (batch.cards.some((card) => card.status === 'used')) throw new BadRequestException('Batches with used cards cannot be deleted');
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
    if (!batch) throw new NotFoundException('Card batch not found');
    const [deletedCards, deletedBatches] = await this.prisma.$transaction([
      this.prisma.card.deleteMany({ where: { batchId, status: 'used' } }),
      this.prisma.cardBatch.deleteMany({ where: { id: batchId, cards: { none: {} } } })
    ]);
    return { deleted: true, batchId, deletedCards: deletedCards.count, deletedBatches: deletedBatches.count };
  }

  private async ensureTemplate(id: string) {
    const exists = await this.prisma.cardTemplate.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('Card template not found');
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
