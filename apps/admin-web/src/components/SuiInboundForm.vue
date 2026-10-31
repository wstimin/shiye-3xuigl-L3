<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import PanelFields from './PanelFields.vue';
import { api } from '../api';
import { type FieldSchema, type PanelRecord } from '../panel-fields';
import { suiInboundProtocols, suiInboundTemplate, suiProtocolSchema, suiTransportSchemas, suiRequiredTls, suiTlsProtocols, suiTransportProtocols, suiSubscriptionProtocols } from '../sui-inbound-fields';
const props = defineProps<{ modelValue: unknown; serverId: string; baseUrl: string; disabled?: boolean; hideProtocol?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: PanelRecord] }>();
const record = computed(() => (props.modelValue || {}) as PanelRecord), protocol = computed(() => String(record.value.type || 'vless'));
const tls = ref<PanelRecord[]>([]), reading = ref(false), tlsError = ref('');
let revision = 0;
const selectedTls = computed(() => tls.value.find(item => Number(item.id) === Number(record.value.tls_id)));
const tlsServer = computed(() => (selectedTls.value?.server || {}) as PanelRecord);
const tlsMode = computed(() => (tlsServer.value.reality as PanelRecord)?.enabled ? 'Reality（不需要普通证书文件）' : tlsServer.value.acme ? 'ACME 自动证书' : tlsServer.value.certificate_path ? '证书文件' : '证书内容');
const protocolSchema = computed(() => suiProtocolSchema(protocol.value, record.value));
const protocolKeys = computed(() => Object.keys(protocolSchema.value.properties || {}));
const addresses = computed(() => Array.isArray(record.value.addrs) ? record.value.addrs as PanelRecord[] : []);
const transport = computed(() => (record.value.transport || {}) as PanelRecord);
const transportType = computed(() => String(transport.value.type || ''));
const handled = computed(() => ['id', 'type', 'tag', 'listen', 'listen_port', 'tls_id', 'addrs', 'out_json', ...protocolKeys.value, ...(protocol.value === 'hysteria2' ? ['obfs'] : []), ...(suiTransportProtocols.includes(protocol.value) ? ['transport'] : [])]);
const addressTlsSchema: FieldSchema = { properties: { server_name: { type: 'string' }, insecure: { type: 'boolean' } } };
function pick(keys: string[]) { return Object.fromEntries(Object.entries(record.value).filter(([key]) => keys.includes(key))); }
const extraSettings = computed(() => Object.fromEntries(Object.entries(record.value).filter(([key]) => !handled.value.includes(key))));
function patch(value: PanelRecord) { emit('update:modelValue', { ...record.value, ...value }); }
function changeProtocol(value: string) { emit('update:modelValue', suiInboundTemplate(value, record.value)); }
function toggleObfs(enabled: boolean) {
  if (enabled) patch({ obfs: { ...(record.value.obfs as PanelRecord || {}), type: 'salamander', password: String((record.value.obfs as PanelRecord)?.password || '') } });
  else emit('update:modelValue', Object.fromEntries(Object.entries(record.value).filter(([key]) => key !== 'obfs')));
}
function updateExtras(value: unknown) { emit('update:modelValue', { ...pick(handled.value), ...value as PanelRecord }); }
function updateTransport(value: string) {
  const defaults: Record<string, PanelRecord> = { http: { host: [], path: '/' }, ws: { path: '/', headers: {} }, grpc: { service_name: '' }, httpupgrade: { host: '', path: '/' }, quic: {} };
  patch({ transport: value ? { type: value, ...defaults[value] } : {} });
}
function transportFields(value: unknown) { patch({ transport: { type: transportType.value, ...value as PanelRecord } }); }
function updateAddress(index: number, value: PanelRecord) { patch({ addrs: addresses.value.map((item, i) => i === index ? { ...item, ...value } : item) }); }
function addAddress() { let host = ''; try { host = new URL(props.baseUrl).hostname.replace(/^\[|\]$/g, ''); } catch { /* The connection editor validates panel addresses. */ } patch({ addrs: [...addresses.value, { server: host, server_port: Number(record.value.listen_port || 443), remark: '' }] }); }
async function readCertificates() {
  const version = ++revision, serverId = props.serverId; tls.value = []; reading.value = true; tlsError.value = '';
  try {
    const result = await api<{ tls: PanelRecord[] }>(`/api/admin/sui-servers/${serverId}/resources/tls`);
    if (version === revision) tls.value = Array.isArray(result.tls) ? result.tls : [];
  } catch (cause) { if (version === revision) tlsError.value = cause instanceof Error ? cause.message : '读取 TLS 配置失败，请重试'; }
  finally { if (version === revision) reading.value = false; }
}
watch(() => props.serverId, readCertificates, { immediate: true });
</script>

