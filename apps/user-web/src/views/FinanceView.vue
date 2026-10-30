<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import QRCode from 'qrcode';
import { useRoute } from 'vue-router';
import AccountLedger, { type BalanceEntry } from '../components/AccountLedger.vue';
import { ArrowRight, Banknote, CheckCircle2, CreditCard, QrCode, ShoppingBag, TicketCheck, WalletCards } from 'lucide-vue-next';
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
type UserDashboard = { customer: { balance: string }; balanceLogs: BalanceEntry[] };

const activeTab = ref<'recharge' | 'redeem'>(useRoute().query.tab === 'redeem' ? 'redeem' : 'recharge');
const balanceLogs = ref<BalanceEntry[]>([]);
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
    balanceLogs.value = dashboardResult.balanceLogs || [];
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
    await loadFinanceData();
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
  <div class="user-page finance-page" :aria-busy="loading">
    <header class="page-heading"><div><span class="eyebrow">账户资金</span><h1>账单与余额</h1><p>为账户充值，用余额延续你的连接服务。</p></div><span class="page-heading-note">每一笔余额变动，都有记录可查。</span></header>
    <p v-if="message" class="user-feedback success" role="status">{{ message }}</p><p v-if="error" class="user-feedback error" role="alert">{{ error }}</p>
    <div class="funding-layout">
      <section class="surface funding-workspace">
        <div class="funding-tabs" role="group" aria-label="选择入账方式"><button type="button" :class="{ active: activeTab === 'recharge' }" :aria-pressed="activeTab === 'recharge'" @click="activeTab = 'recharge'"><CreditCard :size="17" />在线充值</button><button type="button" :class="{ active: activeTab === 'redeem' }" :aria-pressed="activeTab === 'redeem'" @click="activeTab = 'redeem'"><TicketCheck :size="17" />兑换卡密</button></div>
        <div v-show="activeTab === 'recharge'" class="funding-content">
          <div class="funding-intro"><h2>充值账户余额</h2><p>选择支付方式和金额，确认后前往支付。</p></div>
          <form class="recharge-form" @submit.prevent="createRechargeOrder">
            <section class="form-step"><header><span>01</span><h3>选择支付方式</h3></header><div class="payment-method-grid"><button v-for="method in paymentMethods" :key="method.key" type="button" class="payment-method-button" :class="{ active: method === selectedMethod }" :aria-pressed="method === selectedMethod" :disabled="loading || !method.channel" @click="selectPaymentMethod(method)"><img v-if="method.image" :src="method.image" :alt="method.label" /><component :is="method.icon" v-else :size="22" /><strong>{{ method.label }}</strong><CheckCircle2 v-if="method === selectedMethod" class="payment-selected" :size="16" /></button></div><p v-if="!loading && !paymentMethods.length" class="user-feedback warning">暂未开放在线充值，你可以切换到卡密兑换。</p></section>
            <section class="form-step"><header><span>02</span><h3>选择充值金额</h3></header><div class="amount-shortcuts"><button v-for="amount in quickAmounts" :key="amount" type="button" :class="{ active: rechargeForm.amount === amount }" :aria-pressed="rechargeForm.amount === amount" @click="setAmount(amount)"><span>¥</span>{{ amount }}</button></div><label class="field-label" for="recharge-amount">自定义金额</label><div class="finance-amount-input"><span>¥</span><input id="recharge-amount" v-model.number="rechargeForm.amount" type="number" min="0.01" step="0.01" required placeholder="输入充值金额" /><small>元</small></div></section>
            <footer class="checkout-footer"><div><small>本次充值金额</small><strong>¥{{ Number(rechargeForm.amount || 0).toFixed(2) }}</strong><span>{{ selectedMethod?.label || '尚未选择支付方式' }}</span></div><button class="button primary" :disabled="recharging || !selectedChannel || rechargeForm.amount <= 0">{{ recharging ? '正在创建订单…' : '确认并前往支付' }}<ArrowRight :size="17" /></button></footer>
          </form>
          <div v-if="lastOrder?.qrCode" class="qr-box payment-order-box"><strong>扫描二维码完成支付</strong><img v-if="qrImage" :src="qrImage" alt="支付二维码" /><small v-if="lastOrder.order.expiresAt">有效至 {{ new Date(lastOrder.order.expiresAt).toLocaleString('zh-CN', { hour12: false }) }}</small><code>{{ lastOrder.qrCode }}</code></div>
        </div>
        <div v-show="activeTab === 'redeem'" class="funding-content redeem-content">
          <aside v-if="!loading" class="redeem-purchase-card" aria-label="获取卡密">
            <span class="redeem-purchase-icon"><ShoppingBag :size="21" /></span>
            <div><strong>还没有卡密？</strong><p>{{ publicSettings.cardPurchaseUrl ? '先购买卡密，再回来兑换余额。' : '请联系管理员获取卡密，再在下方兑换。' }}</p></div>
            <button v-if="publicSettings.cardPurchaseUrl" class="button primary" type="button" @click="openPurchaseUrl">前往购买<ArrowRight :size="15" /></button>
          </aside>
          <div class="funding-intro"><h2>将卡密兑换为余额</h2><p>完整粘贴卡密。兑换成功后，余额会更新到当前账户。</p></div>
          <form class="card-redeem-form" @submit.prevent="redeemCard"><label class="field-label" for="redeem-code">兑换卡密</label><input id="redeem-code" v-model="code" type="text" placeholder="在这里粘贴完整卡密" autocomplete="off" autocapitalize="off" :spellcheck="false" aria-describedby="redeem-hint" required /><p id="redeem-hint" class="quiet-text">同一张卡密仅能兑换一次，请核对后提交。</p><button class="button primary wide" :disabled="redeeming || !code.trim()">{{ redeeming ? '兑换处理中…' : '确认兑换余额' }}<ArrowRight :size="17" /></button></form>
        </div>
      </section>
      <aside class="funding-rail"><section class="balance-panel balance-summary"><div class="balance-panel-top"><span class="section-number">YOUR BALANCE</span><WalletCards :size="20" /></div><span class="balance-label">当前可用余额</span><strong class="balance-figure"><span>¥</span>{{ accountBalance ? Number(accountBalance).toFixed(2) : '—' }}</strong><p>余额用于服务续费，服务有效期需在连接服务中单独管理。</p><router-link to="/nodes" class="text-link">前往服务续费 <ArrowRight :size="15" /></router-link></section><section class="rail-section"><span class="section-number">HOW IT WORKS</span><h3>关于账户余额</h3><ol class="billing-notes"><li><strong>充值与兑换</strong><p>支付完成或卡密核销成功后，金额计入余额。</p></li><li><strong>按需续费</strong><p>在连接服务中选择续费时长，使用余额支付。</p></li><li><strong>查看记录</strong><p>充值、续费和余额调整可在下方明细中查询。</p></li></ol></section></aside>
    </div>
    <AccountLedger :entries="balanceLogs" :limit="10" :loading="loading" />
  </div>
</template>
