<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue';
import { ElDialog, ElMessage } from 'element-plus';
import 'element-plus/es/components/dialog/style/css';
import { RefreshCw, Plus } from 'lucide-vue-next';
import { api } from '../api';
import { unwrapPanelResult } from '../xui-panel';
import { type PanelRecord } from '../panel-fields';
import { panelInbounds, suiClientReason, inboundManager, type PanelConnection, type LinkedInbound, type PanelInbound } from '../panel-inbounds';
const props = defineProps<{ panels: PanelConnection[]; linked: LinkedInbound[] }>();
const emit = defineEmits<{ connected: []; editService: [id: string] }>();
const XuiCreateForm = defineAsyncComponent(() => import('../views/XuiNativeView.vue'));
const SuiCreateForm = defineAsyncComponent(() => import('../views/SuiServersView.vue'));
const createOpen = ref(false), createServerId = ref(''), createBusy = ref(false), createAttempt = ref(0);
const protocolSelected = ref(false);
watch([createServerId, createAttempt], () => { protocolSelected.value = false; });
const creating = computed(() => props.panels.find(panel => panel.id === createServerId.value));
function openCreate() { createServerId.value = ''; createBusy.value = false; createOpen.value = true; }
function closeCreate(done?: () => void) {
  if (createBusy.value) return;
  createOpen.value = false;
  done?.();
}
async function created() {
  createOpen.value = false;
  createBusy.value = false;
  await load();
}
const serverId = ref(''), loading = ref(false), saving = ref(false), error = ref('');
type InboundRow = PanelInbound & { panel: PanelConnection };
const inbounds = ref<InboundRow[]>([]), clients = ref<PanelRecord[]>([]), search = ref('');
const loadingClients = ref(false), clientError = ref('');
const selected = ref<InboundRow | null>(null), clientId = ref(''), name = ref(''), price = ref(0), takeover = ref(false);
let revision = 0;
const panel = computed(() => selected.value?.panel);
const visible = computed(() => inbounds.value.filter(row => `${row.name} ${row.id} ${row.protocol} ${row.port} ${row.panel.name} ${row.panel.provider === 'sui' ? 's-ui' : '3x-ui'}`.toLowerCase().includes(search.value.toLowerCase())));
const relatedClients = computed(() => clients.value.filter(client => Array.isArray(client.inbounds) && client.inbounds.some(id => Number(id) === selected.value?.id)));
const client = computed(() => clients.value.find(client => String(client.id) === clientId.value));
const reason = computed(() => panel.value?.provider === 'sui' && selected.value && client.value ? suiClientReason(client.value, selected.value.id, props.linked, panel.value.id) : '');
watch([() => props.panels, serverId], load, { immediate: true });
async function load() {
  const panels = props.panels.filter(item => !serverId.value || item.id === serverId.value), request = ++revision;
  selected.value = null; inbounds.value = []; clients.value = []; error.value = ''; search.value = '';
  if (!panels.length) { loading.value = false; return; }
  loading.value = true;
  const results = await Promise.allSettled(panels.map(async current => {
    const value = current.provider === 'sui'
      ? await api(`/api/admin/sui-servers/${current.id}/resources/inbounds`)
      : unwrapPanelResult(await api(`/api/admin/xui-servers/${current.id}/native/execute`, { method: 'POST', body: { operation: 'GET /panel/api/inbounds/list' } }));
    if (request !== revision) return;
    inbounds.value.push(...panelInbounds(value, current, props.linked).map(row => ({ ...row, panel: current })));
  }));
  if (request !== revision) return;
  const failures: string[] = [];
  results.forEach((result, index) => {
    if (result.status === 'rejected') failures.push(`${panels[index]!.name}：${result.reason instanceof Error ? result.reason.message : '读取入站失败'}`);
  });
  error.value = failures.join('；'); loading.value = false;
}
async function choose(row: InboundRow) {
  selected.value = row; name.value = row.name; price.value = 0; takeover.value = false; clientError.value = ''; clients.value = []; clientId.value = '';
  loadingClients.value = row.panel.provider === 'sui';
  if (!loadingClients.value) return;
  try {
    const result = await api<PanelRecord>(`/api/admin/sui-servers/${row.panel.id}/resources/clients`);
    if (selected.value !== row) return;
    clients.value = Array.isArray(result.clients) ? result.clients as PanelRecord[] : [];
    const candidates = relatedClients.value.filter(client => !suiClientReason(client, row.id, props.linked, row.panel.id));
    clientId.value = candidates.length === 1 ? String(candidates[0]!.id) : '';
  } catch (cause) { if (selected.value === row) clientError.value = cause instanceof Error ? cause.message : '读取客户端失败，请重新选择入站重试'; }
  finally { if (selected.value === row) loadingClients.value = false; }
}
async function connect() {
  const current = panel.value, inbound = selected.value;
  if (!current || !inbound || saving.value || loadingClients.value || clientError.value || reason.value || inbound.reason) return;
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
watch(() => props.linked, () => { inbounds.value = inbounds.value.map(row => ({ ...row, linked: props.linked.find(node => node.serverId === row.panel.id && node.inboundId === row.id) })); });
</script>

<template>
  <section class="hub-card inbound-workspace" aria-labelledby="panel-inbounds-title">
    <header class="hub-toolbar"><div><h2 id="panel-inbounds-title">面板全部入站</h2><p>汇总 3x-ui 与 S-UI 的全部入站，可按面板筛选并接入业务。</p></div><div class="hub-actions"><select v-model="serverId" class="panel-select" aria-label="入站来源面板" :disabled="saving"><option value="">全部面板 · 3x-ui 与 S-UI</option><option v-for="item in panels" :key="item.id" :value="item.id">{{ item.provider === 'sui' ? 'S-UI' : '3x-ui' }} · {{ item.name }}{{ item.enabled ? '' : '（已停用）' }}</option></select><button type="button" class="hub-button" :disabled="loading || saving || !panels.length" @click="load"><RefreshCw :size="15" />读取入站</button><button type="button" class="hub-button primary" :disabled="saving || !panels.length" @click="openCreate"><Plus :size="15" />新建入站</button></div></header>
    <div v-if="error" class="hub-alert error" role="alert">{{ error }}</div>
    <div v-if="loading" class="hub-empty" role="status">正在读取全部远端入站…</div>
    <template v-if="panels.length && (inbounds.length || !loading)">
      <div class="inbound-list-tools"><label class="hub-search"><input v-model="search" aria-label="搜索面板入站" placeholder="搜索名称、端口或协议" /></label><span>{{ loading ? '已读取' : '共' }} {{ inbounds.length }} 个入站 · {{ inbounds.filter(row => row.panel.provider === 'sui').length }} 个 S-UI · {{ inbounds.filter(row => row.linked).length }} 个已接入业务</span></div>
      <div class="hub-table-wrap"><table class="hub-table"><thead><tr><th>入站名称</th><th>来源面板</th><th>协议 / 端口</th><th>业务接入</th><th>操作</th></tr></thead><tbody><tr v-for="row in visible" :key="row.panel.id + ':' + row.id"><td><strong>{{ row.name }}</strong><small class="resource-detail">入站 {{ row.id }} · {{ row.enabled ? '已启用' : '已停用' }}</small></td><td data-label="来源面板"><strong>{{ row.panel.provider === 'sui' ? 'S-UI' : '3x-ui' }}</strong><small class="resource-detail">{{ row.panel.name }}</small></td><td data-label="协议 / 端口">{{ row.protocol.toLowerCase() }} · {{ row.port || '—' }}</td><td data-label="业务接入"><span v-if="row.linked" class="status-pill">已接入</span><span v-else>{{ row.reason ? '配置管理' : '待接入' }}</span><small v-if="row.reason" class="resource-detail">{{ row.reason }}</small></td><td><div class="hub-actions"><button v-if="row.linked && row.panel.provider !== 'sui'" type="button" class="hub-link" @click="emit('editService', row.linked.id)">业务入站设置</button><router-link v-else class="hub-link" :to="inboundManager(row.panel, row.id)">管理入站</router-link><button v-if="!row.linked && !row.reason" type="button" class="hub-link" :disabled="saving" @click="choose(row)">接入业务</button><a v-if="row.linked" class="hub-link" :href="'#service-' + row.linked.id">查看服务</a></div></td></tr><tr v-if="!visible.length"><td colspan="5" class="table-empty">{{ search ? '没有匹配的入站' : '所选面板暂无入站，可点击新建入站。' }}</td></tr></tbody></table></div>
    </template>
    <form v-if="selected && panel" class="hub-form inbound-connect-form" @submit.prevent="connect">
      <header><h3>接入「{{ selected.name }}」</h3><button type="button" class="hub-link" :disabled="saving" @click="selected = null">取消接入</button></header>
      <label v-if="panel.provider === 'sui'">业务客户端<select v-model="clientId" aria-label="S-UI 业务客户端" required :disabled="saving || loadingClients"><option value="" disabled>选择该入站的客户端</option><option v-for="item in relatedClients" :key="String(item.id)" :value="String(item.id)" :disabled="Boolean(suiClientReason(item, selected.id, linked, panel.id))">{{ item.remark || item.name }}{{ suiClientReason(item, selected.id, linked, panel.id) ? ' · ' + suiClientReason(item, selected.id, linked, panel.id) : '' }}</option></select><small v-if="loadingClients">正在读取此面板的客户端…</small><small v-else-if="!relatedClients.length && !clientError">该入站暂无客户端，请先在管理入站中创建客户端并仅授权此入站。</small><small v-else>保留所选客户端原有额度、凭据和协议设置。</small></label>
      <div class="hub-form-grid"><label>服务名称<input v-model="name" aria-label="接入服务名称" required maxlength="100" :disabled="saving" /></label><label>月费（元）<input v-model.number="price" aria-label="接入服务月费" type="number" required min="0" max="99999999" step="0.01" :disabled="saving" /></label></div>
      <label v-if="panel.provider !== 'sui'" class="hub-checkbox"><input v-model="takeover" type="checkbox" :disabled="saving" />允许业务托管：后续续费、停用和删除操作可同步远端入站</label>
      <p v-if="clientError || reason" class="form-error" role="alert">{{ clientError || reason }}</p><footer><span>接入已有资源，不新建远端入站或客户端。</span><button class="hub-button primary" :disabled="saving || loadingClients || Boolean(clientError) || !name.trim() || Boolean(reason) || (panel.provider === 'sui' && !client)">{{ saving ? '接入中…' : '确认接入业务' }}</button></footer>
    </form>
    <ElDialog :model-value="createOpen" title="新建入站" width="880px" top="5vh" class="inbound-create-dialog" append-to-body destroy-on-close :close-on-click-modal="false" :show-close="!createBusy" :before-close="closeCreate" @closed="createBusy = false">
      <ol class="create-steps" aria-label="新建入站步骤"><li :class="{ active: !creating }">1 · 选择面板</li><li :class="{ active: creating && !protocolSelected }">2 · 选择协议</li><li :class="{ active: protocolSelected }">3 · 填写配置</li></ol>
      <label class="hub-form create-panel-select">目标面板<select v-model="createServerId" aria-label="新建入站目标面板" :disabled="createBusy"><option value="" disabled>请选择面板</option><option v-for="item in panels" :key="item.id" :value="item.id" :disabled="!item.enabled">{{ item.provider === 'sui' ? 'S-UI' : '3x-ui' }} · {{ item.name }}{{ item.enabled ? '' : '（已停用）' }}</option></select></label>
      <template v-if="creating">
        <div class="create-panel-context"><div><strong>{{ creating.provider === 'sui' ? 'S-UI' : '3x-ui' }} · {{ creating.name }}</strong><p>入站将创建到此面板，保存后可在当前列表中接入业务。</p></div><button type="button" class="hub-link" :disabled="createBusy" @click="createAttempt++">重新加载表单</button></div>
        <component :is="creating.provider === 'sui' ? SuiCreateForm : XuiCreateForm" :key="creating.id + ':' + createAttempt" :create-server-id="creating.id" @busy="createBusy = $event" @protocol-selected="protocolSelected = $event" @saved="created" @close="closeCreate()" />
      </template>
    </ElDialog>
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
.create-steps { display: flex; flex-wrap: wrap; gap: 20px; list-style: none; padding: 0; margin: 0 0 24px; color: var(--muted); font-size: 14px; }
.create-steps .active { color: var(--primary); font-weight: 600; }
.create-panel-select { margin-bottom: 20px; }
.create-panel-context { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; padding-bottom: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
.create-panel-context strong { color: var(--text); }
.create-panel-context p { margin: 8px 0 0; font-size: 14px; line-height: 1.7; color: var(--muted); }
.create-panel-context button { flex-shrink: 0; }
@media(max-width: 600px) { .create-steps { display: flex; flex-wrap: wrap; gap: 20px; list-style: none; padding: 0; margin: 0 0 24px; color: var(--muted); font-size: 14px; }
.create-steps .active { color: var(--primary); font-weight: 600; }
.create-panel-select { margin-bottom: 20px; }
.create-panel-context { flex-direction: column; } }
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
