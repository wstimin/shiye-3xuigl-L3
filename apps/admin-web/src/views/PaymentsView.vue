<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/checkbox-button/style/css';
import 'element-plus/es/components/checkbox-group/style/css';
import 'element-plus/es/components/collapse/style/css';
import 'element-plus/es/components/collapse-item/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/dropdown/style/css';
import 'element-plus/es/components/dropdown-item/style/css';
import 'element-plus/es/components/dropdown-menu/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/switch/style/css';
import { ElAlert, ElButton, ElCheckboxButton, ElCheckboxGroup, ElCollapse, ElCollapseItem, ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu, ElForm, ElFormItem, ElInput, ElInputNumber, ElMessage, ElMessageBox, ElOption, ElSelect, ElSwitch } from 'element-plus';
import {
  Activity,
  AlertTriangle,
  Banknote,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Copy,
  CreditCard,
  Eye,
  KeyRound,
  Landmark,
  Link2,
  MoreHorizontal,
  Plus,
  QrCode,
  RefreshCw,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Trash2
} from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { notifyError } from '../notify';

type PaymentProvider = 'alipay' | 'wechat' | 'epay' | 'bepusdt';
type PaymentChannel = {
  id: string;
  provider: PaymentProvider;
  name: string;
  enabled: boolean;
  sortOrder: number;
  config: {
    url?: string;
    pid?: string;
    appId?: string;
    productName?: string;
    mchId?: string;
    type?: string;
    types?: string[];
    notifyUrl?: string;
    returnUrl?: string;
  };
  hasKey?: boolean;
  hasToken?: boolean;
  hasPrivateKey?: boolean;
  hasPublicKey?: boolean;
  hasApiKey?: boolean;
  notifyUrl?: string;
};
type PaymentChannelSecrets = { key: string; token: string; privateKey: string; publicKey: string; apiKey: string };
type Requirement = { label: string; complete: boolean };

const providerCatalog = [
  { label: '支付宝', value: 'alipay' as const, description: '官方支付宝通道，支持当面付、PC 网站和手机网站支付。', icon: Landmark },
  { label: '微信支付', value: 'wechat' as const, description: '微信商户 V2 Native 扫码支付。', icon: QrCode },
  { label: '易支付', value: 'epay' as const, description: '聚合支付通道，可配置用户端展示的支付子类。', icon: Banknote },
  { label: 'BEpusdt', value: 'bepusdt' as const, description: 'USDT-TRC20 余额充值通道。', icon: CircleDollarSign }
];

const alipayModeOptions = [
  { label: '当面付扫码', value: 'precreate' },
  { label: 'PC 网站支付', value: 'page' },
  { label: '手机网站支付', value: 'wap' }
] as const;

const cryptoTypeOptions = [{ label: 'USDT-TRC20', value: 'usdt.trc20' }] as const;
const epayTypeOptions = [
  { label: '支付宝', value: 'alipay' },
  { label: '微信', value: 'wechat' },
  { label: 'QQ 钱包', value: 'qqpay' },
  { label: '银行卡', value: 'bank' },
  { label: 'PayPal', value: 'paypal' }
] as const;

const loading = ref(false);
const savingChannel = ref(false);
const revealingChannelSecrets = ref(false);
const togglingIds = ref<Set<string>>(new Set());
const error = ref('');
const channels = ref<PaymentChannel[]>([]);
const editingChannelId = ref('');
const channelDialogVisible = ref(false);
const advancedSections = ref<string[]>([]);
const channelForm = reactive({
  provider: 'alipay' as PaymentProvider,
  name: '支付宝',
  enabled: false,
  sortOrder: 0,
  url: 'https://openapi.alipay.com/gateway.do',
  pid: '',
  key: '',
  token: '',
  appId: '',
  privateKey: '',
  publicKey: '',
  productName: '账户余额充值',
  mchId: '',
  apiKey: '',
  type: 'precreate',
  types: ['alipay', 'wechat'] as string[],
  notifyUrl: '',
  returnUrl: ''
});