<template>
  <div class="sui-inbound-form">
    <fieldset class="inbound-section"><legend>基本设置</legend>
      <div class="hub-form-grid">
        <label v-if="!hideProtocol">协议<select aria-label="入站协议" :value="protocol" :disabled="disabled" @change="changeProtocol(($event.target as HTMLSelectElement).value)"><option v-if="!suiInboundProtocols.includes(protocol)" :value="protocol">{{ protocol }}</option><option v-for="type in suiInboundProtocols" :key="type" :value="type">{{ type }}</option></select></label>
        <label>标签（名称）<input aria-label="标签（名称）" :value="String(record.tag || '')" required :disabled="disabled" placeholder="例如 hk-vless" @input="patch({ tag: ($event.target as HTMLInputElement).value })" /><small>S-UI 原面板中的 Tag，也是用户订阅中显示的入站名称。</small></label>
        <template v-if="!['tun', 'cloudflared'].includes(protocol)"><label>监听 IP<input aria-label="监听 IP" :value="String(record.listen ?? '::')" :disabled="disabled" placeholder="::" @input="patch({ listen: ($event.target as HTMLInputElement).value })" /><small>:: 监听所有地址，也可填写指定的本机 IP。</small></label>
        <label>监听端口<input aria-label="监听端口" :value="Number(record.listen_port || 0)" type="number" required min="1" max="65535" :disabled="disabled" @input="patch({ listen_port: Number(($event.target as HTMLInputElement).value) })" /></label></template>
      </div>
    </fieldset>
    <fieldset v-if="protocolKeys.length" class="inbound-section"><legend>协议设置</legend><PanelFields :model-value="pick(protocolKeys)" :schema="protocolSchema" :disabled="disabled" @update:model-value="patch($event as PanelRecord)" /></fieldset>
    <section v-if="protocol === 'hysteria2'" class="inbound-section"><label class="hub-checkbox"><input type="checkbox" :checked="Boolean(record.obfs)" :disabled="disabled" @change="toggleObfs(($event.target as HTMLInputElement).checked)" />启用 salamander 混淆</label><label v-if="record.obfs">混淆密码<input :value="String((record.obfs as PanelRecord).password || '')" required :disabled="disabled" @input="patch({ obfs: { ...record.obfs as PanelRecord, password: ($event.target as HTMLInputElement).value } })" /></label></section>
    <fieldset v-if="suiTransportProtocols.includes(protocol)" class="inbound-section"><legend>传输设置</legend>
      <label>传输协议<select aria-label="传输协议" :value="transportType" :disabled="disabled" @change="updateTransport(($event.target as HTMLSelectElement).value)"><option value="">tcp（不额外封装）</option><option v-if="transportType && !suiTransportSchemas[transportType]" :value="transportType">{{ transportType }}</option><option value="ws">websocket</option><option value="grpc">grpc</option><option value="http">http</option><option value="httpupgrade">httpupgrade</option><option value="quic">quic</option></select></label>
      <PanelFields v-if="transportType" field="transport" compact :model-value="Object.fromEntries(Object.entries(transport).filter(([key]) => key !== 'type'))" :schema="suiTransportSchemas[transportType]" :disabled="disabled" @update:model-value="transportFields" />
    </fieldset>
    <fieldset v-if="suiTlsProtocols.includes(protocol)" class="inbound-section"><legend>TLS / Reality</legend>
      <div class="inbound-certificate-toolbar"><label>TLS 配置<select aria-label="TLS 配置" :value="Number(record.tls_id || 0)" :disabled="disabled || reading" :required="suiRequiredTls.includes(protocol)" @change="patch({ tls_id: Number(($event.target as HTMLSelectElement).value) })"><option :value="0">不使用 TLS</option><option v-if="Number(record.tls_id) && !selectedTls" :value="Number(record.tls_id)">当前配置 #{{ record.tls_id }}（未读取到）</option><option v-for="item in tls" :key="Number(item.id)" :value="Number(item.id)">{{ item.name || 'TLS 配置 ' + item.id }}{{ (item.server as PanelRecord)?.reality ? ' · reality' : '' }}</option></select></label><button type="button" class="hub-button" :disabled="disabled || reading" @click="readCertificates">{{ reading ? '正在读取…' : '读取面板证书' }}</button></div>
      <p v-if="tlsError" role="alert" class="form-error">{{ tlsError }}</p>
      <p v-else-if="!reading" class="muted-text">已读取 {{ tls.length }} 项面板 TLS 配置。{{ suiRequiredTls.includes(protocol) ? '此协议必须选择 TLS 配置。' : '选择面板中已有的证书或 Reality 配置。' }}</p>
      <dl v-if="selectedTls" class="inbound-certificate-info"><div><dt>方式</dt><dd>{{ tlsMode }}</dd></div><div v-if="tlsServer.server_name"><dt>域名（SNI）</dt><dd>{{ tlsServer.server_name }}</dd></div><div v-if="tlsServer.certificate_path"><dt>证书路径</dt><dd>{{ tlsServer.certificate_path }}</dd></div><div v-if="tlsServer.key_path"><dt>私钥路径</dt><dd>{{ tlsServer.key_path }}</dd></div></dl>
      <router-link class="hub-link" target="_blank" rel="noopener noreferrer" :to="{ path: '/sui-servers', query: { serverId, resource: 'tls' } }">管理面板 TLS 配置 ↗</router-link>
    </fieldset>
    <fieldset v-if="suiSubscriptionProtocols.includes(protocol) || 'addrs' in record || 'out_json' in record" class="inbound-section"><legend>客户端 / 分享地址</legend><p class="muted-text">与 S-UI 的客户端设置对应：这里填写用户连接的地址，不是服务器的监听 IP。客户端账号在“客户端”中管理。</p>
      <div v-for="(address, index) in addresses" :key="index" class="inbound-address">
        <header><strong>分享地址 {{ index + 1 }}</strong><button type="button" class="hub-link danger" :disabled="disabled" @click="patch({ addrs: addresses.filter((_, i) => i !== index) })">移除</button></header>
        <div class="hub-form-grid"><label>服务器地址<input :value="String(address.server || '')" required :disabled="disabled" placeholder="域名或公网 IP" @input="updateAddress(index, { server: ($event.target as HTMLInputElement).value })" /></label><label>服务器端口<input :value="Number(address.server_port || 0)" type="number" min="1" max="65535" required :disabled="disabled" @input="updateAddress(index, { server_port: Number(($event.target as HTMLInputElement).value) })" /></label><label>地址备注<input :value="String(address.remark || '')" :disabled="disabled" @input="updateAddress(index, { remark: ($event.target as HTMLInputElement).value })" /></label></div>
        <details><summary>此地址的高级设置</summary><PanelFields :model-value="Object.fromEntries(Object.entries(address).filter(([key]) => !['server', 'server_port', 'remark'].includes(key)))" :schema="addressTlsSchema" :disabled="disabled" @update:model-value="patch({ addrs: addresses.map((item, i) => i === index ? { server: item.server, server_port: item.server_port, remark: item.remark, ...$event as PanelRecord } : item) })" /></details>
      </div>
      <button type="button" class="hub-button" :disabled="disabled" @click="addAddress">添加分享地址</button>
      <details v-if="'out_json' in record"><summary>客户端附加选项</summary><PanelFields :model-value="record.out_json" :disabled="disabled" @update:model-value="patch({ out_json: $event })" /></details>
    </fieldset>
    <details v-if="Object.keys(extraSettings).length" class="inbound-section"><summary>其他高级设置</summary><PanelFields :model-value="extraSettings" :immutable="['id', 'users']" :disabled="disabled" @update:model-value="updateExtras" /></details>
  </div>
