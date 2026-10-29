<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { ArrowRight, ArrowUpRight, CalendarClock, CircleCheck, Network, RefreshCw, WalletCards } from 'lucide-vue-next';
import AccountLedger, { type BalanceEntry } from '../components/AccountLedger.vue';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { formatTraffic } from '../traffic';

type DashboardNode = { expireAt?: string | null };
type UserDashboard = {
  customer: { name: string; balance: string; status: string };
  nodes: DashboardNode[];
  balanceLogs: BalanceEntry[];
};
type UserNode = {
  id: string;
  status: string;
  remoteControl: 'reference' | 'subscription_managed' | 'fully_managed';
  expireAt?: string | null;
  trafficLimitGb: string;
  usedTrafficGb: string;
  usedTrafficBytes?: number;
  trafficStatus?: 'live' | 'cached' | 'error';
  trafficError?: string | null;
  officialTrafficTotalBytes?: number | null;
  officialTrafficRemainingBytes?: number | null;
  officialTrafficUnlimited?: boolean | null;
  links?: string[];
  serviceNode: { name: string; protocol: string; priceMonthly: string; server: { name: string } };
};

const loading = ref(false);
const error = ref('');
const dashboard = ref<UserDashboard | null>(null);
const nodes = ref<UserNode[]>([]);

const activeNodes = computed(() => nodes.value.filter((node) => isNodeAvailable(node)));
const nearestExpireValue = computed(() => {
  const expires = nodes.value
    .map((node) => node.expireAt)
    .filter((value): value is string => Boolean(value) && new Date(value as string).getTime() > Date.now())
    .sort((left, right) => new Date(left).getTime() - new Date(right).getTime());
  return expires[0] || null;
});
const hasUnlimitedTraffic = computed(() => nodes.value.some((node) => node.trafficStatus === 'live' && node.officialTrafficUnlimited === true));
const unavailableTrafficCount = computed(() => nodes.value.filter((node) => node.trafficStatus !== 'live').length);
const unknownQuotaCount = computed(() => nodes.value.filter((node) => node.trafficStatus === 'live' && node.officialTrafficUnlimited !== true && !hasFiniteTrafficQuota(node)).length);
const finiteTrafficNodes = computed(() => nodes.value.filter((node) => node.trafficStatus === 'live' && node.officialTrafficUnlimited !== true && hasFiniteTrafficQuota(node)));
const remainingTrafficBytes = computed(() => finiteTrafficNodes.value.reduce((total, node) => total + Number(node.officialTrafficRemainingBytes), 0));
const totalTrafficBytes = computed(() => finiteTrafficNodes.value.reduce((total, node) => total + Number(node.officialTrafficTotalBytes), 0));
const trafficPercent = computed(() => totalTrafficBytes.value > 0 ? Math.min((remainingTrafficBytes.value / totalTrafficBytes.value) * 100, 100) : 0);
const previewNodes = computed(() => nodes.value.slice(0, 3));
const trafficHeadline = computed(() => {
  if (unavailableTrafficCount.value) return '暂不可用';
  if (unknownQuotaCount.value) return '额度未返回';
  if (hasUnlimitedTraffic.value) return '无限流量 / 无限流量';
  return `${formatTraffic(totalTrafficBytes.value)} / ${formatTraffic(remainingTrafficBytes.value)}`;
});
const trafficSummary = computed(() => {
  if (unavailableTrafficCount.value) return `${unavailableTrafficCount.value} 个节点流量暂不可用`;
  if (unknownQuotaCount.value) return `${unknownQuotaCount.value} 个节点未返回流量额度`;
  if (hasUnlimitedTraffic.value) return '总流量无限，剩余流量无限';
  return `总流量 ${formatTraffic(totalTrafficBytes.value)}，剩余流量 ${formatTraffic(remainingTrafficBytes.value)}`;
});

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    const [dashboardResult, nodeResult] = await Promise.all([
      api<UserDashboard>('/api/user/me'),
      api<UserNode[]>('/api/user/nodes')
    ]);
    dashboard.value = dashboardResult;
    nodes.value = nodeResult;
  } catch (caught) {
    error.value = readableError(caught, '加载失败');
  } finally {
    loading.value = false;
  }
}

function numericValue(value: string) {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : 0;
}

function hasBytes(value?: number | null) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0;
}

function hasFiniteTrafficQuota(node: UserNode) {
  return hasBytes(node.officialTrafficTotalBytes) && hasBytes(node.officialTrafficRemainingBytes);
}

function isNodeAvailable(node: UserNode) {
  if (node.status !== 'active') return false;
  if (node.expireAt && new Date(node.expireAt).getTime() <= Date.now()) return false;
  const limit = numericValue(node.trafficLimitGb);
  return limit <= 0 || numericValue(node.usedTrafficGb) < limit;
}

