<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/checkbox/style/css';
import 'element-plus/es/components/date-picker/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/dropdown/style/css';
import 'element-plus/es/components/dropdown-item/style/css';
import 'element-plus/es/components/dropdown-menu/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/pagination/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/tag/style/css';
import 'element-plus/es/components/tooltip/style/css';
import { ElAlert, ElButton, ElCheckbox, ElDatePicker, ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu, ElForm, ElFormItem, ElInput, ElInputNumber, ElMessage, ElMessageBox, ElOption, ElPagination, ElSelect, ElSwitch, ElTag as ElTagComponent, ElTooltip } from 'element-plus';
const ElTag = ElTagComponent as any;
import { Activity, CalendarClock, CircleCheckBig, Edit3, KeyRound, Link2, MoreHorizontal, Plus, RefreshCw, RotateCcw, Search, ServerOff, Trash2, Unlink, UserRound, Users, Wallet } from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { notifyError } from '../notify';

type CustomerNode = {
  id: string;
  xuiEmail: string;
  uuid?: string | null;
  expireAt: string | null;
  trafficLimitGb?: string | null;
  status: string;
  remoteControl: 'reference' | 'subscription_managed' | 'fully_managed';
  lastSyncedAt: string | null;
  serviceNode?: { id: string; name: string; ownership: 'managed' | 'referenced' | 'shared'; server?: { id: string; name: string } };
};

type Customer = {
  id: string;
  name: string;
  loginUsername: string;
  email?: string | null;
  phone?: string | null;
  balance: string;
  status: 'active' | 'disabled';
  remark?: string | null;
  createdAt: string;
  nodes?: CustomerNode[];
};

type ServiceNode = { id: string; name: string; server?: { name: string } };
type PageResult<T> = { items: T[]; page: number; pageSize: number; total: number };

const customerAvatarPalettes = [
  ['#4338ca', '#6366f1'],
  ['#0369a1', '#0284c7'],
  ['#047857', '#059669'],
  ['#b45309', '#d97706'],
  ['#be185d', '#db2777'],
  ['#6d28d9', '#7c3aed'],
  ['#b91c1c', '#dc2626'],
  ['#0e7490', '#0891b2']
] as const;

const loading = ref(false);
const savingCustomer = ref(false);
const binding = ref(false);
const updatingCustomerNode = ref(false);
const adjustingBalance = ref(false);
const error = ref('');
const customers = ref<Customer[]>([]);
const serviceNodes = ref<ServiceNode[]>([]);
const syncingIds = ref<Set<string>>(new Set());
const renewingIds = ref<Set<string>>(new Set());
const trafficIds = ref<Set<string>>(new Set());
const resettingTrafficIds = ref<Set<string>>(new Set());
const deletingRemoteClientIds = ref<Set<string>>(new Set());
const deletingServiceNodeIds = ref<Set<string>>(new Set());
const deletingCustomerIds = ref<Set<string>>(new Set());
const togglingCustomerIds = ref<Set<string>>(new Set());
const readingPasswordIds = ref<Set<string>>(new Set());
const customerTotal = ref(0);
const customerFilters = reactive({ keyword: '', status: '', balanceMin: undefined as number | undefined, balanceMax: undefined as number | undefined });
const customerPage = reactive({ page: 1, pageSize: 20 });
const editingCustomerId = ref('');
const customerDialogVisible = ref(false);
const bindDialogVisible = ref(false);
const editNodeDialogVisible = ref(false);
const balanceDialogVisible = ref(false);
const customerNodeDialogVisible = ref(false);
const remoteClientDialogVisible = ref(false);
const customerForm = reactive({ name: '', loginUsername: '', loginPassword: '', email: '', phone: '', balance: 0, status: 'active' as 'active' | 'disabled', remark: '' });
const bindForm = reactive({ customerId: '', serviceNodeId: '', expireAt: defaultExpireAt(), trafficLimitGb: undefined as number | undefined });
const nodeEditForm = reactive({ customerId: '', customerNodeId: '', serviceNodeId: '', xuiEmail: '', expireAt: '', trafficLimitGb: undefined as number | undefined, remoteControl: 'reference' as CustomerNode['remoteControl'], originalServiceNodeId: '', originalXuiEmail: '', originalRemoteControl: 'reference' as CustomerNode['remoteControl'], takeover: false });
const remoteClientForm = reactive({ customerId: '', customerNodeId: '', xuiEmail: '', mode: 'edit' as 'create' | 'edit', expireAt: '', trafficLimitGb: 0, enabled: true });
const balanceForm = reactive({ customerId: '', mode: 'add' as 'add' | 'subtract' | 'set', amount: 0, remark: '' });
const renewMonths = ref<Record<string, number>>({});
const selectedCustomerForNodes = ref<Customer | null>(null);

const selectedCustomer = computed(() => customers.value.find((item) => item.id === bindForm.customerId));
const activeCustomerCount = computed(() => customers.value.filter((item) => item.status === 'active').length);
const boundNodeCount = computed(() => customers.value.reduce((total, item) => total + (item.nodes?.length || 0), 0));
const activeBoundNodeCount = computed(() => customers.value.reduce((total, item) => total + (item.nodes?.filter((node) => node.status === 'active').length || 0), 0));
const expiredBoundNodeCount = computed(() => customers.value.reduce((total, item) => total + (item.nodes?.filter((node) => isExpiredNode(node)).length || 0), 0));
const expiringBoundNodeCount = computed(() => customers.value.reduce((total, item) => total + (item.nodes?.filter((node) => isExpiringNode(node)).length || 0), 0));
const customerRangeText = computed(() => {
  if (!customerTotal.value) return '0 / 0';
  const start = (customerPage.page - 1) * customerPage.pageSize + 1;
  const end = Math.min(customerPage.page * customerPage.pageSize, customerTotal.value);
  return `${start}-${end} / ${customerTotal.value}`;
});

async function loadCustomers(resetPage = false) {
  if (resetPage) customerPage.page = 1;
  loading.value = true;
  error.value = '';
  try {
    const params = customerQueryParams();
    const [customerResult, nodeResult] = await Promise.all([
      api<PageResult<Customer>>(`/api/admin/customers?${params.toString()}`),
      api<ServiceNode[]>('/api/admin/service-nodes')
    ]);
    customers.value = customerResult.items;
    customerTotal.value = customerResult.total;
    customerPage.page = customerResult.page;
    customerPage.pageSize = customerResult.pageSize;
    if (selectedCustomerForNodes.value) {
      const refreshed = customerResult.items.find((item) => item.id === selectedCustomerForNodes.value?.id) || null;
      selectedCustomerForNodes.value = refreshed;
      if (!refreshed) customerNodeDialogVisible.value = false;
    }
    serviceNodes.value = nodeResult;
    if (!bindForm.customerId && customerResult.items[0]) bindForm.customerId = customerResult.items[0].id;
    if (!balanceForm.customerId && customerResult.items[0]) balanceForm.customerId = customerResult.items[0].id;
    if (!bindForm.serviceNodeId && nodeResult[0]) bindForm.serviceNodeId = nodeResult[0].id;
  } catch (caught) {
    error.value = readableError(caught, '加载失败');
  } finally {
    loading.value = false;
  }
}

