<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Activity, Clock3, CreditCard, Monitor, RefreshCw, Router, ShieldOff, Users } from 'lucide-vue-next';
import { api } from '../api';

type Overview = {
  customers: { total: number; active: number };
  serviceNodes: { total: number; enabled: number; expiredActive: number };
  servers: { total: number; enabled: number };
  cards: { total: number; unused: number };
  payments: { enabledChannels: number; pendingOrders: number; todayPaidCount: number; todayPaidAmount: string | number };
  renewals: { todayCount: number; todayAmount: string | number };
};
type JobSettings = { disableExpiredEnabled: boolean; trafficSyncEnabled: boolean };
type DisableExpiredResult = { checkedAt: string; total: number; success: number; failed: number };
type TrafficSyncResult = { checkedAt: string; checked: number; disabled: number; failed: number };
type JobStatus = { lastDisableExpired: DisableExpiredResult | null; lastTrafficSync: TrafficSyncResult | null };
type ActivityItem = { key: string; tone: 'green' | 'purple' | 'blue'; icon: typeof Activity; title: string; text: string; time: string };

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
const nodeTotal = computed(() => overview.value?.serviceNodes.total ?? 0);
const enabledNodes = computed(() => overview.value?.serviceNodes.enabled ?? 0);
const expiredNodes = computed(() => overview.value?.serviceNodes.expiredActive ?? 0);
const serverTotal = computed(() => overview.value?.servers.total ?? 0);
const enabledServers = computed(() => overview.value?.servers.enabled ?? 0);
const cardTotal = computed(() => overview.value?.cards.total ?? 0);
const unusedCards = computed(() => overview.value?.cards.unused ?? 0);
const enabledPaymentChannels = computed(() => overview.value?.payments.enabledChannels ?? 0);
const pendingOrders = computed(() => overview.value?.payments.pendingOrders ?? 0);

const customerRate = computed(() => percent(activeCustomers.value, customerTotal.value));
const nodeRate = computed(() => percent(enabledNodes.value, nodeTotal.value));
const serverRate = computed(() => percent(enabledServers.value, serverTotal.value));
const cardRate = computed(() => percent(unusedCards.value, cardTotal.value));

const recentActivity = computed<ActivityItem[]>(() => {
  const items: ActivityItem[] = [];
  if (lastTrafficSync.value) {
    const result = lastTrafficSync.value;
    items.push({
      key: 'traffic-sync',
      tone: result.failed ? 'purple' : 'green',
      icon: Activity,
      title: '流量同步',
      text: `检查 ${result.checked} 个节点，停用 ${result.disabled} 个，失败 ${result.failed} 个`,
      time: formatRelativeDate(result.checkedAt)
    });
  }
  if (lastDisableExpired.value) {
    const result = lastDisableExpired.value;
    items.push({
      key: 'disable-expired',
      tone: result.failed ? 'purple' : 'blue',
      icon: ShieldOff,
      title: '过期检测',
      text: `检查 ${result.total} 个到期节点，成功 ${result.success} 个，失败 ${result.failed} 个`,
      time: formatRelativeDate(result.checkedAt)
    });
  }
  return items.sort((left, right) => activityTime(right.key) - activityTime(left.key));
});

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
  if (!saved) return;
  if (enabled) {
    try {
      await runDisableExpiredNodes();
    } catch {
    }
  }
}