function formatDate(value?: string | null, compact = false) {
  if (!value) return '--';
  return new Date(value).toLocaleString('zh-CN', compact
    ? { year: 'numeric', month: '2-digit', day: '2-digit', hour12: false }
    : { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

function nodeTrafficText(node: UserNode) {
  if (node.trafficStatus !== 'live') return '获取失败';
  if (node.officialTrafficUnlimited === true) return '总流量 无限，剩余流量 无限';
  if (!hasFiniteTrafficQuota(node)) return '额度未返回';
  return `总流量 ${formatTraffic(Number(node.officialTrafficTotalBytes))}，剩余流量 ${formatTraffic(Number(node.officialTrafficRemainingBytes))}`;
}

onMounted(loadDashboard);
</script>

<template>
  <div class="user-page overview-page" :aria-busy="loading">
    <header class="page-heading"><div><span class="eyebrow">PERSONAL WORKSPACE</span><h1>服务总览<span class="heading-dot">.</span></h1><p>{{ dashboard?.customer.name || '你好' }}，欢迎回来。你的连接服务和账户动态都在这里。</p></div><button class="button secondary" :disabled="loading" @click="loadDashboard"><RefreshCw :size="15" :class="{ spinning: loading }" />{{ loading ? '正在更新' : '刷新数据' }}</button></header>
    <div v-if="error" class="user-feedback error" role="alert">{{ error }}</div>
    <div class="overview-layout">
      <div class="overview-primary">
        <section class="service-summary" aria-label="服务摘要">
          <div class="summary-intro"><span class="summary-symbol"><Network :size="22" /></span><div><span class="quiet-text">当前服务</span><strong>{{ activeNodes.length }}<small> / {{ nodes.length }} 个可用</small></strong></div></div>
          <div><span class="quiet-text">流量额度 / 剩余</span><strong class="summary-traffic" :title="trafficSummary">{{ trafficHeadline }}</strong><span class="progress-track"><i :style="{ width: `${trafficPercent}%` }"></i></span></div>
          <div><span class="quiet-text">最近到期</span><strong>{{ nearestExpireValue ? formatDate(nearestExpireValue, true) : '未设置' }}</strong><small class="quiet-text">以各项服务有效期为准</small></div>
        </section>
        <section class="surface services-panel">
          <header class="section-heading"><div><span class="section-number">YOUR CONNECTIONS</span><h2>正在使用的服务 <span class="count-badge">{{ nodes.length }}</span></h2></div><RouterLink class="text-link" to="/nodes">管理全部 <ArrowUpRight :size="15" /></RouterLink></header>
          <div class="service-table-head" aria-hidden="true"><span>服务名称</span><span>流量信息</span><span>有效期 / 状态</span><span></span></div>
          <article v-for="node in previewNodes" :key="node.id" class="service-row">
            <div class="service-identity"><span class="protocol-symbol">{{ node.serviceNode.protocol.slice(0, 1).toUpperCase() }}</span><div><strong>{{ node.serviceNode.name }}</strong><small>{{ node.serviceNode.server.name }} · {{ node.serviceNode.protocol.toUpperCase() }}</small></div></div>
            <div class="service-usage"><strong>{{ node.trafficStatus === 'live' ? node.officialTrafficUnlimited ? '无限流量' : hasFiniteTrafficQuota(node) ? formatTraffic(Number(node.officialTrafficRemainingBytes)) + ' 剩余' : '额度未返回' : '用量暂不可用' }}</strong><small :title="node.trafficError || ''">{{ nodeTrafficText(node) }}</small></div>
            <div class="service-validity"><strong>{{ node.expireAt ? formatDate(node.expireAt, true) : '长期有效' }}</strong><span class="status-pill" :class="isNodeAvailable(node) ? 'success' : 'danger'"><i></i>{{ isNodeAvailable(node) ? '正常可用' : '当前不可用' }}</span></div>
            <RouterLink class="round-link" :to="{ path: '/nodes', query: { node: node.id } }" :aria-label="'管理 ' + node.serviceNode.name"><ArrowUpRight :size="18" /></RouterLink>
          </article>
          <div v-if="!nodes.length" class="empty-state"><Network :size="26" /><strong>{{ loading ? '正在读取服务' : '还没有开通服务' }}</strong><p>管理员为你绑定服务后，可在这里查看连接和用量。</p></div>
          <footer class="panel-footnote"><CircleCheck :size="14" />服务状态与用量来自已接入面板。<RouterLink to="/nodes">查看连接信息 <ArrowRight :size="14" /></RouterLink></footer>
        </section>
        <AccountLedger :entries="dashboard?.balanceLogs || []" :limit="4" :loading="loading" />
      </div>
      <aside class="overview-rail">
        <section class="balance-panel" aria-label="账户余额"><div class="balance-panel-top"><span class="section-number">YOUR BALANCE</span><WalletCards :size="20" /></div><span class="balance-label">账户可用余额</span><div class="balance-figure"><span>¥</span>{{ dashboard ? Number(dashboard.customer.balance).toFixed(2) : '—' }}</div><p>可用于已绑定服务的余额续费。</p><RouterLink class="button primary wide" to="/finance">充值余额 <ArrowRight :size="16" /></RouterLink><RouterLink class="balance-secondary" :to="{ path: '/finance', query: { tab: 'redeem' } }">已有卡密？直接兑换 <ArrowUpRight :size="14" /></RouterLink></section>
        <section class="rail-section"><span class="section-number">SERVICE NOTES</span><h3>服务提醒</h3><div class="notice-item"><CalendarClock :size="18" /><div><strong>{{ nearestExpireValue ? '留意服务有效期' : '有效期信息' }}</strong><p>{{ nearestExpireValue ? '最近一项服务将于 ' + formatDate(nearestExpireValue, true) + ' 到期，可前往连接服务续费。' : '当前服务未设置到期时间，具体使用状态以服务列表为准。' }}</p></div></div><div class="rail-note">续费延长有效期，已用流量与额度保持不变。</div><RouterLink class="text-link" to="/profile">查看账户资料 <ArrowUpRight :size="15" /></RouterLink></section>
      </aside>
    </div>
  </div>
</template>
