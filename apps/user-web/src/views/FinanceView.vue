<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import QRCode from 'qrcode';
import { Banknote, CreditCard, QrCode, ShoppingBag, TicketCheck, WalletCards } from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { notifyError, notifySuccess } from '../notify';
import alipayIcon from '../assets/payments/alipay.webp';
import paypalIcon from '../assets/payments/paypal.webp';
import usdtIcon from '../assets/payments/usdt.webp';
import wechatIcon from '../assets/payments/wechat.jpg';

type PaymentProvider = 'alipay' | 'wechat' | 'epay' | 'bepusdt';
type PaymentChannel = { id: string; provider: PaymentProvider; name: string; type?: string; types?: string[] };
type PaymentMethod = {
  key: string;
  provider: PaymentProvider;
  label: string;
  channel?: PaymentChannel;
  paymentType?: string;
  image?: string;
  icon?: typeof Banknote;
};
type RechargeOrder = { order: { tradeNo: string; amount: string; expiresAt?: string | null }; payUrl?: string | null; qrCode?: string | null };
type PublicSettings = { cardPurchaseUrl?: string };
type UserDashboard = { customer: { balance: string } };

const code = ref('');
const loading = ref(false);
const redeeming = ref(false);
const recharging = ref(false);
const message = ref('');
const error = ref('');
const channels = ref<PaymentChannel[]>([]);
const publicSettings = reactive({ cardPurchaseUrl: '' });
const rechargeForm = reactive({ amount: 10, channelId: '', provider: 'alipay' as PaymentProvider, paymentType: '' });
const lastOrder = ref<RechargeOrder | null>(null);
const qrImage = ref('');
const accountBalance = ref('');
const quickAmounts = [10, 30, 50, 100];

const selectedChannel = computed(() => channels.value.find((item) => item.id === rechargeForm.channelId));
const selectedMethod = computed(() => paymentMethods.value.find((item) => item.channel?.id === rechargeForm.channelId && (item.paymentType || '') === rechargeForm.paymentType));
const paymentMethods = computed<PaymentMethod[]>(() => [
  genericPaymentMethod('alipay', '支付宝', alipayIcon, 'alipay'),
  genericPaymentMethod('wechat', '微信支付', wechatIcon, 'wechat'),
  genericPaymentMethod('paypal', 'PayPal', paypalIcon),
  genericPaymentMethod('qqpay', 'QQ钱包', '', undefined, Banknote),
  genericPaymentMethod('bank', '银行卡', '', undefined, Banknote),
  genericPaymentMethod('usdt', 'USDT', usdtIcon, 'bepusdt')
].filter((method): method is PaymentMethod => Boolean(method?.channel)));

async function loadFinanceData() {
  loading.value = true;
  error.value = '';
  try {
    const [channelResult, settingsResult, dashboardResult] = await Promise.all([
      api<PaymentChannel[]>('/api/public/payment-channels'),
      api<{ settings: PublicSettings }>('/api/public/settings').catch((): { settings: PublicSettings } => ({ settings: {} })),
      api<UserDashboard>('/api/user/me')
    ]);
    channels.value = channelResult;
    publicSettings.cardPurchaseUrl = settingsResult.settings.cardPurchaseUrl || '';
    accountBalance.value = dashboardResult.customer.balance;
    if (!selectedMethod.value) selectPaymentMethod(paymentMethods.value.find((item) => item.channel));
  } catch (caught) {
    error.value = readableError(caught, '加载失败');
  } finally {
    loading.value = false;
  }
}

function channelForProvider(provider: PaymentProvider) {
  return channels.value.find((item) => item.provider === provider);
}

function selectPaymentMethod(method?: PaymentMethod) {
  if (!method?.channel) return;
  rechargeForm.channelId = method.channel.id;
  rechargeForm.provider = method.provider;
  rechargeForm.paymentType = method.paymentType || '';
}

function genericPaymentMethod(key: string, label: string, image: string, officialProvider?: PaymentProvider, icon?: typeof Banknote): PaymentMethod | null {
  const officialChannel = officialProvider ? channelForProvider(officialProvider) : undefined;
  if (officialChannel) return { key, provider: officialProvider as PaymentProvider, label, image, icon, channel: officialChannel };
  const epayChannel = channelForEpayType(key);
  if (epayChannel) return { key, provider: 'epay', label, paymentType: key, image, icon, channel: epayChannel };
  return null;
}

function channelForEpayType(type: string) {
  const channel = channelForProvider('epay');
  const types = channel?.types?.length ? channel.types : channel?.type ? [channel.type] : [];
  return types.includes(type) ? channel : undefined;
}

function setAmount(amount: number) {
  rechargeForm.amount = amount;
}

async function createRechargeOrder() {
  const channel = selectedChannel.value;
  if (!channel) return;
  recharging.value = true;
  message.value = '';
  error.value = '';
  lastOrder.value = null;
  qrImage.value = '';
  try {
    const result = await api<RechargeOrder>('/api/user/recharge-orders', {
      method: 'POST',
      body: {
        amount: rechargeForm.amount,
        channelId: channel.id,
        provider: channel.provider,
        paymentType: rechargeForm.paymentType
      }
    });
    lastOrder.value = result;
    qrImage.value = result.qrCode ? await QRCode.toDataURL(result.qrCode, { width: 220, margin: 1 }) : '';
    message.value = '订单创建成功';
    notifySuccess(message.value);
    if (result.payUrl) window.location.href = result.payUrl;
  } catch (caught) {
    notifyError(caught, '创建失败');
  } finally {
    recharging.value = false;
  }
}

