import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service.js';
import { DatabaseLockService } from '../../shared/database-lock.service.js';

type DisableExpiredResult = {
  customerNodeId: string;
  customerId: string;
  xuiEmail: string;
  expireAt: Date;
  disabled: boolean;
  skipped?: boolean;
  message?: string;
};

type DisableTrafficExceededResult = {
  customerNodeId: string;
  customerId: string;
  xuiEmail: string;
  usedBytes: number;
  limitBytes: number;
  usedTrafficGb: number;
  trafficLimitGb: number;
  disabled: boolean;
  skipped?: boolean;
  message?: string;
};

type DisableExpiredOutcome =
  | { skipped: false }
  | { skipped: true; reason: string };

type DisableTrafficExceededOutcome =
  | { skipped: false; usedBytes: number; usedTrafficGb: number; limitBytes: number }
  | { skipped: true; belowLimit: true; usedBytes: number; usedTrafficGb: number; limitBytes: number }
  | { skipped: true; reason: string; usedBytes: number; usedTrafficGb: number; limitBytes: number };

type JobSettings = {
  disableExpiredEnabled: boolean;
  trafficSyncEnabled: boolean;
};

const JOB_SETTINGS_KEY = 'jobs';
const DEFAULT_JOB_SETTINGS: JobSettings = {
  disableExpiredEnabled: true,
  trafficSyncEnabled: true
};

