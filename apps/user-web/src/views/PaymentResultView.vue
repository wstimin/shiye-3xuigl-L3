<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { RouterLink, useRoute } from 'vue-router';
import QRCode from 'qrcode';
import { ArrowLeft, CheckCircle2, CircleAlert, Clock3, CreditCard, RefreshCw } from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';

type PaymentResult = { tradeNo: string; status: string; amount: string; expiresAt?: string | null; paidAt?: string | null; payUrl?: string | null; qrCode?: string | null };

const route = useRoute();
const loading = ref(false);
const error = ref('');
const result = ref<PaymentResult | null>(null);
const qrImage = ref('');
const tradeNo = computed(() => String(route.query.trade_no || route.query.out_trade_no || ''));
const statusClass = computed(() => {
  if (result.value?.status === 'paid') return 'success';
  if (result.value?.status === 'pending') return 'pending';
  return 'failed';
});
const statusIcon = computed(() => result.value?.status === 'paid' ? CheckCircle2 : result.value?.status === 'pending' ? Clock3 : CircleAlert);

async function loadResult() {
  if (!tradeNo.value) {
    error.value = '缺少充值订单号';
    return;
  }
  loading.value = true;
  error.value = '';
  try {
    result.value = await api<PaymentResult>(`/api/payments/result?trade_no=${encodeURIComponent(tradeNo.value)}`);
    qrImage.value = result.value.qrCode ? await QRCode.toDataURL(result.value.qrCode, { width: 220, margin: 1 }) : '';
  } catch (caught) {
    error.value = readableError(caught, '查询失败');
  } finally {
    loading.value = false;
  }
}

function statusText(status?: string) {
  if (status === 'paid') return '支付成功，余额已到账';
  if (status === 'pending') return '订单待支付';
  if (status === 'failed') return '支付失败';
  if (status === 'closed') return '订单已关闭';
  return status || '-';
}

onMounted(loadResult);
</script>

<template>
  <div class="user-page payment-result-page">
    <div class="user-page-header">
      <div><span class="user-page-kicker">PAYMENT STATUS</span><h2>支付结果</h2><p>查询并展示当前充值订单的真实处理状态。</p></div>
      <button class="user-action-button secondary" type="button" :disabled="loading" @click="loadResult"><RefreshCw :size="16" />重新查询</button>
    </div>
    <div v-if="error" class="user-feedback error">{{ error }}</div>
    <section v-else class="user-section-card result-panel" :class="[{ loading }, statusClass]">
      <div class="payment-status-icon"><component :is="statusIcon" :size="31" /></div>
      <span class="payment-status-kicker">{{ result?.status || 'loading' }}</span>
      <h3>{{ statusText(result?.status) }}</h3>
      <p>{{ result?.status === 'paid' ? '充值金额已经计入账户余额。' : result?.status === 'pending' ? '订单仍在等待支付或支付平台回调。' : '请检查订单状态或返回财务页重新创建订单。' }}</p>
      <div class="payment-result-details">
        <div><span>订单号</span><strong>{{ result?.tradeNo || tradeNo || '-' }}</strong></div>
        <div><span>金额</span><strong>{{ result?.amount || '-' }} 元</strong></div>
        <div><span>有效至</span><strong>{{ result?.expiresAt ? new Date(result.expiresAt).toLocaleString('zh-CN', { hour12: false }) : '-' }}</strong></div>
        <div><span>到账时间</span><strong>{{ result?.paidAt ? new Date(result.paidAt).toLocaleString('zh-CN', { hour12: false }) : '-' }}</strong></div>
      </div>
      <div class="payment-result-actions">
        <RouterLink to="/finance" class="user-action-button secondary"><ArrowLeft :size="16" />返回账户财务</RouterLink>
        <a v-if="result?.status === 'pending' && result.payUrl" class="user-action-button primary" :href="result.payUrl"><CreditCard :size="16" />继续支付</a>
      </div>
    <div v-if="result?.status === 'pending' && result.qrCode" class="qr-box">
      <img v-if="qrImage" :src="qrImage" alt="支付二维码" />
      <span>{{ result.qrCode }}</span>
    </div>
    </section>
  </div>
</template>
