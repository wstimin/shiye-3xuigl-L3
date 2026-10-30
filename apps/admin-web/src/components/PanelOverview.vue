<script setup lang="ts">
import { computed } from 'vue';
import PanelDetails from './PanelDetails.vue';
import { detailText } from '../panel-presentation';
import { type PanelRecord } from '../panel-fields';
const props = defineProps<{ modelValue: unknown }>();
const record = computed(() => props.modelValue as PanelRecord || {});
const core = computed(() => record.value.xray as PanelRecord || {});
function usage(field: string) {
  const item = record.value[field] as PanelRecord | undefined;
  if (!item || !Number(item.total)) return '—';
  return `${(Number(item.current) / Number(item.total) * 100).toFixed(1)}%`;
}
const metrics = computed(() => [
  { label: '核心状态', value: detailText(core.value.state), hint: `Xray ${core.value.version || '—'}` },
  { label: '处理器', value: record.value.cpu === undefined ? '—' : detailText(record.value.cpu, 'cpu'), hint: `${record.value.logicalPro || record.value.cpuCores || '—'} 个逻辑核心` },
  { label: '内存使用率', value: usage('mem'), hint: detailText((record.value.mem as PanelRecord)?.current, 'current', 'mem') },
  { label: '磁盘使用率', value: usage('disk'), hint: detailText((record.value.disk as PanelRecord)?.current, 'current', 'disk') },
]);
</script>

<template>
  <div class="panel-overview">
    <div class="overview-metrics"><article v-for="metric in metrics" :key="metric.label"><span>{{ metric.label }}</span><strong>{{ metric.value }}</strong><small>{{ metric.hint }}</small></article></div>
    <div class="overview-runtime"><div><span>面板版本</span><strong>{{ record.panelVersion || '—' }}</strong></div><div><span>连续运行</span><strong>{{ detailText(record.uptime, 'uptime') }}</strong></div><div><span>活动连接</span><strong>{{ record.tcpCount || 0 }} TCP · {{ record.udpCount || 0 }} UDP</strong></div></div>
    <div v-if="core.errorMsg" class="hub-alert error" role="alert">{{ core.errorMsg }}</div>
    <details class="overview-more"><summary>查看网络、系统与进程详情</summary><PanelDetails :model-value="modelValue" /></details>
  </div>
</template>

<style scoped>
.panel-overview { display: grid; gap: 24px; }
.overview-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.overview-metrics article { display: grid; gap: 12px; padding: 22px; background: var(--surface-soft); border: 1px solid var(--border); border-radius: 10px; min-width: 0; }
.overview-metrics span, .overview-runtime span { color: var(--muted); font-size: 14px; }
.overview-metrics strong { font-size: 26px; line-height: 1.3; font-weight: 600; }
.overview-metrics small { font-size: 13px; color: var(--muted); overflow-wrap: anywhere; }
.overview-runtime { display: flex; flex-wrap: wrap; gap: 20px 48px; padding: 4px 0 24px; border-bottom: 1px solid var(--border); }
.overview-runtime > div { display: grid; gap: 8px; }
.overview-runtime strong { font-size: 14px; font-weight: 500; }
.overview-more summary { cursor: pointer; color: var(--primary-strong); font-size: 14px; padding-bottom: 20px; }
@media (max-width: 1100px) { .overview-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 450px) { .overview-metrics { gap: 10px; } .overview-metrics article { padding: 16px; } .overview-metrics strong { font-size: 23px; } }
</style>
