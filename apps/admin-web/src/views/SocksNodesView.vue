<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  CheckCircle2,
  Clipboard,
  CloudCog,
  Download,
  Edit3,
  Eye,
  KeyRound,
  Link2,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2
} from 'lucide-vue-next';
import { api } from '../api';

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
};
type ServiceNode = { id: string; config?: { socksRelayEnabled?: boolean; socksNodeId?: string | null } | null };
type XuiServer = { id: string; name: string; baseUrl: string; enabled: boolean };

const nodes = ref<SocksNode[]>([]);
const serviceNodes = ref<ServiceNode[]>([]);
const servers = ref<XuiServer[]>([]);
const loading = ref(false);
const saving = ref(false);
const syncingRemote = ref(false);
const revealingSecret = ref(false);
const togglingIds = ref<Set<string>>(new Set());
const deletingIds = ref<Set<string>>(new Set());
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
      api<XuiServer[]>('/api/admin/xui-servers')
    ]);
    nodes.value = socksResult;
    serviceNodes.value = serviceResult;
    servers.value = serverResult;
    if (syncServerId.value && !enabledServers.value.some((server) => server.id === syncServerId.value)) syncServerId.value = '';
    const firstEnabledServer = enabledServers.value[0];
    if (!syncServerId.value && firstEnabledServer) syncServerId.value = firstEnabledServer.id;
  } catch (err) {
    showError(err, '加载出站节点失败');
  } finally {
    loading.value = false;
  }
}

