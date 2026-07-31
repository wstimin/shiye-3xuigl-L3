<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  Activity,
  Banknote,
  CircleDollarSign,
  Clock3,
  Link2,
  RefreshCw,
  Router,
  ShieldOff,
  TicketCheck,
  Users
} from 'lucide-vue-next';
import { api } from '../api';

type BusinessActivity = {
  key: string;
  type: 'payment' | 'renewal' | 'card' | 'sync';
  status: string;
  title: string;
  description: string;
  createdAt: string;
};
type Overview = {
  customers: { total: number; active: number };
  customerNodes: { total: number; active: number; disabled: number; expiredActive: number };
  serviceNodes: { total: number; enabled: number; expiredActive: number };
  servers: { total: number; enabled: number };
  socksNodes: { total: number; enabled: number };
  cards: { total: number; unused: number; used: number; disabled: number };
  payments: {
    channels: number;
    enabledChannels: number;
    pendingOrders: number;
    todayPaidCount: number;
    todayPaidAmount: string | number;
  };
  renewals: { todayCount: number; todayAmount: string | number };
  activity: BusinessActivity[];
};
type JobSettings = { disableExpiredEnabled: boolean; trafficSyncEnabled: boolean };
type DisableExpiredResult = { checkedAt: string; total: number; success: number; failed: number };
type TrafficSyncResult = { checkedAt: string; checked: number; disabled: number; failed: number };
type JobStatus = { lastDisableExpired: DisableExpiredResult | null; lastTrafficSync: TrafficSyncResult | null };

const loading = ref(false);
const jobRunning = ref(false);
const trafficJobRunning = ref(false);
const jobSettingsSaving = ref(false);
const error = ref('');
const overview = ref<Overview | null>(null);
const jobSettings = ref<JobSettings>({ disableExpiredEnabled: true, trafficSyncEnabled: true });
const lastDisableExpired = ref<DisableExpiredResult | null>(null);
const lastTrafficSync = ref<TrafficSyncResult | null>(null);

const customerTotal = computed(() => overview.value?.customers.total ?? 0);
const activeCustomers = computed(() => overview.value?.customers.active ?? 0);
const customerNodeTotal = computed(() => overview.value?.customerNodes.total ?? 0);
const activeCustomerNodes = computed(() => overview.value?.customerNodes.active ?? 0);
const expiredCustomerNodes = computed(() => overview.value?.customerNodes.expiredActive ?? 0);
const serviceNodeTotal = computed(() => overview.value?.serviceNodes.total ?? 0);
const enabledServiceNodes = computed(() => overview.value?.serviceNodes.enabled ?? 0);
const serverTotal = computed(() => overview.value?.servers.total ?? 0);
const enabledServers = computed(() => overview.value?.servers.enabled ?? 0);
const socksTotal = computed(() => overview.value?.socksNodes.total ?? 0);
const enabledSocks = computed(() => overview.value?.socksNodes.enabled ?? 0);
const cardTotal = computed(() => overview.value?.cards.total ?? 0);
const unusedCards = computed(() => overview.value?.cards.unused ?? 0);
const usedCards = computed(() => overview.value?.cards.used ?? 0);
const disabledCards = computed(() => overview.value?.cards.disabled ?? 0);
const paymentChannels = computed(() => overview.value?.payments.channels ?? 0);
const enabledPaymentChannels = computed(() => overview.value?.payments.enabledChannels ?? 0);
const pendingOrders = computed(() => overview.value?.payments.pendingOrders ?? 0);
const todayPaidCount = computed(() => overview.value?.payments.todayPaidCount ?? 0);
const todayRenewalCount = computed(() => overview.value?.renewals.todayCount ?? 0);
const todayIncome = computed(() => numberValue(overview.value?.payments.todayPaidAmount) + numberValue(overview.value?.renewals.todayAmount));
const customerRate = computed(() => percent(activeCustomers.value, customerTotal.value));
const customerNodeRate = computed(() => percent(activeCustomerNodes.value, customerNodeTotal.value));
const networkTotal = computed(() => serviceNodeTotal.value + serverTotal.value);
const networkRate = computed(() => percent(enabledServiceNodes.value + enabledServers.value, networkTotal.value));
const incomeRate = computed(() => (todayIncome.value > 0 ? 100 : 0));
const recentActivity = computed(() => overview.value?.activity ?? []);

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    const [overviewResult, settingsResult, statusResult] = await Promise.all([
      api<Overview>('/api/admin/overview'),
      api<JobSettings>('/api/admin/jobs/settings'),
      api<JobStatus>('/api/admin/jobs/status')
    ]);
    overview.value = overviewResult;
    jobSettings.value = settingsResult;
    lastDisableExpired.value = statusResult.lastDisableExpired;
    lastTrafficSync.value = statusResult.lastTrafficSync;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载数据概览失败';
  } finally {
    loading.value = false;
  }
}