@Injectable()
export class JobsService {
  private readonly logger = new Logger(JobsService.name);
  private disableExpiredRunning = false;
  private disableTrafficExceededRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly locks: DatabaseLockService
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async disableExpiredOnSchedule() {
    if (this.disableExpiredRunning) return;
    const settings = await this.jobSettings();
    if (!settings.disableExpiredEnabled) return;
    try {
      const result = await this.disableExpiredNodes('schedule');
      if (result.total > 0) {
        this.logger.log(`到期节点停用任务完成：成功=${result.success}，失败=${result.failed}，总数=${result.total}`);
      }
    } catch (error) {
      this.logger.error(`到期节点停用任务失败：${this.errorMessage(error)}`);
    }
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async disableTrafficExceededOnSchedule() {
    if (this.disableTrafficExceededRunning) return;
    const settings = await this.jobSettings();
    if (!settings.trafficSyncEnabled) return;
    try {
      const result = await this.disableTrafficExceededNodes('schedule');
      if (result.disabled > 0 || result.failed > 0) {
        this.logger.log(`流量超限停用任务完成：已停用=${result.disabled}，失败=${result.failed}，检查数=${result.checked}`);
      }
    } catch (error) {
      this.logger.error(`流量超限停用任务失败：${this.errorMessage(error)}`);
    }
  }

  async jobSettings(): Promise<JobSettings> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: JOB_SETTINGS_KEY } });
    const value = this.objectValue(row?.value);
    return {
      disableExpiredEnabled: this.booleanValue(value.disableExpiredEnabled, DEFAULT_JOB_SETTINGS.disableExpiredEnabled),
      trafficSyncEnabled: this.booleanValue(value.trafficSyncEnabled, DEFAULT_JOB_SETTINGS.trafficSyncEnabled)
    };
  }

  async jobStatus() {
    const [disableExpiredLog, trafficSyncLog] = await Promise.all([
      this.prisma.syncLog.findFirst({ where: { action: 'disable-expired-nodes' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.syncLog.findFirst({ where: { action: 'disable-traffic-exceeded-nodes' }, orderBy: { createdAt: 'desc' } })
    ]);

    return {
      lastDisableExpired: this.disableExpiredStatus(disableExpiredLog),
      lastTrafficSync: this.trafficSyncStatus(trafficSyncLog)
    };
  }

  async updateJobSettings(input: Partial<Record<keyof JobSettings, unknown>>) {
    const current = await this.jobSettings();
    const next: JobSettings = {
      disableExpiredEnabled: input.disableExpiredEnabled === undefined ? current.disableExpiredEnabled : this.booleanValue(input.disableExpiredEnabled, current.disableExpiredEnabled),
      trafficSyncEnabled: input.trafficSyncEnabled === undefined ? current.trafficSyncEnabled : this.booleanValue(input.trafficSyncEnabled, current.trafficSyncEnabled)
    };
    await this.prisma.systemSetting.upsert({
      where: { key: JOB_SETTINGS_KEY },
      create: { key: JOB_SETTINGS_KEY, value: this.toJsonValue(next) },
      update: { value: this.toJsonValue(next) }
    });
    return next;
  }

  async disableExpiredNodes(trigger = 'manual') {
    if (this.disableExpiredRunning) throw new ConflictException('过期节点停用任务正在执行，请稍后再试');
    this.disableExpiredRunning = true;
    try {
      return await this.performDisableExpiredNodes(trigger);
    } finally {
      this.disableExpiredRunning = false;
    }
  }

  private async performDisableExpiredNodes(trigger: string) {
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
        const outcome = await this.locks.withLock(this.locks.serviceNodeKey(node.serviceNodeId), () =>
          this.locks.withLock<DisableExpiredOutcome>(this.locks.customerNodeKey(node.id), async () => {
            const current = await this.prisma.customerNode.findUnique({
              where: { id: node.id },
              select: { status: true, expireAt: true, serviceNodeId: true }
            });
            if (!current || current.serviceNodeId !== node.serviceNodeId || current.status !== 'active' || !current.expireAt || current.expireAt > new Date()) {
              return { skipped: true, reason: '节点状态或到期时间已变化' } as const;
            }
            if (await this.hasPendingRenewal(node.id)) return { skipped: true, reason: '节点续费正在处理，已等待续费完成后再检查' } as const;
            await this.prisma.customerNode.update({
              where: { id: node.id },
              data: { status: 'disabled', disabledReason: 'expired' }
            });
            return { skipped: false } as const;
          })
        );
        if (outcome.skipped) {
          results.push({
            customerNodeId: node.id,
            customerId: node.customerId,
            xuiEmail: node.xuiEmail,
            expireAt: node.expireAt,
            disabled: false,
            skipped: true,
            message: outcome.reason
          });
          continue;
        }
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
    const skipped = results.filter((item) => item.skipped).length;
    const failed = results.length - success - skipped;
    await this.prisma.syncLog.create({
      data: {
        serverId: null,
        action: 'disable-expired-nodes',
        status: failed > 0 ? 'partial' : 'success',
        message: `到期节点停用任务（触发方式：${trigger === 'schedule' ? '定时' : '手动'}）：成功 ${success}，跳过 ${skipped}，失败 ${failed}，总数 ${results.length}`,
        detail: JSON.parse(JSON.stringify({ trigger, checkedAt: now, results }))
      }
    }).catch(() => undefined);

    return { checkedAt: now, total: results.length, success, skipped, failed, results };
  }

  async disableTrafficExceededNodes(trigger = 'manual') {
    if (this.disableTrafficExceededRunning) throw new ConflictException('远端流量同步任务正在执行，请稍后再试');
    this.disableTrafficExceededRunning = true;
    try {
      return await this.performDisableTrafficExceededNodes(trigger);
    } finally {
      this.disableTrafficExceededRunning = false;
    }
  }

  private async performDisableTrafficExceededNodes(trigger: string) {
    const checkedAt = new Date();
    const activeNodes = await this.prisma.customerNode.findMany({
      where: {
        status: 'active',
        trafficLimitGb: { gt: new Prisma.Decimal(0) }
      },
      orderBy: { updatedAt: 'asc' },
      select: {
        id: true,
        customerId: true,
        xuiEmail: true,
        trafficLimitGb: true,
        serviceNodeId: true
      }
    });

    const results: DisableTrafficExceededResult[] = [];
    for (const node of activeNodes) {
      const trafficLimitGb = Number(node.trafficLimitGb);
      const limitBytes = this.gbToBytes(trafficLimitGb);
      if (limitBytes <= 0) continue;

      try {
        const outcome = await this.locks.withLock(this.locks.serviceNodeKey(node.serviceNodeId), () =>
          this.locks.withLock<DisableTrafficExceededOutcome>(this.locks.customerNodeKey(node.id), async () => {
            const current = await this.prisma.customerNode.findUnique({
              where: { id: node.id },
              select: { status: true, trafficLimitGb: true, usedTrafficGb: true, serviceNodeId: true }
            });
            if (!current || current.serviceNodeId !== node.serviceNodeId || current.status !== 'active') return { skipped: true, reason: '节点状态已变化', usedBytes: 0, usedTrafficGb: 0, limitBytes } as const;
            const currentLimitBytes = this.gbToBytes(Number(current.trafficLimitGb));
            if (currentLimitBytes <= 0) return { skipped: true, reason: '节点流量额度已取消', usedBytes: 0, usedTrafficGb: 0, limitBytes: currentLimitBytes } as const;
            if (await this.hasPendingRenewal(node.id)) return { skipped: true, reason: '节点续费正在处理，已等待续费完成后再检查', usedBytes: 0, usedTrafficGb: 0, limitBytes: currentLimitBytes } as const;
            const usedTrafficGb = Number(current.usedTrafficGb);
            const usedBytes = this.gbToBytes(usedTrafficGb);
            return {
              skipped: true,
              reason: '服务节点使用共享官方客户端，无法将官方总流量准确归属到单个用户，已跳过自动停用',
              usedBytes,
              usedTrafficGb,
              limitBytes: currentLimitBytes
            } as const;
          })
        );

        if (outcome.skipped) {
          if ('belowLimit' in outcome) continue;
          results.push({
            customerNodeId: node.id,
            customerId: node.customerId,
            xuiEmail: node.xuiEmail,
            usedBytes: outcome.usedBytes,
            limitBytes: outcome.limitBytes,
            usedTrafficGb: outcome.usedTrafficGb,
            trafficLimitGb,
            disabled: false,
            skipped: true,
            message: outcome.reason
          });
          continue;
        }
        results.push({
          customerNodeId: node.id,
          customerId: node.customerId,
          xuiEmail: node.xuiEmail,
          usedBytes: outcome.usedBytes,
          limitBytes: outcome.limitBytes,
          usedTrafficGb: outcome.usedTrafficGb,
          trafficLimitGb,
          disabled: true
        });
      } catch (error) {
        results.push({
          customerNodeId: node.id,
          customerId: node.customerId,
          xuiEmail: node.xuiEmail,
          usedBytes: 0,
          limitBytes,
          usedTrafficGb: 0,
          trafficLimitGb,
          disabled: false,
          message: this.errorMessage(error)
        });
      }
    }

    const disabled = results.filter((item) => item.disabled).length;
    const skipped = results.filter((item) => item.skipped).length;
    const failed = results.length - disabled - skipped;
    await this.prisma.syncLog.create({
      data: {
        serverId: null,
        action: 'disable-traffic-exceeded-nodes',
        status: failed > 0 ? 'partial' : 'success',
        message: `流量超限停用任务（触发方式：${trigger === 'schedule' ? '定时' : '手动'}）：已停用 ${disabled}，跳过 ${skipped}，失败 ${failed}，检查数 ${activeNodes.length}`,
        detail: JSON.parse(JSON.stringify({ trigger, checkedAt, checked: activeNodes.length, results }))
      }
    }).catch(() => undefined);

    return { checkedAt, checked: activeNodes.length, disabled, skipped, failed, results };
  }

  private gbToBytes(value: number) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return Math.round(value * 1024 * 1024 * 1024);
  }

  private bytesToGb(value: number) {
    if (!Number.isFinite(value) || value <= 0) return 0;
    return value / 1024 / 1024 / 1024;
  }

  private numberValue(value: unknown) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  private objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  }

  private booleanValue(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private async hasPendingRenewal(customerNodeId: string) {
    const pending = await this.prisma.renewalLog.findFirst({
      where: { customerNodeId, status: 'pending' },
      select: { id: true }
    });
    return Boolean(pending);
  }

  private disableExpiredStatus(log: { detail: Prisma.JsonValue; createdAt: Date } | null) {
    if (!log) return null;
    const detail = this.objectValue(log.detail);
    const results = Array.isArray(detail.results) ? detail.results.map((item) => this.objectValue(item)) : [];
    const success = results.filter((item) => item.disabled === true).length;
    const skipped = results.filter((item) => item.skipped === true).length;
    const failed = results.length - success - skipped;
    return {
      checkedAt: this.dateValue(detail.checkedAt) || log.createdAt,
      total: results.length,
      success,
      skipped,
      failed
    };
  }

  private trafficSyncStatus(log: { detail: Prisma.JsonValue; createdAt: Date } | null) {
    if (!log) return null;
    const detail = this.objectValue(log.detail);
    const results = Array.isArray(detail.results) ? detail.results.map((item) => this.objectValue(item)) : [];
    const disabled = results.filter((item) => item.disabled === true).length;
    const skipped = results.filter((item) => item.skipped === true).length;
    const failed = results.length - disabled - skipped;
    return {
      checkedAt: this.dateValue(detail.checkedAt) || log.createdAt,
      checked: this.numberValue(detail.checked) || 0,
      disabled,
      skipped,
      failed
    };
  }

  private dateValue(value: unknown) {
    const date = value instanceof Date ? value : typeof value === 'string' || typeof value === 'number' ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
