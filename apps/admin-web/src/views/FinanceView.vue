<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { CircleCheckBig, Landmark, ReceiptText, RefreshCw, RotateCcw, Search, ShieldCheck, Trash2, WalletCards } from 'lucide-vue-next';
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
type PageResult<T> = { items: T[]; page: number; pageSize: number; total: number };

const loading = ref(false);
const clearingOrders = ref(false);
const clearingLogs = ref(false);
const error = ref('');
const orders = ref<RechargeOrder[]>([]);
const logs = ref<BalanceLog[]>([]);
const orderTotal = ref(0);
const logTotal = ref(0);
const paymentChannels = ref<PaymentChannel[]>([]);
const activePanels = ref(['orders', 'logs']);
const orderFilters = reactive({ keyword: '', status: '', provider: '', from: '', to: '' });
const logFilters = reactive({ keyword: '', type: '', from: '', to: '' });
const orderPage = reactive({ page: 1, pageSize: 20 });
const logPage = reactive({ page: 1, pageSize: 20 });

const paidOrders = computed(() => orders.value.filter((item) => item.status === 'paid' || item.status === 'success').length);
const pendingOrders = computed(() => orders.value.filter((item) => item.status === 'pending').length);
const enabledChannels = computed(() => paymentChannels.value.filter((item) => item.enabled).length);
const orderRangeText = computed(() => rangeText(orderPage.page, orderPage.pageSize, orderTotal.value));
const logRangeText = computed(() => rangeText(logPage.page, logPage.pageSize, logTotal.value));