const callbackOrigin = computed(() => window.location.origin.replace(/\/+$/, ''));
const callbackUrl = computed(() => `${callbackOrigin.value}/api/payments/${channelForm.provider}/notify`);
const currentChannel = computed(() => channels.value.find((item) => item.id === editingChannelId.value));
const currentProvider = computed(() => providerInfo(channelForm.provider));
const secretLabel = computed(() => {
  if (channelForm.provider === 'bepusdt') return 'Token';
  if (channelForm.provider === 'wechat') return 'V2 API 密钥';
  return '商户密钥';
});
const typeOptions = computed(() => {
  if (channelForm.provider === 'alipay') return alipayModeOptions;
  if (channelForm.provider === 'bepusdt') return cryptoTypeOptions;
  return [];
});
const activeChannelCount = computed(() => channels.value.filter((item) => item.enabled).length);
const readyChannelCount = computed(() => channels.value.filter((item) => channelIssues(item).length === 0).length);
const attentionChannelCount = computed(() => channels.value.filter((item) => channelIssues(item).length > 0).length);
const formRequirements = computed<Requirement[]>(() => {
  const requirements: Requirement[] = [
    { label: '显示名称', complete: Boolean(channelForm.name.trim()) }
  ];
  if (channelForm.provider === 'alipay') {
    requirements.push(
      { label: 'AppID', complete: Boolean(channelForm.appId.trim()) },
      { label: '应用私钥', complete: Boolean(channelForm.privateKey.trim() || currentChannel.value?.hasPrivateKey) },
      { label: '支付宝公钥', complete: Boolean(channelForm.publicKey.trim() || currentChannel.value?.hasPublicKey) },
      { label: '公网回调地址', complete: isAbsoluteUrl(channelForm.notifyUrl || callbackUrl.value) }
    );
  } else if (channelForm.provider === 'wechat') {
    requirements.push(
      { label: 'AppID', complete: Boolean(channelForm.appId.trim()) },
      { label: '商户号', complete: Boolean(channelForm.mchId.trim()) },
      { label: 'V2 API 密钥', complete: Boolean(channelForm.apiKey.trim() || currentChannel.value?.hasApiKey) },
      { label: '公网回调地址', complete: isAbsoluteUrl(channelForm.notifyUrl || callbackUrl.value) }
    );
  } else if (channelForm.provider === 'epay') {
    requirements.push(
      { label: '接口地址', complete: isAbsoluteUrl(channelForm.url) },
      { label: '商户号', complete: Boolean(channelForm.pid.trim()) },
      { label: '商户密钥', complete: Boolean(channelForm.key.trim() || currentChannel.value?.hasKey) },
      { label: '用户端支付方式', complete: channelForm.types.length > 0 }
    );
  } else {
    requirements.push(
      { label: '接口地址', complete: isAbsoluteUrl(channelForm.url) },
      { label: 'Token', complete: Boolean(channelForm.token.trim() || currentChannel.value?.hasToken) }
    );
  }
  return requirements;
});
const missingFormRequirements = computed(() => formRequirements.value.filter((item) => !item.complete));
const formCompletion = computed(() => {
  const complete = formRequirements.value.filter((item) => item.complete).length;
  return Math.round((complete / Math.max(formRequirements.value.length, 1)) * 100);
});
const canSaveChannel = computed(() => {
  if (!channelForm.name.trim()) return false;
  return !channelForm.enabled || missingFormRequirements.value.length === 0;
});

async function loadChannels() {
  loading.value = true;
  error.value = '';
  try {
    channels.value = await api<PaymentChannel[]>('/api/admin/payment-channels');
  } catch (caught) {
    error.value = readableError(caught, '加载失败');
  } finally {
    loading.value = false;
  }
}

async function saveChannel() {
  if (!canSaveChannel.value) {
    ElMessage.warning(`启用前请补全：${missingFormRequirements.value.map((item) => item.label).join('、')}`);
    return;
  }
  savingChannel.value = true;
  error.value = '';
  try {
    const path = editingChannelId.value ? `/api/admin/payment-channels/${editingChannelId.value}` : '/api/admin/payment-channels';
    await api(path, { method: editingChannelId.value ? 'PATCH' : 'POST', body: channelBody() });
    ElMessage.success(editingChannelId.value ? '支付通道已更新' : '支付通道已新增');
    channelDialogVisible.value = false;
    resetChannelForm();
    await loadChannels();
  } catch (caught) {
    notifyError(caught, '保存失败');
  } finally {
    savingChannel.value = false;
  }
}

