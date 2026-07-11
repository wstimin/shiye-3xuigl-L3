<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { RefreshCw, Trash2 } from 'lucide-vue-next';
import { api } from '../api';

type RechargeOrder = {
  id: string;
  tradeNo: string;
  provider: string;
  amount: string;
  status: string;
  expiresAt?: string | null;
  createdAt: string;
  customer?: { name: string; loginUsername: string };
};

type BalanceLog = {
  id: string;
  type: string;
  amount: string;
  beforeBalance: string;
  afterBalance: string;
  operator?: string | null;
  remark?: string | null;
  createdAt: string;
  customer?: { name: string; loginUsername: string };
};

type PaymentChannel = { id: string; enabled: boolean; name: string };

const loading = ref(false);
const clearingOrders = ref(false);
const clearingLogs = ref(false);
const error = ref('');
const orders = ref<RechargeOrder[]>([]);
const logs = ref<BalanceLog[]>([]);
const paymentChannels = ref<PaymentChannel[]>([]);
const activePanels = ref(['orders', 'logs']);

const paidOrders = computed(() => orders.value.filter((item) => item.status === 'paid' || item.status === 'success').length);
const pendingOrders = computed(() => orders.value.filter((item) => item.status === 'pending').length);
const enabledChannels = computed(() => paymentChannels.value.filter((item) => item.enabled).length);

async function loadFinance() {
  loading.value = true;
  error.value = '';
  try {
    const [orderResult, logResult, channelResult] = await Promise.all([
      api<RechargeOrder[]>('/api/admin/recharge-orders'),
      api<BalanceLog[]>('/api/admin/balance-logs'),
      api<PaymentChannel[]>('/api/admin/payment-channels')
    ]);
    orders.value = orderResult;
    logs.value = logResult;
    paymentChannels.value = channelResult;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载失败';
  } finally {
    loading.value = false;
  }
}

async function clearRechargeHistory() {
  await ElMessageBox.confirm('确认清除已完成、失败或取消的充值订单历史？未完成的 pending 订单会保留。', '清除充值历史', { type: 'warning' });
  clearingOrders.value = true;
  error.value = '';
  try {
    const result = await api<{ deleted: number }>('/api/admin/recharge-orders/history', { method: 'DELETE' });
    ElMessage.success(`已清除 ${result.deleted} 条充值订单历史`);
    await loadFinance();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '清除充值订单历史失败';
  } finally {
    clearingOrders.value = false;
  }
}

async function clearBalanceHistory() {
  await ElMessageBox.confirm('确认清除余额流水历史？此操作只清理后台流水列表，不会修改用户当前余额。', '清除余额流水', { type: 'warning' });
  clearingLogs.value = true;
  error.value = '';
  try {
    const result = await api<{ deleted: number }>('/api/admin/balance-logs/history', { method: 'DELETE' });
    ElMessage.success(`已清除 ${result.deleted} 条余额流水`);
    await loadFinance();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '清除余额流水失败';
  } finally {
    clearingLogs.value = false;
  }
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

onMounted(loadFinance);
</script>

<template>
  <h1 class="page-title">财务中心</h1>
  <el-alert v-if="!paymentChannels.some((item) => item.enabled)" class="page-alert" title="尚未启用在线支付方式；用户仍可使用卡密兑换，管理员也可手工调整余额。" type="warning" show-icon :closable="false" />
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid">
    <div class="metric"><span>充值订单</span><strong>{{ orders.length }}</strong><small>成功 {{ paidOrders }} / 待支付 {{ pendingOrders }}</small></div>
    <div class="metric"><span>余额流水</span><strong>{{ logs.length }}</strong><small>当前显示最近 100 条</small></div>
    <div class="metric"><span>支付通道</span><strong>{{ enabledChannels }}</strong><small>已启用通道</small></div>
    <div class="metric"><span>财务状态</span><strong>{{ enabledChannels ? '正常' : '待配置' }}</strong><small>{{ enabledChannels ? '用户可在线充值' : '仅卡密/手动充值' }}</small></div>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>财务记录</strong>
      <el-button size="small" :loading="loading" @click="loadFinance"><RefreshCw :size="15" />刷新</el-button>
    </div>
    <el-collapse v-model="activePanels" class="admin-collapse">
      <el-collapse-item name="orders">
        <template #title>
          <div class="collapse-title"><strong>充值订单</strong><span>{{ orders.length }} 条</span></div>
        </template>
        <div class="table-toolbar-actions collapse-actions">
          <el-button size="small" type="danger" plain :loading="clearingOrders" @click="clearRechargeHistory"><Trash2 :size="15" />清除历史记录</el-button>
        </div>
        <el-table :data="orders" v-loading="loading" style="width: 100%">
          <el-table-column prop="tradeNo" label="订单号" min-width="180" />
          <el-table-column label="用户" min-width="160"><template #default="{ row }">{{ row.customer?.name || '-' }}</template></el-table-column>
          <el-table-column prop="provider" label="通道" width="110" />
          <el-table-column prop="amount" label="金额" width="120" />
          <el-table-column prop="status" label="状态" width="100" />
          <el-table-column label="过期时间" min-width="180"><template #default="{ row }">{{ formatDate(row.expiresAt) }}</template></el-table-column>
          <el-table-column label="创建时间" min-width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
        </el-table>
      </el-collapse-item>
      <el-collapse-item name="logs">
        <template #title>
          <div class="collapse-title"><strong>余额流水</strong><span>{{ logs.length }} 条</span></div>
        </template>
        <div class="table-toolbar-actions collapse-actions">
          <el-button size="small" type="danger" plain :loading="clearingLogs" @click="clearBalanceHistory"><Trash2 :size="15" />清除历史记录</el-button>
        </div>
        <el-table :data="logs" v-loading="loading" style="width: 100%">
          <el-table-column label="用户" min-width="160"><template #default="{ row }">{{ row.customer?.name || '-' }}</template></el-table-column>
          <el-table-column prop="type" label="类型" width="140" />
          <el-table-column prop="amount" label="变动" width="120" />
          <el-table-column prop="beforeBalance" label="变动前" width="120" />
          <el-table-column prop="afterBalance" label="变动后" width="120" />
          <el-table-column prop="operator" label="操作人" width="130" />
          <el-table-column prop="remark" label="备注" min-width="180" />
          <el-table-column label="时间" min-width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
        </el-table>
      </el-collapse-item>
    </el-collapse>
  </div>
</template>