</template>

<style scoped>
.sui-inbound-form { display: grid; gap: 22px; min-width: 0; }
.inbound-section { display: grid; gap: 14px; min-width: 0; margin: 0; padding: 16px 0 0; border: 0; border-top: 1px solid var(--border); }
.inbound-section > legend { padding-right: 12px; font-size: 14px; font-weight: 600; color: var(--text); }
.inbound-section label { display: grid; gap: 7px; min-width: 0; font-size: 13px; }
.inbound-section small, .inbound-section p { margin: 0; font-size: 13px; line-height: 1.7; color: var(--muted); }
.inbound-section > .hub-button { justify-self: start; }
.inbound-certificate-toolbar { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; }
.inbound-certificate-toolbar > label { flex: 1; min-width: 160px; }
.inbound-certificate-info { display: grid; gap: 9px; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 7px; font-size: 13px; }
.inbound-certificate-info > div { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 10px; }
.inbound-certificate-info dt { color: var(--muted); }
.inbound-certificate-info dd { margin: 0; color: var(--text); overflow-wrap: anywhere; }
.inbound-address { display: grid; gap: 14px; padding: 14px; border: 1px solid var(--border); border-radius: 7px; min-width: 0; }
.inbound-address > header { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.inbound-section summary { margin-bottom: 14px; cursor: pointer; font-size: 13px; color: var(--text); }
</style>
