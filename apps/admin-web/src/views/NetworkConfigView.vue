<script setup lang="ts">
import { useRoute } from 'vue-router';
import SocksNodesView from './SocksNodesView.vue';
import PanelFields from '../components/PanelFields.vue';
import { decodePanelValue, type FieldSchema } from '../panel-fields';
import { computed, onMounted, reactive, ref } from 'vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/tab-pane/style/css';
import 'element-plus/es/components/tabs/style/css';
import 'element-plus/es/components/tooltip/style/css';
import {
  ElAlert,
  ElButton,
  ElDialog,
  ElForm,
  ElFormItem,
  ElInput,
  ElMessage,
  ElMessageBox,
  ElOption,
  ElSelect,
  ElSwitch,
  ElTabPane,
  ElTabs,
  ElTooltip
} from 'element-plus';
import {
  ArrowDownToLine,
  CloudOff,
  CloudUpload,
  Code2,
  Edit3,
  GitBranch,
  Network,
  Plus,
  RefreshCw,
  Route,
  Search,
  Server,
  ShieldCheck,
  Trash2
} from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { entityInitial } from '../entity-avatar';
import { notifyError } from '../notify';

type Ownership = 'managed' | 'referenced' | 'shared';
type XuiServer = { id: string; name: string; enabled: boolean };
type ServiceNode = { id: string; serverId: string; name: string; inboundId?: number | null; config?: { remoteInboundTag?: string } };
type NetworkOutbound = {
  id: string;
  serverId: string;
  name: string;
  tag: string;
  protocol: string;
  ownership: Ownership;
  sourceFormat?: string | null;
  normalizedConfig: Record<string, unknown>;
  remoteFingerprint?: string | null;
  lastSyncedAt?: string | null;
  server: XuiServer;
  _count: { routes: number };
};
type NetworkRoute = {
  id: string;
  serverId: string;
  serviceNodeId?: string | null;
  outboundId?: string | null;
  name: string;
  remoteOrder?: number | null;
  ownership: Ownership;
  normalizedConfig: Record<string, unknown>;
  remoteFingerprint?: string | null;
  lastSyncedAt?: string | null;
  server: Pick<XuiServer, 'id' | 'name'>;
  outbound?: Pick<NetworkOutbound, 'id' | 'name' | 'tag' | 'protocol'> | null;
  serviceNode?: Pick<ServiceNode, 'id' | 'name' | 'inboundId'> | null;
};
type OutboundPreview = {
  format: string;
  count: number;
  items: Array<{ name: string; tag: string; protocol: string; outbound: Record<string, unknown>; fingerprint: string }>;
};

const formatOptions = [
  ['auto', '自动识别'],
  ['xray_json', '配置文件'],
  ['socks', 'SOCKS 链接'],
  ['http', 'HTTP 链接'],
  ['shadowsocks', 'Shadowsocks'],
  ['vmess', 'VMess'],
  ['vless', 'VLESS'],
  ['trojan', 'Trojan'],
  ['wireguard', 'WireGuard'],
  ['subscription', '订阅内容']
] as const;

const servers = ref<XuiServer[]>([]);
const serviceNodes = ref<ServiceNode[]>([]);
const outbounds = ref<NetworkOutbound[]>([]);
const routes = ref<NetworkRoute[]>([]);
const activeTab = ref<'outbounds' | 'routes' | 'library'>(useRoute().query.tab === 'library' ? 'library' : 'outbounds');
const loading = ref(false);
const saving = ref(false);
const previewing = ref(false);
const deletingIds = ref<Set<string>>(new Set());
const error = ref('');
const searchQuery = ref('');
const selectedServerId = ref('');
const selectedOwnership = ref('');
const importDialogVisible = ref(false);
const routeDialogVisible = ref(false);
const editingRouteId = ref('');
const preview = ref<OutboundPreview | null>(null);
const outboundDetail = ref<NetworkOutbound | null>(null);
const routeRule = computed({ get: () => parseRule(), set: (value: unknown) => { routeForm.ruleText = JSON.stringify(value); } });
const routeRuleSchema: FieldSchema = { type: 'object', properties: { type: { enum: ['field'] }, protocol: { type: 'array', items: { enum: ['http', 'tls', 'bittorrent'] } }, network: { enum: ['', 'tcp', 'udp', 'tcp,udp'] }, domain: { type: 'array', items: { type: 'string' } }, ip: { type: 'array', items: { type: 'string' } }, port: { type: 'string' }, inboundTag: { type: 'array', items: { type: 'string' } }, outboundTag: { type: 'string' } } };

