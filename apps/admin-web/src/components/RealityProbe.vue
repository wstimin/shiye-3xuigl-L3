<script setup lang="ts">
import { ref } from 'vue';
import { api } from '../api';
import { operationParameters, operationTemplate, unwrapPanelResult, type PanelOperation } from '../xui-panel';
import { applyRealityTarget } from '../xray-inbound-fields';
import type { PanelRecord } from '../panel-fields';
const props = defineProps<{ serverId: string; modelValue: PanelRecord; disabled?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: PanelRecord] }>();
const candidate = ref(''), busy = ref(false), error = ref(''), scanned = ref(false);
const results = ref<PanelRecord[]>([]);
async function request(id: string, values: PanelRecord = {}) {
  const catalog = await api<{ operations: PanelOperation[] }>(`/api/admin/xui-servers/${props.serverId}/native/catalog`);
  const operation = catalog.operations.find(item => item.id === id);
  if (!operation || operation.mutates) throw new Error('当前面板版本不支持此检测功能');
  const fields = operation.schema.properties || {};
  const body = operation.encoding ? { ...operationTemplate(operation) as PanelRecord, ...Object.fromEntries(Object.entries({ ...values, allowPrivate: false }).filter(([key]) => key in fields)) } : undefined;
  const parameters = { ...operationParameters(operation), ...Object.fromEntries(Object.entries(values).filter(([key]) => operation.parameters.some(field => field.name === key))) };
  return unwrapPanelResult(await api(`/api/admin/xui-servers/${props.serverId}/native/execute`, { method: 'POST', timeoutMs: 120000, body: { operation: id, parameters, body } }));
}
async function scan() {
  if (busy.value || props.disabled) return;
  busy.value = true; error.value = ''; results.value = []; scanned.value = false;
  try {
    const target = candidate.value.trim();
    const value = await request(target ? 'POST /panel/api/server/scanRealityTarget' : 'POST /panel/api/server/scanRealityTargets', target ? { target } : {});
    results.value = (Array.isArray(value) ? value : [value]).filter(row => row && typeof row === 'object'); scanned.value = true;
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '探测失败，请重试'; }
  finally { busy.value = false; }
}
function target(row: PanelRecord) { return String(row.target || row.dest || '').trim(); }
function serverName(row: PanelRecord) {
  return String(row.sni || row.serverName || (Array.isArray(row.serverNames) ? row.serverNames.find(name => typeof name === 'string' && name && !name.includes('*')) : '') || row.host || '').trim();
}
function apply(row: PanelRecord) {
  if (row.feasible !== true || !target(row) || !serverName(row)) return;
  emit('update:modelValue', applyRealityTarget(props.modelValue, target(row), serverName(row)));
}
async function generateKeys() {
  if (busy.value || props.disabled) return;
  busy.value = true; error.value = '';
  try {
    const value = await request('GET /panel/api/server/getNewX25519Cert') as PanelRecord;
    if (!value?.privateKey || !value?.publicKey) throw new Error('面板没有返回有效密钥');
    emit('update:modelValue', { ...props.modelValue, privateKey: value.privateKey, publicKey: value.publicKey, settings: { ...(props.modelValue.settings as PanelRecord || {}), publicKey: value.publicKey } });
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '生成失败'; }
  finally { busy.value = false; }
}
</script>
<template>
  <section class="reality-probe" aria-label="Reality 域名探测">
    <header><div><strong>Reality 域名探测</strong><p>从所选面板服务器检测域名，选择可用结果填入。保存入站后才会生效。</p></div><button type="button" class="hub-button" :disabled="busy || disabled" @click="generateKeys">生成 Reality 密钥</button></header>
    <div class="probe-actions"><label>待探测域名<input v-model="candidate" aria-label="待探测域名" placeholder="留空自动发现，或填写 域名:端口" maxlength="255" :disabled="busy || disabled" @keydown.enter.prevent="scan" /></label><button type="button" class="hub-button primary" :disabled="busy || disabled" @click="scan">{{ busy ? '检测中…' : candidate.trim() ? '探测此域名' : '自动发现域名' }}</button></div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <p v-if="scanned && !results.length" role="status">未发现可用目标，可输入域名重新探测。</p>
    <ul v-if="results.length" class="probe-results"><li v-for="(row, index) in results" :key="index"><div><strong>{{ target(row) || '未知目标' }}</strong><small>{{ row.feasible === true ? '可用' : '不可用' }}<template v-if="row.latencyMs != null"> · {{ row.latencyMs }} ms</template><template v-if="row.reason"> · {{ row.reason }}</template></small></div><button type="button" class="hub-button" :disabled="busy || disabled || row.feasible !== true || !target(row) || !serverName(row)" @click="apply(row)">使用此域名</button></li></ul>
  </section>
</template>
<style scoped>
.reality-probe { padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); }
header, .probe-actions, .probe-results li { display: flex; gap: 16px; justify-content: space-between; align-items: center; flex-wrap: wrap; }
header p { margin: 7px 0 0; font-size: 14px; color: var(--muted); line-height: 1.7; }
.probe-actions { margin-top: 18px; align-items: flex-end; }
.probe-actions label { flex: 1; min-width: 180px; }
.probe-results { list-style: none; margin: 16px 0 0; padding: 0; display: grid; gap: 12px; max-height: 320px; overflow: auto; }
.probe-results li { border-top: 1px solid var(--border); padding-top: 12px; }
.probe-results li > div { min-width: 0; overflow-wrap: anywhere; }
.probe-results small { display: block; margin-top: 6px; color: var(--muted); }
</style>
