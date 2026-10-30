<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { RefreshCw, Plus } from 'lucide-vue-next';
import { api } from '../api';
import { unwrapPanelResult } from '../xui-panel';
import { type PanelRecord } from '../panel-fields';
import { panelInbounds, suiClientReason, inboundManager, type PanelConnection, type LinkedInbound, type PanelInbound } from '../panel-inbounds';
const props = defineProps<{ panels: PanelConnection[]; linked: LinkedInbound[] }>();
const emit = defineEmits<{ connected: [] }>();
const serverId = ref(''), loading = ref(false), saving = ref(false), error = ref('');
const inbounds = ref<PanelInbound[]>([]), clients = ref<PanelRecord[]>([]), search = ref('');
const selected = ref<PanelInbound | null>(null), clientId = ref(''), name = ref(''), price = ref(0), takeover = ref(false);
let revision = 0;
const panel = computed(() => props.panels.find(panel => panel.id === serverId.value));
const visible = computed(() => inbounds.value.filter(row => `${row.name} ${row.id} ${row.protocol} ${row.port}`.toLowerCase().includes(search.value.toLowerCase())));
const relatedClients = computed(() => clients.value.filter(client => Array.isArray(client.inbounds) && client.inbounds.some(id => Number(id) === selected.value?.id)));
const client = computed(() => clients.value.find(client => String(client.id) === clientId.value));
const reason = computed(() => panel.value?.provider === 'sui' && selected.value && client.value ? suiClientReason(client.value, selected.value.id, props.linked, panel.value.id) : '');
watch(() => props.panels, () => { if (!serverId.value && props.panels.length) serverId.value = props.panels[0]!.id; }, { immediate: true });
watch(serverId, load, { immediate: true });
async function load() {
  const current = panel.value, request = ++revision;
  selected.value = null; inbounds.value = []; clients.value = []; error.value = ''; search.value = '';
  if (!current) return;
  loading.value = true;
  try {
    const [value, people] = current.provider === 'sui'
      ? await Promise.all([api(`/api/admin/sui-servers/${current.id}/resources/inbounds`), api<PanelRecord>(`/api/admin/sui-servers/${current.id}/resources/clients`)])
      : [unwrapPanelResult(await api(`/api/admin/xui-servers/${current.id}/native/execute`, { method: 'POST', body: { operation: 'GET /panel/api/inbounds/list' } })), null];
    if (request !== revision) return;
    inbounds.value = panelInbounds(value, current, props.linked);
    clients.value = Array.isArray(people?.clients) ? people.clients as PanelRecord[] : [];
  } catch (cause) { if (request === revision) error.value = cause instanceof Error ? cause.message : '读取入站失败'; }
  finally { if (request === revision) loading.value = false; }
}
function choose(row: PanelInbound) {
  selected.value = row; name.value = row.name; price.value = 0; takeover.value = false; error.value = '';
  const candidates = clients.value.filter(client => !suiClientReason(client, row.id, props.linked, serverId.value));
  clientId.value = candidates.length === 1 ? String(candidates[0]!.id) : '';
}
async function connect() {
  const current = panel.value, inbound = selected.value;
  if (!current || !inbound || saving.value || reason.value || inbound.reason) return;
  saving.value = true; error.value = '';
  try {
    if (current.provider === 'sui') {
      if (!client.value) throw new Error('请选择用于计费的客户端');
      await api(`/api/admin/sui-servers/${current.id}/business-link`, { method: 'POST', body: { clientId: Number(clientId.value), inboundId: inbound.id, name: name.value, priceMonthly: price.value } });
    } else {
      await api('/api/admin/service-nodes', { method: 'POST', body: { serverId: current.id, inboundId: inbound.id, remoteMode: 'bind', name: name.value, priceMonthly: price.value, takeover: takeover.value } });
    }
    selected.value = null; emit('connected'); ElMessage.success('已接入服务入站');
    await load();
  } catch (cause) { error.value = cause instanceof Error ? cause.message : '接入失败'; }
  finally { saving.value = false; }
}
watch(() => props.linked, () => { if (panel.value) inbounds.value = inbounds.value.map(row => ({ ...row, linked: props.linked.find(node => node.serverId === serverId.value && node.inboundId === row.id) })); });
</script>

