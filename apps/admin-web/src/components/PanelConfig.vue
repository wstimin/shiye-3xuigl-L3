<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PanelFields from './PanelFields.vue';
import PanelDetails from './PanelDetails.vue';
import { configGroups } from '../panel-presentation';
import { type PanelRecord, type FieldSchema } from '../panel-fields';

const props = withDefaults(defineProps<{
  modelValue: unknown; mode: 'settings' | 'core'; readonly?: boolean; disabled?: boolean; schema?: FieldSchema;
}>(), { readonly: false, disabled: false });
const emit = defineEmits<{ 'update:modelValue': [value: unknown] }>();
const active = ref('');
const wrapped = computed(() => Boolean((props.modelValue as PanelRecord)?.xraySetting && typeof (props.modelValue as PanelRecord).xraySetting === 'object'));
const record = computed(() => (wrapped.value ? (props.modelValue as PanelRecord).xraySetting : props.modelValue) as PanelRecord || {});
const metadata = computed(() => wrapped.value ? Object.fromEntries(Object.entries(props.modelValue as PanelRecord).filter(([key]) => key !== 'xraySetting')) : {});
const groups = computed(() => [...configGroups(record.value, props.mode), ...(Object.keys(metadata.value).length ? [{ id: 'metadata', label: '资源与检测', description: '检测地址、可用资源与规则数据文件。', keys: Object.keys(metadata.value) }] : [])]);
const group = computed(() => groups.value.find(item => item.id === active.value) || (props.mode === 'core' ? groups.value.find(item => item.id === 'outbounds') : undefined) || groups.value[0]);
watch(() => props.mode, () => { active.value = ''; });
const groupValue = computed(() => group.value?.id === 'metadata' ? metadata.value : Object.fromEntries((group.value?.keys || []).map(key => [key, record.value[key]])));
const groupSchema = computed(() => ({ ...props.schema, properties: Object.fromEntries(Object.entries(props.schema?.properties || {}).filter(([key]) => group.value?.keys.includes(key))) }));
const resourceChoices = computed(() => {
  const options = (key: string) => Array.isArray(record.value[key]) ? (record.value[key] as PanelRecord[]).filter(item => item?.tag).map(item => ({ value: String(item.tag), label: String(item.remark || item.name || item.tag) })) : [];
  return { outboundTag: options('outbounds'), inboundTag: options('inbounds') };
});
function update(value: unknown) {
  if (group.value?.id === 'metadata') {
    emit('update:modelValue', { ...props.modelValue as PanelRecord, ...value as PanelRecord });
    return;
  }
  const next = { ...record.value, ...value as PanelRecord };
  emit('update:modelValue', wrapped.value ? { ...props.modelValue as PanelRecord, xraySetting: next } : next);
}
</script>

<template>
  <div class="config-workspace">
    <nav class="config-navigation" aria-label="设置分类">
      <button v-for="item in groups" :key="item.id" type="button" :aria-current="group?.id === item.id ? 'page' : undefined" :class="{ active: group?.id === item.id }" @click="active = item.id">{{ item.label }}<small>{{ item.keys.length }}</small></button>
    </nav>
    <section v-if="group" class="config-content">
      <header><h3>{{ group.label }}</h3><p>{{ group.description }}</p></header>
      <PanelDetails v-if="readonly" :model-value="groupValue" />
      <PanelFields v-else :model-value="groupValue" :schema="groupSchema" :choices="resourceChoices" :disabled="disabled" @update:model-value="update" />
    </section>
    <p v-else class="muted-text">暂无设置</p>
  </div>
</template>

<style scoped>
.config-workspace { display: grid; grid-template-columns: 176px minmax(0, 1fr); gap: 28px; align-items: start; }
.config-navigation { display: grid; gap: 6px; position: sticky; top: 88px; }
.config-navigation button { display: flex; justify-content: space-between; gap: 12px; width: 100%; text-align: left; padding: 12px; border: 0; background: transparent; color: var(--muted); border-radius: 8px; font: inherit; font-size: 14px; cursor: pointer; }
.config-navigation button:hover { background: var(--surface-soft); color: var(--text); }
.config-navigation button.active { background: var(--primary-soft); color: var(--primary-strong); font-weight: 600; }
.config-navigation small { opacity: .8; font-size: 12px; }
.config-content { min-width: 0; }
.config-content > header { padding-bottom: 20px; }
.config-content > header h3 { margin: 0 0 6px; font-size: 17px; }
.config-content > header p { margin: 0; font-size: 14px; color: var(--muted); line-height: 1.6; }
@media (max-width: 700px) { .config-workspace { grid-template-columns: minmax(0, 1fr); gap: 20px; } .config-navigation { display: flex; flex-wrap: wrap; position: static; } .config-navigation button { width: auto; } }
</style>
