<script setup lang="ts">
import { computed } from 'vue';
import { templateParts, templateText } from '../panel-presentation';
const props = defineProps<{ modelValue: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const fields = [{ value: '{{INBOUND}}', label: '入站名称' }, { value: '{{EMAIL}}', label: '客户端用户名' }, { value: '{{TRAFFIC_LEFT}}', label: '剩余流量' }, { value: '{{DAYS_LEFT}}', label: '剩余天数' }];
const parts = computed(() => templateParts(props.modelValue));
function update(index: number, value: string) { const next = parts.value.map(part => ({ ...part })); next[index]!.value = value; emit('update:modelValue', templateText(next)); }
function remove(index: number) { emit('update:modelValue', templateText(parts.value.filter((_, i) => i !== index))); }
function add(field: boolean) { emit('update:modelValue', props.modelValue + (field ? '{{EMAIL}}' : ' ')); }
function move(index: number, direction: number) { const next = [...parts.value]; const other = index + direction; if (other < 0 || other >= next.length) return; [next[index], next[other]] = [next[other]!, next[index]!]; emit('update:modelValue', templateText(next)); }
</script>

<template>
  <div class="remark-template">
    <p>按顺序组合显示内容，连接名称会自动填入所选信息。</p>
    <div v-for="(part, index) in parts" :key="index" class="template-part">
      <span>{{ part.field ? '动态信息' : '自定义文字' }}</span>
      <select v-if="part.field" :value="part.value" aria-label="动态信息" :disabled="disabled" @change="update(index, ($event.target as HTMLSelectElement).value)"><option v-if="!fields.some(field => field.value === part.value)" :value="part.value">已有扩展字段</option><option v-for="field in fields" :key="field.value" :value="field.value">{{ field.label }}</option></select>
      <input v-else :value="part.value" aria-label="自定义文字" :disabled="disabled" @input="update(index, ($event.target as HTMLInputElement).value)" />
      <button type="button" :disabled="disabled || index === 0" aria-label="上移内容" @click="move(index, -1)">↑</button><button type="button" :disabled="disabled || index === parts.length - 1" aria-label="下移内容" @click="move(index, 1)">↓</button><button type="button" :disabled="disabled" aria-label="删除内容" @click="remove(index)">删除</button>
    </div>
    <div class="hub-actions"><button type="button" class="hub-button" :disabled="disabled" @click="add(true)">添加动态信息</button><button type="button" class="hub-button" :disabled="disabled" @click="add(false)">添加文字</button></div>
    <div class="template-preview"><small>显示结构预览</small><span v-for="(part, index) in parts" :key="index">{{ part.field ? (fields.find(field => field.value === part.value)?.label || '扩展信息') : part.value }}</span></div>
  </div>
</template>

<style scoped>
.remark-template { display: grid; gap: 12px; }
.remark-template > p { margin: 0; font-size: 13px; color: var(--muted); }
.template-part { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.template-part > span { width: 76px; color: var(--muted); font-size: 13px; }
.template-part input, .template-part select { flex: 1; min-width: 120px; }
.template-part button { background: var(--surface); border: 1px solid var(--border); border-radius: 6px; padding: 8px; color: var(--text); cursor: pointer; }
.template-part button:disabled { opacity: .4; cursor: default; }
.template-preview { padding: 16px; border-radius: 8px; background: var(--surface-soft); white-space: pre-wrap; overflow-wrap: anywhere; }
.template-preview small { display: block; font-size: 12px; color: var(--muted); margin-bottom: 8px; }
</style>