async function toggleTrafficSync(value: string | number | boolean) {
  const enabled = Boolean(value);
  const saved = await saveJobSettings({ trafficSyncEnabled: enabled });
  if (!saved) return;
  if (enabled) {
    try {
      await runTrafficSync();
    } catch {
    }
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
  await ElMessageBox.confirm('系统会把已到期且仍处于启用状态的用户节点同步停用到远端 3x-ui，远端同步成功后再更新本地状态。确认执行？', '停用过期节点', { type: 'warning', customClass: 'operations-dark-message-box' });
  try {
    const result = await runDisableExpiredNodes();
    ElMessage.success(`执行完成：成功 ${result.success}，失败 ${result.failed}，总数 ${result.total}`);
  } catch {
  }
}

async function syncTraffic() {
  try {
    const result = await runTrafficSync();
    ElMessage.success(`流量同步完成：检查 ${result.checked}，停用 ${result.disabled}，失败 ${result.failed}`);
  } catch {
  }
}

function percent(value: number, total: number) {
  if (!total || value <= 0) return 0;
  return Math.min(100, Math.round((value / total) * 100));
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

function activityTime(key: string) {
  const value = key === 'traffic-sync' ? lastTrafficSync.value?.checkedAt : lastDisableExpired.value?.checkedAt;
  const timestamp = value ? new Date(value).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

onMounted(loadDashboard);
</script>

<template>
  <div class="dashboard-page" :class="{ loading }">
    <section class="dashboard-welcome">
      <div>
        <h1>数据概览</h1>
        <p>查看系统初始化状态、核心资源数量和后台自动任务</p>
      </div>
      <div class="dashboard-welcome-meta">
        <div>
          <span>数据状态</span>
          <strong><i></i>{{ error ? '读取异常' : '读取正常' }}</strong>
        </div>
        <button class="dashboard-refresh" type="button" :disabled="loading" title="刷新数据概览" @click="loadDashboard">
          <RefreshCw :size="15" :class="{ spinning: loading }" />
          <span>{{ loading ? '刷新中' : '刷新数据' }}</span>
        </button>
      </div>
    </section>

    <el-alert v-if="error" class="dashboard-alert" :title="error" type="error" show-icon :closable="false" />

    <section class="dashboard-stat-grid" aria-label="核心资源统计">
      <article class="dashboard-stat-card purple">
        <div class="dashboard-stat-head"><span>用户总数</span><i><Users :size="18" /></i></div>
        <strong>{{ customerTotal }}</strong>
        <p>状态正常 {{ activeCustomers }} <em>{{ customerRate ? `${customerRate}%` : '暂无正常用户' }}</em></p>
        <div class="dashboard-stat-bar"><i :style="{ width: `${customerRate}%` }"></i></div>
      </article>
      <article class="dashboard-stat-card blue">
        <div class="dashboard-stat-head"><span>路由节点</span><i><Router :size="18" /></i></div>
        <strong>{{ nodeTotal }}</strong>
        <p>启用 {{ enabledNodes }} / 到期用户节点 {{ expiredNodes }}</p>
        <div class="dashboard-stat-bar"><i :style="{ width: `${nodeRate}%` }"></i></div>
      </article>
      <article class="dashboard-stat-card green">
        <div class="dashboard-stat-head"><span>面板连接</span><i><Monitor :size="18" /></i></div>
        <strong>{{ serverTotal }}</strong>
        <p>已启用 {{ enabledServers }} <em>{{ enabledServers ? '已配置' : '待启用' }}</em></p>
        <div class="dashboard-stat-bar"><i :style="{ width: `${serverRate}%` }"></i></div>
      </article>
      <article class="dashboard-stat-card orange">
        <div class="dashboard-stat-head"><span>卡密总数</span><i><CreditCard :size="18" /></i></div>
        <strong>{{ cardTotal }}</strong>
        <p>未使用 {{ unusedCards }}</p>
        <div class="dashboard-stat-bar"><i :style="{ width: `${cardRate}%` }"></i></div>
      </article>
    </section>

    <section class="dashboard-middle-grid">
      <article class="dashboard-section-card">
        <header class="dashboard-section-head">
          <h2>初始化状态 <span>核心</span></h2>
        </header>
        <div class="dashboard-init-grid">
          <div>
            <span><i :class="enabledPaymentChannels ? 'on' : 'off'"></i>在线支付</span>
            <strong :class="{ muted: !enabledPaymentChannels, ok: enabledPaymentChannels }">{{ enabledPaymentChannels ? `已启用 ${enabledPaymentChannels} 个通道` : '未启用' }}</strong>
          </div>
          <div>
            <span><i :class="enabledServers ? 'on' : 'off'"></i>面板连接</span>
            <strong :class="{ muted: !enabledServers, ok: enabledServers }">{{ enabledServers }}/{{ serverTotal }} 已启用</strong>
          </div>
          <div>
            <span><i :class="enabledNodes ? 'on' : 'off'"></i>路由节点</span>
            <strong :class="{ muted: !enabledNodes, ok: enabledNodes }">{{ enabledNodes }}/{{ nodeTotal }} 启用</strong>
          </div>
          <div>
            <span><i :class="pendingOrders ? 'warn' : 'off'"></i>待支付订单</span>
            <strong>{{ pendingOrders }} 单</strong>
          </div>
        </div>
      </article>

      <article class="dashboard-section-card">
        <header class="dashboard-section-head">
          <h2>最近动态 <span>任务状态</span></h2>
        </header>
        <div v-if="recentActivity.length" class="dashboard-activity-list">
          <div v-for="item in recentActivity" :key="item.key" class="dashboard-activity-item">
            <i :class="item.tone"><component :is="item.icon" :size="16" /></i>
            <div><p><strong>{{ item.title }}</strong> {{ item.text }}</p><span>{{ item.time }}</span></div>
          </div>
        </div>
        <div v-else class="dashboard-empty-activity">
          <Activity :size="20" />
          <span>暂无任务执行记录</span>
        </div>
      </article>
    </section>

    <section class="dashboard-job-grid">
      <article class="dashboard-job-card">
        <header>
          <div class="dashboard-job-title"><i><ShieldOff :size="18" /></i><div><h2>自动停用过期节点</h2><p>每 10 分钟自动检测；启动后立即检测一次</p></div></div>
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
          <div class="dashboard-job-title"><i><Activity :size="18" /></i><div><h2>远端流量同步任务</h2><p>每 10 分钟读取远端用量；启动后立即同步一次</p></div></div>
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
