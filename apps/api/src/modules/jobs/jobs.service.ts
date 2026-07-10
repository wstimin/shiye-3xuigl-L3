import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { XuiService } from '../xui/xui.service.js';

type DisableExpiredResult = {
  customerNodeId: string;
  customerId: string;
  xuiEmail: string;
  expireAt: Date;
  disabled: boolean;
  message?: string;
};

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private disableExpiredRunning = false;

  constructor(private readonly prisma: PrismaService, private readonly xui: XuiService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async disableExpiredOnSchedule() {
    if (this.disableExpiredRunning) return;
    this.disableExpiredRunning = true;
    try {
      const result = await this.disableExpiredNodes('schedule');
      if (result.total > 0) {
        this.logger.log(`Expired node disable job finished: success=${result.success}, failed=${result.failed}, total=${result.total}`);
      }
    } catch (error) {
      this.logger.error(`Expired node disable job failed: ${this.errorMessage(error)}`);
    } finally {
      this.disableExpiredRunning = false;
    }
  }

  async disableExpiredNodes(trigger = 'manual') {
    const now = new Date();
    const expiredNodes = await this.prisma.customerNode.findMany({
      where: {
        status: 'active',
        expireAt: { not: null, lte: now }
      },
      orderBy: { expireAt: 'asc' },
      select: {
        id: true,
        customerId: true,
        xuiEmail: true,
        expireAt: true,
        serviceNodeId: true
      }
    });

    const results: DisableExpiredResult[] = [];
    for (const node of expiredNodes) {
      if (!node.expireAt) continue;
      try {
        await this.xui.syncCustomerNode(node.customerId, node.id, { status: 'disabled', expireAt: node.expireAt, createIfMissing: false });
        await this.prisma.customerNode.update({
          where: { id: node.id },
          data: { status: 'disabled', lastSyncedAt: new Date() }
        });
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, expireAt: node.expireAt, disabled: true });
      } catch (error) {
        results.push({
          customerNodeId: node.id,
          customerId: node.customerId,
          xuiEmail: node.xuiEmail,
          expireAt: node.expireAt,
          disabled: false,
          message: this.errorMessage(error)
        });
      }
    }

    const success = results.filter((item) => item.disabled).length;
    const failed = results.length - success;
    await this.prisma.syncLog.create({
      data: {
        serverId: null,
        action: 'disable-expired-nodes',
        status: failed > 0 ? 'partial' : 'success',
        message: `Expired node disable job by ${trigger}: success ${success}, failed ${failed}, total ${results.length}`,
        detail: JSON.parse(JSON.stringify({ trigger, checkedAt: now, results }))
      }
    }).catch(() => undefined);

    return { checkedAt: now, total: results.length, success, failed, results };
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