function customerQueryParams() {
  const params = new URLSearchParams({ page: String(customerPage.page), pageSize: String(customerPage.pageSize) });
  if (customerFilters.keyword.trim()) params.set('keyword', customerFilters.keyword.trim());
  if (customerFilters.status) params.set('status', customerFilters.status);
  if (customerFilters.balanceMin !== undefined) params.set('balanceMin', String(customerFilters.balanceMin));
  if (customerFilters.balanceMax !== undefined) params.set('balanceMax', String(customerFilters.balanceMax));
  return params;
}

function resetCustomerFilters() {
  Object.assign(customerFilters, { keyword: '', status: '', balanceMin: undefined, balanceMax: undefined });
  void loadCustomers(true);
}

function handleCustomerPageChange(page: number) {
  customerPage.page = page;
  void loadCustomers();
}

function handleCustomerPageSizeChange(pageSize: number) {
  customerPage.pageSize = pageSize;
  void loadCustomers(true);
}

async function saveCustomer() {
  if (savingCustomer.value) return;
  savingCustomer.value = true;
  error.value = '';
  try {
    const body = editingCustomerId.value
      ? { ...customerForm, balance: undefined, loginPassword: customerForm.loginPassword || undefined }
      : { ...customerForm, loginPassword: customerForm.loginPassword || undefined };
    const path = editingCustomerId.value ? `/api/admin/customers/${editingCustomerId.value}` : '/api/admin/customers';
    await api(path, { method: editingCustomerId.value ? 'PATCH' : 'POST', body });
    ElMessage.success(editingCustomerId.value ? '用户已更新' : '用户已新增');
    customerDialogVisible.value = false;
    resetCustomerForm();
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '保存失败');
  } finally {
    savingCustomer.value = false;
  }
}

async function bindNode() {
  if (binding.value || !bindForm.customerId || !bindForm.serviceNodeId) return;
  binding.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${bindForm.customerId}/nodes`, {
      method: 'POST',
      body: {
        serviceNodeId: bindForm.serviceNodeId,
        expireAt: dateForApi(bindForm.expireAt),
        trafficLimitGb: bindForm.trafficLimitGb,
        remoteControl: 'fully_managed',
        remoteAction: 'create',
        takeover: true
      }
    });
    ElMessage.success('官方客户端已创建并绑定');
    bindDialogVisible.value = false;
    Object.assign(bindForm, { expireAt: defaultExpireAt(), trafficLimitGb: undefined });
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '绑定失败');
  } finally {
    binding.value = false;
  }
}

async function updateCustomerNode() {
  if (updatingCustomerNode.value || !nodeEditForm.customerId || !nodeEditForm.customerNodeId || !nodeEditForm.serviceNodeId) return;
  updatingCustomerNode.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${nodeEditForm.customerId}/nodes/${nodeEditForm.customerNodeId}`, {
      method: 'PATCH',
      body: {
        serviceNodeId: nodeEditForm.serviceNodeId,
        xuiEmail: nodeEditForm.xuiEmail,
        expireAt: nodeEditForm.expireAt || null,
        trafficLimitGb: nodeEditForm.trafficLimitGb,
        remoteControl: nodeEditForm.remoteControl,
        takeover: nodeEditForm.takeover
      }
    });
    ElMessage.success('更新成功');
    editNodeDialogVisible.value = false;
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '更新失败');
  } finally {
    updatingCustomerNode.value = false;
  }
}

async function adjustBalance() {
  if (adjustingBalance.value || !balanceForm.customerId || balanceForm.amount <= 0) return;
  adjustingBalance.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${balanceForm.customerId}/balance-adjustments`, {
      method: 'POST',
      body: {
        mode: balanceForm.mode,
        amount: balanceForm.amount,
        remark: balanceForm.remark || undefined
      }
    });
    ElMessage.success('余额已调整');
    balanceDialogVisible.value = false;
    Object.assign(balanceForm, { mode: 'add', amount: 0, remark: '' });
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '调整失败');
  } finally {
    adjustingBalance.value = false;
  }
}

async function syncNode(customer: Customer, node: CustomerNode) {
  if (syncingIds.value.has(node.id)) return;
  syncingIds.value = new Set(syncingIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/sync`, { method: 'POST' });
    ElMessage.success('同步成功');
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '同步失败');
  } finally {
    const done = new Set(syncingIds.value);
    done.delete(node.id);
    syncingIds.value = done;
  }
}