const importForm = reactive({
  serverId: '',
  format: 'auto',
  name: '',
  ownership: 'managed' as Ownership,
  strategy: 'target_panel' as 'local_only' | 'target_panel',
  conflict: 'reject' as 'reject' | 'rename' | 'replace_managed' | 'takeover',
  createRoute: false,
  inboundTags: '',
  input: ''
});
const routeForm = reactive({
  serverId: '',
  name: '',
  serviceNodeId: '',
  outboundId: '',
  ownership: 'managed' as Ownership,
  pushRemote: true,
  conflict: 'reject' as 'reject' | 'replace_managed' | 'takeover',
  ruleText: '{\n  "type": "field",\n  "inboundTag": [],\n  "outboundTag": ""\n}'
});

const enabledServers = computed(() => servers.value.filter((server) => server.enabled));
const managedOutboundCount = computed(() => outbounds.value.filter((item) => item.ownership === 'managed').length);
const managedRouteCount = computed(() => routes.value.filter((item) => item.ownership === 'managed').length);
const remoteOutboundCount = computed(() => outbounds.value.filter((item) => item.lastSyncedAt).length);
const remoteRouteCount = computed(() => routes.value.filter((item) => item.lastSyncedAt).length);
const availableRouteOutbounds = computed(() => outbounds.value.filter((item) => item.serverId === routeForm.serverId));
const availableServiceNodes = computed(() => serviceNodes.value.filter((item) => item.serverId === routeForm.serverId));
const importReady = computed(() => Boolean(
  importForm.serverId
  && importForm.input.trim()
  && (!importForm.createRoute || parseTags(importForm.inboundTags).length)
));
const filteredOutbounds = computed(() => outbounds.value.filter((item) => resourceMatches(item, [item.name, item.tag, item.protocol, item.server.name, item.sourceFormat])));
const filteredRoutes = computed(() => routes.value.filter((item) => resourceMatches(item, [
  item.name,
  item.server.name,
  item.outbound?.name,
  item.outbound?.tag,
  item.serviceNode?.name,
  JSON.stringify(item.normalizedConfig)
])));

async function loadResources() {
  loading.value = true;
  error.value = '';
  try {
    const query = selectedServerId.value ? `?serverId=${encodeURIComponent(selectedServerId.value)}` : '';
    const [serverResult, nodeResult, outboundResult, routeResult] = await Promise.all([
      api<XuiServer[]>('/api/admin/xui-servers'),
      api<ServiceNode[]>('/api/admin/service-nodes'),
      api<NetworkOutbound[]>(`/api/admin/network-outbounds${query}`),
      api<NetworkRoute[]>(`/api/admin/network-routes${query}`)
    ]);
    servers.value = serverResult;
    serviceNodes.value = nodeResult;
    outbounds.value = outboundResult.map((item) => ({ ...item, normalizedConfig: jsonObject(item.normalizedConfig) }));
    routes.value = routeResult.map((item) => ({ ...item, normalizedConfig: jsonObject(item.normalizedConfig) }));
  } catch (caught) {
    error.value = readableError(caught, '加载出站与路由失败');
  } finally {
    loading.value = false;
  }
}

async function renameOutbound(outbound: NetworkOutbound) {
  let name: string;
  try {
    const result = await ElMessageBox.prompt('填写便于识别的出站名称。路由关联会保留。', '修改出站名称', { inputValue: outbound.name, confirmButtonText: '保存名称', cancelButtonText: '取消', inputValidator: value => Boolean(value.trim() && value.trim().length <= 120) || '请输入 1–120 个字符' });
    name = result.value.trim();
  } catch { return; }
  try {
    await api(`/api/admin/network-outbounds/${outbound.id}/name`, { method: 'PATCH', body: { name } });
    ElMessage.success('出站名称已更新');
    await loadResources();
  } catch (cause) { notifyError(cause, '修改出站名称失败'); }
}

function openImportDialog() {
  Object.assign(importForm, {
    serverId: selectedServerId.value || enabledServers.value[0]?.id || '',
    format: 'auto',
    name: '',
    ownership: 'managed',
    strategy: 'target_panel',
    conflict: 'reject',
    createRoute: false,
    inboundTags: '',
    input: ''
  });
  preview.value = null;
  importDialogVisible.value = true;
}

