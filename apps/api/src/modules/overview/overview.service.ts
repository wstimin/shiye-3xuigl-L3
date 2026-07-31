import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';

type OverviewActivity = {
  key: string;
  type: 'payment' | 'renewal' | 'card' | 'sync';
  status: string;
  title: string;
  description: string;
  createdAt: Date;
};

@Injectable()
export class OverviewService {
  constructor(private readonly prisma: PrismaService) {}

  async adminOverview() {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const [
      totalCustomers,
      activeCustomers,
      totalServiceNodes,
      enabledServiceNodes,
      totalServers,
      enabledServers,
      totalCustomerNodes,
      activeCustomerNodes,
      disabledCustomerNodes,
      expiredActiveCustomerNodes,
      totalSocksNodes,
      enabledSocksNodes,
      totalCards,
      unusedCards,
      usedCards,
      disabledCards,
      totalPaymentChannels,
      enabledPaymentChannels,
      pendingOrders,
      todayPaidOrders,
      todayRenewals
    ] = await this.prisma.$transaction([
      this.prisma.customer.count(),
      this.prisma.customer.count({ where: { status: 'active' } }),
      this.prisma.serviceNode.count(),
      this.prisma.serviceNode.count({ where: { enabled: true } }),
      this.prisma.xuiServer.count(),
      this.prisma.xuiServer.count({ where: { enabled: true } }),
      this.prisma.customerNode.count(),
      this.prisma.customerNode.count({ where: { status: 'active' } }),
      this.prisma.customerNode.count({ where: { status: 'disabled' } }),
      this.prisma.customerNode.count({ where: { status: 'active', expireAt: { lte: now } } }),
      this.prisma.socksNode.count(),
      this.prisma.socksNode.count({ where: { enabled: true } }),
      this.prisma.card.count(),
      this.prisma.card.count({ where: { status: 'unused' } }),
      this.prisma.card.count({ where: { status: 'used' } }),
      this.prisma.card.count({ where: { status: 'disabled' } }),
      this.prisma.paymentChannel.count(),
      this.prisma.paymentChannel.count({ where: { enabled: true } }),
      this.prisma.rechargeOrder.count({ where: { status: 'pending' } }),
      this.prisma.rechargeOrder.aggregate({
        where: { status: 'paid', paidAt: { gte: todayStart } },
        _count: { _all: true },
        _sum: { amount: true }
      }),
      this.prisma.renewalLog.aggregate({
        where: { status: 'success', createdAt: { gte: todayStart } },
        _count: { _all: true },
        _sum: { amount: true }
      })
    ]);

    const [recentPayments, recentRenewals, recentCardRedemptions, recentSyncLogs] = await Promise.all([
      this.prisma.rechargeOrder.findMany({
        where: { status: 'paid' },
        orderBy: { paidAt: 'desc' },
        take: 4,
        select: {
          id: true,
          amount: true,
          paidAt: true,
          createdAt: true,
          customer: { select: { name: true, loginUsername: true } }
        }
      }),
      this.prisma.renewalLog.findMany({
        where: { status: 'success' },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: {
          id: true,
          months: true,
          amount: true,
          status: true,
          createdAt: true,
          customer: { select: { name: true, loginUsername: true } },
          customerNode: { select: { serviceNode: { select: { name: true } } } }
        }
      }),
      this.prisma.balanceLog.findMany({
        where: { type: 'card_redeem' },
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: {
          id: true,
          amount: true,
          createdAt: true,
          customer: { select: { name: true, loginUsername: true } }
        }
      }),
      this.prisma.syncLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 4,
        select: {
          id: true,
          action: true,
          status: true,
          message: true,
          createdAt: true,
          server: { select: { name: true } }
        }
      })
    ]);

    const activity: OverviewActivity[] = [
      ...recentPayments.map((item) => ({
        key: `payment-${item.id}`,
        type: 'payment' as const,
        status: 'success',
        title: '在线充值到账',
        description: `${this.customerLabel(item.customer)} 完成充值 ${this.money(item.amount)}`,
        createdAt: item.paidAt || item.createdAt
      })),
      ...recentRenewals.map((item) => ({
        key: `renewal-${item.id}`,
        type: 'renewal' as const,
        status: item.status,
        title: '用户节点续费',
        description: `${this.customerLabel(item.customer)} 为 ${item.customerNode?.serviceNode.name || '用户节点'} 续费 ${item.months} 个月，金额 ${this.money(item.amount)}`,
        createdAt: item.createdAt
      })),
      ...recentCardRedemptions.map((item) => ({
        key: `card-${item.id}`,
        type: 'card' as const,
        status: 'success',
        title: '卡密兑换成功',
        description: `${this.customerLabel(item.customer)} 兑换卡密 ${this.money(item.amount)}`,
        createdAt: item.createdAt
      })),
      ...recentSyncLogs.map((item) => ({
        key: `sync-${item.id}`,
        type: 'sync' as const,
        status: item.status,
        title: this.syncActionLabel(item.action),
        description: `${item.server?.name || '系统任务'}：${item.message || '同步任务已执行'}`,
        createdAt: item.createdAt
      }))
    ]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .slice(0, 6);

    return {
      customers: { total: totalCustomers, active: activeCustomers },
      customerNodes: {
        total: totalCustomerNodes,
        active: activeCustomerNodes,
        disabled: disabledCustomerNodes,
        expiredActive: expiredActiveCustomerNodes
      },
      serviceNodes: {
        total: totalServiceNodes,
        enabled: enabledServiceNodes,
        expiredActive: expiredActiveCustomerNodes
      },
      servers: { total: totalServers, enabled: enabledServers },
      socksNodes: { total: totalSocksNodes, enabled: enabledSocksNodes },
      cards: { total: totalCards, unused: unusedCards, used: usedCards, disabled: disabledCards },
      payments: {
        channels: totalPaymentChannels,
        enabledChannels: enabledPaymentChannels,
        pendingOrders,
        todayPaidCount: todayPaidOrders._count._all,
        todayPaidAmount: todayPaidOrders._sum.amount || 0
      },
      renewals: {
        todayCount: todayRenewals._count._all,
        todayAmount: todayRenewals._sum.amount || 0
      },
      activity
    };
  }

  private customerLabel(customer: { name: string; loginUsername: string }) {
    return customer.name || customer.loginUsername;
  }

  private money(value: Prisma.Decimal | number | string) {
    return `¥${Number(value || 0).toFixed(2)}`;
  }

  private syncActionLabel(action: string) {
    const labels: Record<string, string> = {
      'disable-expired-nodes': '过期节点检测',
      'disable-traffic-exceeded-nodes': '远端流量同步',
      'service-node-delete': '路由节点删除同步',
      'customer-node-delete': '用户节点删除同步',
      'customer-node-sync': '用户节点同步',
      'service-node-sync': '路由节点同步',
      'socks-sync': 'SOCKS 出站同步'
    };
    return labels[action] || '面板同步记录';
  }
}