async function renewNode(customer: Customer, node: CustomerNode) {
  if (renewingIds.value.has(node.id)) return;
  const months = renewMonths.value[node.id] || 1;
  renewingIds.value = new Set(renewingIds.value).add(node.id);
  error.value = '';
  const requestKey = `${customer.id}:${node.id}:${months}`;
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/renew`, {
      method: 'POST',
      body: { months, requestId: renewalRequestId(requestKey) }
    });
    clearRenewalRequestId(requestKey);
    ElMessage.success('续费成功');
    await loadCustomers();
  } catch (caught) {
    if (!shouldReuseRenewalRequest(readableError(caught, '续费失败'))) clearRenewalRequestId(requestKey);
    notifyError(caught, '续费失败');
  } finally {
    const done = new Set(renewingIds.value);
    done.delete(node.id);
    renewingIds.value = done;
  }
}

function shouldReuseRenewalRequest(message: string) {
  return /请求超时|网络异常|不会重复扣款|系统将自动恢复|正在续费/.test(message);
}

function renewalRequestId(requestKey: string) {
  const storageKey = `shiye:admin-renewal:${requestKey}`;
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, created);
  return created;
}

function clearRenewalRequestId(requestKey: string) {
  window.sessionStorage.removeItem(`shiye:admin-renewal:${requestKey}`);
}

async function showNodeTraffic(customer: Customer, node: CustomerNode) {
  trafficIds.value = new Set(trafficIds.value).add(node.id);
  error.value = '';
  try {
    const result = await api<{ traffic?: Record<string, unknown>; xuiEmail?: string }>(`/api/admin/customers/${customer.id}/nodes/${node.id}/traffic`);
    const traffic = result.traffic || {};
    await ElMessageBox.alert([
      `客户端：${result.xuiEmail || node.xuiEmail}`,
      `启用状态：${traffic.enable ?? '-'}`,
      `上传流量：${formatBytes(Number(traffic.up || 0))}`,
      `下载流量：${formatBytes(Number(traffic.down || 0))}`,
      `总流量：${formatBytes(Number(traffic.total || 0))}`,
      `到期时间：${formatRemoteExpiry(traffic.expiryTime)}`,
      `最近在线：${formatRemoteLastOnline(traffic.lastOnline)}`
    ].join('\n'), '3x-ui 客户端流量', { type: 'info', customClass: 'customer-dark-message-box' });
  } catch (caught) {
    notifyError(caught, '读取失败');
  } finally {
    const next = new Set(trafficIds.value);
    next.delete(node.id);
    trafficIds.value = next;
  }
}

async function resetNodeTraffic(customer: Customer, node: CustomerNode) {
  if (resettingTrafficIds.value.has(node.id)) return;
  await ElMessageBox.confirm(`确认重置「${node.serviceNode?.name || node.xuiEmail}」这个远端客户端的流量？`, '重置客户端流量', { type: 'warning', customClass: 'customer-dark-message-box' });
  resettingTrafficIds.value = new Set(resettingTrafficIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/reset-traffic`, { method: 'POST' });
    ElMessage.success('远端客户端流量已重置');
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '重置失败');
  } finally {
    const next = new Set(resettingTrafficIds.value);
    next.delete(node.id);
    resettingTrafficIds.value = next;
  }
}

function openRemoteClientDialog(customer: Customer, node: CustomerNode, mode: 'create' | 'edit') {
  Object.assign(remoteClientForm, {
    customerId: customer.id,
    customerNodeId: node.id,
    xuiEmail: node.xuiEmail,
    mode,
    expireAt: node.expireAt || '',
    trafficLimitGb: Number(node.trafficLimitGb || 0),
    enabled: node.status === 'active'
  });
  remoteClientDialogVisible.value = true;
}

async function saveRemoteClient() {
  if (updatingCustomerNode.value || !remoteClientForm.customerId || !remoteClientForm.customerNodeId) return;
  updatingCustomerNode.value = true;
  error.value = '';
  try {
    await api(`/api/admin/customers/${remoteClientForm.customerId}/nodes/${remoteClientForm.customerNodeId}/remote-client`, {
      method: remoteClientForm.mode === 'create' ? 'POST' : 'PATCH',
      body: remoteClientForm.mode === 'create'
        ? {
            email: remoteClientForm.xuiEmail,
            expireAt: remoteClientForm.expireAt || null,
            trafficLimitGb: remoteClientForm.trafficLimitGb,
            enabled: remoteClientForm.enabled
          }
        : {
            expireAt: remoteClientForm.expireAt || null,
            trafficLimitGb: remoteClientForm.trafficLimitGb,
            enabled: remoteClientForm.enabled
          }
    });
    ElMessage.success(remoteClientForm.mode === 'create' ? '远端客户端已创建' : '远端客户端已更新');
    remoteClientDialogVisible.value = false;
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, remoteClientForm.mode === 'create' ? '创建失败' : '更新失败');
  } finally {
    updatingCustomerNode.value = false;
  }
}

