<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';

type CustomerResult = { total: number; items: Array<{ id: string; status: string }> };
type ServiceNode = { id: string; enabled: boolean };
type XuiServer = { id: string; enabled: boolean };
type CardResult = { total: number; items: Array<{ id: string; status: string }> };
type PaymentChannel = { id: string; enabled: boolean };
type DisableExpiredResult = { checkedAt: string; total: number; success: number; failed: number };

const loading = ref(false);
const jobRunning = ref(false);
const error = ref('');
const customers = ref<CustomerResult>({ total: 0, items: [] });
const serviceNodes = ref<ServiceNode[]>([]);
const servers = ref<XuiServer[]>([]);
const cards = ref<CardResult>({ total: 0, items: [] });
const paymentChannels = ref<PaymentChannel[]>([]);
const lastDisableExpired = ref<DisableExpiredResult | null>(null);

const activeCustomers = computed(() => customers.value.items.filter((item) => item.status === 'active').length);
const enabledNodes = computed(() => serviceNodes.value.filter((item) => item.enabled).length);
const unusedCards = computed(() => cards.value.items.filter((item) => item.status === 'unused').length);

async function loadDashboard() {
  loading.value = true;
  error.value = '';
  try {
    const [customerResult, nodeResult, serverResult, cardResult, channelResult] = await Promise.all([
      api<CustomerResult>('/api/admin/customers'),
      api<ServiceNode[]>('/api/admin/service-nodes'),
      api<XuiServer[]>('/api/admin/xui-servers'),
      api<CardResult>('/api/admin/cards'),
      api<PaymentChannel[]>('/api/admin/payment-channels')
    ]);
    customers.value = customerResult;
    serviceNodes.value = nodeResult;
    servers.value = serverResult;
    cards.value = cardResult;
    paymentChannels.value = channelResult;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function disableExpiredNodes() {
  await ElMessageBox.confirm('系统会把已到期且仍处于启用状态的用户节点同步停用到远端 3x-ui，远端同步成功后才更新本地状态。确认执行？', '停用过期节点', { type: 'warning' });
  jobRunning.value = true;
  error.value = '';
  try {
    const result = await api<DisableExpiredResult>('/api/admin/jobs/disable-expired', { method: 'POST' });
    lastDisableExpired.value = result;
    ElMessage.success(`执行完成：成功 ${result.success}，失败 ${result.failed}，总数 ${result.total}`);
    await loadDashboard();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '停用过期节点失败';
  } finally {
    jobRunning.value = false;
  }
}

onMounted(loadDashboard);
</script>

<template>
  <h1 class="page-title">概览</h1>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid" :class="{ loading }">
    <div class="metric"><span>用户总数</span><strong>{{ customers.total }}</strong><small>当前页活跃 {{ activeCustomers }}</small></div>
    <div class="metric"><span>服务节点</span><strong>{{ serviceNodes.length }}</strong><small>已启用 {{ enabledNodes }}</small></div>
    <div class="metric"><span>3x-ui 服务器</span><strong>{{ servers.length }}</strong><small>已启用 {{ servers.filter((item) => item.enabled).length }}</small></div>
    <div class="metric"><span>卡密总数</span><strong>{{ cards.total }}</strong><small>当前页未使用 {{ unusedCards }}</small></div>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>初始化状态</strong>
      <el-button size="small" :loading="loading" @click="loadDashboard">刷新</el-button>
    </div>
    <el-descriptions :column="1" border>
      <el-descriptions-item label="在线支付">{{ paymentChannels.filter((item) => item.enabled).length ? '已启用' : '未启用' }}</el-descriptions-item>
      <el-descriptions-item label="自动停用过期节点">
        已启用，每 10 分钟执行一次
        <el-button size="small" type="primary" plain :loading="jobRunning" @click="disableExpiredNodes">立即执行</el-button>
        <span v-if="lastDisableExpired" class="inline-note">上次：成功 {{ lastDisableExpired.success }}，失败 {{ lastDisableExpired.failed }}</span>
      </el-descriptions-item>
      <el-descriptions-item label="远端流量同步任务">未启用</el-descriptions-item>
    </el-descriptions>
  </div>
</template>
