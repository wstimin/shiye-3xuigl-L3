<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { api } from '../api';

type PaymentCategory = 'official' | 'aggregate' | 'crypto';
type PaymentProvider = 'alipay' | 'wechat' | 'epay' | 'bepusdt';
type PaymentChannel = {
  id: string;
  provider: PaymentProvider;
  name: string;
  enabled: boolean;
  sortOrder: number;
  config: { url?: string; pid?: string; appId?: string; productName?: string; mchId?: string; type?: string; notifyUrl?: string; returnUrl?: string };
  hasKey?: boolean;
  hasToken?: boolean;
  hasPrivateKey?: boolean;
  hasPublicKey?: boolean;
  hasApiKey?: boolean;
  notifyUrl?: string;
};

const categoryOptions = [
  { label: '官方支付', value: 'official' },
  { label: '聚合支付', value: 'aggregate' },
  { label: '数字货币', value: 'crypto' }
] as const;

const providerOptions = [
  { label: '支付宝官方', value: 'alipay', category: 'official' },
  { label: '微信支付 Native', value: 'wechat', category: 'official' },
  { label: '易支付', value: 'epay', category: 'aggregate' },
  { label: 'BEpusdt', value: 'bepusdt', category: 'crypto' }
] as const;

const alipayModeOptions = [
  { label: '当面付扫码', value: 'precreate' },
  { label: 'PC 网站支付', value: 'page' },
  { label: '手机网站支付', value: 'wap' }
] as const;

const epayTypeOptions = [
  { label: '支付宝', value: 'alipay' },
  { label: '微信', value: 'wechat' },
  { label: 'QQ 钱包', value: 'qqpay' },
  { label: '银行卡', value: 'bank' }
] as const;

const cryptoTypeOptions = [{ label: 'USDT-TRC20', value: 'usdt.trc20' }] as const;

const loading = ref(false);
const savingChannel = ref(false);
const togglingIds = ref<Set<string>>(new Set());
const error = ref('');
const channels = ref<PaymentChannel[]>([]);
const editingChannelId = ref('');
const channelDialogVisible = ref(false);
const channelForm = reactive({
  category: 'aggregate' as PaymentCategory,
  provider: 'epay' as PaymentProvider,
  name: '易支付',
  enabled: false,
  sortOrder: 0,
  url: '',
  pid: '',
  key: '',
  token: '',
  appId: '',
  privateKey: '',
  publicKey: '',
  productName: '账户余额充值',
  mchId: '',
  apiKey: '',
  type: 'alipay',
  notifyUrl: '',
  returnUrl: ''
});

const providerChoices = computed(() => providerOptions.filter((item) => item.category === channelForm.category));
const callbackOrigin = computed(() => window.location.origin.replace(/\/+$/, ''));
const callbackUrl = computed(() => `${callbackOrigin.value}/api/payments/${channelForm.provider}/notify`);
const secretLabel = computed(() => {
  if (channelForm.provider === 'bepusdt') return 'Token';
  if (channelForm.provider === 'wechat') return 'V2 API 密钥';
  return '商户密钥';
});
const typeOptions = computed(() => {
  if (channelForm.provider === 'alipay') return alipayModeOptions;
  if (channelForm.provider === 'epay') return epayTypeOptions;
  if (channelForm.provider === 'bepusdt') return cryptoTypeOptions;
  return [];
});

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
      type: channelForm.type,
      notifyUrl: resolvedNotifyUrl,
      returnUrl: channelForm.returnUrl
    }
  };
}

function openChannelDialog() {
  resetChannelForm();
  channelDialogVisible.value = true;
}

function editChannel(channel: PaymentChannel) {
  editingChannelId.value = channel.id;
  Object.assign(channelForm, {
    category: providerCategory(channel.provider),
    provider: channel.provider,
    name: channel.name,
    enabled: channel.enabled,
    sortOrder: channel.sortOrder,
    url: channel.config.url || '',
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
    notifyUrl: channel.config.notifyUrl || '',
    returnUrl: channel.config.returnUrl || ''
  });
  channelDialogVisible.value = true;
}