async function toggleChannel(channel: PaymentChannel, enabled: boolean | string | number) {
  const nextEnabled = Boolean(enabled);
  const previous = !nextEnabled;
  if (nextEnabled) {
    const issues = channelIssues(channel);
    if (issues.length) {
      channel.enabled = false;
      ElMessage.warning(`请先完善配置：${issues.join('、')}`);
      return;
    }
  } else {
    try {
      await ElMessageBox.confirm(`停用“${channel.name}”后，用户将无法继续使用该通道充值。`, '停用支付通道', {
        type: 'warning',
        confirmButtonText: '确认停用',
        cancelButtonText: '取消',
        customClass: 'operations-dark-message-box'
      });
    } catch {
      channel.enabled = true;
      return;
    }
  }

  togglingIds.value = new Set(togglingIds.value).add(channel.id);
  error.value = '';
  try {
    await api(`/api/admin/payment-channels/${channel.id}`, { method: 'PATCH', body: { enabled: nextEnabled } });
    ElMessage.success(nextEnabled ? '支付通道已启用' : '支付通道已停用');
    await loadChannels();
  } catch (caught) {
    channel.enabled = previous;
    notifyError(caught, '更新失败');
  } finally {
    const next = new Set(togglingIds.value);
    next.delete(channel.id);
    togglingIds.value = next;
  }
}

function channelBody() {
  const resolvedNotifyUrl = channelForm.notifyUrl || callbackUrl.value;
  return {
    provider: channelForm.provider,
    name: channelForm.name,
    enabled: channelForm.enabled,
    sortOrder: channelForm.sortOrder,
    config: {
      url: channelForm.url,
      pid: channelForm.pid,
      key: channelForm.provider === 'epay' ? channelForm.key : '',
      token: channelForm.provider === 'bepusdt' ? channelForm.token : '',
      appId: ['alipay', 'wechat'].includes(channelForm.provider) ? channelForm.appId : '',
      privateKey: channelForm.provider === 'alipay' ? channelForm.privateKey : '',
      publicKey: channelForm.provider === 'alipay' ? channelForm.publicKey : '',
      productName: ['alipay', 'wechat'].includes(channelForm.provider) ? channelForm.productName : '',
      mchId: channelForm.provider === 'wechat' ? channelForm.mchId : '',
      apiKey: channelForm.provider === 'wechat' ? channelForm.apiKey : '',
      type: channelForm.provider === 'epay' ? '' : channelForm.type,
      types: channelForm.provider === 'epay' ? channelForm.types : [],
      notifyUrl: resolvedNotifyUrl,
      returnUrl: channelForm.returnUrl
    }
  };
}

function openChannelDialog(provider: PaymentProvider) {
  resetChannelForm(provider);
  channelDialogVisible.value = true;
}

function editChannel(channel: PaymentChannel) {
  editingChannelId.value = channel.id;
  advancedSections.value = [];
  Object.assign(channelForm, {
    provider: channel.provider,
    name: channel.name,
    enabled: channel.enabled,
    sortOrder: channel.sortOrder,
    url: channel.config.url || defaultUrl(channel.provider),
    pid: channel.config.pid || '',
    key: '',
    token: '',
    appId: channel.config.appId || '',
    privateKey: '',
    publicKey: '',
    productName: channel.config.productName || '账户余额充值',
    mchId: channel.config.mchId || '',
    apiKey: '',
    type: channel.config.type || defaultType(channel.provider),
    types: channel.provider === 'epay' ? normalizeEpayTypes(channel.config.types) : [],
    notifyUrl: channel.config.notifyUrl || '',
    returnUrl: channel.config.returnUrl || ''
  });
  channelDialogVisible.value = true;
}