async function deleteRemoteClient(customer: Customer, node: CustomerNode) {
  if (deletingRemoteClientIds.value.has(node.id)) return;
  await ElMessageBox.confirm(`确认删除官方面板中的客户端「${node.xuiEmail}」？本地用户绑定会保留并标记停用，后续可使用同一标识重新创建；该操作不会删除用户、服务节点或其他官方账号。`, '删除远端客户端', {
    type: 'warning',
    customClass: 'customer-dark-message-box',
    confirmButtonText: '删除远端客户端',
    cancelButtonText: '取消'
  });
  deletingRemoteClientIds.value = new Set(deletingRemoteClientIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/remote-client`, { method: 'DELETE' });
    ElMessage.success('远端客户端已删除，本地绑定已保留');
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '删除失败');
  } finally {
    const next = new Set(deletingRemoteClientIds.value);
    next.delete(node.id);
    deletingRemoteClientIds.value = next;
  }
}

async function unbindNode(customer: Customer, node: CustomerNode) {
  await ElMessageBox.confirm(`确认解绑「${node.serviceNode?.name || node.xuiEmail}」？解绑只移除本地关系，不删除远端客户端。`, '解绑确认', { type: 'warning', customClass: 'customer-dark-message-box' });
  await api(`/api/admin/customers/${customer.id}/nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('节点已解绑');
  await loadCustomers();
}

async function deleteBoundServiceNode(customer: Customer, node: CustomerNode) {
  if (deletingServiceNodeIds.value.has(node.id)) return;
  if (!node.serviceNode?.id) {
    notifyError('该绑定缺少服务节点信息，无法删除服务节点');
    return;
  }
  const managed = node.serviceNode.ownership === 'managed';
  const message = managed
    ? `确认删除服务节点「${node.serviceNode.name}」？该节点由本系统托管，将删除本地全部绑定、远端入站及其中全部客户端。`
    : `确认删除本地服务节点「${node.serviceNode.name}」？该节点是官方面板引用资源，只删除本地节点和绑定，不修改远端入站或客户端。`;
  await ElMessageBox.confirm(message, '删除服务节点', { type: 'warning', customClass: 'customer-dark-message-box' });
  deletingServiceNodeIds.value = new Set(deletingServiceNodeIds.value).add(node.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}/nodes/${node.id}/service-node`, { method: 'DELETE' });
    ElMessage.success('删除成功');
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '删除失败');
  } finally {
    const next = new Set(deletingServiceNodeIds.value);
    next.delete(node.id);
    deletingServiceNodeIds.value = next;
  }
}

async function revealEditingCustomerPassword() {
  if (!editingCustomerId.value) return;
  readingPasswordIds.value = new Set(readingPasswordIds.value).add(editingCustomerId.value);
  error.value = '';
  try {
    const result = await api<{ loginPassword: string }>(`/api/admin/customers/${editingCustomerId.value}/secrets`);
    if (!result.loginPassword) {
      await ElMessageBox.alert('该用户没有可读取的已保存密码。历史用户如果只保存了哈希，需要管理员重置密码，或用户下次自行修改密码后才可读取。', '读取密码', { type: 'warning', customClass: 'customer-dark-message-box' });
      return;
    }
    customerForm.loginPassword = result.loginPassword;
    ElMessage.success('已读取到登录密码输入框');
  } catch (caught) {
    notifyError(caught, '读取失败');
  } finally {
    const next = new Set(readingPasswordIds.value);
    next.delete(editingCustomerId.value);
    readingPasswordIds.value = next;
  }
}

function openCustomerDialog() {
  resetCustomerForm();
  customerDialogVisible.value = true;
}

function openBindDialog(customer?: Customer) {
  if (customer) bindForm.customerId = customer.id;
  if (!bindForm.customerId && customers.value[0]) bindForm.customerId = customers.value[0].id;
  if (!bindForm.serviceNodeId && serviceNodes.value[0]) bindForm.serviceNodeId = serviceNodes.value[0].id;
  bindForm.expireAt = bindForm.expireAt || defaultExpireAt();
  bindDialogVisible.value = true;
}

function openBalanceDialog(customer?: Customer) {
  if (customer) balanceForm.customerId = customer.id;
  if (!balanceForm.customerId && customers.value[0]) balanceForm.customerId = customers.value[0].id;
  balanceDialogVisible.value = true;
}

function openCustomerNodesDialog(customer: Customer) {
  selectedCustomerForNodes.value = customer;
  customerNodeDialogVisible.value = true;
}

function editCustomerNode(customer: Customer, node: CustomerNode) {
  Object.assign(nodeEditForm, {
    customerId: customer.id,
    customerNodeId: node.id,
    serviceNodeId: node.serviceNode?.id || '',
    xuiEmail: node.xuiEmail,
    expireAt: node.expireAt || '',
    trafficLimitGb: node.trafficLimitGb === undefined || node.trafficLimitGb === null ? undefined : Number(node.trafficLimitGb),
    remoteControl: node.remoteControl || 'reference',
    originalServiceNodeId: node.serviceNode?.id || '',
    originalXuiEmail: node.xuiEmail,
    originalRemoteControl: node.remoteControl || 'reference',
    takeover: false
  });
  editNodeDialogVisible.value = true;
}

function editCustomer(customer: Customer) {
  editingCustomerId.value = customer.id;
  Object.assign(customerForm, {
    name: customer.name,
    loginUsername: customer.loginUsername,
    loginPassword: '',
    email: customer.email || '',
    phone: customer.phone || '',
    balance: Number(customer.balance),
    status: customer.status,
    remark: customer.remark || ''
  });
  customerDialogVisible.value = true;
}

async function removeCustomer(customer: Customer) {
  if (deletingCustomerIds.value.has(customer.id)) return;
  try {
    await ElMessageBox.confirm(`确认删除用户「${customer.name}」？系统只会删除面板用户和本地绑定，不会删除路由节点或远端 3x-ui 入站/客户端。`, '删除确认', {
      type: 'warning',
      customClass: 'customer-dark-message-box',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消'
    });
  } catch {
    return;
  }

  error.value = '';
  deletingCustomerIds.value = new Set(deletingCustomerIds.value).add(customer.id);
  try {
    await api(`/api/admin/customers/${customer.id}`, { method: 'DELETE' });
    ElMessage.success('用户已删除');
    if (editingCustomerId.value === customer.id) resetCustomerForm();
    await loadCustomers();
  } catch (caught) {
    notifyError(caught, '删除失败');
  } finally {
    const next = new Set(deletingCustomerIds.value);
    next.delete(customer.id);
    deletingCustomerIds.value = next;
  }
}

async function handleCustomerCommand(customer: Customer, command: string) {
  if (command === 'edit') return editCustomer(customer);
  if (command === 'bind') return openBindDialog(customer);
  if (command === 'balance') return openBalanceDialog(customer);
  if (command === 'toggle') return toggleCustomerStatus(customer, customer.status !== 'active');
  if (command === 'delete') return removeCustomer(customer);
}

async function toggleCustomerStatus(customer: Customer, enabled: boolean | string | number) {
  if (togglingCustomerIds.value.has(customer.id)) return;
  const previous = customer.status;
  const nextStatus: Customer['status'] = Boolean(enabled) ? 'active' : 'disabled';
  customer.status = nextStatus;
  togglingCustomerIds.value = new Set(togglingCustomerIds.value).add(customer.id);
  error.value = '';
  try {
    await api(`/api/admin/customers/${customer.id}`, { method: 'PATCH', body: { status: nextStatus } });
    ElMessage.success(nextStatus === 'active' ? '用户已启用' : '用户已禁用');
  } catch (caught) {
    customer.status = previous;
    notifyError(caught, '更新失败');
  } finally {
    const next = new Set(togglingCustomerIds.value);
    next.delete(customer.id);
    togglingCustomerIds.value = next;
  }
}

function resetCustomerForm() {
  editingCustomerId.value = '';
  Object.assign(customerForm, { name: '', loginUsername: '', loginPassword: '', email: '', phone: '', balance: 0, status: 'active', remark: '' });
}

function remoteControlLabel(mode: CustomerNode['remoteControl']) {
  if (mode === 'fully_managed') return '完全托管';
  if (mode === 'subscription_managed') return '订阅托管';
  return '只读引用';
}

function controlRank(mode: CustomerNode['remoteControl']) {
  if (mode === 'fully_managed') return 2;
  if (mode === 'subscription_managed') return 1;
  return 0;
}

function editRequiresTakeover() {
  if (nodeEditForm.remoteControl === 'reference') return false;
  const identityChanged = nodeEditForm.serviceNodeId !== nodeEditForm.originalServiceNodeId
    || nodeEditForm.xuiEmail.trim() !== nodeEditForm.originalXuiEmail;
  return identityChanged || controlRank(nodeEditForm.remoteControl) > controlRank(nodeEditForm.originalRemoteControl);
}

function serviceNodeDeleteLabel(node: CustomerNode) {
  return node.serviceNode?.ownership === 'managed' ? '删除服务节点与远端入站' : '删除本地服务节点';
}

function setBindExpireNow() {
  bindForm.expireAt = formatDatePickerValue(new Date());
}

function setBindExpireMonths(months: number) {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  bindForm.expireAt = formatDatePickerValue(date);
}

function clearBindExpire() {
  bindForm.expireAt = '';
}

function setEditExpireNow() {
  nodeEditForm.expireAt = formatDatePickerValue(new Date());
}

function setEditExpireMonths(months: number) {
  const date = new Date();
  date.setMonth(date.getMonth() + months);
  nodeEditForm.expireAt = formatDatePickerValue(date);
}

function clearEditExpire() {
  nodeEditForm.expireAt = '';
}

function defaultExpireAt() {
  const date = new Date();
  date.setMonth(date.getMonth() + 1);
  return formatDatePickerValue(date);
}

function formatDatePickerValue(date: Date) {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const timezoneOffset = -date.getTimezoneOffset();
  const sign = timezoneOffset >= 0 ? '+' : '-';
  const offsetHours = pad(Math.floor(Math.abs(timezoneOffset) / 60));
  const offsetMinutes = pad(Math.abs(timezoneOffset) % 60);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${offsetHours}:${offsetMinutes}`;
}

function dateForApi(value?: string | null) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('到期时间格式无效，请重新选择');
  return new Date(timestamp).toISOString();
}