async function loadFinance() {
  loading.value = true;
  error.value = '';
  try {
    const [orderResult, logResult, channelResult] = await Promise.all([
      api<PageResult<RechargeOrder>>(`/api/admin/recharge-orders?${orderQueryParams().toString()}`),
      api<PageResult<BalanceLog>>(`/api/admin/balance-logs?${logQueryParams().toString()}`),
      api<PaymentChannel[]>('/api/admin/payment-channels')
    ]);
    orders.value = orderResult.items;
    logs.value = logResult.items;
    orderTotal.value = orderResult.total;
    logTotal.value = logResult.total;
    orderPage.page = orderResult.page;
    orderPage.pageSize = orderResult.pageSize;
    logPage.page = logResult.page;
    logPage.pageSize = logResult.pageSize;
    paymentChannels.value = channelResult;
  } catch {
    error.value = '加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadOrders(resetPage = false) {
  if (resetPage) orderPage.page = 1;
  loading.value = true;
  error.value = '';
  try {
    const result = await api<PageResult<RechargeOrder>>(`/api/admin/recharge-orders?${orderQueryParams().toString()}`);
    orders.value = result.items;
    orderTotal.value = result.total;
    orderPage.page = result.page;
    orderPage.pageSize = result.pageSize;
  } catch {
    error.value = '加载失败';
  } finally {
    loading.value = false;
  }
}

async function loadLogs(resetPage = false) {
  if (resetPage) logPage.page = 1;
  loading.value = true;
  error.value = '';
  try {
    const result = await api<PageResult<BalanceLog>>(`/api/admin/balance-logs?${logQueryParams().toString()}`);
    logs.value = result.items;
    logTotal.value = result.total;
    logPage.page = result.page;
    logPage.pageSize = result.pageSize;
  } catch {
    error.value = '加载失败';
  } finally {
    loading.value = false;
  }
}

function orderQueryParams() {
  const params = new URLSearchParams({ page: String(orderPage.page), pageSize: String(orderPage.pageSize) });
  if (orderFilters.keyword.trim()) params.set('keyword', orderFilters.keyword.trim());
  if (orderFilters.status) params.set('status', orderFilters.status);
  if (orderFilters.provider) params.set('provider', orderFilters.provider);
  if (orderFilters.from) params.set('from', new Date(orderFilters.from).toISOString());
  if (orderFilters.to) params.set('to', new Date(orderFilters.to).toISOString());
  return params;
}

function logQueryParams() {
  const params = new URLSearchParams({ page: String(logPage.page), pageSize: String(logPage.pageSize) });
  if (logFilters.keyword.trim()) params.set('keyword', logFilters.keyword.trim());
  if (logFilters.type) params.set('type', logFilters.type);
  if (logFilters.from) params.set('from', new Date(logFilters.from).toISOString());
  if (logFilters.to) params.set('to', new Date(logFilters.to).toISOString());
  return params;
}

function resetOrderFilters() {
  Object.assign(orderFilters, { keyword: '', status: '', provider: '', from: '', to: '' });
  void loadOrders(true);
}

function resetLogFilters() {
  Object.assign(logFilters, { keyword: '', type: '', from: '', to: '' });
  void loadLogs(true);
}

function handleOrderPageChange(page: number) {
  orderPage.page = page;
  void loadOrders();
}

function handleOrderPageSizeChange(pageSize: number) {
  orderPage.pageSize = pageSize;
  void loadOrders(true);
}

function handleLogPageChange(page: number) {
  logPage.page = page;
  void loadLogs();
}

function handleLogPageSizeChange(pageSize: number) {
  logPage.pageSize = pageSize;
  void loadLogs(true);
}

async function clearRechargeHistory() {
  const range = await askHistoryRange('清除充值历史');
  await askConfirmText('CLEAR_RECHARGE_HISTORY');
  clearingOrders.value = true;
  error.value = '';
  try {
    await api('/api/admin/recharge-orders/history', { method: 'DELETE', body: { ...range, confirmText: 'CLEAR_RECHARGE_HISTORY' } });
    ElMessage.success('清除成功');
    await loadFinance();
  } catch {
    error.value = '清除失败';
    ElMessage.error(error.value);
  } finally {
    clearingOrders.value = false;
  }
}

async function clearBalanceHistory() {
  const range = await askHistoryRange('清除余额流水');
  await askConfirmText('CLEAR_BALANCE_HISTORY');
  clearingLogs.value = true;
  error.value = '';
  try {
    await api('/api/admin/balance-logs/history', { method: 'DELETE', body: { ...range, confirmText: 'CLEAR_BALANCE_HISTORY' } });
    ElMessage.success('清除成功');
    await loadFinance();
  } catch {
    error.value = '清除失败';
    ElMessage.error(error.value);
  } finally {
    clearingLogs.value = false;
  }
}

async function askHistoryRange(title: string) {
  const fromInput = await askDatePrompt(`${title} - 开始时间`, '请输入开始时间，格式 YYYY-MM-DD HH:mm:ss；留空表示从最早记录开始。', defaultHistoryFrom(), true);
  const toInput = await askDatePrompt(`${title} - 结束时间`, '请输入结束时间，格式 YYYY-MM-DD HH:mm:ss；只清理早于该时间的记录。', defaultHistoryTo(), false);
  return {
    from: normalizeOptionalDate(fromInput),
    to: normalizeRequiredDate(toInput)
  };
}

async function askDatePrompt(title: string, message: string, inputValue: string, allowEmpty: boolean) {
  const { value } = await ElMessageBox.prompt(message, title, {
    customClass: 'operations-dark-message-box',
    confirmButtonText: '下一步',
    cancelButtonText: '取消',
    inputValue,
    inputPattern: allowEmpty ? /^$|^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/ : /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/,
    inputErrorMessage: '时间格式应为 YYYY-MM-DD HH:mm:ss'
  });
  return value;
}

async function askConfirmText(confirmText: string) {
  await ElMessageBox.prompt(`二次确认：请输入 ${confirmText}`, '确认清理历史', {
    customClass: 'operations-dark-message-box',
    confirmButtonText: '确认清理',
    cancelButtonText: '取消',
    inputPattern: new RegExp(`^${confirmText}$`),
    inputErrorMessage: '确认文本不匹配',
    type: 'warning'
  });
}

function normalizeOptionalDate(value: string) {
  const trimmed = value.trim();
  return trimmed ? normalizeRequiredDate(trimmed) : undefined;
}

function normalizeRequiredDate(value: string) {
  return new Date(value.trim().replace(' ', 'T')).toISOString();
}

function defaultHistoryFrom() {
  const date = new Date();
  date.setMonth(date.getMonth() - 1);
  return formatInputDate(date);
}

function defaultHistoryTo() {
  return formatInputDate(new Date());
}

function formatInputDate(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function rangeText(page: number, pageSize: number, total: number) {
  if (!total) return '0 / 0';
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(page * pageSize, total);
  return `${start}-${end} / ${total}`;
}

function statusType(status: string) {
  if (status === 'paid') return 'success';
  if (status === 'pending') return 'warning';
  if (status === 'failed') return 'danger';
  return 'info';
}

function statusLabel(status: string) {
  const map: Record<string, string> = { pending: '待支付', paid: '已支付', closed: '已关闭', failed: '失败' };
  return map[status] || status || '-';
}

function logTypeLabel(type: string) {
  const map: Record<string, string> = {
    card_redeem: '卡密兑换',
    recharge: '在线充值',
    renewal: '续费扣款',
    admin_add: '管理员增加',
    admin_subtract: '管理员扣减',
    admin_set: '管理员设置',
    refund: '退款'
  };
  return map[type] || type || '-';
}

onMounted(loadFinance);
</script>

<template>
  <div class="operations-page finance-page" :class="{ loading }">
  <div class="page-head operations-page-header">
    <div class="page-head-main">
      <h1 class="page-title">财务中心</h1>
      <p>集中查看在线充值订单、账户余额流水和支付通道状态，所有记录均来自真实业务数据。</p>
    </div>
    <div class="page-actions">
      <el-button :loading="loading" @click="loadFinance()"><RefreshCw :size="15" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="!paymentChannels.some((item) => item.enabled)" class="page-alert" title="尚未启用在线支付方式；用户仍可使用卡密兑换，管理员也可手工调整余额。" type="warning" show-icon :closable="false" />
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid operations-stat-grid">
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-indigo"><ReceiptText :size="19" /></span><div><span>充值订单</span><strong>{{ orderTotal }}</strong><small>当前页成功 {{ paidOrders }} / 待支付 {{ pendingOrders }}</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-cyan"><WalletCards :size="19" /></span><div><span>余额流水</span><strong>{{ logTotal }}</strong><small>当前页 {{ logs.length }} 条</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-emerald"><Landmark :size="19" /></span><div><span>支付通道</span><strong>{{ enabledChannels }}</strong><small>已启用通道</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon" :class="enabledChannels ? 'tone-emerald' : 'tone-amber'"><component :is="enabledChannels ? CircleCheckBig : ShieldCheck" :size="19" /></span><div><span>财务状态</span><strong>{{ enabledChannels ? '正常' : '待配置' }}</strong><small>{{ enabledChannels ? '用户可在线充值' : '仅卡密/手动充值' }}</small></div></div>
  </div>

  <div class="panel list-panel operations-content-card finance-record-card">
    <div class="panel-toolbar">
      <strong>财务记录</strong>
      <span class="muted-text">订单与流水按真实业务记录汇总</span>
    </div>
    <el-collapse v-model="activePanels" class="admin-collapse">
      <el-collapse-item name="orders">
        <template #title>
          <div class="collapse-title"><strong>充值订单</strong><span>{{ orderRangeText }}</span></div>
        </template>
        <div class="filter-bar">
          <el-input v-model="orderFilters.keyword" clearable placeholder="订单号、用户、账号" style="max-width: 260px" @keyup.enter="loadOrders(true)">
            <template #prefix><Search :size="15" /></template>
          </el-input>
          <el-select v-model="orderFilters.status" clearable placeholder="状态" style="width: 130px" @change="loadOrders(true)">
            <el-option label="待支付" value="pending" />
            <el-option label="已支付" value="paid" />
            <el-option label="已关闭" value="closed" />
            <el-option label="失败" value="failed" />
          </el-select>
          <el-select v-model="orderFilters.provider" clearable placeholder="通道" style="width: 130px" @change="loadOrders(true)">
            <el-option label="支付宝" value="alipay" />
            <el-option label="微信" value="wechat" />
            <el-option label="易支付" value="epay" />
            <el-option label="BEPUSDT" value="bepusdt" />
          </el-select>
          <el-date-picker v-model="orderFilters.from" type="datetime" placeholder="开始时间" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 190px" @change="loadOrders(true)" />
          <el-date-picker v-model="orderFilters.to" type="datetime" placeholder="结束时间" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 190px" @change="loadOrders(true)" />
          <el-button @click="resetOrderFilters"><RotateCcw :size="15" />重置</el-button>
          <el-button type="primary" :loading="loading" @click="loadOrders(true)"><Search :size="15" />查询</el-button>
          <span class="filter-summary">显示 {{ orderRangeText }}</span>
        </div>
        <div class="record-action-row">
          <el-button size="small" type="danger" plain :loading="clearingOrders" @click="clearRechargeHistory"><Trash2 :size="15" />清除历史记录</el-button>
        </div>
        <el-table :data="orders" v-loading="loading" style="width: 100%">
          <el-table-column prop="tradeNo" label="订单号" min-width="180" />
          <el-table-column label="用户" min-width="160"><template #default="{ row }">{{ row.customer?.name || '-' }}</template></el-table-column>
          <el-table-column prop="provider" label="通道" width="110" />
          <el-table-column prop="amount" label="金额" width="120" />
          <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
          <el-table-column label="过期时间" min-width="180"><template #default="{ row }">{{ formatDate(row.expiresAt) }}</template></el-table-column>
          <el-table-column label="创建时间" min-width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
          <template #empty><el-empty description="暂无充值订单" /></template>
        </el-table>
        <div class="pagination-bar">
          <el-pagination
            background
            layout="total, sizes, prev, pager, next, jumper"
            :total="orderTotal"
            :current-page="orderPage.page"
            :page-size="orderPage.pageSize"
            :page-sizes="[10, 20, 50, 100]"
            @current-change="handleOrderPageChange"
            @size-change="handleOrderPageSizeChange"
          />
        </div>
      </el-collapse-item>
      <el-collapse-item name="logs">
        <template #title>
          <div class="collapse-title"><strong>余额流水</strong><span>{{ logRangeText }}</span></div>
        </template>
        <div class="filter-bar">
          <el-input v-model="logFilters.keyword" clearable placeholder="用户、账号、操作人、备注" style="max-width: 280px" @keyup.enter="loadLogs(true)">
            <template #prefix><Search :size="15" /></template>
          </el-input>
          <el-select v-model="logFilters.type" clearable placeholder="类型" style="width: 150px" @change="loadLogs(true)">
            <el-option label="卡密兑换" value="card_redeem" />
            <el-option label="在线充值" value="recharge" />
            <el-option label="续费扣款" value="renewal" />
            <el-option label="管理员增加" value="admin_add" />
            <el-option label="管理员扣减" value="admin_subtract" />
            <el-option label="管理员设置" value="admin_set" />
            <el-option label="退款" value="refund" />
          </el-select>
          <el-date-picker v-model="logFilters.from" type="datetime" placeholder="开始时间" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 190px" @change="loadLogs(true)" />
          <el-date-picker v-model="logFilters.to" type="datetime" placeholder="结束时间" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 190px" @change="loadLogs(true)" />
          <el-button @click="resetLogFilters"><RotateCcw :size="15" />重置</el-button>
          <el-button type="primary" :loading="loading" @click="loadLogs(true)"><Search :size="15" />查询</el-button>
          <span class="filter-summary">显示 {{ logRangeText }}</span>
        </div>
        <div class="record-action-row">
          <el-button size="small" type="danger" plain :loading="clearingLogs" @click="clearBalanceHistory"><Trash2 :size="15" />清除历史记录</el-button>
        </div>
        <el-table :data="logs" v-loading="loading" style="width: 100%">
          <el-table-column label="用户" min-width="160"><template #default="{ row }">{{ row.customer?.name || '-' }}</template></el-table-column>
          <el-table-column label="类型" width="140"><template #default="{ row }"><el-tag type="info">{{ logTypeLabel(row.type) }}</el-tag></template></el-table-column>
          <el-table-column prop="amount" label="变动" width="120" />
          <el-table-column prop="beforeBalance" label="变动前" width="120" />
          <el-table-column prop="afterBalance" label="变动后" width="120" />
          <el-table-column prop="operator" label="操作人" width="130" />
          <el-table-column prop="remark" label="备注" min-width="180" />
          <el-table-column label="时间" min-width="180"><template #default="{ row }">{{ formatDate(row.createdAt) }}</template></el-table-column>
          <template #empty><el-empty description="暂无余额流水" /></template>
        </el-table>
        <div class="pagination-bar">
          <el-pagination
            background
            layout="total, sizes, prev, pager, next, jumper"
            :total="logTotal"
            :current-page="logPage.page"
            :page-size="logPage.pageSize"
            :page-sizes="[10, 20, 50, 100]"
            @current-change="handleLogPageChange"
            @size-change="handleLogPageSizeChange"
          />
        </div>
      </el-collapse-item>
    </el-collapse>
  </div>
  </div>
</template>
