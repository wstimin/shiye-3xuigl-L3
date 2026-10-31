<script setup lang="ts">
import { computed, ref } from 'vue';
import { api } from '../api';
import PanelFields from './PanelFields.vue';
import type { PanelRecord } from '../panel-fields';
const props = defineProps<{ modelValue: unknown[]; serverId: string; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: PanelRecord[]] }>();
const reading = ref(false), notice = ref(''), error = ref('');
const rows = computed(() => (props.modelValue.length ? props.modelValue : [{}]) as PanelRecord[]);
const credentialKeys = ['certificateFile', 'keyFile', 'certificate', 'key'];
function inline(cert: PanelRecord) { return !cert.certificateFile && !cert.keyFile && (cert.certificate != null || cert.key != null); }
function update(index: number, patch: PanelRecord) { emit('update:modelValue', rows.value.map((cert, i) => i === index ? { ...cert, ...patch } : cert)); }
function mode(index: number, value: string) {
  emit('update:modelValue', rows.value.map((cert, i) => i === index
    ? { ...Object.fromEntries(Object.entries(cert).filter(([key]) => !credentialKeys.includes(key))), ...(value === 'content' ? { certificate: [], key: [] } : { certificateFile: '', keyFile: '' }) }
    : cert));
}
function text(value: unknown) { return Array.isArray(value) ? value.join('\n') : String(value || ''); }
function pem(index: number, key: string, event: Event) { update(index, { [key]: (event.target as HTMLTextAreaElement).value.split(/\r?\n/) }); }
function extras(cert: PanelRecord) { return Object.fromEntries(Object.entries(cert).filter(([key]) => !credentialKeys.includes(key))); }
function extra(index: number, value: unknown) { emit('update:modelValue', rows.value.map((cert, i) => i === index ? { ...Object.fromEntries(Object.entries(cert).filter(([key]) => credentialKeys.includes(key))), ...value as PanelRecord } : cert)); }
async function read(index: number) {
  const serverId = props.serverId; reading.value = true; error.value = ''; notice.value = '';
  try {
    const result = await api<{ found: boolean; certFile: string; keyFile: string }>(`/api/admin/xui-servers/${serverId}/certs`);
    if (serverId !== props.serverId) return;
    if (!result.found || !result.certFile || !result.keyFile) throw Error('面板未配置完整的证书和私钥，请先在原面板配置证书。');
    emit('update:modelValue', rows.value.map((cert, i) => i === index ? { ...extras(cert), certificateFile: result.certFile, keyFile: result.keyFile } : cert));
    notice.value = '已填入面板证书路径，保存入站后生效。';
  } catch (cause) { if (serverId === props.serverId) error.value = cause instanceof Error ? cause.message : '读取证书失败，请稍后重试'; }
  finally { reading.value = false; }
}
</script>

<template>
  <div class="tls-certificates">
    <p class="muted-text">与 3x-ui 原面板一致，可填写证书文件路径或粘贴 PEM 内容。文件路径属于远端面板服务器。</p>
    <section v-for="(cert, index) in rows" :key="index" class="tls-certificate">
      <header><strong>证书 {{ index + 1 }}</strong><button v-if="rows.length > 1" type="button" class="hub-link danger" :disabled="disabled || reading" @click="emit('update:modelValue', rows.filter((_, i) => i !== index))">移除证书</button></header>
      <div class="tls-certificate-toolbar">
        <label>证书方式<select aria-label="证书方式" :value="inline(cert) ? 'content' : 'file'" :disabled="disabled || reading" @change="mode(index, ($event.target as HTMLSelectElement).value)"><option value="file">文件路径</option><option value="content">证书内容（PEM）</option></select></label>
        <button type="button" class="hub-button" :disabled="disabled || reading" @click="read(index)">{{ reading ? '正在读取…' : '从面板读取证书' }}</button>
      </div>
      <div v-if="!inline(cert)" class="hub-form-grid">
        <label>公钥证书路径<input :value="String(cert.certificateFile || '')" :disabled="disabled" placeholder="/path/fullchain.pem" @input="update(index, { certificateFile: ($event.target as HTMLInputElement).value })" /></label>
        <label>私钥文件路径<input :value="String(cert.keyFile || '')" :disabled="disabled" placeholder="/path/privkey.pem" @input="update(index, { keyFile: ($event.target as HTMLInputElement).value })" /></label>
      </div>
      <div v-else class="hub-form-grid">
        <label>公钥证书内容<textarea :value="text(cert.certificate)" rows="5" :disabled="disabled" placeholder="-----BEGIN CERTIFICATE-----" @input="pem(index, 'certificate', $event)" /></label>
        <label>私钥内容<textarea :value="text(cert.key)" rows="5" :disabled="disabled" placeholder="-----BEGIN PRIVATE KEY-----" @input="pem(index, 'key', $event)" /></label>
      </div>
      <details v-if="Object.keys(extras(cert)).length" class="tls-certificate-options"><summary>此证书的高级设置</summary><PanelFields :model-value="extras(cert)" :disabled="disabled" @update:model-value="extra(index, $event)" /></details>
    </section>
    <p v-if="notice" role="status" class="muted-text">{{ notice }}</p><p v-if="error" role="alert" class="form-error">{{ error }}</p>
    <button type="button" class="hub-button" :disabled="disabled || reading" @click="emit('update:modelValue', [...rows, { certificateFile: '', keyFile: '' }])">添加证书</button>
  </div>
</template>

<style scoped>
.tls-certificates { display: grid; gap: 14px; min-width: 0; }
.tls-certificates > p { margin: 0; font-size: 13px; line-height: 1.7; }
.tls-certificate { display: grid; gap: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 8px; min-width: 0; }
.tls-certificate > header, .tls-certificate-toolbar { display: flex; gap: 14px; justify-content: space-between; align-items: end; flex-wrap: wrap; }
.tls-certificate > header { align-items: center; }
.tls-certificate-toolbar label { flex: 1; min-width: 160px; }
.tls-certificate label { display: grid; gap: 7px; font-size: 13px; }
.tls-certificate-options > summary { margin-bottom: 12px; cursor: pointer; font-size: 13px; }
.tls-certificate textarea { width: 100%; min-width: 0; resize: vertical; font: inherit; }
.tls-certificates > button { justify-self: start; }
</style>