async function revealChannelSecrets() {
  if (!editingChannelId.value) return;
  revealingChannelSecrets.value = true;
  error.value = '';
  try {
    const secrets = await api<PaymentChannelSecrets>(`/api/admin/payment-channels/${editingChannelId.value}/secrets`);
    if (channelForm.provider === 'epay') channelForm.key = secrets.key || '';
    if (channelForm.provider === 'bepusdt') channelForm.token = secrets.token || '';
    if (channelForm.provider === 'alipay') {
      channelForm.privateKey = secrets.privateKey || '';
      channelForm.publicKey = secrets.publicKey || '';
    }
    if (channelForm.provider === 'wechat') channelForm.apiKey = secrets.apiKey || '';
    ElMessage.success(hasAnySecret(secrets) ? '已读取保存的支付凭据' : '该通道没有保存凭据');
  } catch (caught) {
    notifyError(caught, '读取失败');
  } finally {
    revealingChannelSecrets.value = false;
  }
}

async function removeChannel(channel: PaymentChannel) {
  try {
    await ElMessageBox.confirm(`删除“${channel.name}”后无法恢复，已有订单记录不会被删除。`, '删除支付通道', {
      type: 'warning',
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      customClass: 'operations-dark-message-box'
    });
    await api(`/api/admin/payment-channels/${channel.id}`, { method: 'DELETE' });
    ElMessage.success('支付通道已删除');
    if (editingChannelId.value === channel.id) resetChannelForm();
    await loadChannels();
  } catch (err) {
    if (err === 'cancel' || err === 'close') return;
    notifyError(err, '删除失败');
  }
}

async function handleChannelCommand(command: string, channel: PaymentChannel) {
  if (command === 'edit') editChannel(channel);
  if (command === 'copy') await copyText(channelCallback(channel));
  if (command === 'delete') await removeChannel(channel);
}

async function copyText(value: string) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    textarea.remove();
  }
  ElMessage.success('地址已复制');
}

function resetChannelForm(provider: PaymentProvider = channelForm.provider) {
  editingChannelId.value = '';
  advancedSections.value = [];
  Object.assign(channelForm, {
    provider,
    name: providerName(provider),
    enabled: false,
    sortOrder: 0,
    url: defaultUrl(provider),
    pid: '',
    key: '',
    token: '',
    appId: '',
    privateKey: '',
    publicKey: '',
    productName: '账户余额充值',
    mchId: '',
    apiKey: '',
    type: defaultType(provider),
    types: provider === 'epay' ? ['alipay', 'wechat'] : [],
    notifyUrl: '',
    returnUrl: ''
  });
}

function defaultUrl(provider: PaymentProvider) {
  if (provider === 'alipay') return 'https://openapi.alipay.com/gateway.do';
  if (provider === 'wechat') return 'https://api.mch.weixin.qq.com/pay/unifiedorder';
  return '';
}

function defaultType(provider: PaymentProvider) {
  if (provider === 'alipay') return 'precreate';
  if (provider === 'bepusdt') return 'usdt.trc20';
  return '';
}

function providerInfo(provider: PaymentProvider): (typeof providerCatalog)[number] {
  return providerCatalog.find((item) => item.value === provider) ?? providerCatalog[0]!;
}

function providerName(provider: PaymentProvider) {
  return providerInfo(provider).label;
}

function paymentTypeLabel(provider: PaymentProvider) {
  if (provider === 'alipay') return '支付模式';
  if (provider === 'bepusdt') return '币种网络';
  return '接口类型';
}

function channelModeLabel(channel: PaymentChannel) {
  if (channel.provider === 'epay') return epayTypeLabels(channel.config.types).join('、') || '未选择';
  if (channel.provider === 'wechat') return 'Native';
  const options = channel.provider === 'alipay' ? alipayModeOptions : channel.provider === 'bepusdt' ? cryptoTypeOptions : [];
  return options.find((item) => item.value === channel.config.type)?.label || channel.config.type || '-';
}

function normalizeEpayTypes(types: unknown) {
  const source = Array.isArray(types) ? types : [];
  const enabled = source.map((item) => String(item)).filter((item) => epayTypeOptions.some((option) => option.value === item));
  return enabled.length ? enabled : ['alipay', 'wechat'];
}

function epayTypeLabels(types: unknown) {
  return normalizeEpayTypes(types).map((type) => epayTypeOptions.find((item) => item.value === type)?.label || type);
}

function hasAnySecret(secrets: PaymentChannelSecrets) {
  return Boolean(secrets.key || secrets.token || secrets.privateKey || secrets.publicKey || secrets.apiKey);
}