async function previewImport() {
  if (!importForm.input.trim()) return;
  previewing.value = true;
  try {
    preview.value = await api<OutboundPreview>('/api/admin/network-outbounds/preview', {
      method: 'POST',
      body: { input: importForm.input, format: importForm.format, name: importForm.name.trim() || undefined }
    });
    ElMessage.success(`已识别 ${preview.value.count} 个出站`);
  } catch (caught) {
    preview.value = null;
    notifyError(caught, '预览导入内容失败');
  } finally {
    previewing.value = false;
  }
}

async function importOutbounds() {
  if (saving.value) return;
  saving.value = true;
  try {
    const result = await api<{ imported: number; state?: 'success' | 'partial'; message?: string }>('/api/admin/network-outbounds/import', {
      method: 'POST',
      body: {
        serverId: importForm.serverId,
        format: importForm.format,
        name: importForm.name.trim() || undefined,
        ownership: importForm.ownership,
        strategy: importForm.strategy,
        conflict: importForm.conflict,
        createRoute: importForm.createRoute,
        inboundTags: parseTags(importForm.inboundTags),
        input: importForm.input
      }
    });
    if (result.state === 'partial') ElMessage.warning(result.message || `已导入 ${result.imported} 个出站，但部分自动路由创建失败`);
    else ElMessage.success(result.message || `成功导入 ${result.imported} 个出站`);
    importDialogVisible.value = false;
    await loadResources();
  } catch (caught) {
    notifyError(caught, '导入出站失败');
  } finally {
    saving.value = false;
  }
}

function openRouteDialog() {
  editingRouteId.value = '';
  Object.assign(routeForm, {
    serverId: selectedServerId.value || enabledServers.value[0]?.id || '',
    name: '',
    serviceNodeId: '',
    outboundId: '',
    ownership: 'managed',
    pushRemote: true,
    conflict: 'reject',
    ruleText: '{\n  "type": "field",\n  "inboundTag": [],\n  "outboundTag": ""\n}'
  });
  routeDialogVisible.value = true;
}

function editRoute(route: NetworkRoute) {
  editingRouteId.value = route.id;
  Object.assign(routeForm, {
    serverId: route.serverId,
    name: route.name,
    serviceNodeId: route.serviceNodeId || '',
    outboundId: route.outboundId || '',
    ownership: route.ownership,
    pushRemote: false,
    conflict: 'reject',
    ruleText: JSON.stringify(route.normalizedConfig, null, 2)
  });
  routeDialogVisible.value = true;
}

function handleRouteServerChange() {
  routeForm.outboundId = '';
  routeForm.serviceNodeId = '';
}

function handleImportStrategyChange(strategy: 'local_only' | 'target_panel') {
  if (strategy === 'target_panel') importForm.ownership = 'managed';
  if (strategy === 'local_only' && importForm.conflict === 'takeover') importForm.conflict = 'reject';
}

function handleRoutePushRemoteChange(pushRemote: string | number | boolean) {
  if (pushRemote === true) routeForm.ownership = 'managed';
}

function handleRouteOutboundChange(outboundId: string) {
  const outbound = outbounds.value.find((item) => item.id === outboundId);
  if (!outbound) return;
  try {
    const rule = parseRule();
    rule.outboundTag = outbound.tag;
    routeForm.ruleText = JSON.stringify(rule, null, 2);
  } catch {
    // Keep the user's invalid JSON untouched until they fix it.
  }
}

function handleRouteServiceNodeChange(serviceNodeId: string) {
  const serviceNode = serviceNodes.value.find((item) => item.id === serviceNodeId);
  if (!serviceNode?.config?.remoteInboundTag) return;
  try {
    const rule = parseRule();
    rule.type = 'field';
    rule.inboundTag = [serviceNode.config.remoteInboundTag];
    routeForm.ruleText = JSON.stringify(rule, null, 2);
  } catch {
    // Keep the user's invalid JSON untouched until they fix it.
  }
}

