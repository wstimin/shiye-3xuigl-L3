<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
const props = defineProps<{ embedded?: boolean; provider?: 'xui' | 'sui' }>();
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/checkbox/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/switch/style/css';
import { ElAlert, ElButton, ElCheckbox, ElDialog, ElForm, ElFormItem, ElInput, ElInputNumber, ElMessage, ElMessageBox, ElOption, ElSelect, ElSwitch } from 'element-plus';
import {
  CheckCircle2,
  Clipboard,
  Download,
  Eye,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck
} from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { entityInitial } from '../entity-avatar';
import { notifyError } from '../notify';

type SyncTask = { id: string; action: string; status: string; message?: string | null; attemptCount: number; updatedAt: string };
type OperationResult = { state?: 'success' | 'partial' | 'failed'; message?: string; pendingActions?: string[] };

type SocksNode = {
  id: string;
  name: string;
  host: string;
  port: number;
  username?: string | null;
  enabled: boolean;
  remark?: string | null;
  hasPassword?: boolean;
  sourceServerId?: string | null;
  remoteOutboundTag?: string | null;
  syncTasks?: SyncTask[];
};
type ServiceNode = { id: string; config?: { socksRelayEnabled?: boolean; socksNodeId?: string | null } | null };
type PanelServer = { id: string; provider: string; name: string; baseUrl: string; enabled: boolean };

const nodes = ref<SocksNode[]>([]);
const serviceNodes = ref<ServiceNode[]>([]);
const servers = ref<PanelServer[]>([]);
const applying = ref<SocksNode | null>(null);
const applyServerId = ref('');
const applyName = ref('');
const applyingBusy = ref(false);
const loading = ref(false);
const saving = ref(false);
const syncingRemote = ref(false);
const revealingSecret = ref(false);
const togglingIds = ref<Set<string>>(new Set());
const deletingIds = ref<Set<string>>(new Set());
const retryingIds = ref<Set<string>>(new Set());
const error = ref('');
const searchQuery = ref('');
const selectedStatus = ref('');
const selectedSource = ref('');
const selectedAuth = ref('');
const syncServerId = ref('');
const editingId = ref('');
const dialogVisible = ref(false);
const clearPassword = ref(false);
const form = reactive({ name: '', host: '', port: 1080, username: '', password: '', enabled: true, remark: '' });

const enabledNodeCount = computed(() => nodes.value.filter((node) => node.enabled).length);
const authedNodeCount = computed(() => nodes.value.filter(hasAuthentication).length);
const importedNodeCount = computed(() => nodes.value.filter(isImportedNode).length);
const usedNodeCount = computed(() => nodes.value.filter((node) => usageCount(node.id) > 0).length);
const enabledServers = computed(() => servers.value.filter((server) => server.enabled));
const hasActiveFilters = computed(() => Boolean(searchQuery.value.trim() || selectedStatus.value || selectedSource.value || selectedAuth.value));
const filteredNodes = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
  return nodes.value.filter((node) => {
    const references = usageCount(node.id);
    if (keyword && !socksSearchText(node).includes(keyword)) return false;
    if (selectedStatus.value === 'enabled' && !node.enabled) return false;
    if (selectedStatus.value === 'disabled' && node.enabled) return false;
    if (selectedStatus.value === 'used' && references === 0) return false;
    if (selectedStatus.value === 'unused' && references > 0) return false;
    if (selectedSource.value === 'imported' && !isImportedNode(node)) return false;
    if (selectedSource.value === 'manual' && isImportedNode(node)) return false;
    if (selectedAuth.value === 'authenticated' && !hasAuthentication(node)) return false;
    if (selectedAuth.value === 'anonymous' && hasAuthentication(node)) return false;
    return true;
  });
});

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    const [socksResult, serviceResult, serverResult] = await Promise.all([
      api<SocksNode[]>('/api/admin/socks-nodes'),
      api<ServiceNode[]>('/api/admin/service-nodes'),
      api<PanelServer[]>('/api/admin/panel-servers')
    ]);
    nodes.value = socksResult;
    serviceNodes.value = serviceResult;
    servers.value = serverResult;
    if (syncServerId.value && !enabledServers.value.some((server) => server.id === syncServerId.value)) syncServerId.value = '';
    const firstEnabledServer = enabledServers.value.find(server => server.provider === props.provider) || enabledServers.value[0];
    if (!syncServerId.value && firstEnabledServer) syncServerId.value = firstEnabledServer.id;
  } catch (err) {
    error.value = readableError(err, '加载SOCKS 中转模板失败');
  } finally {
    loading.value = false;
  }
}