function channelCallback(channel: PaymentChannel) {
  return channel.notifyUrl || channel.config.notifyUrl || '';
}

function channelIssues(channel: PaymentChannel) {
  const issues: string[] = [];
  if (channel.provider === 'alipay') {
    if (!channel.config.appId) issues.push('AppID');
    if (!channel.hasPrivateKey) issues.push('应用私钥');
    if (!channel.hasPublicKey) issues.push('支付宝公钥');
    if (!isAbsoluteUrl(channelCallback(channel))) issues.push('公网回调');
  } else if (channel.provider === 'wechat') {
    if (!channel.config.appId) issues.push('AppID');
    if (!channel.config.mchId) issues.push('商户号');
    if (!channel.hasApiKey) issues.push('V2 API 密钥');
    if (!isAbsoluteUrl(channelCallback(channel))) issues.push('公网回调');
  } else if (channel.provider === 'epay') {
    if (!isAbsoluteUrl(channel.config.url || '')) issues.push('接口地址');
    if (!channel.config.pid) issues.push('商户号');
    if (!channel.hasKey) issues.push('商户密钥');
    if (!normalizeEpayTypes(channel.config.types).length) issues.push('支付方式');
  } else {
    if (!isAbsoluteUrl(channel.config.url || '')) issues.push('接口地址');
    if (!channel.hasToken) issues.push('Token');
  }
  return issues;
}

function channelStatus(channel: PaymentChannel) {
  const issues = channelIssues(channel);
  if (channel.enabled && issues.length) return { label: '配置异常', tone: 'danger', icon: AlertTriangle };
  if (channel.enabled) return { label: '运行中', tone: 'success', icon: Activity };
  if (issues.length) return { label: '待完善', tone: 'warning', icon: AlertTriangle };
  return { label: '已停用', tone: 'neutral', icon: CheckCircle2 };
}

function secretState(channel: PaymentChannel) {
  const secretIssues = channelIssues(channel).filter((item) => ['应用私钥', '支付宝公钥', 'V2 API 密钥', '商户密钥', 'Token'].includes(item));
  return secretIssues.length ? `缺少 ${secretIssues.length} 项` : '已安全保存';
}

function callbackState(channel: PaymentChannel) {
  if (!channelCallback(channel)) return '未配置';
  return isAbsoluteUrl(channelCallback(channel)) ? '可用' : '需公网地址';
}

function isAbsoluteUrl(value: string) {
  return /^https?:\/\//i.test(value.trim());
}

onMounted(loadChannels);
</script>

