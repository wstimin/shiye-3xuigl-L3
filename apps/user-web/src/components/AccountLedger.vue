<script setup lang="ts">
import { computed } from 'vue';
import { ArrowDownLeft, ArrowUpRight, ReceiptText } from 'lucide-vue-next';
export type BalanceEntry = { id: string; type: string; amount: string; beforeBalance: string; afterBalance: string; createdAt: string; remark?: string | null };
const props = withDefaults(defineProps<{ entries: BalanceEntry[]; limit?: number; loading?: boolean }>(), { limit: 10, loading: false });
const visible = computed(() => props.entries.slice(0, props.limit));
const labels: Record<string, string> = { card_redeem: '卡密兑换', recharge: '余额充值', renewal: '服务续费', admin_add: '余额调整', admin_subtract: '余额调整', admin_set: '余额调整', refund: '余额退回' };
const difference = (entry: BalanceEntry) => Number(entry.afterBalance) - Number(entry.beforeBalance);
</script>
<template>
  <section class="surface ledger-panel" aria-label="余额明细">
    <header class="section-heading"><h2>余额明细</h2><span class="quiet-text">最近 {{ limit }} 条</span></header>
    <div v-if="visible.length" class="ledger-list">
      <article v-for="entry in visible" :key="entry.id" class="ledger-row">
        <span class="ledger-icon" :class="difference(entry) >= 0 ? 'income' : 'expense'"><ArrowDownLeft v-if="difference(entry) >= 0" :size="17" /><ArrowUpRight v-else :size="17" /></span>
        <div class="ledger-title"><strong>{{ labels[entry.type] || '余额变动' }}</strong><small>{{ entry.remark || '账户余额变动' }}</small></div>
        <time :datetime="entry.createdAt">{{ new Date(entry.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) }}</time>
        <div class="ledger-amount"><strong :class="difference(entry) > 0 ? 'positive' : ''">{{ difference(entry) > 0 ? '+' : '' }}{{ difference(entry).toFixed(2) }}</strong><small>余额 ¥{{ Number(entry.afterBalance).toFixed(2) }}</small></div>
      </article>
    </div>
    <div v-else class="empty-state"><ReceiptText :size="24" /><strong>{{ loading ? '正在读取余额记录' : '暂无余额变动' }}</strong><p>充值、兑换和服务续费的记录会显示在这里。</p></div>
  </section>
</template>
