import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { JobsService } from '../jobs/jobs.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { XuiService } from '../xui/xui.service.js';

type CheckStatus = 'ok' | 'warning' | 'error' | 'skipped';

type DiagnosticCheck = {
  key: string;
  label: string;
  status: CheckStatus;
  message: string;
  detail?: unknown;
  meta?: Array<{ label: string; value: string }>;
  checkedAt: Date;
  durationMs: number;
};

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly xui: XuiService
  ) {}

  async overview() {
    const startedAt = new Date();
    const started = performance.now();
    const [database, jobs, serviceNodes, payment, xuiServers, recentFailures, counts, resources] = await Promise.all([
      this.databaseCheck(),
      this.jobsCheck(),
      this.serviceNodesCheck(),
      this.paymentCheck(),
      this.xuiServerChecks(),
      this.recentFailures(),
      this.resourceCounts(),
      this.systemResources()
    ]);
    const checks = [this.runtimeCheck(), database, jobs, serviceNodes, payment, ...xuiServers];

    return {
      checkedAt: new Date(),
      startedAt,
      durationMs: this.elapsed(started),
      summary: this.summary(checks),
      counts,
      resources,
      checks,
      recentFailures
    };
  }

  private runtimeCheck(): DiagnosticCheck {
    const checkedAt = new Date();
    const uptimeSeconds = Math.floor(process.uptime());
    return {
      key: 'runtime',
      label: 'API 运行环境',
      status: 'ok',
      message: `API 服务运行正常，Node.js ${process.version}`,
      meta: [
        { label: '平台', value: `${process.platform}/${process.arch}` },
        { label: '进程运行', value: this.durationLabel(uptimeSeconds) }
      ],
      detail: {
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        processId: process.pid,
        startedAt: new Date(Date.now() - uptimeSeconds * 1000)
      },
      checkedAt,
      durationMs: 0
    };
  }

  private async databaseCheck(): Promise<DiagnosticCheck> {
    const checkedAt = new Date();
    const started = performance.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      const durationMs = this.elapsed(started);
      return {
        key: 'database',
        label: '数据库',
        status: 'ok',
        message: '数据库连接正常，基础查询执行成功',
        meta: [{ label: '查询延迟', value: this.millisecondsLabel(durationMs) }],
        checkedAt,
        durationMs
      };
    } catch (error) {
      return {
        key: 'database',
        label: '数据库',
        status: 'error',
        message: `数据库连接失败：${this.errorMessage(error)}`,
        checkedAt,
        durationMs: this.elapsed(started)
      };
    }
  }

  private async jobsCheck(): Promise<DiagnosticCheck> {
    const checkedAt = new Date();
    const started = performance.now();
    try {
      const [settings, status] = await Promise.all([this.jobs.jobSettings(), this.jobs.jobStatus()]);
      const disabled: string[] = [];
      if (!settings.disableExpiredEnabled) disabled.push('自动停用过期节点');
      if (!settings.trafficSyncEnabled) disabled.push('远端流量同步');
      const latestRun = [status.lastDisableExpired?.checkedAt, status.lastTrafficSync?.checkedAt]
        .filter(Boolean)
        .map((value) => new Date(value as string | Date))
        .sort((left, right) => right.getTime() - left.getTime())[0];
      const durationMs = this.elapsed(started);
      return {
        key: 'jobs',
        label: '同步任务',
        status: disabled.length ? 'warning' : 'ok',
        message: disabled.length ? `${disabled.join('、')}未启用` : '自动停用与流量同步任务均已启用',
        meta: [
          { label: '任务状态', value: disabled.length ? `${2 - disabled.length}/2 已启用` : '2/2 已启用' },
          { label: '最近检查', value: latestRun ? latestRun.toISOString() : '暂无执行记录' }
        ],
        detail: { settings, status },
        checkedAt,
        durationMs
      };
    } catch (error) {
      return {
        key: 'jobs',
        label: '同步任务',
        status: 'error',
        message: `读取任务状态失败：${this.errorMessage(error)}`,
        checkedAt,
        durationMs: this.elapsed(started)
      };
    }
  }

  private async serviceNodesCheck(): Promise<DiagnosticCheck> {
    const checkedAt = new Date();
    const started = performance.now();
    try {
      const nodes = await this.prisma.serviceNode.findMany({
        where: { enabled: true },
        select: {
          id: true,
          name: true,
          inboundId: true,
          protocol: true,
          server: { select: { id: true, name: true, enabled: true } }
        }
      });
      if (!nodes.length) {
        return {
          key: 'service-nodes',
          label: '路由节点',
          status: 'skipped',
          message: '当前没有启用的路由节点，已跳过配置检查',
          meta: [{ label: '启用节点', value: '0 个' }],
          detail: { nodes: [] },
          checkedAt,
          durationMs: this.elapsed(started)
        };
      }

      const missingInbound = nodes.filter((node) => node.inboundId === null);
      const disabledServers = nodes.filter((node) => !node.server.enabled);
      const issues = missingInbound.length + disabledServers.length;
      return {
        key: 'service-nodes',
        label: '路由节点',
        status: issues ? 'warning' : 'ok',
        message: issues
          ? `${issues} 个节点配置需要处理，面板连通性由独立检查项验证`
          : `${nodes.length} 个启用节点配置完整，面板连通性由独立检查项验证`,
        meta: [
          { label: '启用节点', value: `${nodes.length} 个` },
          { label: '配置异常', value: `${issues} 个` }
        ],
        detail: {
          total: nodes.length,
          missingInbound: missingInbound.map((node) => ({ id: node.id, name: node.name, panel: node.server.name })),
          disabledServers: disabledServers.map((node) => ({ id: node.id, name: node.name, panel: node.server.name }))
        },
        checkedAt,
        durationMs: this.elapsed(started)
      };
    } catch (error) {
      return {
        key: 'service-nodes',
        label: '路由节点',
        status: 'error',
        message: `读取路由节点配置失败：${this.errorMessage(error)}`,
        checkedAt,
        durationMs: this.elapsed(started)
      };
    }
  }

  private async paymentCheck(): Promise<DiagnosticCheck> {
    const checkedAt = new Date();
    const started = performance.now();
    try {
      const channels = await this.prisma.paymentChannel.findMany({
        orderBy: { sortOrder: 'asc' },
        select: { id: true, name: true, provider: true, enabled: true }
      });
      const enabledChannels = channels.filter((channel) => channel.enabled);
      return {
        key: 'payment',
        label: '在线支付',
        status: enabledChannels.length ? 'ok' : 'warning',
        message: enabledChannels.length
          ? `${enabledChannels.length} 个在线支付渠道已启用`
          : '在线支付未启用，用户仍可使用卡密兑换',
        meta: [
          { label: '启用渠道', value: `${enabledChannels.length}/${channels.length}` },
          { label: '支付方式', value: enabledChannels.map((channel) => channel.name).join('、') || '卡密兑换' }
        ],
        detail: { channels },
        checkedAt,
        durationMs: this.elapsed(started)
      };
    } catch (error) {
      return {
        key: 'payment',
        label: '在线支付',
        status: 'error',
        message: `读取支付配置失败：${this.errorMessage(error)}`,
        checkedAt,
        durationMs: this.elapsed(started)
      };
    }
  }

  private async xuiServerChecks(): Promise<DiagnosticCheck[]> {
    const servers = await this.prisma.xuiServer.findMany({
      where: { enabled: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, name: true, baseUrl: true }
    });
    if (!servers.length) {
      return [{
        key: 'xui-empty',
        label: '面板连接',
        status: 'skipped',
        message: '没有启用中的 3-x-ui 面板连接',
        meta: [{ label: '启用面板', value: '0 个' }],
        checkedAt: new Date(),
        durationMs: 0
      }];
    }

    return Promise.all(servers.map(async (server) => {
      const checkedAt = new Date();
      const started = performance.now();
      try {
        const status = await this.xui.storedServerStatus(server.id);
        const durationMs = this.elapsed(started);
        return {
          key: `xui-${server.id}`,
          label: server.name,
          status: 'ok' as const,
          message: `面板连接正常：${server.baseUrl}`,
          meta: [
            { label: '连接地址', value: server.baseUrl },
            { label: '响应耗时', value: this.millisecondsLabel(durationMs) }
          ],
          detail: { serverId: server.id, baseUrl: server.baseUrl, status: status.status, versions: status.versions },
          checkedAt,
          durationMs
        };
      } catch (error) {
        return {
          key: `xui-${server.id}`,
          label: server.name,
          status: 'error' as const,
          message: `面板连接失败：${this.errorMessage(error)}`,
          meta: [
            { label: '连接地址', value: server.baseUrl },
            { label: '响应耗时', value: this.millisecondsLabel(this.elapsed(started)) }
          ],
          detail: { serverId: server.id, baseUrl: server.baseUrl },
          checkedAt,
          durationMs: this.elapsed(started)
        };
      }
    }));
  }

  private async recentFailures() {
    return this.prisma.syncLog.findMany({
      where: { status: { in: ['failed', 'partial'] } },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { server: { select: { id: true, name: true, baseUrl: true } } }
    });
  }

  private async resourceCounts() {
    const [
      customers,
      activeCustomers,
      serviceNodes,
      enabledServiceNodes,
      xuiServers,
      enabledXuiServers,
      socksNodes,
      enabledSocksNodes,
      paymentChannels,
      enabledPaymentChannels,
      pendingOrders
    ] = await Promise.all([
      this.prisma.customer.count(),
      this.prisma.customer.count({ where: { status: 'active' } }),
      this.prisma.serviceNode.count(),
      this.prisma.serviceNode.count({ where: { enabled: true } }),
      this.prisma.xuiServer.count(),
      this.prisma.xuiServer.count({ where: { enabled: true } }),
      this.prisma.socksNode.count(),
      this.prisma.socksNode.count({ where: { enabled: true } }),
      this.prisma.paymentChannel.count(),
      this.prisma.paymentChannel.count({ where: { enabled: true } }),
      this.prisma.rechargeOrder.count({ where: { status: 'pending' } })
    ]);

    return {
      customers,
      activeCustomers,
      serviceNodes,
      enabledServiceNodes,
      xuiServers,
      enabledXuiServers,
      socksNodes,
      enabledSocksNodes,
      paymentChannels,
      enabledPaymentChannels,
      pendingOrders
    };
  }

  private async systemResources() {
    const [cpu, disk] = await Promise.all([this.cpuUsage(), this.diskUsage()]);
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const processUptime = Math.floor(process.uptime());

    return {
      cpu: {
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'Unknown CPU',
        usagePercent: cpu,
        loadAverage: os.loadavg()[0] || 0
      },
      memory: {
        totalBytes: totalMemory,
        freeBytes: freeMemory,
        usedBytes: usedMemory,
        usagePercent: this.percent(usedMemory, totalMemory)
      },
      disk,
      uptime: {
        processSeconds: processUptime,
        systemSeconds: Math.floor(os.uptime()),
        startedAt: new Date(Date.now() - processUptime * 1000)
      },
      runtime: {
        nodeVersion: process.version,
        platform: `${process.platform}/${process.arch}`
      }
    };
  }

  private async cpuUsage() {
    const before = this.cpuTimes();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const after = this.cpuTimes();
    const total = after.total - before.total;
    const idle = after.idle - before.idle;
    return total > 0 ? Math.round((1 - idle / total) * 1000) / 10 : 0;
  }

  private cpuTimes() {
    return os.cpus().reduce((result, cpu) => {
      const total = Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
      return { idle: result.idle + cpu.times.idle, total: result.total + total };
    }, { idle: 0, total: 0 });
  }

  private async diskUsage() {
    const diskPath = path.parse(process.cwd()).root || process.cwd();
    try {
      const stats = await statfs(diskPath);
      const totalBytes = stats.blocks * stats.bsize;
      const freeBytes = stats.bavail * stats.bsize;
      const usedBytes = Math.max(0, totalBytes - freeBytes);
      return {
        available: true,
        path: diskPath,
        totalBytes,
        freeBytes,
        usedBytes,
        usagePercent: this.percent(usedBytes, totalBytes)
      };
    } catch (error) {
      return {
        available: false,
        path: diskPath,
        totalBytes: 0,
        freeBytes: 0,
        usedBytes: 0,
        usagePercent: 0,
        message: this.errorMessage(error)
      };
    }
  }

  private summary(checks: DiagnosticCheck[]) {
    const errors = checks.filter((item) => item.status === 'error').length;
    const warnings = checks.filter((item) => item.status === 'warning').length;
    const skipped = checks.filter((item) => item.status === 'skipped').length;
    const ok = checks.filter((item) => item.status === 'ok').length;
    const scoreTotal = checks.reduce((total, item) => {
      if (item.status === 'ok' || item.status === 'skipped') return total + 1;
      if (item.status === 'warning') return total + 0.7;
      return total;
    }, 0);
    return {
      status: errors ? 'error' : warnings ? 'warning' : 'ok',
      score: checks.length ? Math.round((scoreTotal / checks.length) * 100) : 100,
      total: checks.length,
      passed: ok + skipped,
      ok,
      warnings,
      errors,
      skipped
    };
  }

  private elapsed(started: number) {
    return Math.max(0, Math.round(performance.now() - started));
  }

  private millisecondsLabel(value: number) {
    return value < 1000 ? `${value} ms` : `${(value / 1000).toFixed(2)} s`;
  }

  private durationLabel(seconds: number) {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    if (days) return `${days} 天 ${hours} 小时`;
    if (hours) return `${hours} 小时 ${minutes} 分钟`;
    return `${minutes} 分钟`;
  }

  private percent(value: number, total: number) {
    return total > 0 ? Math.round((value / total) * 1000) / 10 : 0;
  }

  private errorMessage(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) return `${error.code} ${error.message}`;
    return error instanceof Error ? error.message : String(error);
  }
}