async function saveNode() {
  saving.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/socks-nodes/${editingId.value}` : '/api/admin/socks-nodes';
    await api(path, { method: editingId.value ? 'PATCH' : 'POST', body: cleanFormBody() });
    ElMessage.success(editingId.value ? '出站节点已更新' : '出站节点已添加');
    dialogVisible.value = false;
    resetForm();
    await loadNodes();
  } catch (err) {
    showError(err, '保存出站节点失败');
  } finally {
    saving.value = false;
  }
}

async function syncRemoteSocks() {
  if (!syncServerId.value) {
    ElMessage.warning('请先选择要导入的 3x-ui 面板');
    return;
  }
  const server = servers.value.find((item) => item.id === syncServerId.value);
  try {
    await ElMessageBox.confirm(
      `确认从“${server?.name || '选中的面板'}”读取并导入远端 SOCKS 出站？此操作只同步真实 SOCKS 出站到本地列表，不会创建远端规则。`,
      '导入远端 SOCKS',
      { type: 'warning', customClass: 'socks-dark-message-box' }
    );
  } catch {
    return;
  }
  syncingRemote.value = true;
  error.value = '';
  try {
    await api(`/api/admin/xui-servers/${syncServerId.value}/sync-socks`, { method: 'POST' });
    ElMessage.success('导入成功');
    await loadNodes();
  } catch (err) {
    showError(err, '导入远端 SOCKS 失败');
  } finally {
    syncingRemote.value = false;
  }
}

function openDialog() {
  resetForm();
  dialogVisible.value = true;
}

function editNode(node: SocksNode) {
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
  dialogVisible.value = true;
}

async function revealNodeSecret() {
  if (!editingId.value) return;
  revealingSecret.value = true;
  error.value = '';
  try {
    const secrets = await api<{ password: string }>(`/api/admin/socks-nodes/${editingId.value}/secrets`);
    form.password = secrets.password || '';
    clearPassword.value = false;
    ElMessage.success(secrets.password ? '已读取保存的出站密码' : '该出站节点没有保存密码');
  } catch (err) {
    showError(err, '读取保存密码失败');
  } finally {
    revealingSecret.value = false;
  }
}

async function removeNode(node: SocksNode) {
  const remoteHint = isImportedNode(node)
    ? '该节点来自远端，删除时会同步删除远端对应 SOCKS 出站和引用规则。'
    : '该节点由本地创建，只会删除本地记录。';
  try {
    await ElMessageBox.confirm(
      `确认删除出站节点“${node.name}”？${remoteHint} 正在被路由节点使用时，后端会拒绝删除。`,
      '删除出站节点',
      { type: 'warning', customClass: 'socks-dark-message-box' }
    );
  } catch {
    return;
  }
  deletingIds.value = addPendingId(deletingIds.value, node.id);
  error.value = '';
  try {
    await api(`/api/admin/socks-nodes/${node.id}`, { method: 'DELETE' });
    ElMessage.success('出站节点已删除');
    await loadNodes();
  } catch (err) {
    showError(err, '删除出站节点失败');
  } finally {
    deletingIds.value = removePendingId(deletingIds.value, node.id);
  }
}

async function toggleNodeEnabled(node: SocksNode, enabled = !node.enabled) {
  const previous = node.enabled;
  togglingIds.value = addPendingId(togglingIds.value, node.id);
  error.value = '';
  try {
    await api(`/api/admin/socks-nodes/${node.id}`, { method: 'PATCH', body: { enabled } });
    node.enabled = enabled;
    ElMessage.success(enabled ? '出站节点已启用' : '出站节点已停用');
  } catch (err) {
    node.enabled = previous;
    showError(err, '更新出站节点状态失败');
  } finally {
    togglingIds.value = removePendingId(togglingIds.value, node.id);
  }
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

function showError(_err: unknown, fallback: string) {
  error.value = fallback;
  ElMessage.error(fallback);
}

onMounted(loadNodes);
</script>

<template>
  <section class="socks-management-page" :class="{ loading }">
    <header class="socks-page-header">
      <div>
        <h1>出站节点</h1>
        <p>维护真实 SOCKS 出站连接；路由节点启用出站中转后会引用这里的地址与认证信息。</p>
      </div>
      <div class="socks-page-actions">
        <el-select v-model="syncServerId" placeholder="选择来源面板" class="socks-server-select">
          <el-option v-for="server in enabledServers" :key="server.id" :label="server.name" :value="server.id" />
        </el-select>
        <el-button class="socks-secondary-button" :loading="syncingRemote" :disabled="!syncServerId" @click="syncRemoteSocks"><Download :size="15" />导入远端 SOCKS</el-button>
        <el-button class="socks-secondary-button" :loading="loading" @click="loadNodes"><RefreshCw :size="15" />刷新</el-button>
        <el-button type="primary" @click="openDialog"><Plus :size="15" />添加出站</el-button>
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

    <div v-loading="loading" class="socks-card-grid">
      <article v-for="node in filteredNodes" :key="node.id" class="socks-outbound-card entity-runtime-card" :class="node.enabled ? 'runtime-state-online' : 'runtime-state-disabled'">
        <header class="socks-card-header">
          <div class="socks-card-identity">
            <span class="socks-card-icon"><Network :size="20" /></span>
            <div>
              <strong :title="node.name">{{ node.name }}</strong>
              <span>SOCKS 出站 · {{ isImportedNode(node) ? '远端导入' : '本地创建' }}</span>
            </div>
          </div>
          <span class="socks-status-chip" :class="node.enabled ? 'is-enabled' : 'is-disabled'"><i></i>{{ node.enabled ? '已启用' : '已停用' }}</span>
        </header>

        <div class="socks-endpoint">
          <Server :size="14" />
          <div>
            <small>SOCKS 连接地址</small>
            <strong :title="`${node.host}:${node.port}`">{{ node.host }}:{{ node.port }}</strong>
          </div>
          <el-tooltip content="复制 SOCKS 地址" placement="top">
            <button type="button" class="socks-copy-button" aria-label="复制 SOCKS 地址" @click="copyEndpoint(node)"><Clipboard :size="14" /></button>
          </el-tooltip>
        </div>

        <div class="socks-card-meta runtime-metric-grid">
          <div class="runtime-metric tone-indigo"><span>认证方式</span><strong>{{ hasAuthentication(node) ? '已配置' : '无认证' }}</strong></div>
          <div class="runtime-metric tone-cyan"><span>路由引用</span><strong>{{ usageCount(node.id) }} 个</strong></div>
          <div class="runtime-metric" :class="isImportedNode(node) ? 'tone-amber' : 'tone-emerald'"><span>节点来源</span><strong>{{ isImportedNode(node) ? '远端导入' : '本地创建' }}</strong></div>
        </div>

        <div class="runtime-info-line socks-runtime-info">
          <span><KeyRound :size="13" />{{ node.username || '未设置登录账号' }}</span>
          <span><Link2 :size="13" />{{ usageCount(node.id) ? '正在被路由引用' : '暂未被引用' }}</span>
        </div>

        <div class="socks-card-tags">
          <span class="socks-card-tag protocol">SOCKS</span>
          <span class="socks-card-tag" :class="isImportedNode(node) ? 'imported' : 'manual'">{{ isImportedNode(node) ? '远端导入' : '本地创建' }}</span>
          <span v-if="node.hasPassword" class="socks-card-tag password">已保存密码</span>
          <span v-if="node.remoteOutboundTag" class="socks-card-tag outbound" :title="node.remoteOutboundTag">{{ node.remoteOutboundTag }}</span>
        </div>

        <p v-if="node.remark" class="socks-card-remark">{{ node.remark }}</p>

        <footer class="socks-card-actions runtime-card-footer">
          <span class="runtime-footer-label"><Network :size="13" />{{ isImportedNode(node) ? (serverName(node.sourceServerId) || '远端面板') : '本地配置' }}</span>
          <div class="runtime-action-group">
          <el-tooltip content="编辑出站" placement="top">
            <el-button class="runtime-icon-button" aria-label="编辑出站" @click="editNode(node)"><Edit3 :size="15" /></el-button>
          </el-tooltip>
          <el-tooltip :content="node.enabled ? '停用出站' : '启用出站'" placement="top">
            <el-switch
              class="runtime-toggle-switch"
              :model-value="node.enabled"
              :loading="togglingIds.has(node.id)"
              :disabled="togglingIds.has(node.id)"
              @change="(enabled: boolean | string | number) => toggleNodeEnabled(node, Boolean(enabled))"
            />
          </el-tooltip>
          <el-tooltip content="删除出站节点" placement="top">
            <el-button class="socks-delete-button runtime-icon-button" :loading="deletingIds.has(node.id)" aria-label="删除出站节点" @click="removeNode(node)"><Trash2 :size="15" /></el-button>
          </el-tooltip>
          </div>
        </footer>
      </article>

      <div v-if="!filteredNodes.length && !loading" class="socks-empty-state">
        <CloudCog :size="28" />
        <strong>{{ nodes.length ? '没有符合筛选条件的出站节点' : '暂无出站节点' }}</strong>
        <span>{{ nodes.length ? '调整筛选条件后再查看' : '使用右上角按钮添加真实 SOCKS 出站，或从已启用面板导入' }}</span>
      </div>
    </div>

    <footer class="socks-list-footer">显示 {{ filteredNodes.length }} / {{ nodes.length }} 个真实 SOCKS 出站</footer>
  </section>

  <el-dialog
    v-model="dialogVisible"
    :title="editingId ? '编辑 SOCKS 出站' : '添加 SOCKS 出站'"
    width="min(680px, 94vw)"
    class="socks-dark-dialog"
    destroy-on-close
  >
    <div class="socks-dialog-intro">
      <ShieldCheck :size="18" />
      <div>
        <strong>{{ editingId ? '更新已保存的 SOCKS 出站配置' : '添加真实 SOCKS 出站连接' }}</strong>
        <span>这里只保存当前系统实际支持的 SOCKS 地址与认证信息，路由节点引用后会同步写入对应远端 Xray。</span>
      </div>
    </div>

    <el-form :model="form" label-position="top" class="socks-dialog-form">
      <section class="socks-dialog-section">
        <header><strong>基本信息</strong><span>设置节点名称和启用状态</span></header>
        <div class="socks-dialog-grid">
          <el-form-item label="节点名称"><el-input v-model="form.name" maxlength="120" placeholder="例如 HK-SOCKS-01" /></el-form-item>
          <el-form-item label="启用此出站" class="socks-switch-item">
            <div class="socks-switch-row">
              <span>停用时不能被新的路由节点选择</span>
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
            <el-input v-model="form.password" type="password" show-password maxlength="256" :disabled="clearPassword" placeholder="编辑时留空不修改" />
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
          <el-form-item label="备注" class="socks-dialog-full"><el-input v-model="form.remark" type="textarea" :rows="3" maxlength="500" placeholder="输入出站节点备注" /></el-form-item>
        </div>
      </section>
    </el-form>

    <template #footer>
      <el-button class="socks-secondary-button" @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.name.trim() || !form.host.trim() || !form.port" @click="saveNode">{{ editingId ? '保存修改' : '添加出站' }}</el-button>
    </template>
  </el-dialog>
</template>
