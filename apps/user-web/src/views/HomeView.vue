<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink } from 'vue-router';
import { Activity, CalendarDays, Network, RefreshCw, Settings, TicketCheck, WalletCards } from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { formatTraffic } from '../traffic';

type DashboardNode = { expireAt?: string | null };
type UserDashboard = {
  customer: { name: string; balance: string; status: string };
  nodes: DashboardNode[];
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

function formatNumber(value: number) {
  return value.toLocaleString('zh-CN', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
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
  <div class="user-page" :class="{ loading }">
    <section class="user-welcome-card">
      <div>
        <span class="user-page-kicker">ACCOUNT OVERVIEW</span>
        <h2>你好，{{ dashboard?.customer.name || '用户' }}</h2>
        <p>在这里查看账户余额、节点状态、流量和服务有效期。</p>
      </div>
      <div class="welcome-meta">
        <div><span>账号状态</span><strong class="status-live"><i></i>{{ dashboard?.customer.status === 'active' ? '正常' : '已停用' }}</strong></div>
        <div><span>最近到期</span><strong>{{ formatDate(nearestExpireValue, true) }}</strong></div>
      </div>
    </section>

    <div v-if="error" class="user-feedback error">{{ error }}</div>

    <section v-else class="user-stat-grid">
      <article class="user-stat-card purple">
        <div class="user-stat-head"><span>账户余额</span><i><WalletCards :size="17" /></i></div>
        <strong>{{ dashboard?.customer.balance ?? '--' }}<small> 元</small></strong>
        <p>可用于节点余额续费</p>
      </article>
      <article class="user-stat-card green">
        <div class="user-stat-head"><span>正常节点</span><i><Network :size="17" /></i></div>
        <strong>{{ activeNodes.length }}<small> / {{ nodes.length }}</small></strong>
        <p>当前可连接的服务节点</p>
      </article>
      <article class="user-stat-card blue">
        <div class="user-stat-head"><span>总流量 / 剩余流量</span><i><Activity :size="17" /></i></div>
        <strong>{{ trafficHeadline }}</strong>
        <p>{{ trafficSummary }}</p>
        <span class="user-stat-progress"><i :style="{ width: `${trafficPercent}%` }"></i></span>
      </article>
      <article class="user-stat-card orange">
        <div class="user-stat-head"><span>最近到期</span><i><CalendarDays :size="17" /></i></div>
        <strong class="date-value">{{ formatDate(nearestExpireValue, true) }}</strong>
        <p>{{ nearestExpireValue ? '请在到期前完成续费' : '当前节点未设置到期时间' }}</p>
      </article>
    </section>

    <div class="user-dashboard-grid">
      <section class="user-section-card">
        <header class="user-section-head">
          <div><span>我的服务</span><small>真实节点状态与用量</small></div>
          <RouterLink to="/nodes">查看全部</RouterLink>
        </header>
        <div class="user-section-body service-preview-list">
          <article v-for="node in previewNodes" :key="node.id" class="service-preview-card">
            <div class="service-preview-head">
              <div><strong>{{ node.serviceNode.name }}</strong><span>{{ node.serviceNode.server.name }} / {{ node.serviceNode.protocol }}</span></div>
              <span class="status-pill" :class="isNodeAvailable(node) ? 'success' : 'danger'">{{ isNodeAvailable(node) ? '正常可用' : '不可用' }}</span>
            </div>
            <div class="user-feedback warning">续费仅延长本系统访问授权，不修改路由节点共享的官方客户端。</div>
            <div class="service-preview-stats">
              <div><span>总流量 / 剩余流量</span><strong :title="node.trafficError || ''">{{ nodeTrafficText(node) }}</strong></div>
              <div><span>到期</span><strong>{{ formatDate(node.expireAt, true) }}</strong></div>
              <div><span>线路</span><strong>{{ node.links?.length || 0 }} 条</strong></div>
            </div>
          </article>
          <div v-if="!loading && !previewNodes.length" class="user-empty-state">当前账号暂未绑定节点</div>
        </div>
      </section>

      <section class="user-section-card">
        <header class="user-section-head">
          <div><span>快捷操作</span><small>仅保留当前可用功能</small></div>
          <button class="section-refresh" type="button" title="刷新概览" :disabled="loading" @click="loadDashboard"><RefreshCw :size="15" /></button>
        </header>
        <div class="user-section-body user-quick-grid">
          <RouterLink to="/nodes"><i><Network :size="19" /></i><strong>节点与链接</strong><span>复制连接或显示二维码</span></RouterLink>
          <RouterLink to="/finance"><i><WalletCards :size="19" /></i><strong>余额充值</strong><span>使用已启用的支付通道</span></RouterLink>
          <RouterLink to="/finance"><i><TicketCheck :size="19" /></i><strong>卡密兑换</strong><span>兑换后余额即时增加</span></RouterLink>
          <RouterLink to="/profile"><i><Settings :size="19" /></i><strong>安全设置</strong><span>查看账号和修改密码</span></RouterLink>
        </div>
      </section>
    </div>
  </div>
</template>