function formatDate(value?: string | null) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatShortDate(value?: string | null) {
  if (!value) return '未设置';
  return new Date(value).toLocaleDateString('zh-CN');
}

function customerNearestExpiry(customer: Customer) {
  const timestamps = (customer.nodes || [])
    .map((node) => node.expireAt)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter(Number.isFinite);
  const future = timestamps.filter((value) => value > Date.now()).sort((left, right) => left - right);
  const expired = timestamps.filter((value) => value <= Date.now()).sort((left, right) => right - left);
  const nearest = future[0] ?? expired[0];
  return nearest ? new Date(nearest).toISOString() : null;
}

function customerExpiryState(customer: Customer) {
  const nodes = customer.nodes || [];
  if (nodes.some((node) => isExpiredNode(node))) return { label: '存在到期绑定', tone: 'danger' };
  if (nodes.some((node) => isExpiringNode(node))) return { label: '临近到期', tone: 'warning' };
  if (!nodes.some((node) => node.expireAt)) return { label: '未设置到期', tone: 'neutral' };
  return { label: '服务有效', tone: 'success' };
}

function customerInitial(customer: Customer) {
  return Array.from(customer.name.trim() || customer.loginUsername.trim() || '用户')[0]?.toUpperCase() || '用';
}

function customerAvatarStyle(customer: Customer) {
  const seed = customer.loginUsername.trim() || customer.id || customer.name.trim() || '用户';
  let hash = 0;
  for (const char of Array.from(seed)) {
    hash = ((hash << 5) - hash + (char.codePointAt(0) || 0)) | 0;
  }
  const palette = customerAvatarPalettes[Math.abs(hash) % customerAvatarPalettes.length] || customerAvatarPalettes[0];
  return {
    '--customer-avatar-start': palette[0],
    '--customer-avatar-end': palette[1]
  };
}

function isExpiredNode(node: CustomerNode) {
  if (!node.expireAt) return false;
  return new Date(node.expireAt).getTime() <= Date.now();
}

function isExpiringNode(node: CustomerNode) {
  if (!node.expireAt) return false;
  const remaining = new Date(node.expireAt).getTime() - Date.now();
  return remaining > 0 && remaining <= 7 * 24 * 60 * 60 * 1000;
}

function nodeExpireStatus(node: CustomerNode) {
  if (!node.expireAt) return { label: '未设置到期', type: 'info' };
  const expireTime = new Date(node.expireAt).getTime();
  if (expireTime <= Date.now()) return { label: '已到期', type: 'danger' };
  if (expireTime - Date.now() <= 7 * 24 * 60 * 60 * 1000) return { label: '临近到期', type: 'warning' };
  return { label: '有效', type: 'success' };
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatRemoteExpiry(value: unknown) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '-';
  return new Date(time).toLocaleString('zh-CN', { hour12: false });
}

function formatRemoteLastOnline(value: unknown) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '-';
  return new Date(time * 1000).toLocaleString('zh-CN', { hour12: false });
}

onMounted(loadCustomers);
</script>