<template>
  <div class="operations-page payments-page" :class="{ loading }">
    <div class="page-head operations-page-header">
      <div class="page-head-main">
        <h1 class="page-title">支付设置</h1>
        <p>统一管理在线充值通道、商户凭据、回调地址和运行状态。</p>
      </div>
      <div class="page-actions">
        <el-dropdown trigger="click" @command="(provider: PaymentProvider) => openChannelDialog(provider)">
          <el-button type="primary"><Plus :size="15" />新增通道<ChevronDown :size="14" /></el-button>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item v-for="provider in providerCatalog" :key="provider.value" :command="provider.value">
                <component :is="provider.icon" :size="15" />{{ provider.label }}
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
        <el-button :loading="loading" @click="loadChannels"><RefreshCw :size="15" />刷新</el-button>
      </div>
    </div>

    <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

    <div class="metric-grid compact-metrics operations-stat-grid payment-overview-grid">
      <div class="metric operations-stat-card"><span class="operations-stat-icon tone-indigo"><CreditCard :size="19" /></span><div><span>全部通道</span><strong>{{ channels.length }}</strong><small>已接入支付通道</small></div></div>
      <div class="metric operations-stat-card"><span class="operations-stat-icon tone-emerald"><Activity :size="19" /></span><div><span>正在运行</span><strong>{{ activeChannelCount }}</strong><small>用户端可用通道</small></div></div>
      <div class="metric operations-stat-card"><span class="operations-stat-icon tone-cyan"><ShieldCheck :size="19" /></span><div><span>配置完整</span><strong>{{ readyChannelCount }}</strong><small>凭据与必要参数齐全</small></div></div>
      <div class="metric operations-stat-card"><span class="operations-stat-icon" :class="attentionChannelCount ? 'tone-rose' : 'tone-amber'"><AlertTriangle :size="19" /></span><div><span>需要处理</span><strong>{{ attentionChannelCount }}</strong><small>{{ attentionChannelCount ? '存在缺失配置' : '所有通道状态正常' }}</small></div></div>
    </div>

    <div class="panel list-panel operations-content-card payment-list-card">
      <div class="panel-toolbar payment-console-toolbar">
        <div>
          <strong>支付通道</strong>
          <span>检查配置完整度并控制用户端可用状态</span>
        </div>
        <span class="payment-running-summary"><i :class="{ active: activeChannelCount }"></i>{{ activeChannelCount }} 个通道运行中</span>
      </div>

      <div v-loading="loading" class="payment-console-grid">
        <section
          v-for="channel in channels"
          :key="channel.id"
          class="payment-console-card"
          :class="[`provider-${channel.provider}`, `status-${channelStatus(channel).tone}`]"
        >
          <div class="payment-card-head">
            <div class="payment-brand-block">
              <span class="payment-brand-icon"><component :is="providerInfo(channel.provider).icon" :size="21" /></span>
              <div>
                <strong>{{ channel.name }}</strong>
                <span>{{ providerName(channel.provider) }} · {{ channelModeLabel(channel) }}</span>
              </div>
            </div>
            <div class="payment-card-controls">
              <span class="payment-status-pill" :class="channelStatus(channel).tone">
                <component :is="channelStatus(channel).icon" :size="13" />{{ channelStatus(channel).label }}
              </span>
              <el-switch
                v-model="channel.enabled"
                :loading="togglingIds.has(channel.id)"
                :aria-label="`${channel.name}启停状态`"
                @change="(value: boolean | string | number) => toggleChannel(channel, value)"
              />
            </div>
          </div>

          <div v-if="channelIssues(channel).length" class="payment-issue-strip">
            <AlertTriangle :size="15" />
            <span>启用前还需配置：{{ channelIssues(channel).join('、') }}</span>
          </div>

          <div class="payment-card-facts">
            <div><KeyRound :size="15" /><span>商户凭据</span><strong :class="{ warning: secretState(channel).startsWith('缺少') }">{{ secretState(channel) }}</strong></div>
            <div><Link2 :size="15" /><span>异步回调</span><strong :class="{ warning: callbackState(channel) !== '可用' }">{{ callbackState(channel) }}</strong></div>
            <div><SlidersHorizontal :size="15" /><span>通道排序</span><strong>{{ channel.sortOrder }}</strong></div>
          </div>

          <div class="payment-callback-row">
            <Link2 :size="14" />
            <span :title="channelCallback(channel)">{{ channelCallback(channel) || '尚未生成回调地址' }}</span>
            <button v-if="channelCallback(channel)" type="button" class="payment-copy-button" title="复制回调地址" @click="copyText(channelCallback(channel))"><Copy :size="14" /></button>
          </div>

          <div class="payment-card-actions">
            <el-button type="primary" plain @click="editChannel(channel)"><Settings2 :size="15" />配置通道</el-button>
            <el-dropdown trigger="click" @command="(command: string) => handleChannelCommand(command, channel)">
              <button type="button" class="payment-more-button" title="更多操作"><MoreHorizontal :size="18" /></button>
              <template #dropdown>
                <el-dropdown-menu>
                  <el-dropdown-item command="edit"><Settings2 :size="15" />编辑配置</el-dropdown-item>
                  <el-dropdown-item v-if="channelCallback(channel)" command="copy"><Copy :size="15" />复制回调地址</el-dropdown-item>
                  <el-dropdown-item command="delete" divided class="payment-delete-menu-item"><Trash2 :size="15" />删除通道</el-dropdown-item>
                </el-dropdown-menu>
              </template>
            </el-dropdown>
          </div>
        </section>

        <div v-if="!channels.length && !loading" class="payment-console-empty">
          <span><CreditCard :size="23" /></span>
          <strong>还没有支付通道</strong>
          <p>选择一种已实现的支付方式，填写真实商户配置后再启用。</p>
          <div class="payment-empty-provider-grid">
            <button
              v-for="provider in providerCatalog"
              :key="provider.value"
              type="button"
              class="payment-empty-provider"
              :class="`provider-${provider.value}`"
              @click="openChannelDialog(provider.value)"
            >
              <span><component :is="provider.icon" :size="18" /></span>
              <strong>{{ provider.label }}</strong>
              <small>{{ provider.description }}</small>
            </button>
          </div>
        </div>
      </div>
    </div>

    <el-dialog
      v-model="channelDialogVisible"
      :title="editingChannelId ? `配置${channelForm.name}` : `新增${providerName(channelForm.provider)}通道`"
      width="920px"
      class="operations-dark-dialog payment-config-dialog"
      destroy-on-close
    >
      <div class="payment-dialog-overview" :class="`provider-${channelForm.provider}`">
        <span class="payment-dialog-provider-icon"><component :is="currentProvider.icon" :size="23" /></span>
        <div>
          <strong>{{ currentProvider.label }}</strong>
          <span>{{ currentProvider.description }}</span>
        </div>
        <div class="payment-completion">
          <span>{{ formCompletion }}%</span>
          <small>{{ missingFormRequirements.length ? `还缺 ${missingFormRequirements.length} 项` : '配置完整' }}</small>
        </div>
      </div>

      <el-form :model="channelForm" label-position="top" class="payment-config-form">
        <section class="payment-form-section">
          <div class="payment-section-head">
            <span><CreditCard :size="17" /></span>
            <div><strong>基本信息</strong><small>设置用户端看到的名称和支付模式。</small></div>
          </div>
          <div class="payment-form-grid">
            <el-form-item label="支付方式">
              <div class="payment-readonly-provider"><component :is="currentProvider.icon" :size="16" />{{ currentProvider.label }}</div>
            </el-form-item>
            <el-form-item label="显示名称" required>
              <el-input v-model="channelForm.name" maxlength="120" placeholder="用户端显示的支付方式名称" />
            </el-form-item>
            <el-form-item v-if="typeOptions.length" :label="paymentTypeLabel(channelForm.provider)" required>
              <el-select v-model="channelForm.type" style="width: 100%"><el-option v-for="item in typeOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select>
            </el-form-item>
            <el-form-item v-if="channelForm.provider === 'alipay' || channelForm.provider === 'wechat'" label="商品名称">
              <el-input v-model="channelForm.productName" maxlength="120" placeholder="例如：账户余额充值" />
            </el-form-item>
            <el-form-item v-if="channelForm.provider === 'epay'" label="用户端支付方式" required class="payment-form-full">
              <el-checkbox-group v-model="channelForm.types" class="epay-type-group">
                <el-checkbox-button v-for="item in epayTypeOptions" :key="item.value" :label="item.value">{{ item.label }}</el-checkbox-button>
              </el-checkbox-group>
            </el-form-item>
          </div>
        </section>

        <section class="payment-form-section">
          <div class="payment-section-head">
            <span><KeyRound :size="17" /></span>
            <div><strong>商户凭据</strong><small>敏感信息将加密保存，编辑时留空不会覆盖原凭据。</small></div>
          </div>
          <div class="payment-form-grid">
            <el-form-item label="接口地址" :required="channelForm.provider === 'epay' || channelForm.provider === 'bepusdt'" class="payment-form-full">
              <el-input v-model="channelForm.url" type="url" placeholder="请输入支付服务接口地址" />
            </el-form-item>
            <el-form-item v-if="channelForm.provider === 'epay'" label="商户号" required><el-input v-model="channelForm.pid" maxlength="120" /></el-form-item>
            <el-form-item v-if="channelForm.provider === 'alipay' || channelForm.provider === 'wechat'" label="AppID" required><el-input v-model="channelForm.appId" maxlength="120" /></el-form-item>
            <el-form-item v-if="channelForm.provider === 'wechat'" label="商户号" required><el-input v-model="channelForm.mchId" maxlength="120" /></el-form-item>
            <el-form-item v-if="channelForm.provider === 'epay' || channelForm.provider === 'bepusdt' || channelForm.provider === 'wechat'" :label="secretLabel" required>
              <el-input v-if="channelForm.provider === 'epay'" v-model="channelForm.key" type="password" show-password maxlength="2048" placeholder="留空保留现有密钥" />
              <el-input v-else-if="channelForm.provider === 'bepusdt'" v-model="channelForm.token" type="password" show-password maxlength="2048" placeholder="留空保留现有 Token" />
              <el-input v-else v-model="channelForm.apiKey" type="password" show-password maxlength="2048" placeholder="留空保留现有 V2 API 密钥" />
            </el-form-item>
            <el-form-item v-if="channelForm.provider === 'alipay'" label="应用私钥" required class="payment-form-full"><el-input v-model="channelForm.privateKey" type="textarea" :rows="4" maxlength="12000" placeholder="编辑时留空表示不修改已保存私钥" /></el-form-item>
            <el-form-item v-if="channelForm.provider === 'alipay'" label="支付宝公钥" required class="payment-form-full"><el-input v-model="channelForm.publicKey" type="textarea" :rows="4" maxlength="12000" placeholder="编辑时留空表示不修改已保存公钥" /></el-form-item>
          </div>
          <div class="payment-secret-footer">
            <span><ShieldCheck :size="15" />凭据只在主动读取时显示，请避免在共享设备上操作。</span>
            <el-button v-if="editingChannelId" :loading="revealingChannelSecrets" @click="revealChannelSecrets"><Eye :size="15" />读取已保存凭据</el-button>
          </div>
        </section>

        <section class="payment-form-section">
          <div class="payment-section-head">
            <span><Link2 :size="17" /></span>
            <div><strong>回调与返回</strong><small>支付平台通过异步回调确认到账，通常使用系统地址即可。</small></div>
          </div>
          <div class="payment-form-grid">
            <el-form-item label="系统回调地址" class="payment-form-full">
              <el-input :model-value="callbackUrl" readonly>
                <template #append><el-button title="复制系统回调地址" @click="copyText(callbackUrl)"><Copy :size="15" /></el-button></template>
              </el-input>
            </el-form-item>
            <el-form-item label="自定义回调地址"><el-input v-model="channelForm.notifyUrl" type="url" placeholder="留空使用系统回调地址" /></el-form-item>
            <el-form-item label="支付完成返回地址"><el-input v-model="channelForm.returnUrl" type="url" placeholder="留空使用用户支付结果页" /></el-form-item>
          </div>
        </section>

        <el-collapse v-model="advancedSections" class="payment-advanced-collapse">
          <el-collapse-item name="advanced">
            <template #title><div class="payment-advanced-title"><SlidersHorizontal :size="16" /><span><strong>高级设置</strong><small>调整排序和通道启用状态</small></span></div></template>
            <div class="payment-advanced-grid">
              <el-form-item label="通道排序"><el-input-number v-model="channelForm.sortOrder" :min="0" :max="9999" style="width: 100%" /></el-form-item>
              <div class="payment-enable-setting">
                <div><strong>立即启用</strong><span>启用后将在用户充值页面显示此通道。</span></div>
                <el-switch v-model="channelForm.enabled" />
              </div>
            </div>
          </el-collapse-item>
        </el-collapse>

        <div v-if="missingFormRequirements.length" class="payment-form-notice" :class="{ blocking: channelForm.enabled }">
          <AlertTriangle :size="16" />
          <span>{{ channelForm.enabled ? '启用前必须补全' : '当前可保存为停用草稿' }}：{{ missingFormRequirements.map((item) => item.label).join('、') }}</span>
        </div>
        <div v-else class="payment-form-notice success"><CheckCircle2 :size="16" /><span>必要配置已经完整，可以安全启用该通道。</span></div>
      </el-form>

      <template #footer>
        <div class="payment-dialog-footer">
          <span>{{ channelForm.enabled ? '保存后立即对用户生效' : '当前将保存为停用状态' }}</span>
          <div><el-button @click="channelDialogVisible = false">取消</el-button><el-button type="primary" :loading="savingChannel" :disabled="!canSaveChannel" @click="saveChannel">保存通道</el-button></div>
        </div>
      </template>
    </el-dialog>
  </div>
</template>