async function removeChannel(channel: PaymentChannel) {
  await ElMessageBox.confirm(`确认删除支付方式“${channel.name}”？`, '删除确认', { type: 'warning' });
  await api(`/api/admin/payment-channels/${channel.id}`, { method: 'DELETE' });
  ElMessage.success('支付方式已删除');
  if (editingChannelId.value === channel.id) resetChannelForm();
  await loadChannels();
}

function resetChannelForm() {
  editingChannelId.value = '';
  Object.assign(channelForm, {
    category: 'aggregate',
    provider: 'epay',
    name: '易支付',
    enabled: false,
    sortOrder: 0,
    url: '',
    pid: '',
    key: '',
    token: '',
    appId: '',
    privateKey: '',
    publicKey: '',
    productName: '账户余额充值',
    mchId: '',
    apiKey: '',
    type: 'alipay',
    notifyUrl: '',
    returnUrl: ''
  });
}

function onCategoryChange() {
  const first = providerChoices.value[0];
  if (first) onProviderChange(first.value);
}

function onProviderChange(provider: PaymentProvider) {
  channelForm.provider = provider;
  channelForm.name = providerName(provider);
  channelForm.type = defaultType(provider);
  channelForm.url = provider === 'alipay'
    ? 'https://openapi.alipay.com/gateway.do'
    : provider === 'wechat'
      ? 'https://api.mch.weixin.qq.com/pay/unifiedorder'
      : '';
}

function defaultType(provider: PaymentProvider) {
  if (provider === 'alipay') return 'precreate';
  if (provider === 'epay') return 'alipay';
  if (provider === 'bepusdt') return 'usdt.trc20';
  return 'NATIVE';
}

function providerCategory(provider: PaymentProvider): PaymentCategory {
  return providerOptions.find((item) => item.value === provider)?.category || 'aggregate';
}

function providerName(provider: PaymentProvider) {
  return providerOptions.find((item) => item.value === provider)?.label || provider;
}

function categoryName(provider: PaymentProvider) {
  const category = providerCategory(provider);
  return categoryOptions.find((item) => item.value === category)?.label || category;
}

function paymentTypeLabel(provider: PaymentProvider) {
  if (provider === 'alipay') return '支付宝接口';
  if (provider === 'epay') return '支付子类';
  if (provider === 'bepusdt') return '币种网络';
  return '接口类型';
}

function secretState(channel: PaymentChannel) {
  if (channel.provider === 'epay') return channel.hasKey ? '已配置' : '未配置';
  if (channel.provider === 'bepusdt') return channel.hasToken ? '已配置' : '未配置';
  if (channel.provider === 'alipay') return channel.hasPrivateKey && channel.hasPublicKey ? '已配置' : '未配置';
  return channel.hasApiKey ? '已配置' : '未配置';
}

onMounted(loadChannels);
</script>

