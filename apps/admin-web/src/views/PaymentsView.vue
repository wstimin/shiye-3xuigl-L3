<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Banknote, CheckCircle2, CircleDollarSign, CreditCard, Eye, Landmark, Plus, QrCode, RefreshCw, ShieldCheck } from 'lucide-vue-next';
import { api } from '../api';

type PaymentProvider = 'alipay' | 'wechat' | 'epay' | 'bepusdt';
type PaymentChannel = {
  id: string;
  provider: PaymentProvider;
  name: string;
  enabled: boolean;
  sortOrder: number;
  config: { url?: string; pid?: string; appId?: string; productName?: string; mchId?: string; type?: string; types?: string[]; notifyUrl?: string; returnUrl?: string };
  hasKey?: boolean;
  hasToken?: boolean;
  hasPrivateKey?: boolean;
  hasPublicKey?: boolean;
  hasApiKey?: boolean;
  notifyUrl?: string;
};
type PaymentChannelSecrets = { key: string; token: string; privateKey: string; publicKey: string; apiKey: string };

const providerOptions = [
  { label: '支付宝', value: 'alipay' },
  { label: '微信支付', value: 'wechat' },
  { label: '易支付', value: 'epay' },
  { label: 'BEpusdt', value: 'bepusdt' }
] as const;

const alipayModeOptions = [
  { label: '当面付扫码', value: 'precreate' },
  { label: 'PC 网站支付', value: 'page' },
  { label: '手机网站支付', value: 'wap' }
] as const;

const cryptoTypeOptions = [{ label: 'USDT-TRC20', value: 'usdt.trc20' }] as const;
const epayTypeOptions = [
  { label: '支付宝', value: 'alipay' },
  { label: '微信', value: 'wechat' },
  { label: 'QQ钱包', value: 'qqpay' },
  { label: '银行卡', value: 'bank' },
  { label: 'PayPal', value: 'paypal' }
] as const;
const providerCards = [
  { provider: 'alipay' as const, label: '支付宝', description: '官方支付宝通道，支持扫码、PC、手机网站支付。', icon: Landmark },
  { provider: 'wechat' as const, label: '微信支付', description: '微信商户 V2 Native 扫码支付。', icon: QrCode },
  { provider: 'epay' as const, label: '易支付', description: '聚合支付通道，可选择用户端显示的支付子类。', icon: Banknote },
  { provider: 'bepusdt' as const, label: 'BEpusdt', description: 'USDT-TRC20 余额充值通道。', icon: CircleDollarSign }
];

const loading = ref(false);
const savingChannel = ref(false);
const revealingChannelSecrets = ref(false);
const togglingIds = ref<Set<string>>(new Set());
const error = ref('');
const channels = ref<PaymentChannel[]>([]);
const editingChannelId = ref('');
const channelDialogVisible = ref(false);
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

async function loadChannels() {
  loading.value = true;
  error.value = '';
  try {
    channels.value = await api<PaymentChannel[]>('/api/admin/payment-channels');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载支付方式失败';
  } finally {
    loading.value = false;
  }
}

async function saveChannel() {
  savingChannel.value = true;
  error.value = '';
  try {
    const path = editingChannelId.value ? `/api/admin/payment-channels/${editingChannelId.value}` : '/api/admin/payment-channels';
    await api(path, { method: editingChannelId.value ? 'PATCH' : 'POST', body: channelBody() });
    ElMessage.success(editingChannelId.value ? '支付方式已更新' : '支付方式已新增');
    channelDialogVisible.value = false;
    resetChannelForm();
    await loadChannels();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存支付方式失败';
  } finally {
    savingChannel.value = false;
  }
}