async function saveRoute() {
  if (saving.value) return;
  let rule: Record<string, unknown>;
  try {
    rule = parseRule();
  } catch (caught) {
    notifyError(caught, '请检查路由设置');
    return;
  }
  saving.value = true;
  try {
    const path = editingRouteId.value ? `/api/admin/network-routes/${editingRouteId.value}` : '/api/admin/network-routes';
    await api(path, {
      method: editingRouteId.value ? 'PATCH' : 'POST',
      body: {
        serverId: routeForm.serverId,
        name: routeForm.name.trim(),
        serviceNodeId: routeForm.serviceNodeId || null,
        outboundId: routeForm.outboundId || null,
        ownership: routeForm.ownership,
        pushRemote: routeForm.pushRemote,
        conflict: routeForm.conflict,
        rule
      }
    });
    ElMessage.success(editingRouteId.value ? '路由规则已更新' : '路由规则已创建');
    routeDialogVisible.value = false;
    await loadResources();
  } catch (caught) {
    notifyError(caught, '保存路由规则失败');
  } finally {
    saving.value = false;
  }
}

async function deleteOutbound(outbound: NetworkOutbound, remote: boolean) {
  if (deletingIds.value.has(outbound.id)) return;
  const detail = remote
    ? outbound.ownership === 'managed'
      ? '将同时删除官方面板中的对应出站。远端配置发生漂移或仍被路由引用时，后端会拒绝删除。'
      : '本次操作表示确认接管删除，将同时删除官方面板中的对应出站。远端配置发生漂移或仍被路由引用时，后端会拒绝删除。'
    : '只删除集成系统中的本地记录，不修改官方面板。';
  try {
    await ElMessageBox.confirm(`确认删除出站“${outbound.name}”？${detail}`, remote ? '删除远端出站' : '删除本地出站记录', { type: 'warning' });
  } catch {
    return;
  }
  deletingIds.value = addPendingId(deletingIds.value, outbound.id);
  try {
    const query = remote ? `?remote=true${outbound.ownership === 'managed' ? '' : '&takeover=true'}` : '';
    await api(`/api/admin/network-outbounds/${outbound.id}${query}`, { method: 'DELETE' });
    ElMessage.success(remote ? '远端出站与本地记录已删除' : '本地出站记录已删除');
    await loadResources();
  } catch (caught) {
    notifyError(caught, '删除出站失败');
  } finally {
    deletingIds.value = removePendingId(deletingIds.value, outbound.id);
  }
}

async function deleteRoute(route: NetworkRoute, remote: boolean) {
  if (deletingIds.value.has(route.id)) return;
  const detail = remote
    ? route.ownership === 'managed'
      ? '将同时删除官方面板中的对应路由规则。远端规则发生漂移时，后端会拒绝误删。'
      : '本次操作表示确认接管删除，将同时删除官方面板中的对应路由规则。远端规则发生漂移时，后端会拒绝误删。'
    : '只删除集成系统中的本地记录，不修改官方面板。';
  try {
    await ElMessageBox.confirm(`确认删除路由“${route.name}”？${detail}`, remote ? '删除远端路由' : '删除本地路由记录', { type: 'warning' });
  } catch {
    return;
  }
  deletingIds.value = addPendingId(deletingIds.value, route.id);
  try {
    const query = remote ? `?remote=true${route.ownership === 'managed' ? '' : '&takeover=true'}` : '';
    await api(`/api/admin/network-routes/${route.id}${query}`, { method: 'DELETE' });
    ElMessage.success(remote ? '远端路由与本地记录已删除' : '本地路由记录已删除');
    await loadResources();
  } catch (caught) {
    notifyError(caught, '删除路由失败');
  } finally {
    deletingIds.value = removePendingId(deletingIds.value, route.id);
  }
}

function resourceMatches(item: { serverId: string; ownership: Ownership }, values: unknown[]) {
  if (selectedServerId.value && item.serverId !== selectedServerId.value) return false;
  if (selectedOwnership.value && item.ownership !== selectedOwnership.value) return false;
  const keyword = searchQuery.value.trim().toLowerCase();
  return !keyword || values.filter(Boolean).join(' ').toLowerCase().includes(keyword);
}

function showOutboundConfig(outbound: NetworkOutbound) {
  outboundDetail.value = outbound;
}
async function importConfigFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 ** 2) { ElMessage.error('配置文件不能超过 2 MB'); return; }
  try {
    const text = await file.text();
    JSON.parse(text);
    importForm.input = text;
    preview.value = null;
  } catch { ElMessage.error('无法读取配置文件，请选择面板导出的有效文件'); }
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseRule() {
  const parsed: unknown = JSON.parse(routeForm.ruleText);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('路由设置无效，请重新打开后重试');
  return parsed as Record<string, unknown>;
}

function parseTags(value: string) {
  return [...new Set(value.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean))];
}

function resetFilters() {
  searchQuery.value = '';
  selectedServerId.value = '';
  selectedOwnership.value = '';
  void loadResources();
}

