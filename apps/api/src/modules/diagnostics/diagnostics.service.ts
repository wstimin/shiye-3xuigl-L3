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
  checkedAt: Date;
};

@Injectable()
export class DiagnosticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly xui: XuiService
  ) {}

  async overview() {
    const checkedAt = new Date();
    const [database, jobs, xuiServers, recentFailures, counts] = await Promise.all([
      this.databaseCheck(),
      this.jobsCheck(),
      this.xuiServerChecks(),
      this.recentFailures(),
      this.resourceCounts()
    ]);
    const checks = [database, jobs, ...xuiServers];

    return {
      checkedAt,
      summary: this.summary(checks),
      counts,
      checks,
      recentFailures
    };
  }

  private async databaseCheck(): Promise<DiagnosticCheck> {
    const checkedAt = new Date();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return { key: 'database', label: '数据库连接', status: 'ok', message: '数据库连接正常', checkedAt };
    } catch (error) {
      return { key: 'database', label: '数据库连接', status: 'error', message: `数据库连接失败：${this.errorMessage(error)}`, checkedAt };
    }
  }

  private async jobsCheck(): Promise<DiagnosticCheck> {
    const checkedAt = new Date();
    try {
      const [settings, status] = await Promise.all([this.jobs.jobSettings(), this.jobs.jobStatus()]);
      const disabled: string[] = [];
      if (!settings.disableExpiredEnabled) disabled.push('自动停用过期节点');
      if (!settings.trafficSyncEnabled) disabled.push('远端流量同步');
      return {
        key: 'jobs',
        label: '后台自动任务',
        status: disabled.length ? 'warning' : 'ok',
        message: disabled.length ? `${disabled.join('、')}未启用` : '自动任务已启用',
        detail: { settings, status },
        checkedAt
      };
    } catch (error) {
      return { key: 'jobs', label: '后台自动任务', status: 'error', message: `读取任务状态失败：${this.errorMessage(error)}`, checkedAt };
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
        label: '3-x-ui 面板连接',
        status: 'skipped',
        message: '没有启用中的面板连接',
        checkedAt: new Date()
      }];
    }

    return Promise.all(servers.map(async (server) => {
      const checkedAt = new Date();
      try {
        const status = await this.xui.storedServerStatus(server.id);
        return {
          key: `xui-${server.id}`,
          label: server.name,
          status: 'ok' as const,
          message: `面板连接正常：${server.baseUrl}`,
          detail: { serverId: server.id, baseUrl: server.baseUrl, status: status.status, versions: status.versions },
          checkedAt
        };
      } catch (error) {
        return {
          key: `xui-${server.id}`,
          label: server.name,
          status: 'error' as const,
          message: `面板连接失败：${this.errorMessage(error)}`,
          detail: { serverId: server.id, baseUrl: server.baseUrl },
          checkedAt
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
    const [customers, activeCustomers, serviceNodes, enabledServiceNodes, xuiServers, enabledXuiServers, socksNodes, enabledSocksNodes, pendingOrders] = await Promise.all([
      this.prisma.customer.count(),
      this.prisma.customer.count({ where: { status: 'active' } }),
      this.prisma.serviceNode.count(),
      this.prisma.serviceNode.count({ where: { enabled: true } }),
      this.prisma.xuiServer.count(),
      this.prisma.xuiServer.count({ where: { enabled: true } }),
      this.prisma.socksNode.count(),
      this.prisma.socksNode.count({ where: { enabled: true } }),
      this.prisma.rechargeOrder.count({ where: { status: 'pending' } })
    ]);

    return { customers, activeCustomers, serviceNodes, enabledServiceNodes, xuiServers, enabledXuiServers, socksNodes, enabledSocksNodes, pendingOrders };
  }

  private summary(checks: DiagnosticCheck[]) {
    const errors = checks.filter((item) => item.status === 'error').length;
    const warnings = checks.filter((item) => item.status === 'warning').length;
    const skipped = checks.filter((item) => item.status === 'skipped').length;
    return {
      status: errors ? 'error' : warnings ? 'warning' : 'ok',
      total: checks.length,
      ok: checks.filter((item) => item.status === 'ok').length,
      warnings,
      errors,
      skipped
    };
  }

  private errorMessage(error: unknown) {
    if (error instanceof Prisma.PrismaClientKnownRequestError) return `${error.code} ${error.message}`;
    return error instanceof Error ? error.message : String(error);
  }
}