<template>
  <div class="customer-management-page" :class="{ loading }">
    <header class="customer-page-header">
      <div>
        <h1>用户管理</h1>
        <p>管理面板登录用户、账户余额与 3x-ui 路由节点绑定。</p>
      </div>
      <div class="customer-page-actions">
        <el-button class="customer-secondary-button" :loading="loading" @click="loadCustomers()"><RefreshCw :size="15" />刷新</el-button>
        <el-button class="customer-secondary-button" @click="openBalanceDialog()"><Wallet :size="15" />调整余额</el-button>
        <el-button type="primary" @click="openCustomerDialog"><Plus :size="15" />新增用户</el-button>
      </div>
    </header>

    <el-alert v-if="error" class="customer-page-alert" :title="error" type="error" show-icon :closable="false" />

    <section class="customer-stat-grid" aria-label="当前用户统计">
      <article class="customer-stat-card">
        <span class="customer-stat-icon tone-indigo"><Users :size="18" /></span>
        <div><small>用户总数</small><strong>{{ customerTotal }}</strong><span>符合当前筛选条件</span></div>
      </article>
      <article class="customer-stat-card">
        <span class="customer-stat-icon tone-emerald"><CircleCheckBig :size="18" /></span>
        <div><small>当前页启用</small><strong>{{ activeCustomerCount }}</strong><span>本页共 {{ customers.length }} 位用户</span></div>
      </article>
      <article class="customer-stat-card">
        <span class="customer-stat-icon tone-cyan"><Link2 :size="18" /></span>
        <div><small>当前页绑定</small><strong>{{ boundNodeCount }}</strong><span>其中启用 {{ activeBoundNodeCount }} 个</span></div>
      </article>
      <article class="customer-stat-card">
        <span class="customer-stat-icon tone-amber"><CalendarClock :size="18" /></span>
        <div><small>临近 / 已到期</small><strong>{{ expiringBoundNodeCount }} / {{ expiredBoundNodeCount }}</strong><span>按当前页绑定统计</span></div>
      </article>
    </section>

    <section class="customer-filter-panel">
      <div class="customer-search-field">
        <Search :size="16" />
        <el-input v-model="customerFilters.keyword" clearable placeholder="搜索名称、账号、邮箱、手机或绑定节点" @keyup.enter="loadCustomers(true)" />
      </div>
      <el-select v-model="customerFilters.status" clearable placeholder="全部状态" class="customer-filter-select" @change="loadCustomers(true)">
        <el-option label="启用" value="active" />
        <el-option label="禁用" value="disabled" />
      </el-select>
      <el-input-number v-model="customerFilters.balanceMin" :min="0" :precision="2" placeholder="最低余额" controls-position="right" class="customer-balance-filter" />
      <el-input-number v-model="customerFilters.balanceMax" :min="0" :precision="2" placeholder="最高余额" controls-position="right" class="customer-balance-filter" />
      <el-button class="customer-secondary-button" @click="resetCustomerFilters"><RotateCcw :size="15" />重置</el-button>
      <el-button type="primary" :loading="loading" @click="loadCustomers(true)"><Search :size="15" />查询</el-button>
    </section>

    <section v-loading="loading" class="customer-user-grid">
      <article v-for="customer in customers" :key="customer.id" class="customer-user-card entity-runtime-card" :class="customer.status === 'active' ? 'runtime-state-online' : 'runtime-state-disabled'">
        <header class="customer-card-header">
          <div class="customer-card-identity">
            <span class="customer-card-avatar" :style="customerAvatarStyle(customer)">{{ customerInitial(customer) }}</span>
            <div>
              <strong>{{ customer.name }}</strong>
              <span>@{{ customer.loginUsername }}</span>
            </div>
          </div>
          <span class="customer-status-chip" :class="customer.status === 'active' ? 'is-active' : 'is-disabled'"><i></i>{{ customer.status === 'active' ? '启用' : '禁用' }}</span>
        </header>

        <div class="customer-card-meta runtime-metric-grid">
          <div class="runtime-metric tone-indigo"><span>账户余额</span><strong>¥ {{ Number(customer.balance).toFixed(2) }}</strong></div>
          <div class="runtime-metric tone-cyan"><span>绑定节点</span><strong>{{ customer.nodes?.length || 0 }} 个</strong></div>
          <div class="runtime-metric" :class="'tone-' + customerExpiryState(customer).tone"><span>最近到期</span><strong>{{ formatShortDate(customerNearestExpiry(customer)) }}</strong></div>
        </div>

        <div class="runtime-info-line customer-runtime-info">
          <span><UserRound :size="13" />{{ customer.email || customer.phone || '未填写联系方式' }}</span>
          <span><CalendarClock :size="13" />创建于 {{ formatShortDate(customer.createdAt) }}</span>
        </div>

        <div class="customer-service-line runtime-tag-line">
          <span class="customer-expiry-chip" :class="`is-${customerExpiryState(customer).tone}`"><i></i>{{ customerExpiryState(customer).label }}</span>
          <span v-if="customer.remark" class="customer-card-remark" :title="customer.remark">{{ customer.remark }}</span>
        </div>

        <footer class="customer-card-actions runtime-card-footer">
          <span class="runtime-footer-label"><Activity :size="13" />{{ customer.nodes?.length || 0 }} 个绑定，{{ (customer.nodes || []).filter((node) => node.status === 'active').length }} 个启用</span>
          <div class="runtime-action-group">
          <el-tooltip content="节点详情" placement="top">
            <el-button class="runtime-icon-button" aria-label="节点详情" @click="openCustomerNodesDialog(customer)"><Link2 :size="15" /></el-button>
          </el-tooltip>
          <el-tooltip content="编辑用户" placement="top">
            <el-button class="runtime-icon-button" aria-label="编辑用户" @click="editCustomer(customer)"><Edit3 :size="15" /></el-button>
          </el-tooltip>
          <el-tooltip :content="customer.status === 'active' ? '禁用用户' : '启用用户'" placement="top">
            <el-switch
              class="runtime-toggle-switch"
              :model-value="customer.status === 'active'"
              :loading="togglingCustomerIds.has(customer.id)"
              :disabled="togglingCustomerIds.has(customer.id)"
              @change="(enabled: boolean | string | number) => toggleCustomerStatus(customer, enabled)"
            />
          </el-tooltip>
          <el-dropdown trigger="click" placement="bottom-end" @command="(command: string) => handleCustomerCommand(customer, command)">
            <el-button class="customer-more-button runtime-icon-button" aria-label="更多操作" title="更多操作"><MoreHorizontal :size="17" /></el-button>
            <template #dropdown>
              <el-dropdown-menu class="customer-action-menu">
                <el-dropdown-item command="edit"><Edit3 :size="14" />编辑用户</el-dropdown-item>
                <el-dropdown-item command="bind"><Link2 :size="14" />绑定节点</el-dropdown-item>
                <el-dropdown-item command="balance"><Wallet :size="14" />调整余额</el-dropdown-item>
                <el-dropdown-item command="delete" divided :disabled="deletingCustomerIds.has(customer.id)"><Trash2 :size="14" />{{ deletingCustomerIds.has(customer.id) ? '正在删除' : '删除用户' }}</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          </div>
        </footer>
      </article>
      <div v-if="!customers.length && !loading" class="customer-empty-state"><Users :size="30" /><strong>暂无用户数据</strong><span>调整筛选条件或新增用户后再查看。</span></div>
    </section>

    <footer class="customer-list-footer">
      <span>显示 {{ customerRangeText }}</span>
      <el-pagination
        background
        layout="sizes, prev, pager, next"
        :total="customerTotal"
        :current-page="customerPage.page"
        :page-size="customerPage.pageSize"
        :page-sizes="[10, 20, 50, 100]"
        @current-change="handleCustomerPageChange"
        @size-change="handleCustomerPageSizeChange"
      />
    </footer>
  </div>

  <el-dialog
    v-model="customerNodeDialogVisible"
    class="customer-dark-dialog customer-node-dialog"
    :title="selectedCustomerForNodes ? `${selectedCustomerForNodes.name} 的绑定节点` : '绑定节点'"
    width="960px"
    destroy-on-close
    align-center
  >
    <template v-if="selectedCustomerForNodes">
      <div class="customer-node-dialog-head">
        <div>
          <strong>{{ selectedCustomerForNodes.name }}</strong>
          <span>{{ selectedCustomerForNodes.loginUsername }} · 余额 {{ selectedCustomerForNodes.balance }}</span>
        </div>
        <el-button type="primary" @click="openBindDialog(selectedCustomerForNodes)"><Link2 :size="15" />绑定节点</el-button>
      </div>
      <div v-if="selectedCustomerForNodes.nodes?.length" class="customer-node-dialog-list">
        <article v-for="node in selectedCustomerForNodes.nodes" :key="node.id" class="customer-node-dialog-card entity-card">
          <div class="entity-card-head">
            <div>
              <strong>{{ node.serviceNode?.name || node.xuiEmail }}</strong>
              <span>{{ node.serviceNode?.server?.name || '-' }} / {{ node.xuiEmail }}</span>
            </div>
            <div class="tag-stack">
              <el-tag size="small" :type="node.status === 'active' ? 'success' : 'info'">{{ node.status === 'active' ? '启用' : '停用' }}</el-tag>
              <el-tag size="small" :type="nodeExpireStatus(node).type">{{ nodeExpireStatus(node).label }}</el-tag>
              <el-tag size="small" :type="node.remoteControl === 'fully_managed' ? 'danger' : node.remoteControl === 'subscription_managed' ? 'warning' : 'info'">{{ remoteControlLabel(node.remoteControl) }}</el-tag>
            </div>
          </div>
          <div class="entity-card-stats">
            <div><span>到期</span><strong>{{ formatDate(node.expireAt) }}</strong></div>
            <div><span>流量</span><strong>{{ node.trafficLimitGb ?? '-' }} GB</strong></div>
            <div><span>同步</span><strong>{{ formatDate(node.lastSyncedAt) }}</strong></div>
          </div>
          <div class="node-actions node-action-grid customer-node-dialog-actions">
            <div class="node-action-group renew-action">
              <span class="action-group-label">续费</span>
              <el-select v-model="renewMonths[node.id]" size="small" style="width: 82px">
                <el-option :value="1" label="1月" />
                <el-option :value="3" label="3月" />
                <el-option :value="6" label="6月" />
                <el-option :value="12" label="12月" />
              </el-select>
              <el-button size="small" type="primary" :loading="renewingIds.has(node.id)" :disabled="node.remoteControl === 'reference'" @click="renewNode(selectedCustomerForNodes, node)">续费</el-button>
            </div>
            <div class="node-action-group remote-action">
              <span class="action-group-label">远端客户端</span>
              <el-button size="small" type="primary" plain :loading="syncingIds.has(node.id)" @click="syncNode(selectedCustomerForNodes, node)"><RefreshCw :size="15" />同步</el-button>
              <el-button size="small" class="customer-node-secondary-button" :loading="trafficIds.has(node.id)" @click="showNodeTraffic(selectedCustomerForNodes, node)"><Activity :size="15" />流量</el-button>
              <el-button v-if="node.remoteControl !== 'reference'" size="small" class="customer-node-secondary-button" @click="openRemoteClientDialog(selectedCustomerForNodes, node, 'edit')"><Edit3 :size="15" />设置</el-button>
              <el-button v-if="node.remoteControl === 'fully_managed'" size="small" class="customer-node-secondary-button" @click="openRemoteClientDialog(selectedCustomerForNodes, node, 'create')"><Plus :size="15" />创建</el-button>
              <el-button size="small" class="customer-node-secondary-button" :loading="resettingTrafficIds.has(node.id)" :disabled="node.remoteControl !== 'fully_managed'" @click="resetNodeTraffic(selectedCustomerForNodes, node)"><RotateCcw :size="15" />重置</el-button>
              <el-button v-if="node.remoteControl === 'fully_managed'" size="small" type="danger" plain :loading="deletingRemoteClientIds.has(node.id)" @click="deleteRemoteClient(selectedCustomerForNodes, node)"><Trash2 :size="15" />删除</el-button>
            </div>
            <div class="node-action-group manage-action">
              <span class="action-group-label">本地绑定</span>
              <el-button size="small" class="customer-node-secondary-button" @click="editCustomerNode(selectedCustomerForNodes, node)"><Edit3 :size="15" />编辑</el-button>
              <el-button size="small" class="customer-node-secondary-button" @click="unbindNode(selectedCustomerForNodes, node)"><Unlink :size="15" />解绑</el-button>
            </div>
            <div class="node-action-group danger-action">
              <span class="action-group-label">服务节点</span>
              <el-button size="small" type="danger" plain :loading="deletingServiceNodeIds.has(node.id)" @click="deleteBoundServiceNode(selectedCustomerForNodes, node)"><ServerOff :size="15" />{{ serviceNodeDeleteLabel(node) }}</el-button>
            </div>
          </div>
        </article>
      </div>
      <div v-else class="empty-panel">该用户还没有绑定节点</div>
    </template>
    <template #footer>
      <el-button class="customer-node-close-button" @click="customerNodeDialogVisible = false">关闭</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="customerDialogVisible" class="customer-dark-dialog" :title="editingCustomerId ? '编辑用户' : '新增用户'" width="720px" destroy-on-close>
    <div class="customer-dialog-intro"><UserRound :size="18" /><div><strong>{{ editingCustomerId ? '编辑账户资料' : '创建面板用户' }}</strong><span>填写真实登录资料、联系方式、余额和账户状态。</span></div></div>
    <el-form :model="customerForm" label-width="82px" class="dialog-form-grid customer-dialog-form">
      <el-form-item label="名称"><el-input v-model="customerForm.name" /></el-form-item>
      <el-form-item label="登录账号"><el-input v-model="customerForm.loginUsername" /></el-form-item>
      <el-form-item label="登录密码">
        <div class="password-field-stack">
          <el-input v-model="customerForm.loginPassword" type="password" show-password :placeholder="editingCustomerId ? '留空不修改' : '可留空自动生成'" />
          <el-button v-if="editingCustomerId" size="small" :loading="readingPasswordIds.has(editingCustomerId)" @click="revealEditingCustomerPassword"><KeyRound :size="15" />读取已保存密码</el-button>
        </div>
      </el-form-item>
      <el-form-item label="邮箱"><el-input v-model="customerForm.email" placeholder="可留空" /></el-form-item>
      <el-form-item label="手机"><el-input v-model="customerForm.phone" /></el-form-item>
      <el-form-item v-if="!editingCustomerId" label="初始余额"><el-input-number v-model="customerForm.balance" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      <el-form-item label="状态"><el-select v-model="customerForm.status" style="width: 100%"><el-option label="启用" value="active" /><el-option label="禁用" value="disabled" /></el-select></el-form-item>
      <el-form-item label="备注" class="form-item-full"><el-input v-model="customerForm.remark" type="textarea" :rows="3" placeholder="可填写用户说明" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="customerDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="savingCustomer" :disabled="!customerForm.name || !customerForm.loginUsername" @click="saveCustomer">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="bindDialogVisible" class="customer-dark-dialog" title="绑定路由节点" width="680px" destroy-on-close>
    <div class="customer-dialog-intro"><Link2 :size="18" /><div><strong>选择用户和路由节点即可完成绑定</strong><span>系统会在该节点对应的官方入站中创建独立客户端，并自动完成后续续费、停用和流量同步。</span></div></div>
    <el-form :model="bindForm" label-width="104px" class="dialog-form-grid customer-dialog-form">
      <el-form-item label="用户">
        <el-select v-model="bindForm.customerId" placeholder="选择用户" style="width: 100%">
          <el-option v-for="customer in customers" :key="customer.id" :label="`${customer.name} / ${customer.loginUsername}`" :value="customer.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="节点">
        <el-select v-model="bindForm.serviceNodeId" placeholder="选择节点" style="width: 100%">
          <el-option v-for="node in serviceNodes" :key="node.id" :label="`${node.name} / ${node.server?.name || '-'}`" :value="node.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="到期时间">
        <div class="date-picker-stack">
          <el-date-picker v-model="bindForm.expireAt" type="datetime" placeholder="到期时间，可留空" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 100%" />
          <div class="quick-actions">
            <el-button size="small" @click="setBindExpireNow">当前时间</el-button>
            <el-button size="small" @click="setBindExpireMonths(1)">加 1 月</el-button>
            <el-button size="small" @click="clearBindExpire">清空</el-button>
          </div>
        </div>
      </el-form-item>
      <el-form-item label="流量 GB"><el-input-number v-model="bindForm.trafficLimitGb" :min="0" :precision="2" placeholder="可留空" style="width: 100%" /></el-form-item>
      <el-form-item v-if="selectedCustomer?.nodes?.length" label="已绑定"><span class="muted-text">当前用户已绑定 {{ selectedCustomer.nodes.length }} 个节点</span></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="bindDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="binding" :disabled="!bindForm.customerId || !bindForm.serviceNodeId" @click="bindNode">创建并绑定</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="remoteClientDialogVisible" class="customer-dark-dialog" :title="remoteClientForm.mode === 'create' ? '创建远端客户端' : '设置远端客户端'" width="680px" destroy-on-close>
    <div class="customer-dialog-intro"><ServerOff :size="18" /><div><strong>{{ remoteClientForm.mode === 'create' ? '在官方 3x-ui 入站中创建客户端' : '更新官方 3x-ui 客户端设置' }}</strong><span>{{ remoteClientForm.mode === 'create' ? '使用当前绑定标识创建，适用于远端账号尚不存在或已被人工删除的情况。' : '订阅托管可修改到期、额度与启停；完全托管还可创建、重置流量和删除。' }}</span></div></div>
    <el-form :model="remoteClientForm" label-width="104px" class="dialog-form-grid customer-dialog-form">
      <el-form-item label="远端标识" class="form-item-full"><el-input v-model="remoteClientForm.xuiEmail" disabled /></el-form-item>
      <el-form-item label="到期时间">
        <el-date-picker v-model="remoteClientForm.expireAt" type="datetime" placeholder="留空表示不限期" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 100%" />
      </el-form-item>
      <el-form-item label="流量 GB"><el-input-number v-model="remoteClientForm.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      <el-form-item label="启用状态" class="form-item-full"><el-switch v-model="remoteClientForm.enabled" inline-prompt active-text="启用" inactive-text="停用" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="remoteClientDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="updatingCustomerNode" @click="saveRemoteClient">{{ remoteClientForm.mode === 'create' ? '创建' : '保存' }}</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="editNodeDialogVisible" class="customer-dark-dialog" title="编辑绑定节点" width="760px" destroy-on-close>
    <div class="customer-dialog-intro"><Edit3 :size="18" /><div><strong>更新绑定资料</strong><span>保存后会校验并同步官方面板中已存在的客户端资料，不会创建、改名或替换远端账号。</span></div></div>
    <el-form :model="nodeEditForm" label-width="104px" class="dialog-form-grid customer-dialog-form">
      <el-form-item label="服务节点">
        <el-select v-model="nodeEditForm.serviceNodeId" placeholder="选择节点" style="width: 100%">
          <el-option v-for="node in serviceNodes" :key="node.id" :label="`${node.name} / ${node.server?.name || '-'}`" :value="node.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="远端标识"><el-input v-model="nodeEditForm.xuiEmail" placeholder="必填：准确的 3x-ui 客户端邮箱" /></el-form-item>
      <el-form-item label="控制模式">
        <el-select v-model="nodeEditForm.remoteControl" style="width: 100%">
          <el-option label="只读引用（不修改远端账号）" value="reference" />
          <el-option label="订阅生命周期托管（续费、停用、额度）" value="subscription_managed" />
          <el-option label="完全托管（含创建、重置、删除）" value="fully_managed" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="editRequiresTakeover()" label="接管确认" class="form-item-full">
        <el-checkbox v-model="nodeEditForm.takeover">确认授权本系统按新范围管理该官方客户端；不会改名或替换官方账号</el-checkbox>
      </el-form-item>
      <el-form-item label="到期时间">
        <div class="date-picker-stack">
          <el-date-picker v-model="nodeEditForm.expireAt" type="datetime" placeholder="到期时间，可留空" value-format="YYYY-MM-DDTHH:mm:ss.SSSZ" style="width: 100%" />
          <div class="quick-actions">
            <el-button size="small" @click="setEditExpireNow">当前时间</el-button>
            <el-button size="small" @click="setEditExpireMonths(1)">加 1 月</el-button>
            <el-button size="small" @click="clearEditExpire">清空</el-button>
          </div>
        </div>
      </el-form-item>
      <el-form-item label="流量 GB"><el-input-number v-model="nodeEditForm.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="editNodeDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="updatingCustomerNode" :disabled="!nodeEditForm.serviceNodeId || !nodeEditForm.xuiEmail.trim() || (editRequiresTakeover() && !nodeEditForm.takeover)" @click="updateCustomerNode">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="balanceDialogVisible" class="customer-dark-dialog" title="调整余额" width="680px" destroy-on-close>
    <div class="customer-dialog-intro"><Wallet :size="18" /><div><strong>账户余额变更</strong><span>支持增加、扣减或直接设置余额，变更会记录到财务流水。</span></div></div>
    <el-form :model="balanceForm" label-width="82px" class="dialog-form-grid customer-dialog-form">
      <el-form-item label="用户">
        <el-select v-model="balanceForm.customerId" placeholder="选择用户" style="width: 100%">
          <el-option v-for="customer in customers" :key="customer.id" :label="`${customer.name} / ${customer.loginUsername}`" :value="customer.id" />
        </el-select>
      </el-form-item>
      <el-form-item label="方式"><el-select v-model="balanceForm.mode" style="width: 100%"><el-option label="增加" value="add" /><el-option label="扣减" value="subtract" /><el-option label="设置为" value="set" /></el-select></el-form-item>
      <el-form-item label="金额"><el-input-number v-model="balanceForm.amount" :min="0" :precision="2" style="width: 100%" /></el-form-item>
      <el-form-item label="备注" class="form-item-full"><el-input v-model="balanceForm.remark" type="textarea" :rows="3" placeholder="建议填写本次调整原因" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="balanceDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="adjustingBalance" :disabled="!balanceForm.customerId || balanceForm.amount <= 0" @click="adjustBalance">提交</el-button>
    </template>
  </el-dialog>
</template>