<template>
  <section class="hub-card inbound-workspace" aria-labelledby="panel-inbounds-title">
    <header class="hub-toolbar"><div><h2 id="panel-inbounds-title">面板全部入站</h2><p>直接选择 3x-ui 或 S-UI，查看完整入站并接入业务。</p></div><div class="hub-actions"><select v-model="serverId" class="panel-select" aria-label="入站来源面板" :disabled="saving"><option value="" disabled>选择面板</option><option v-for="item in panels" :key="item.id" :value="item.id">{{ item.provider === 'sui' ? 'S-UI' : '3x-ui' }} · {{ item.name }}{{ item.enabled ? '' : '（已停用）' }}</option></select><button type="button" class="hub-button" :disabled="loading || saving || !panel" @click="load"><RefreshCw :size="15" />读取入站</button><router-link v-if="panel" class="hub-button primary" :to="inboundManager(panel, undefined, true)"><Plus :size="15" />新建入站</router-link></div></header>
    <div v-if="error" class="hub-alert error" role="alert">{{ error }}</div>
    <div v-if="loading" class="hub-empty" role="status">正在读取全部远端入站…</div>
    <template v-else-if="panel">
      <div class="inbound-list-tools"><label class="hub-search"><input v-model="search" aria-label="搜索面板入站" placeholder="搜索名称、端口或协议" /></label><span>{{ inbounds.length }} 个入站 · {{ inbounds.filter(row => row.linked).length }} 个已接入业务</span></div>
      <div class="hub-table-wrap"><table class="hub-table"><thead><tr><th>入站名称</th><th>协议 / 端口</th><th>业务接入</th><th>操作</th></tr></thead><tbody><tr v-for="row in visible" :key="row.id"><td><strong>{{ row.name }}</strong><small class="resource-detail">入站 {{ row.id }} · {{ row.enabled ? '已启用' : '已停用' }}</small></td><td data-label="协议 / 端口">{{ row.protocol.toUpperCase() }} · {{ row.port || '—' }}</td><td data-label="业务接入"><span v-if="row.linked" class="status-pill">已接入</span><span v-else>{{ row.reason ? '配置管理' : '待接入' }}</span><small v-if="row.reason" class="resource-detail">{{ row.reason }}</small></td><td><div class="hub-actions"><router-link class="hub-link" :to="inboundManager(panel, row.id)">管理入站</router-link><button v-if="!row.linked && !row.reason" type="button" class="hub-link" :disabled="saving" @click="choose(row)">接入业务</button><a v-if="row.linked" class="hub-link" :href="'#service-' + row.linked.id">查看服务</a></div></td></tr><tr v-if="!visible.length"><td colspan="4" class="table-empty">{{ search ? '没有匹配的入站' : '该面板暂无入站，可点击新建入站。' }}</td></tr></tbody></table></div>
    </template>
    <form v-if="selected && panel" class="hub-form inbound-connect-form" @submit.prevent="connect">
      <header><h3>接入「{{ selected.name }}」</h3><button type="button" class="hub-link" :disabled="saving" @click="selected = null">取消接入</button></header>
      <label v-if="panel.provider === 'sui'">业务客户端<select v-model="clientId" aria-label="S-UI 业务客户端" required :disabled="saving"><option value="" disabled>选择该入站的客户端</option><option v-for="item in relatedClients" :key="String(item.id)" :value="String(item.id)" :disabled="Boolean(suiClientReason(item, selected.id, linked, panel.id))">{{ item.remark || item.name }}{{ suiClientReason(item, selected.id, linked, panel.id) ? ' · ' + suiClientReason(item, selected.id, linked, panel.id) : '' }}</option></select><small v-if="!relatedClients.length">该入站暂无客户端，请先在管理入站中创建客户端并仅授权此入站。</small><small v-else>保留所选客户端原有额度、凭据和协议设置。</small></label>
      <div class="hub-form-grid"><label>服务名称<input v-model="name" aria-label="接入服务名称" required maxlength="100" :disabled="saving" /></label><label>月费（元）<input v-model.number="price" aria-label="接入服务月费" type="number" required min="0" max="99999999" step="0.01" :disabled="saving" /></label></div>
      <label v-if="panel.provider !== 'sui'" class="hub-checkbox"><input v-model="takeover" type="checkbox" :disabled="saving" />允许业务托管：后续续费、停用和删除操作可同步远端入站</label>
      <p v-if="reason" class="form-error">{{ reason }}</p><footer><span>接入已有资源，不新建远端入站或客户端。</span><button class="hub-button primary" :disabled="saving || !name.trim() || Boolean(reason) || (panel.provider === 'sui' && !client)">{{ saving ? '接入中…' : '确认接入业务' }}</button></footer>
    </form>
  </section>
</template>

<style scoped>
.inbound-workspace { margin: 4px 0 24px; min-width: 0; }
.hub-toolbar p { margin: 6px 0 0; font-size: 14px; color: var(--muted); }
.inbound-list-tools { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; padding: 18px 20px; }
.inbound-list-tools > span { color: var(--muted); font-size: 13px; }
.inbound-connect-form { border-top: 1px solid var(--border); padding: 24px; }
.inbound-connect-form > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.inbound-connect-form small { color: var(--muted); font-size: 13px; line-height: 1.7; }
.inbound-connect-form footer { display: flex; align-items: center; gap: 16px; justify-content: space-between; flex-wrap: wrap; font-size: 13px; color: var(--muted); }
.hub-toolbar .panel-select { max-width: 280px; }
@media(max-width: 600px) { .hub-toolbar { align-items: stretch; flex-direction: column; } .hub-toolbar .panel-select { max-width: 100%; width: 100%; } .hub-toolbar .hub-actions { flex-wrap: wrap; } .inbound-connect-form { padding: 16px; } }
@media(max-width: 600px) {
  .hub-table, .hub-table tbody { display: block; width: 100%; }
  .hub-table thead { display: none; }
  .hub-table tr { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); padding: 16px; gap: 16px; border-top: 1px solid var(--border); }
  .hub-table td { display: block; padding: 0; border: 0; min-width: 0; }
  .hub-table td:first-child, .hub-table td:last-child { grid-column: 1 / -1; }
  .hub-table td[data-label]::before { content: attr(data-label); display: block; color: var(--muted); font-size: 12px; margin-bottom: 8px; }
  .hub-table .hub-actions { gap: 20px; }
}
</style>