async function toggleChannel(channel: PaymentChannel, enabled: boolean | string | number) {
  const nextEnabled = Boolean(enabled);
  const previous = !nextEnabled;
  togglingIds.value = new Set(togglingIds.value).add(channel.id);
  error.value = '';
  try {
    await api(`/api/admin/payment-channels/${channel.id}`, { method: 'PATCH', body: { enabled: nextEnabled } });
    ElMessage.success(nextEnabled ? '支付方式已启用' : '支付方式已停用');
    await loadChannels();
  } catch (err) {
    channel.enabled = previous;
    error.value = err instanceof Error ? err.message : '切换支付方式失败';
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

function openChannelDialog(provider?: PaymentProvider) {
  resetChannelForm(provider);
  channelDialogVisible.value = true;
}

function editChannel(channel: PaymentChannel) {
  editingChannelId.value = channel.id;
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
    ElMessage.success(hasAnySecret(secrets) ? '已读取保存的支付密钥' : '该支付方式没有保存密钥');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '读取保存密钥失败';
    ElMessage.error(error.value);
  } finally {
    revealingChannelSecrets.value = false;
  }
}

async function removeChannel(channel: PaymentChannel) {
  await ElMessageBox.confirm(`确认删除支付方式“${channel.name}”？`, '删除确认', { type: 'warning', customClass: 'operations-dark-message-box' });
  await api(`/api/admin/payment-channels/${channel.id}`, { method: 'DELETE' });
  ElMessage.success('支付方式已删除');
  if (editingChannelId.value === channel.id) resetChannelForm();
  await loadChannels();
}

function resetChannelForm(provider: PaymentProvider = 'alipay') {
  editingChannelId.value = '';
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

function providerName(provider: PaymentProvider) {
  return providerOptions.find((item) => item.value === provider)?.label || provider;
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

function secretState(channel: PaymentChannel) {
  if (channel.provider === 'epay') return channel.hasKey ? '已配置' : '未配置';
  if (channel.provider === 'bepusdt') return channel.hasToken ? '已配置' : '未配置';
  if (channel.provider === 'alipay') return channel.hasPrivateKey && channel.hasPublicKey ? '已配置' : '未配置';
  return channel.hasApiKey ? '已配置' : '未配置';
}

function hasAnySecret(secrets: PaymentChannelSecrets) {
  return Boolean(secrets.key || secrets.token || secrets.privateKey || secrets.publicKey || secrets.apiKey);
}

onMounted(loadChannels);
</script>

<template>
  <div class="operations-page payments-page" :class="{ loading }">
  <div class="page-head operations-page-header">
    <div class="page-head-main">
      <h1 class="page-title">支付设置</h1>
      <p>管理用户在线充值使用的真实支付通道、接口凭据、回调地址和启停状态。</p>
    </div>
    <div class="page-actions">
      <el-button type="primary" @click="openChannelDialog()"><Plus :size="15" />新增通道</el-button>
      <el-button :loading="loading" @click="loadChannels"><RefreshCw :size="15" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid compact-metrics operations-stat-grid">
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-indigo"><CreditCard :size="19" /></span><div><span>支付通道</span><strong>{{ channels.length }}</strong><small>启用 {{ activeChannelCount }}</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-emerald"><CheckCircle2 :size="19" /></span><div><span>支付宝</span><strong>{{ channels.filter((item) => item.provider === 'alipay').length }}</strong><small>官方通道</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-cyan"><QrCode :size="19" /></span><div><span>微信支付</span><strong>{{ channels.filter((item) => item.provider === 'wechat').length }}</strong><small>官方通道</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-amber"><ShieldCheck :size="19" /></span><div><span>易支付</span><strong>{{ channels.filter((item) => item.provider === 'epay').length }}</strong><small>聚合通道</small></div></div>
  </div>

  <div class="provider-card-grid">
    <button v-for="card in providerCards" :key="card.provider" type="button" class="provider-card" @click="openChannelDialog(card.provider)">
      <component :is="card.icon" :size="22" />
      <strong>{{ card.label }}</strong>
      <span>{{ card.description }}</span>
    </button>
  </div>

  <div class="panel list-panel operations-content-card payment-list-card">
    <div class="panel-toolbar">
      <strong>支付方式列表</strong>
      <div class="table-toolbar-actions">
        <span class="muted-text">{{ activeChannelCount }} 个通道正在启用</span>
      </div>
    </div>
    <div v-loading="loading" class="entity-card-grid payment-channel-grid">
      <section v-for="channel in channels" :key="channel.id" class="entity-card payment-channel-card">
        <div class="entity-card-head">
          <div>
            <strong>{{ channel.name }}</strong>
            <span>{{ providerName(channel.provider) }} / {{ channelModeLabel(channel) }}</span>
          </div>
          <el-switch
            v-model="channel.enabled"
            :loading="togglingIds.has(channel.id)"
            inline-prompt
            active-text="启"
            inactive-text="停"
            @change="(value: boolean | string | number) => toggleChannel(channel, value)"
          />
        </div>
        <div class="entity-card-stats">
          <div><span>密钥</span><strong>{{ secretState(channel) }}</strong></div>
          <div><span>排序</span><strong>{{ channel.sortOrder }}</strong></div>
          <div><span>状态</span><strong>{{ channel.enabled ? '启用' : '停用' }}</strong></div>
        </div>
        <div class="entity-card-meta">
          <span>回调地址：{{ channel.notifyUrl || channel.config.notifyUrl || '-' }}</span>
        </div>
        <div class="entity-card-actions">
          <el-button size="small" @click="editChannel(channel)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeChannel(channel)">删除</el-button>
        </div>
      </section>
      <div v-if="!channels.length && !loading" class="empty-panel entity-empty">暂无支付方式</div>
    </div>
  </div>

  <el-dialog v-model="channelDialogVisible" :title="editingChannelId ? '编辑支付方式' : `新增${providerName(channelForm.provider)}`" width="860px" class="operations-dark-dialog" destroy-on-close>
    <el-form :model="channelForm" label-width="108px" class="payment-dialog-form">
      <el-form-item label="支付方式">
        <el-input :model-value="providerName(channelForm.provider)" readonly />
      </el-form-item>
      <el-form-item v-if="typeOptions.length" :label="paymentTypeLabel(channelForm.provider)">
        <el-select v-model="channelForm.type" style="width: 100%"><el-option v-for="item in typeOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select>
      </el-form-item>
      <el-form-item v-if="channelForm.provider === 'epay'" label="用户端显示">
        <el-checkbox-group v-model="channelForm.types" class="epay-type-group">
          <el-checkbox-button v-for="item in epayTypeOptions" :key="item.value" :label="item.value">{{ item.label }}</el-checkbox-button>
        </el-checkbox-group>
      </el-form-item>
      <el-form-item label="显示名称"><el-input v-model="channelForm.name" maxlength="120" /></el-form-item>
      <el-form-item label="接口地址"><el-input v-model="channelForm.url" type="url" placeholder="支付宝/微信可保留默认地址；易支付和 BEpusdt 请填写你的接口地址" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'epay'" label="商户号"><el-input v-model="channelForm.pid" maxlength="120" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'alipay' || channelForm.provider === 'wechat'" label="AppID"><el-input v-model="channelForm.appId" maxlength="120" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'wechat'" label="商户号"><el-input v-model="channelForm.mchId" maxlength="120" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'alipay' || channelForm.provider === 'wechat'" label="商品名称"><el-input v-model="channelForm.productName" maxlength="120" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'alipay'" label="应用私钥"><el-input v-model="channelForm.privateKey" type="textarea" :rows="4" maxlength="12000" placeholder="编辑时留空表示不修改已保存私钥" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'alipay'" label="支付宝公钥"><el-input v-model="channelForm.publicKey" type="textarea" :rows="4" maxlength="12000" placeholder="编辑时留空表示不修改已保存公钥" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'epay' || channelForm.provider === 'bepusdt' || channelForm.provider === 'wechat'" :label="secretLabel">
        <el-input v-if="channelForm.provider === 'epay'" v-model="channelForm.key" type="password" show-password maxlength="2048" placeholder="编辑时留空表示不修改已保存密钥" />
        <el-input v-else-if="channelForm.provider === 'bepusdt'" v-model="channelForm.token" type="password" show-password maxlength="2048" placeholder="编辑时留空表示不修改已保存 Token" />
        <el-input v-else v-model="channelForm.apiKey" type="password" show-password maxlength="2048" placeholder="编辑时留空表示不修改已保存 V2 API 密钥" />
      </el-form-item>
      <el-form-item v-if="editingChannelId" label="已保存密钥"><el-button :loading="revealingChannelSecrets" @click="revealChannelSecrets"><Eye :size="15" />读取已保存密钥</el-button></el-form-item>
      <el-form-item label="系统回调"><el-input :model-value="callbackUrl" readonly /></el-form-item>
      <el-form-item label="自定义回调"><el-input v-model="channelForm.notifyUrl" type="url" placeholder="通常留空，系统使用当前域名生成" /></el-form-item>
      <el-form-item label="返回地址"><el-input v-model="channelForm.returnUrl" type="url" placeholder="通常留空，系统使用用户支付结果页" /></el-form-item>
      <el-form-item label="排序"><el-input-number v-model="channelForm.sortOrder" :min="0" :max="9999" style="width: 100%" /></el-form-item>
      <el-form-item label="启用"><el-switch v-model="channelForm.enabled" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="channelDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="savingChannel" :disabled="!channelForm.name" @click="saveChannel">保存</el-button>
    </template>
  </el-dialog>
  </div>
</template>