async function saveNode() {
  if (saving.value) return;
  saving.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/socks-nodes/${editingId.value}` : '/api/admin/socks-nodes';
    const result = await api<OperationResult>(path, { method: editingId.value ? 'PATCH' : 'POST', body: cleanFormBody() });
    if (result.state === 'partial') ElMessage.warning(readableError(result.message, '保存成功，但部分同步失败'));
    else ElMessage.success(editingId.value ? 'SOCKS 中转模板已更新' : 'SOCKS 中转模板已添加');
    dialogVisible.value = false;
    resetForm();
    await loadNodes();
  } catch (err) {
    showError(err, '保存SOCKS 中转模板失败');
  } finally {
    saving.value = false;
  }
}

async function syncRemoteSocks() {
  if (syncingRemote.value) return;
  if (!syncServerId.value) {
    ElMessage.warning('请先选择来源面板');
    return;
  }
  const server = servers.value.find((item) => item.id === syncServerId.value);
  try {
    await ElMessageBox.confirm(
      `从“${server?.name || '选中的面板'}”复制 SOCKS 模板到本地？此操作不会创建远端规则。`,
      '从面板复制模板',
      { type: 'warning', customClass: 'socks-message-box' }
    );
  } catch {
    return;
  }
  syncingRemote.value = true;
  error.value = '';
  try {
    const result = await api<{ imported?: number; skipped?: number; remoteSocksImported?: number }>(`/api/admin/${server?.provider === 'sui' ? 'sui' : 'xui'}-servers/${syncServerId.value}/sync-socks`, { method: 'POST' });
    const note = `已复制 ${result.imported ?? result.remoteSocksImported ?? 0} 个 SOCKS 模板`;
    if (result.skipped) ElMessage.warning(`${note}；${result.skipped} 个不支持、无效或正在使用的模板已跳过`);
    else ElMessage.success(note);
    await loadNodes();
  } catch (err) {
    showError(err, '从面板复制模板 失败');
  } finally {
    syncingRemote.value = false;
  }
}

function openApply(node: SocksNode) {
  applying.value = node;
  applyServerId.value = enabledServers.value.find(server => server.provider === props.provider)?.id || syncServerId.value || enabledServers.value[0]?.id || '';
  applyName.value = node.name;
}
async function applyTemplate() {
  const node = applying.value, server = servers.value.find(item => item.id === applyServerId.value);
  if (!node || !server || !node.enabled || !server.enabled || !applyName.value.trim() || applyingBusy.value) return;
  applyingBusy.value = true;
  try {
    const { password } = await api<{ password: string }>(`/api/admin/socks-nodes/${node.id}/secrets`);
    if (password && !node.username) throw new Error('此模板有密码但未填写账号，请先编辑模板补齐账号');
    if (server.provider === 'sui') {
      await api(`/api/admin/sui-servers/${server.id}/save`, { method: 'POST', body: { object: 'outbounds', action: 'new', data: { type: 'socks', tag: applyName.value.trim(), server: node.host, server_port: node.port, version: '5', ...(node.username ? { username: node.username, password } : {}) } } });
    } else {
      const url = new URL('socks://127.0.0.1');
      url.hostname = node.host.includes(':') ? `[${node.host.replace(/^\[|\]$/g, '')}]` : node.host;
      url.port = String(node.port); url.username = node.username || ''; url.password = password || '';
      const result = await api<OperationResult>('/api/admin/network-outbounds/import', { method: 'POST', body: { serverId: server.id, name: applyName.value.trim(), input: url.toString(), format: 'socks', strategy: 'target_panel', ownership: 'managed', conflict: 'reject', createRoute: false, inboundTags: [] } });
      if (result.state && result.state !== 'success') throw new Error(result.message || '出站创建尚未完成，请先核对面板状态');
    }
    ElMessage.success('出站已创建，可在路由规则中选择并关联入站');
    applying.value = null;
  } catch (cause) { notifyError(cause, '使用 SOCKS 模板失败'); }
  finally { applyingBusy.value = false; }
}

function openDialog() {
  resetForm();
  dialogVisible.value = true;
}

async function editNode(node: SocksNode) {
  editingId.value = node.id;
  clearPassword.value = false;
  Object.assign(form, {
    name: node.name,
    host: node.host,
    port: node.port,
    username: node.username || '',
    password: '',
    enabled: node.enabled,
    remark: node.remark || ''
  });
  await revealNodeSecret();
  if (editingId.value !== node.id) return;
  dialogVisible.value = true;
}

async function revealNodeSecret() {
  if (!editingId.value) return;
  const requestedId = editingId.value;
  revealingSecret.value = true;
  error.value = '';
  try {
    const secrets = await api<{ password: string }>(`/api/admin/socks-nodes/${editingId.value}/secrets`);
    if (editingId.value !== requestedId) return;
    form.password = secrets.password || '';
    clearPassword.value = false;
  } catch (err) {
    showError(err, '读取保存密码失败');
  } finally {
    revealingSecret.value = false;
  }
}

async function removeNode(node: SocksNode) {
  if (deletingIds.value.has(node.id)) return;
  const remoteHint = isRemoteManaged(node)
    ? '该节点来自官方面板。本次操作表示确认接管删除，并会同步删除远端对应 SOCKS 出站和全部引用规则。'
    : '只删除本地模板，已有远端出站不受影响。';
  try {
    await ElMessageBox.confirm(
      `确认删除SOCKS 中转模板“${node.name}”？${remoteHint} 正在被服务入站使用时，后端会拒绝删除。`,
      '删除SOCKS 中转模板',
      { type: 'warning', customClass: 'socks-message-box' }
    );
  } catch {
    return;
  }
  deletingIds.value = addPendingId(deletingIds.value, node.id);
  error.value = '';
  try {
    const takeover = isRemoteManaged(node) ? '?takeover=true' : '';
    await api(`/api/admin/socks-nodes/${node.id}${takeover}`, { method: 'DELETE' });
    ElMessage.success('SOCKS 中转模板已删除');
    await loadNodes();
  } catch (err) {
    showError(err, '删除SOCKS 中转模板失败');
  } finally {
    deletingIds.value = removePendingId(deletingIds.value, node.id);
  }
}

async function toggleNodeEnabled(node: SocksNode, enabled = !node.enabled) {
  if (togglingIds.value.has(node.id)) return;
  const previous = node.enabled;
  node.enabled = enabled;
  togglingIds.value = addPendingId(togglingIds.value, node.id);
  error.value = '';
  try {
    const result = await api<OperationResult>(`/api/admin/socks-nodes/${node.id}`, { method: 'PATCH', body: { enabled } });
    if (result.state === 'partial') ElMessage.warning('保存成功，同步失败');
    else ElMessage.success(enabled ? 'SOCKS 中转模板已启用' : 'SOCKS 中转模板已停用');
    await loadNodes();
  } catch (err) {
    node.enabled = previous;
    showError(err, '更新SOCKS 中转模板状态失败');
  } finally {
    await loadNodes();
    togglingIds.value = removePendingId(togglingIds.value, node.id);
  }
}

async function retryNodeTasks(node: SocksNode) {
  if (retryingIds.value.has(node.id) || !node.syncTasks?.length) return;
  retryingIds.value = addPendingId(retryingIds.value, node.id);
  let failed = 0;
  const priority: Record<string, number> = { 'socks-references': 1, 'socks-delete-check': 2 };
  for (const task of [...node.syncTasks].sort((left, right) => (priority[left.action] || 9) - (priority[right.action] || 9))) {
    try {
      await api(`/api/admin/sync-tasks/${task.id}/retry`, { method: 'POST' });
    } catch {
      failed += 1;
    }
  }
  if (failed) ElMessage.warning('部分同步失败');
  else ElMessage.success('同步成功');
  retryingIds.value = removePendingId(retryingIds.value, node.id);
  await loadNodes();
}

async function copyEndpoint(node: SocksNode) {
  const endpoint = `${node.host}:${node.port}`;
  try {
    await navigator.clipboard.writeText(endpoint);
  } catch {
    const input = document.createElement('textarea');
    input.value = endpoint;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  ElMessage.success('SOCKS 地址已复制');
}

function resetFilters() {
  searchQuery.value = '';
  selectedStatus.value = '';
  selectedSource.value = '';
  selectedAuth.value = '';
}

function resetForm() {
  editingId.value = '';
  clearPassword.value = false;
  Object.assign(form, { name: '', host: '', port: 1080, username: '', password: '', enabled: true, remark: '' });
}

function cleanFormBody() {
  return {
    name: form.name.trim(),
    host: form.host.trim(),
    port: form.port,
    username: form.username.trim() || undefined,
    password: clearPassword.value ? '' : form.password || undefined,
    enabled: form.enabled,
    remark: form.remark.trim() || undefined
  };
}

function usageCount(id: string) {
  return serviceNodes.value.filter((node) => node.config?.socksRelayEnabled && node.config?.socksNodeId === id).length;
}

function serverName(id?: string | null) {
  if (!id) return '';
  return servers.value.find((server) => server.id === id)?.name || id;
}

function isImportedNode(node: SocksNode) {
  return Boolean(node.sourceServerId || node.remoteOutboundTag);
}
function isRemoteManaged(node: SocksNode) {
  return Boolean(node.sourceServerId && node.remoteOutboundTag && servers.value.find(server => server.id === node.sourceServerId)?.provider !== 'sui');
}

function hasAuthentication(node: SocksNode) {
  return Boolean(node.username || node.hasPassword);
}

function socksSearchText(node: SocksNode) {
  return [
    node.name,
    node.host,
    node.port,
    node.username,
    node.enabled ? '启用' : '停用',
    hasAuthentication(node) ? '认证' : '无认证',
    isImportedNode(node) ? '远端导入' : '本地创建',
    node.remark,
    node.remoteOutboundTag,
    serverName(node.sourceServerId),
    usageCount(node.id)
  ].filter(Boolean).join(' ').toLowerCase();
}

function addPendingId(source: Set<string>, id: string) {
  return new Set(source).add(id);
}

function removePendingId(source: Set<string>, id: string) {
  const next = new Set(source);
  next.delete(id);
  return next;
}

function showError(err: unknown, fallback: string) {
  notifyError(err, fallback);
}

onMounted(loadNodes);
</script>

<template>
  <section class="socks-management-page" :class="{ loading }">
    <header class="socks-page-header">
      <div v-if="!embedded">
        <h1>SOCKS 中转模板</h1>
        <p>维护真实 SOCKS 出站连接；服务入站启用出站中转后会引用这里的地址与认证信息。</p>
      </div>
      <div class="socks-page-actions">
        <el-select v-model="syncServerId" aria-label="模板来源面板" placeholder="选择来源面板" class="socks-server-select">
          <el-option v-for="server in enabledServers" :key="server.id" :label="`${server.provider === 'sui' ? 'S-UI' : '3x-ui'} · ${server.name}`" :value="server.id" />
        </el-select>
        <el-button class="socks-secondary-button" :loading="syncingRemote" :disabled="!syncServerId" @click="syncRemoteSocks"><Download :size="15" />从面板复制模板</el-button>
        <el-button class="socks-secondary-button" :loading="loading" @click="loadNodes"><RefreshCw :size="15" />刷新</el-button>
        <el-button type="primary" @click="openDialog"><Plus :size="15" />添加模板</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="socks-page-alert" />

    <div class="socks-stat-grid">
      <article class="socks-stat-card">
        <span class="socks-stat-icon tone-indigo"><ShieldCheck :size="18" /></span>
        <div><small>出站总数</small><strong>{{ nodes.length }}</strong><span>真实保存的 SOCKS 节点</span></div>
      </article>
      <article class="socks-stat-card">
        <span class="socks-stat-icon tone-emerald"><CheckCircle2 :size="18" /></span>
        <div><small>已启用</small><strong>{{ enabledNodeCount }}</strong><span>{{ nodes.length - enabledNodeCount }} 个已停用</span></div>
      </article>
      <article class="socks-stat-card">
        <span class="socks-stat-icon tone-cyan"><KeyRound :size="18" /></span>
        <div><small>认证节点</small><strong>{{ authedNodeCount }}</strong><span>保存账号或密码</span></div>
      </article>
      <article class="socks-stat-card">
        <span class="socks-stat-icon tone-amber"><Link2 :size="18" /></span>
        <div><small>正在引用</small><strong>{{ usedNodeCount }}</strong><span>{{ importedNodeCount }} 个来自远端导入</span></div>
      </article>
    </div>

    <div class="socks-filter-panel">
      <div class="socks-search-field">
        <Search :size="15" />
        <el-input v-model="searchQuery" clearable placeholder="搜索名称、地址、端口、账号、来源面板或备注" />
      </div>
      <el-select v-model="selectedStatus" clearable placeholder="全部状态" class="socks-filter-select">
        <el-option label="已启用" value="enabled" />
        <el-option label="已停用" value="disabled" />
        <el-option label="正在引用" value="used" />
        <el-option label="未被引用" value="unused" />
      </el-select>
      <el-select v-model="selectedSource" clearable placeholder="全部来源" class="socks-filter-select">
        <el-option label="远端导入" value="imported" />
        <el-option label="本地创建" value="manual" />
      </el-select>
      <el-select v-model="selectedAuth" clearable placeholder="全部认证" class="socks-filter-select">
        <el-option label="配置认证" value="authenticated" />
        <el-option label="无认证" value="anonymous" />
      </el-select>
      <el-button v-if="hasActiveFilters" class="socks-reset-filter" text @click="resetFilters">重置</el-button>
    </div>

    <div v-loading="loading" class="hub-card hub-table-wrap">
      <table class="hub-table resource-table" aria-label="SOCKS 模板列表">
        <thead><tr><th>模板名称</th><th>连接地址</th><th>来源</th><th>认证 / 引用</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="node in filteredNodes" :key="node.id">
            <td><div class="hub-entity"><span class="hub-avatar">{{ entityInitial(node.name, '出') }}</span><div><strong>{{ node.name }}</strong><small>{{ node.remark || 'socks5' }}</small></div></div></td>
            <td>{{ node.host }}:{{ node.port }} <button class="hub-link" aria-label="复制 SOCKS 地址" @click="copyEndpoint(node)"><Clipboard :size="14" /></button></td>
            <td>{{ serverName(node.sourceServerId) || '本地创建' }}<small class="resource-note">{{ isRemoteManaged(node) ? '关联远端出站' : '独立模板' }}<template v-if="node.remoteOutboundTag"> · {{ node.remoteOutboundTag }}</template></small></td>
            <td>{{ hasAuthentication(node) ? '已配置认证' : '无认证' }}<small class="resource-note">{{ usageCount(node.id) }} 个服务入站引用</small></td>
            <td><span class="status-pill" :class="{ off: !node.enabled }">{{ node.syncTasks?.length ? '待同步' : node.enabled ? '已启用' : '已停用' }}</span></td>
            <td><div class="hub-actions">
              <button class="hub-link" :disabled="!node.enabled" @click="openApply(node)">使用模板</button><button class="hub-link" @click="editNode(node)">编辑</button>
              <button v-if="node.syncTasks?.length" class="hub-link" :disabled="retryingIds.has(node.id)" @click="retryNodeTasks(node)">重试同步</button>
              <el-switch :model-value="node.enabled" :aria-label="node.enabled ? '停用模板' : '启用模板'" :loading="togglingIds.has(node.id)" :disabled="togglingIds.has(node.id)" @change="(enabled: boolean | string | number) => toggleNodeEnabled(node, Boolean(enabled))" />
              <button class="hub-link danger" :disabled="deletingIds.has(node.id)" @click="removeNode(node)">删除</button>
            </div></td>
          </tr>
          <tr v-if="!filteredNodes.length && !loading"><td colspan="6" class="table-empty">暂无符合条件的 SOCKS 模板，可添加模板或从 3x-ui、S-UI 面板复制。</td></tr>
        </tbody>
      </table>
    </div>

    <footer class="socks-list-footer">显示 {{ filteredNodes.length }} / {{ nodes.length }} 个真实 SOCKS 出站</footer>
  </section>

  <el-dialog :model-value="Boolean(applying)" title="使用 SOCKS 模板" width="min(560px, 94vw)" :close-on-click-modal="!applyingBusy" :close-on-press-escape="!applyingBusy" :show-close="!applyingBusy" @update:model-value="!applyingBusy && (applying = null)">
    <el-form label-position="top">
      <el-form-item label="目标面板"><el-select v-model="applyServerId" aria-label="模板目标面板" :disabled="applyingBusy" style="width: 100%"><el-option v-for="server in enabledServers" :key="server.id" :label="`${server.provider === 'sui' ? 'S-UI' : '3x-ui'} · ${server.name}`" :value="server.id" /></el-select></el-form-item>
      <el-form-item label="出站名称"><el-input v-model="applyName" maxlength="120" :disabled="applyingBusy" placeholder="输入便于识别的名称" /></el-form-item>
      <p class="muted-text">创建独立出站后，可在路由规则中选择它。后续修改模板不会改动此次创建的出站。</p>
    </el-form>
    <template #footer><el-button :disabled="applyingBusy" @click="applying = null">取消</el-button><el-button type="primary" :loading="applyingBusy" :disabled="!applyServerId || !applyName.trim()" @click="applyTemplate">创建出站</el-button></template>
  </el-dialog>
  <el-dialog
    v-model="dialogVisible"
    :title="editingId ? '编辑 SOCKS 出站' : '添加 SOCKS 出站'"
    width="min(680px, 94vw)"
    class="socks-dialog"
    destroy-on-close
  >
    <div class="socks-dialog-intro">
      <ShieldCheck :size="18" />
      <div>
        <strong>{{ editingId ? '更新已保存的 SOCKS 出站配置' : '添加真实 SOCKS 出站连接' }}</strong>
        <span>保存地址与认证信息后，可用模板在 3x-ui 或 S-UI 创建出站，再选择路由关联入站。</span>
      </div>
    </div>

    <el-form :model="form" label-position="top" class="socks-dialog-form">
      <section class="socks-dialog-section">
        <header><strong>基本信息</strong><span>设置节点名称和启用状态</span></header>
        <div class="socks-dialog-grid">
          <el-form-item label="节点名称"><el-input v-model="form.name" maxlength="120" placeholder="例如 HK-SOCKS-01" /></el-form-item>
          <el-form-item label="启用此出站" class="socks-switch-item">
            <div class="socks-switch-row">
              <span>停用时不能被新的服务入站选择</span>
              <el-switch v-model="form.enabled" />
            </div>
          </el-form-item>
        </div>
      </section>

      <section class="socks-dialog-section">
        <header><strong>SOCKS 连接</strong><span>填写真实服务器地址和端口，协议固定为 SOCKS</span></header>
        <div class="socks-dialog-grid">
          <el-form-item label="服务器地址"><el-input v-model="form.host" maxlength="255" placeholder="域名或 IP 地址" /></el-form-item>
          <el-form-item label="端口"><el-input-number v-model="form.port" :min="1" :max="65535" controls-position="right" style="width: 100%" /></el-form-item>
        </div>
      </section>

      <section class="socks-dialog-section">
        <header><strong>访问认证</strong><span>无认证时留空；编辑时密码留空会保留原值</span></header>
        <div class="socks-dialog-grid">
          <el-form-item label="用户名"><el-input v-model="form.username" maxlength="120" placeholder="可选 SOCKS 用户名" /></el-form-item>
          <el-form-item label="密码">
            <el-input v-model="form.password" type="text" maxlength="256" :disabled="clearPassword" placeholder="编辑时留空不修改" />
            <el-checkbox v-if="editingId" v-model="clearPassword" class="socks-clear-secret">清除已保存密码</el-checkbox>
          </el-form-item>
          <el-form-item v-if="editingId" label="已保存凭据" class="socks-dialog-full">
            <el-button class="socks-secondary-button" :loading="revealingSecret" @click="revealNodeSecret"><Eye :size="15" />读取已保存密码</el-button>
          </el-form-item>
        </div>
      </section>

      <section class="socks-dialog-section">
        <header><strong>备注</strong><span>记录线路、机房、用途或维护信息</span></header>
        <div class="socks-dialog-grid">
          <el-form-item label="备注" class="socks-dialog-full"><el-input v-model="form.remark" type="textarea" :rows="3" maxlength="500" placeholder="输入SOCKS 中转模板备注" /></el-form-item>
        </div>
      </section>
    </el-form>

    <template #footer>
      <el-button class="socks-secondary-button" @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.name.trim() || !form.host.trim() || !form.port" @click="saveNode">{{ editingId ? '保存修改' : '添加模板' }}</el-button>
    </template>
  </el-dialog>
</template>