<template>
  <h1 class="page-title">支付设置</h1>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>支付方式列表</strong>
      <div class="table-toolbar-actions">
        <el-button type="primary" @click="openChannelDialog">新增支付方式</el-button>
        <el-button :loading="loading" @click="loadChannels">刷新</el-button>
      </div>
    </div>
    <el-table :data="channels" v-loading="loading" style="width: 100%">
      <el-table-column label="名称" min-width="140"><template #default="{ row }: { row: PaymentChannel }">{{ row.name }}</template></el-table-column>
      <el-table-column label="大类" width="110"><template #default="{ row }: { row: PaymentChannel }">{{ categoryName(row.provider) }}</template></el-table-column>
      <el-table-column label="方式" width="130"><template #default="{ row }: { row: PaymentChannel }">{{ providerName(row.provider) }}</template></el-table-column>
      <el-table-column label="子类" width="110"><template #default="{ row }: { row: PaymentChannel }">{{ row.config.type || '-' }}</template></el-table-column>
      <el-table-column label="密钥" width="100"><template #default="{ row }: { row: PaymentChannel }">{{ secretState(row) }}</template></el-table-column>
      <el-table-column label="启用" width="100">
        <template #default="{ row }: { row: PaymentChannel }">
          <el-switch v-model="row.enabled" :loading="togglingIds.has(row.id)" @change="(value: boolean | string | number) => toggleChannel(row, value)" />
        </template>
      </el-table-column>
      <el-table-column label="回调地址" min-width="260"><template #default="{ row }: { row: PaymentChannel }">{{ row.notifyUrl }}</template></el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }: { row: PaymentChannel }">
          <el-button size="small" @click="editChannel(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeChannel(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <el-dialog v-model="channelDialogVisible" :title="editingChannelId ? '编辑支付方式' : '新增支付方式'" width="860px" destroy-on-close>
    <el-form :model="channelForm" label-width="108px" class="payment-dialog-form">
      <el-form-item label="支付大类">
        <el-select v-model="channelForm.category" style="width: 100%" :disabled="Boolean(editingChannelId)" @change="onCategoryChange">
          <el-option v-for="item in categoryOptions" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item label="支付方式">
        <el-select v-model="channelForm.provider" style="width: 100%" :disabled="Boolean(editingChannelId)" @change="onProviderChange">
          <el-option v-for="item in providerChoices" :key="item.value" :label="item.label" :value="item.value" />
        </el-select>
      </el-form-item>
      <el-form-item v-if="typeOptions.length" :label="paymentTypeLabel(channelForm.provider)">
        <el-select v-model="channelForm.type" style="width: 100%"><el-option v-for="item in typeOptions" :key="item.value" :label="item.label" :value="item.value" /></el-select>
      </el-form-item>
      <el-form-item label="显示名称"><el-input v-model="channelForm.name" /></el-form-item>
      <el-form-item label="接口地址"><el-input v-model="channelForm.url" placeholder="官方接口可保留默认值" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'epay'" label="商户号"><el-input v-model="channelForm.pid" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'alipay' || channelForm.provider === 'wechat'" label="AppID"><el-input v-model="channelForm.appId" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'wechat'" label="商户号"><el-input v-model="channelForm.mchId" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'alipay' || channelForm.provider === 'wechat'" label="商品名称"><el-input v-model="channelForm.productName" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'alipay'" label="应用私钥"><el-input v-model="channelForm.privateKey" type="textarea" :rows="4" placeholder="编辑时留空表示不修改已保存私钥" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'alipay'" label="支付宝公钥"><el-input v-model="channelForm.publicKey" type="textarea" :rows="4" placeholder="编辑时留空表示不修改已保存公钥" /></el-form-item>
      <el-form-item v-if="channelForm.provider === 'epay' || channelForm.provider === 'bepusdt' || channelForm.provider === 'wechat'" :label="secretLabel">
        <el-input v-if="channelForm.provider === 'epay'" v-model="channelForm.key" type="password" show-password placeholder="编辑时留空表示不修改已保存密钥" />
        <el-input v-else-if="channelForm.provider === 'bepusdt'" v-model="channelForm.token" type="password" show-password placeholder="编辑时留空表示不修改已保存 Token" />
        <el-input v-else v-model="channelForm.apiKey" type="password" show-password placeholder="编辑时留空表示不修改已保存 V2 API 密钥" />
      </el-form-item>
      <el-form-item label="回调地址"><el-input :model-value="callbackUrl" readonly /></el-form-item>
      <el-form-item label="自定义回调"><el-input v-model="channelForm.notifyUrl" placeholder="通常留空，系统使用当前域名生成" /></el-form-item>
      <el-form-item label="返回地址"><el-input v-model="channelForm.returnUrl" placeholder="通常留空，系统使用用户支付结果页" /></el-form-item>
      <el-form-item label="排序"><el-input-number v-model="channelForm.sortOrder" :min="0" :max="9999" style="width: 100%" /></el-form-item>
      <el-form-item label="启用"><el-switch v-model="channelForm.enabled" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="channelDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="savingChannel" :disabled="!channelForm.name" @click="saveChannel">保存</el-button>
    </template>
  </el-dialog>
</template>
