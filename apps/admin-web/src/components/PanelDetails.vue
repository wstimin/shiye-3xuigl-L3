<script setup lang="ts">
import { computed } from 'vue';
import { ElMessage } from 'element-plus';
import { decodePanelValue, fieldLabel, isSecretField, type PanelRecord } from '../panel-fields';
import { detailText } from '../panel-presentation';

defineOptions({ name: 'PanelDetails' });
const props = withDefaults(defineProps<{ modelValue: unknown; field?: string; parent?: string }>(), { field: '', parent: '' });
const value = computed(() => decodePanelValue(props.modelValue, props.field));
const entries = computed(() => value.value && typeof value.value === 'object' && !Array.isArray(value.value) ? Object.entries(value.value as PanelRecord) : []);
const scalars = computed(() => entries.value.filter(([, item]) => item === null || typeof item !== 'object'));
const sections = computed(() => entries.value.filter(([, item]) => item !== null && typeof item === 'object'));
function itemTitle(item: unknown, index: number) {
  const record = item && typeof item === 'object' ? item as PanelRecord : {};
  return String(record.remark || record.email || record.name || record.tag || `第 ${index + 1} 项`);
}
async function copy(value: unknown) {
  try { await navigator.clipboard.writeText(String(value)); ElMessage.success('已复制'); }
  catch { ElMessage.error('复制失败，请选择文字后手动复制'); }
}
</script>

<template>
  <div v-if="Array.isArray(value)" class="detail-collection">
    <p v-if="!value.length" class="detail-empty">暂无记录</p>
    <template v-else>
      <article v-for="(item, index) in value" :key="index" :class="item && typeof item === 'object' ? 'detail-record' : 'detail-line'">
        <h4 v-if="item && typeof item === 'object'">{{ itemTitle(item, index) }}</h4>
        <PanelDetails :model-value="item" :field="field" :parent="parent" />
      </article>
    </template>
  </div>
  <div v-else-if="value && typeof value === 'object'" class="panel-details">
    <p v-if="!entries.length" class="detail-empty">暂无设置</p>
    <dl v-if="scalars.length" class="detail-facts">
      <div v-for="[key, item] in scalars" :key="key"><dt>{{ fieldLabel(key) }}<button v-if="isSecretField(key) && item" type="button" class="hub-link detail-copy" :aria-label="'复制' + fieldLabel(key)" @click="copy(item)">复制</button></dt><dd>{{ detailText(item, key, field) }}</dd></div>
    </dl>
    <section v-for="[key, item] in sections" :key="key" class="detail-section">
      <h3>{{ fieldLabel(key) }}<small v-if="Array.isArray(item)">{{ item.length }} 项</small></h3>
      <PanelDetails :model-value="item" :field="key" :parent="field" />
    </section>
  </div>
  <span v-else class="detail-value">{{ detailText(value, field, parent) }}</span>
</template>

<style scoped>
.panel-details, .detail-collection { display: grid; gap: 20px; min-width: 0; }
.detail-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 0 28px; margin: 0; }
.detail-facts > div { padding: 14px 0; border-bottom: 1px solid var(--border); min-width: 0; }
dt { color: var(--muted); font-size: 13px; margin-bottom: 6px; }
.detail-copy { margin-left: 12px; font-size: 12px; }
dd { margin: 0; line-height: 1.7; overflow-wrap: anywhere; white-space: pre-wrap; font-size: 15px; }
.detail-section { min-width: 0; }
.detail-section > h3, .detail-record > h4 { display: flex; align-items: center; gap: 10px; font-size: 15px; margin: 0 0 12px; }
.detail-section > h3 > small { color: var(--muted); font-size: 12px; font-weight: 400; }
.detail-record { padding: 18px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface-soft); min-width: 0; }
.detail-line { border-bottom: 1px solid var(--border); padding: 8px 0; }
.detail-value { overflow-wrap: anywhere; white-space: pre-wrap; line-height: 1.8; font-size: 15px; }
.detail-empty { color: var(--muted); font-size: 14px; margin: 0; }
</style>