function ownershipLabel(value: Ownership) {
  return value === 'managed' ? '本系统托管' : value === 'shared' ? '共享管理' : '官方引用';
}

function sourceFormatLabel(value?: string | null) {
  return formatOptions.find(([format]) => format === value)?.[1] || value || '远端同步';
}

function ruleSummary(rule: Record<string, unknown>) {
  const inbound = Array.isArray(rule.inboundTag) ? rule.inboundTag.join(', ') : String(rule.inboundTag || '全部入站');
  return `${inbound || '全部入站'} -> ${String(rule.outboundTag || '未指定出站')}`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '仅本地';
}

function addPendingId(source: Set<string>, id: string) {
  return new Set(source).add(id);
}

function removePendingId(source: Set<string>, id: string) {
  const next = new Set(source);
  next.delete(id);
  return next;
}

onMounted(loadResources);
</script>

<template>
  <section class="network-config-page operations-page" :class="{ loading }">
    <header class="operations-page-header page-head">
      <div class="page-head-main">
        <h1>网络规则</h1>
        <p>管理 3x-ui 出站与路由，复用 SOCKS 中转模板。sing-box 规则在 S-UI 工作区管理。</p>
      </div>
      <div class="page-actions">
        <el-button v-if="activeTab !== 'library'" :loading="loading" @click="loadResources"><RefreshCw :size="15" />刷新</el-button>
        <el-button v-if="activeTab === 'outbounds'" type="primary" @click="openImportDialog"><ArrowDownToLine :size="15" />导入出站</el-button>
        <el-button v-else-if="activeTab === 'routes'" type="primary" @click="openRouteDialog"><Plus :size="15" />创建路由</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="page-alert" />

    <el-tabs v-model="activeTab" class="network-tabs">
      <el-tab-pane label="面板出站" name="outbounds" />
      <el-tab-pane label="路由规则" name="routes" />
      <el-tab-pane label="SOCKS 中转模板" name="library" />
    </el-tabs>
    <SocksNodesView v-if="activeTab === 'library'" embedded />
    <template v-else>
    <div class="metric-grid operations-stat-grid">
      <article class="metric operations-stat-card"><span class="operations-stat-icon tone-indigo"><Network :size="18" /></span><div><span>出站记录</span><strong>{{ outbounds.length }}</strong><small>{{ managedOutboundCount }} 个由本系统托管</small></div></article>
      <article class="metric operations-stat-card"><span class="operations-stat-icon tone-emerald"><GitBranch :size="18" /></span><div><span>路由规则</span><strong>{{ routes.length }}</strong><small>{{ managedRouteCount }} 个由本系统托管</small></div></article>
      <article class="metric operations-stat-card"><span class="operations-stat-icon tone-cyan"><CloudUpload :size="18" /></span><div><span>远端出站</span><strong>{{ remoteOutboundCount }}</strong><small>已写入或同步官方面板</small></div></article>
      <article class="metric operations-stat-card"><span class="operations-stat-icon tone-amber"><Route :size="18" /></span><div><span>远端路由</span><strong>{{ remoteRouteCount }}</strong><small>带远端同步时间的规则</small></div></article>
    </div>

    <div class="panel operations-content-card network-workspace">


      <div class="filter-bar network-filter-bar">
        <div class="network-search-field"><Search :size="15" /><el-input v-model="searchQuery" clearable placeholder="搜索名称、标签、协议、面板或规则" /></div>
        <el-select v-model="selectedServerId" clearable placeholder="全部面板" @change="loadResources">
          <el-option v-for="server in servers" :key="server.id" :label="server.name" :value="server.id" />
        </el-select>
        <el-select v-model="selectedOwnership" clearable placeholder="全部所有权">
          <el-option label="本系统托管" value="managed" />
          <el-option label="官方引用" value="referenced" />
          <el-option label="共享管理" value="shared" />
        </el-select>
        <el-button text @click="resetFilters">重置</el-button>
      </div>

      <div v-loading="loading" class="entity-card-grid network-resource-grid">
        <template v-if="activeTab === 'outbounds'">
          <article v-for="outbound in filteredOutbounds" :key="outbound.id" class="network-resource-card entity-runtime-card" :class="outbound.lastSyncedAt ? 'runtime-state-online' : 'runtime-state-unknown'">
            <header class="network-resource-card-header">
              <div class="network-resource-identity">
                <span class="network-resource-icon entity-name-avatar">{{ entityInitial(outbound.name, '出') }}</span>
                <div><strong :title="outbound.name">{{ outbound.name }}</strong><span :title="outbound.tag">{{ outbound.tag }}</span></div>
              </div>
              <span class="network-resource-status" :class="outbound.lastSyncedAt ? 'is-synced' : 'is-local'"><i></i>{{ outbound.lastSyncedAt ? '已同步' : '仅本地' }}</span>
            </header>
            <div class="network-resource-metrics runtime-metric-grid">
              <div class="runtime-metric tone-cyan"><span>协议</span><strong>{{ outbound.protocol.toUpperCase() }}</strong></div>
              <div class="runtime-metric tone-indigo"><span>来源格式</span><strong>{{ sourceFormatLabel(outbound.sourceFormat) }}</strong></div>
              <div class="runtime-metric tone-emerald"><span>关联路由</span><strong>{{ outbound._count.routes }}</strong></div>
            </div>
            <div class="network-resource-runtime-info runtime-endpoint-line"><span class="runtime-endpoint-value"><Server :size="13" /><strong :title="outbound.server.name">{{ outbound.server.name }}</strong></span></div>
            <div class="network-resource-summary runtime-summary-line"><span class="network-resource-tag">{{ ownershipLabel(outbound.ownership) }}</span><span class="runtime-summary-note">同步：{{ formatDate(outbound.lastSyncedAt) }}</span></div>
            <footer class="network-resource-actions runtime-card-footer">
              <span class="runtime-footer-label"><Network :size="13" />{{ outbound.protocol.toUpperCase() }} · {{ outbound.tag }}</span>
              <div class="runtime-action-group">
                <el-tooltip content="修改出站名称" placement="top"><el-button class="runtime-icon-button" aria-label="修改出站名称" @click="renameOutbound(outbound)"><Edit3 :size="15" /></el-button></el-tooltip>
                <el-tooltip content="查看出站详情" placement="top"><el-button class="runtime-icon-button" aria-label="查看出站详情" @click="showOutboundConfig(outbound)"><Code2 :size="15" /></el-button></el-tooltip>
                <el-tooltip content="仅删除本地记录" placement="top"><el-button class="runtime-icon-button" :loading="deletingIds.has(outbound.id)" aria-label="仅删除本地记录" @click="deleteOutbound(outbound, false)"><Trash2 :size="15" /></el-button></el-tooltip>
                <el-tooltip :content="outbound.remoteFingerprint ? (outbound.ownership === 'managed' ? '删除远端出站与本地记录' : '接管并删除远端出站与本地记录') : '缺少已确认的远端状态，不能删除远端'" placement="top"><el-button class="runtime-icon-button danger" :disabled="!outbound.remoteFingerprint" :loading="deletingIds.has(outbound.id)" aria-label="删除远端出站" @click="deleteOutbound(outbound, true)"><CloudOff :size="15" /></el-button></el-tooltip>
              </div>
            </footer>
          </article>
          <div v-if="!loading && !filteredOutbounds.length" class="empty-panel network-empty"><Network :size="26" /><strong>暂无符合条件的出站</strong><span>从右上角导入分享链接、订阅或面板导出的配置文件。</span></div>
        </template>

        <template v-else>
          <article v-for="route in filteredRoutes" :key="route.id" class="network-resource-card entity-runtime-card" :class="route.lastSyncedAt ? 'runtime-state-online' : 'runtime-state-unknown'">
            <header class="network-resource-card-header">
              <div class="network-resource-identity">
                <span class="network-resource-icon entity-name-avatar">{{ entityInitial(route.name, '路') }}</span>
                <div><strong :title="route.name">{{ route.name }}</strong><span :title="ruleSummary(route.normalizedConfig)">{{ ruleSummary(route.normalizedConfig) }}</span></div>
              </div>
              <span class="network-resource-status" :class="route.lastSyncedAt ? 'is-synced' : 'is-local'"><i></i>{{ route.lastSyncedAt ? '已同步' : '仅本地' }}</span>
            </header>
            <div class="network-resource-metrics runtime-metric-grid">
              <div class="runtime-metric tone-cyan"><span>出站</span><strong>{{ route.outbound?.tag || String(route.normalizedConfig.outboundTag || '-') }}</strong></div>
              <div class="runtime-metric tone-indigo"><span>服务节点</span><strong>{{ route.serviceNode?.name || '未关联' }}</strong></div>
              <div class="runtime-metric tone-amber"><span>远端顺序</span><strong>{{ route.remoteOrder ?? '本地' }}</strong></div>
            </div>
            <div class="network-resource-runtime-info runtime-endpoint-line"><span class="runtime-endpoint-value"><Server :size="13" /><strong :title="route.server.name">{{ route.server.name }}</strong></span></div>
            <div class="network-resource-summary runtime-summary-line"><span class="network-resource-tag">{{ ownershipLabel(route.ownership) }}</span><span class="runtime-summary-note">同步：{{ formatDate(route.lastSyncedAt) }}</span></div>
            <footer class="network-resource-actions runtime-card-footer">
              <span class="runtime-footer-label"><Route :size="13" />{{ route.serviceNode?.name || '全部入站' }}</span>
              <div class="runtime-action-group">
                <el-tooltip content="编辑路由" placement="top"><el-button class="runtime-icon-button" aria-label="编辑路由" @click="editRoute(route)"><Edit3 :size="15" /></el-button></el-tooltip>
                <el-tooltip content="仅删除本地记录" placement="top"><el-button class="runtime-icon-button" :loading="deletingIds.has(route.id)" aria-label="仅删除本地记录" @click="deleteRoute(route, false)"><Trash2 :size="15" /></el-button></el-tooltip>
                <el-tooltip :content="route.remoteFingerprint ? (route.ownership === 'managed' ? '删除远端路由与本地记录' : '接管并删除远端路由与本地记录') : '缺少已确认的远端状态，不能删除远端'" placement="top"><el-button class="runtime-icon-button danger" :disabled="!route.remoteFingerprint" :loading="deletingIds.has(route.id)" aria-label="删除远端路由" @click="deleteRoute(route, true)"><CloudOff :size="15" /></el-button></el-tooltip>
              </div>
            </footer>
          </article>
          <div v-if="!loading && !filteredRoutes.length" class="empty-panel network-empty"><GitBranch :size="26" /><strong>暂无符合条件的路由</strong><span>创建本地规则或直接写入目标官方面板。</span></div>
        </template>
      </div>
    </div>
    </template>
  </section>

  <el-dialog v-model="importDialogVisible" title="导入出站" width="min(920px, 94vw)" class="operations-dialog" destroy-on-close>
    <el-form :model="importForm" label-position="top" class="network-dialog-form">
      <div class="network-dialog-grid">
        <el-form-item label="目标面板" required><el-select v-model="importForm.serverId" style="width: 100%"><el-option v-for="server in enabledServers" :key="server.id" :label="server.name" :value="server.id" /></el-select></el-form-item>
        <el-form-item label="导入格式"><el-select v-model="importForm.format" style="width: 100%"><el-option v-for="item in formatOptions" :key="item[0]" :label="item[1]" :value="item[0]" /></el-select></el-form-item>
        <el-form-item label="官方出站名称"><el-input v-model="importForm.name" maxlength="120" placeholder="单项导入时同时作为官方 tag" /></el-form-item>
        <el-form-item label="所有权"><el-select v-model="importForm.ownership" :disabled="importForm.strategy === 'target_panel'" style="width: 100%"><el-option label="本系统托管" value="managed" /><el-option label="官方引用" value="referenced" /><el-option label="共享管理" value="shared" /></el-select></el-form-item>
        <el-form-item label="保存方式"><el-select v-model="importForm.strategy" style="width: 100%" @change="handleImportStrategyChange"><el-option label="写入目标官方面板" value="target_panel" /><el-option label="仅保存本地记录" value="local_only" /></el-select></el-form-item>
        <el-form-item label="冲突策略"><el-select v-model="importForm.conflict" style="width: 100%"><el-option label="发现冲突时拒绝" value="reject" /><el-option label="自动重命名标签" value="rename" /><el-option label="替换本系统托管资源" value="replace_managed" /><el-option label="明确接管现有资源" value="takeover" /></el-select></el-form-item>
        <el-form-item label="自动创建路由" class="network-switch-item"><el-switch v-model="importForm.createRoute" /><span>为每个导入出站生成对应 field 路由。</span></el-form-item>
        <el-form-item v-if="importForm.createRoute" label="入站标签" class="network-dialog-full"><el-input v-model="importForm.inboundTags" placeholder="多个标签用逗号、空格或换行分隔" /></el-form-item>
        <el-form-item v-if="importForm.format === 'xray_json'" label="选择配置文件" class="network-dialog-full" required><input type="file" accept=".json" @change="importConfigFile" /><span v-if="importForm.input" class="muted-text">文件已读取，可预览后导入</span></el-form-item>
        <el-form-item v-else label="分享链接或订阅地址" class="network-dialog-full" required><el-input v-model="importForm.input" type="textarea" :rows="5" placeholder="粘贴服务商提供的分享链接或订阅地址" /></el-form-item>
      </div>
      <section v-if="preview" class="network-preview">
        <header><strong>识别结果：{{ preview.count }} 个出站</strong><span>{{ sourceFormatLabel(preview.format) }}</span></header>
        <div><span v-for="item in preview.items" :key="item.fingerprint"><b>{{ item.name }}</b><small>{{ item.protocol }} / {{ item.tag }}</small></span></div>
      </section>
    </el-form>
    <template #footer>
      <el-button :loading="previewing" :disabled="!importForm.input.trim()" @click="previewImport"><ShieldCheck :size="15" />预览识别</el-button>
      <el-button @click="importDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!importReady" @click="importOutbounds"><ArrowDownToLine :size="15" />确认导入</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="routeDialogVisible" :title="editingRouteId ? '编辑路由规则' : '创建路由规则'" width="min(860px, 94vw)" class="operations-dialog" destroy-on-close>
    <el-form :model="routeForm" label-position="top" class="network-dialog-form">
      <div class="network-dialog-grid">
        <el-form-item label="目标面板" required><el-select v-model="routeForm.serverId" :disabled="Boolean(editingRouteId)" style="width: 100%" @change="handleRouteServerChange"><el-option v-for="server in enabledServers" :key="server.id" :label="server.name" :value="server.id" /></el-select></el-form-item>
        <el-form-item label="规则名称" required><el-input v-model="routeForm.name" maxlength="120" placeholder="例如：香港入站转 SOCKS" /></el-form-item>
        <el-form-item label="关联出站"><el-select v-model="routeForm.outboundId" clearable style="width: 100%" @change="handleRouteOutboundChange"><el-option v-for="outbound in availableRouteOutbounds" :key="outbound.id" :label="`${outbound.name} (${outbound.tag})`" :value="outbound.id" /></el-select></el-form-item>
        <el-form-item label="关联服务节点"><el-select v-model="routeForm.serviceNodeId" clearable style="width: 100%" @change="handleRouteServiceNodeChange"><el-option v-for="node in availableServiceNodes" :key="node.id" :label="`${node.name}${node.inboundId ? ` (#${node.inboundId})` : ''}`" :value="node.id" /></el-select></el-form-item>
        <el-form-item label="所有权"><el-select v-model="routeForm.ownership" :disabled="routeForm.pushRemote" style="width: 100%"><el-option label="本系统托管" value="managed" /><el-option label="官方引用" value="referenced" /><el-option label="共享管理" value="shared" /></el-select></el-form-item>
        <el-form-item label="冲突策略"><el-select v-model="routeForm.conflict" style="width: 100%"><el-option label="发现冲突时拒绝" value="reject" /><el-option label="替换本系统托管规则" value="replace_managed" /><el-option label="明确接管远端规则" value="takeover" /></el-select></el-form-item>
        <el-form-item label="写入官方面板" class="network-switch-item"><el-switch v-model="routeForm.pushRemote" @change="handleRoutePushRemoteChange" /><span>关闭时只保存本地规则；引用规则写回必须选择明确接管。</span></el-form-item>
        <div class="network-dialog-full"><h3>匹配条件</h3><p class="muted-text">按需添加域名、IP 范围或端口；未填写的条件不参与匹配。</p><PanelFields v-model="routeRule" :schema="routeRuleSchema" :choices="{ outboundTag: availableRouteOutbounds.map(item => ({ value: item.tag, label: item.name })) }" /></div>
      </div>
    </el-form>
    <template #footer>
      <el-button @click="routeDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!routeForm.serverId || !routeForm.name.trim() || !routeForm.ruleText.trim()" @click="saveRoute"><CloudUpload :size="15" />{{ routeForm.pushRemote ? '保存并写入面板' : '仅保存本地' }}</el-button>
    </template>
  </el-dialog>
  <el-dialog :model-value="Boolean(outboundDetail)" title="出站详情" width="min(860px, 94vw)" @update:model-value="outboundDetail = null"><PanelFields v-if="outboundDetail" :model-value="decodePanelValue(outboundDetail.normalizedConfig)" readonly /></el-dialog>
</template>