async function saveJobSettings(patch: Partial<JobSettings>) {
  const previous = { ...jobSettings.value };
  jobSettings.value = { ...jobSettings.value, ...patch };
  jobSettingsSaving.value = true;
  error.value = '';
  try {
    jobSettings.value = await api<JobSettings>('/api/admin/jobs/settings', { method: 'PATCH', body: patch });
    ElMessage.success('任务设置已保存');
    return true;
  } catch (err) {
    jobSettings.value = previous;
    error.value = err instanceof Error ? err.message : '保存任务设置失败';
    return false;
  } finally {
    jobSettingsSaving.value = false;
  }
}

async function toggleDisableExpired(value: string | number | boolean) {
  const enabled = Boolean(value);
  const saved = await saveJobSettings({ disableExpiredEnabled: enabled });
  if (!saved || !enabled) return;
  try {
    await runDisableExpiredNodes();
  } catch {
    // The request error is already displayed on the page.
  }
}

async function toggleTrafficSync(value: string | number | boolean) {
  const enabled = Boolean(value);
  const saved = await saveJobSettings({ trafficSyncEnabled: enabled });
  if (!saved || !enabled) return;
  try {
    await runTrafficSync();
  } catch {
    // The request error is already displayed on the page.
  }
}

async function runDisableExpiredNodes() {
  jobRunning.value = true;
  error.value = '';
  try {
    const result = await api<DisableExpiredResult>('/api/admin/jobs/disable-expired', { method: 'POST' });
    lastDisableExpired.value = result;
    await loadDashboard();
    return result;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '停用过期节点失败';
    throw err;
  } finally {
    jobRunning.value = false;
  }
}

async function runTrafficSync() {
  trafficJobRunning.value = true;
  error.value = '';
  try {
    const result = await api<TrafficSyncResult>('/api/admin/jobs/sync-traffic', { method: 'POST' });
    lastTrafficSync.value = result;
    await loadDashboard();
    return result;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步远端流量失败';
    throw err;
  } finally {
    trafficJobRunning.value = false;
  }
}

async function disableExpiredNodes() {
  await ElMessageBox.confirm(
    '系统会把已到期且仍处于启用状态的用户节点同步停用到远端 3x-ui，远端同步成功后再更新本地状态。确认执行？',
    '停用过期节点',
    { type: 'warning', customClass: 'operations-dark-message-box' }
  );
  try {
    const result = await runDisableExpiredNodes();
    ElMessage.success(`执行完成：成功 ${result.success}，失败 ${result.failed}，总数 ${result.total}`);
  } catch {
    // The request error is already displayed on the page.
  }
}

async function syncTraffic() {
  try {
    const result = await runTrafficSync();
    ElMessage.success(`流量同步完成：检查 ${result.checked}，停用 ${result.disabled}，失败 ${result.failed}`);
  } catch {
    // The request error is already displayed on the page.
  }
}

function percent(value: number, total: number) {
  if (!total || value <= 0) return 0;
  return Math.min(100, Math.round((value / total) * 100));
}

function numberValue(value?: string | number | null) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatMoney(value?: string | number | null) {
  return `¥${numberValue(value).toFixed(2)}`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '尚未执行';
}

function formatRelativeDate(value: string) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return formatDate(value);
  const elapsed = Date.now() - timestamp;
  if (elapsed >= 0 && elapsed < 60_000) return '刚刚';
  if (elapsed >= 0 && elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed >= 0 && elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return formatDate(value);
}