async function redeemCard() {
  redeeming.value = true;
  message.value = '';
  error.value = '';
  try {
    await api('/api/user/cards/redeem', { method: 'POST', body: { code: code.value } });
    message.value = '兑换成功';
    notifySuccess(message.value);
    code.value = '';
  } catch (caught) {
    notifyError(caught, '兑换失败');
  } finally {
    redeeming.value = false;
  }
}

function openPurchaseUrl() {
  if (!publicSettings.cardPurchaseUrl) return;
  window.open(publicSettings.cardPurchaseUrl, '_blank', 'noopener,noreferrer');
}

onMounted(loadFinanceData);
</script>

<template>
  <div class="user-page">
  <div class="user-page-header">
    <div>
      <span class="user-page-kicker">ACCOUNT FINANCE</span>
      <h2>账户财务</h2>
      <p>通过已启用的支付通道充值，或使用管理员发放的卡密增加余额。</p>
    </div>
    <div class="balance-summary"><span>当前余额</span><strong>{{ accountBalance || '--' }}<small> 元</small></strong></div>
  </div>
  <p v-if="message" class="user-feedback success">{{ message }}</p>
  <p v-if="error" class="user-feedback error">{{ error }}</p>

  <div class="finance-grid">
    <section class="user-section-card finance-form recharge-card">
      <header class="business-card-head">
        <span class="business-card-icon purple"><WalletCards :size="20" /></span>
        <div><h3>余额充值</h3><p>选择支付方式与金额后创建真实充值订单。</p></div>
      </header>
      <div class="finance-field-label">支付方式</div>
      <div class="payment-method-grid">
        <button
          v-for="method in paymentMethods"
          :key="method.key"
          type="button"
          class="payment-method-button"
          :class="{ active: method.channel?.id === rechargeForm.channelId && (method.paymentType || '') === rechargeForm.paymentType }"
          :disabled="loading || !method.channel"
          @click="selectPaymentMethod(method)"
        >
          <img v-if="method.image" :src="method.image" :alt="method.label" />
          <component :is="method.icon" v-else :size="18" />
          <span>{{ method.label }}</span>
          <small>{{ method.channel ? '已启用' : '未启用' }}</small>
        </button>
      </div>
      <div class="finance-field-label">充值金额</div>
      <div class="amount-shortcuts">
        <button v-for="amount in quickAmounts" :key="amount" type="button" :class="{ active: rechargeForm.amount === amount }" @click="setAmount(amount)">{{ amount }} 元</button>
      </div>
      <form @submit.prevent="createRechargeOrder">
        <label class="finance-amount-input"><span>¥</span><input v-model.number="rechargeForm.amount" type="number" min="0.01" step="0.01" placeholder="充值金额" /></label>
        <button :disabled="recharging || !selectedChannel || rechargeForm.amount <= 0"><CreditCard :size="16" />{{ recharging ? '创建中' : '去支付' }}</button>
      </form>
      <div v-if="selectedMethod" class="empty-hint">当前通道：{{ selectedMethod.label }}</div>
      <div v-if="!loading && !paymentMethods.length" class="empty-hint">管理员未启用在线支付方式</div>
      <div v-if="lastOrder?.qrCode" class="qr-box payment-order-box">
        <div class="payment-order-title"><QrCode :size="17" /><strong>扫码完成支付</strong></div>
        <img v-if="qrImage" :src="qrImage" alt="支付二维码" />
        <small v-if="lastOrder.order.expiresAt">有效至：{{ new Date(lastOrder.order.expiresAt).toLocaleString('zh-CN', { hour12: false }) }}</small>
        <span>{{ lastOrder.qrCode }}</span>
      </div>
    </section>

    <section class="user-section-card finance-form card-redeem-panel">
      <div class="card-redeem-head">
        <div class="card-redeem-title">
          <span class="card-redeem-icon"><TicketCheck :size="20" /></span>
          <div>
            <h2>卡密兑换</h2>
            <p>输入管理员发放的卡密后，金额会直接加入账户余额。</p>
          </div>
        </div>
        <button v-if="publicSettings.cardPurchaseUrl" type="button" class="secondary-button card-buy-button" @click="openPurchaseUrl">
          <ShoppingBag :size="16" />购买卡密
        </button>
      </div>
      <form class="card-redeem-form" @submit.prevent="redeemCard">
        <input v-model="code" placeholder="输入卡密" autocomplete="one-time-code" />
        <button :disabled="redeeming || !code.trim()">{{ redeeming ? '兑换中' : '立即兑换' }}</button>
      </form>
      <div class="card-redeem-tip">请完整粘贴卡密，兑换成功后可在首页查看余额变化。</div>
    </section>
  </div>
  </div>
</template>