function activityTone(item: BusinessActivity) {
  if (item.status === 'failed' || item.status === 'error') return 'rose';
  if (item.status === 'partial') return 'amber';
  return { payment: 'green', renewal: 'purple', card: 'orange', sync: 'blue' }[item.type];
}

function activityIcon(type: BusinessActivity['type']) {
  return { payment: CircleDollarSign, renewal: RefreshCw, card: TicketCheck, sync: Activity }[type];
}

onMounted(loadDashboard);
</script>

<template>
  <div class="dashboard-page" :class="{ loading }">
    <section class="dashboard-welcome">
      <div>
        <h1>数据概览</h1>
        <p>集中查看账户、节点、支付、卡密与远端同步的实时运行状态</p>
      </div>
      <div class="dashboard-welcome-meta">
        <div>
          <span>数据状态</span>
          <strong><i :class="{ error: Boolean(error) }"></i>{{ error ? '读取异常' : '读取正常' }}</strong>
        </div>
        <button class="dashboard-refresh" type="button" :disabled="loading" title="刷新数据概览" @click="loadDashboard">
          <RefreshCw :size="15" :class="{ spinning: loading }" />
          <span>{{ loading ? '刷新中' : '刷新数据' }}</span>
        </button>
      </div>
    </section>

    <el-alert v-if="error" class="dashboard-alert" :title="error" type="error" show-icon :closable="false" />

    <section class="dashboard-stat-grid" aria-label="核心业务统计">
      <article class="dashboard-stat-card purple">
        <div class="dashboard-stat-head"><span>用户账户</span><i><Users :size="18" /></i></div>
        <strong>{{ customerTotal }}</strong>
        <p>正常 {{ activeCustomers }} / 停用 {{ customerTotal - activeCustomers }} <em>{{ customerRate }}% 正常</em></p>
        <div class="dashboard-stat-bar"><i :style="{ width: `${customerRate}%` }"></i></div>
      </article>
      <article class="dashboard-stat-card blue">
        <div class="dashboard-stat-head"><span>用户绑定节点</span><i><Link2 :size="18" /></i></div>
        <strong>{{ customerNodeTotal }}</strong>
        <p>启用 {{ activeCustomerNodes }} / 过期待停用 {{ expiredCustomerNodes }}</p>
        <div class="dashboard-stat-bar"><i :style="{ width: `${customerNodeRate}%` }"></i></div>
      </article>
      <article class="dashboard-stat-card green">
        <div class="dashboard-stat-head"><span>网络资源</span><i><Router :size="18" /></i></div>
        <strong>{{ networkTotal }}</strong>
        <p>路由启用 {{ enabledServiceNodes }} / 面板在线 {{ enabledServers }}/{{ serverTotal }}</p>
        <div class="dashboard-stat-bar"><i :style="{ width: `${networkRate}%` }"></i></div>
      </article>
      <article class="dashboard-stat-card orange">
        <div class="dashboard-stat-head"><span>今日收入</span><i><Banknote :size="18" /></i></div>
        <strong class="dashboard-money-value">{{ formatMoney(todayIncome) }}</strong>
        <p>在线充值 {{ todayPaidCount }} 笔 / 节点续费 {{ todayRenewalCount }} 笔</p>
        <div class="dashboard-stat-bar"><i :style="{ width: `${incomeRate}%` }"></i></div>
      </article>
    </section>

    <section class="dashboard-middle-grid">
      <article class="dashboard-section-card">
        <header class="dashboard-section-head">
          <h2>业务运行概览 <span>实时</span></h2>
        </header>
        <div class="dashboard-init-grid dashboard-business-grid">
          <div>
            <span><i :class="unusedCards ? 'on' : 'off'"></i>卡密库存</span>
            <strong :class="{ muted: !unusedCards }">{{ unusedCards }} 张可用</strong>
            <small>总计 {{ cardTotal }} / 已使用 {{ usedCards }} / 禁用 {{ disabledCards }}</small>
          </div>
          <div>
            <span><i :class="enabledPaymentChannels ? 'on' : 'off'"></i>在线支付</span>
            <strong :class="{ muted: !enabledPaymentChannels }">{{ enabledPaymentChannels }}/{{ paymentChannels }} 个通道启用</strong>
            <small>今日到账 {{ formatMoney(overview?.payments.todayPaidAmount) }}</small>
          </div>
          <div>
            <span><i :class="enabledSocks ? 'on' : 'off'"></i>SOCKS 出站</span>
            <strong :class="{ muted: !enabledSocks }">{{ enabledSocks }}/{{ socksTotal }} 个启用</strong>
            <small>可用于路由节点出站中转</small>
          </div>
          <div>
            <span><i :class="pendingOrders ? 'warn' : 'off'"></i>待支付订单</span>
            <strong>{{ pendingOrders }} 笔</strong>
            <small>今日续费 {{ formatMoney(overview?.renewals.todayAmount) }}</small>
          </div>
        </div>
      </article>

      <article class="dashboard-section-card">
        <header class="dashboard-section-head">
          <h2>最近业务动态 <span>真实记录</span></h2>
        </header>
        <div v-if="recentActivity.length" class="dashboard-activity-list">
          <div v-for="item in recentActivity" :key="item.key" class="dashboard-activity-item">
            <i :class="activityTone(item)"><component :is="activityIcon(item.type)" :size="16" /></i>
            <div><p><strong>{{ item.title }}</strong> {{ item.description }}</p><span>{{ formatRelativeDate(item.createdAt) }}</span></div>
          </div>
        </div>
        <div v-else class="dashboard-empty-activity">
          <Activity :size="20" />
          <span>暂无支付、续费、卡密兑换或同步记录</span>
        </div>
      </article>
    </section>

    <section class="dashboard-job-grid">
      <article class="dashboard-job-card">
        <header>
          <div class="dashboard-job-title"><i><ShieldOff :size="18" /></i><div><h2>自动停用过期节点</h2><p>每 10 分钟自动检测，启用后立即检测一次</p></div></div>
          <div class="dashboard-job-switch"><span>{{ jobSettings.disableExpiredEnabled ? '启用' : '停用' }}</span><el-switch :model-value="jobSettings.disableExpiredEnabled" :loading="jobSettingsSaving" @change="toggleDisableExpired" /></div>
        </header>
        <div class="dashboard-job-stats">
          <div><span>上次检测</span><strong>{{ formatDate(lastDisableExpired?.checkedAt) }}</strong></div>
          <div><span>成功</span><strong>{{ lastDisableExpired?.success ?? '-' }}</strong></div>
          <div><span>失败</span><strong>{{ lastDisableExpired?.failed ?? '-' }}</strong></div>
        </div>
        <button type="button" :disabled="jobRunning" @click="disableExpiredNodes"><Clock3 :size="15" />{{ jobRunning ? '执行中' : '立即执行' }}</button>
      </article>

      <article class="dashboard-job-card">
        <header>
          <div class="dashboard-job-title"><i><Activity :size="18" /></i><div><h2>远端流量同步任务</h2><p>每 10 分钟读取远端用量，超限后同步停用节点</p></div></div>
          <div class="dashboard-job-switch"><span>{{ jobSettings.trafficSyncEnabled ? '启用' : '停用' }}</span><el-switch :model-value="jobSettings.trafficSyncEnabled" :loading="jobSettingsSaving" @change="toggleTrafficSync" /></div>
        </header>
        <div class="dashboard-job-stats">
          <div><span>上次检测</span><strong>{{ formatDate(lastTrafficSync?.checkedAt) }}</strong></div>
          <div><span>检查</span><strong>{{ lastTrafficSync?.checked ?? '-' }}</strong></div>
          <div><span>停用</span><strong>{{ lastTrafficSync?.disabled ?? '-' }}</strong></div>
        </div>
        <button type="button" :disabled="trafficJobRunning" @click="syncTraffic"><Activity :size="15" />{{ trafficJobRunning ? '同步中' : '立即同步' }}</button>
      </article>
    </section>
  </div>
</template>
