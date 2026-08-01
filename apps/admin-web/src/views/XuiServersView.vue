<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  Activity,
  CheckCircle2,
  Clipboard,
  CloudCog,
  Edit3,
  Eye,
  FileKey2,
  KeyRound,
  MoreHorizontal,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Users,
  Wifi
} from 'lucide-vue-next';
import { api } from '../api';
import { entityAvatarStyle, entityInitial } from '../entity-avatar';

type XuiServer = {
  id: string;
  name: string;
  baseUrl: string;
  basePath?: string | null;
  username?: string | null;
  enabled: boolean;
  remark?: string | null;
  config?: {
    shareHost?: string;
    tlsServerName?: string;
    tlsCertFile?: string;
    tlsKeyFile?: string;
    realityTarget?: string;
    realityServerName?: string;
    realityFingerprint?: string;
    realitySpiderX?: string;
  } | null;
  hasPassword?: boolean;
  hasToken?: boolean;
};

type CertResult = { found: boolean; certFile: string; keyFile: string; message?: string; raw?: unknown };
type ConnectionTest = { state: 'success' | 'error'; inboundCount?: number; message?: string };

const servers = ref<XuiServer[]>([]);
const loading = ref(false);
const saving = ref(false);
const testingForm = ref(false);
const testingCertForm = ref(false);
const testingIds = ref<Set<string>>(new Set());
const certIds = ref<Set<string>>(new Set());
const syncingIds = ref<Set<string>>(new Set());
const syncingSocksIds = ref<Set<string>>(new Set());
const statusIds = ref<Set<string>>(new Set());
const presenceIds = ref<Set<string>>(new Set());
const togglingIds = ref<Set<string>>(new Set());
const deletingIds = ref<Set<string>>(new Set());
const revealingSecrets = ref(false);
const connectionTests = ref<Record<string, ConnectionTest>>({});
const error = ref('');
const searchQuery = ref('');
const selectedStatus = ref('');
const selectedCredential = ref('');
const editingId = ref('');
const dialogVisible = ref(false);
const clearPassword = ref(false);
const clearToken = ref(false);
const form = reactive({
  name: '',
  protocol: 'https' as 'http' | 'https',
  host: '',
  port: 2053,
  basePath: '/',
  shareHost: '',
  username: '',
  password: '',
  token: '',
  tlsServerName: '',
  tlsCertFile: '',
  tlsKeyFile: '',
  realityTarget: '',
  realityServerName: '',
  realityFingerprint: 'chrome',
  realitySpiderX: '/',
  enabled: true,
  remark: ''
});

const enabledServerCount = computed(() => servers.value.filter((server) => server.enabled).length);
const passwordServerCount = computed(() => servers.value.filter((server) => server.hasPassword).length);
const tokenServerCount = computed(() => servers.value.filter((server) => server.hasToken).length);
const baseConnectionReady = computed(() => Boolean(form.name.trim() && form.host.trim() && form.port >= 1 && form.port <= 65535));
const hasActiveFilters = computed(() => Boolean(searchQuery.value.trim() || selectedStatus.value || selectedCredential.value));
const filteredServers = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
  return servers.value.filter((server) => {
    if (keyword && !serverSearchText(server).includes(keyword)) return false;
    if (selectedStatus.value === 'enabled' && !server.enabled) return false;
    if (selectedStatus.value === 'disabled' && server.enabled) return false;
    if (selectedStatus.value === 'tested-success' && connectionTests.value[server.id]?.state !== 'success') return false;
    if (selectedStatus.value === 'tested-error' && connectionTests.value[server.id]?.state !== 'error') return false;
    if (selectedCredential.value === 'token' && !server.hasToken) return false;
    if (selectedCredential.value === 'password' && !server.hasPassword) return false;
    if (selectedCredential.value === 'missing' && (server.hasToken || server.hasPassword)) return false;
    return true;
  });
});

async function loadServers() {
  loading.value = true;
  error.value = '';
  try {
    servers.value = await api<XuiServer[]>('/api/admin/xui-servers');
  } catch (err) {
    showError(err, '加载面板连接失败');
  } finally {
    loading.value = false;
  }
}

async function saveServer() {
  saving.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/xui-servers/${editingId.value}` : '/api/admin/xui-servers';
    await api(path, { method: editingId.value ? 'PATCH' : 'POST', body: cleanFormBody() });
    ElMessage.success(editingId.value ? '面板连接已更新' : '面板连接已添加');
    dialogVisible.value = false;
    resetForm();
    await loadServers();
  } catch (err) {
    showError(err, '保存面板连接失败');
  } finally {
    saving.value = false;
  }
}

async function testForm() {
  testingForm.value = true;
  error.value = '';
  try {
    await api<{ connected: boolean; inbounds: unknown }>('/api/admin/xui/test', { method: 'POST', body: cleanFormBody() });
    ElMessage.success('连接成功');
  } catch (err) {
    showError(err, '测试连接失败');
  } finally {
    testingForm.value = false;
  }
}

async function testSaved(server: XuiServer) {
  testingIds.value = addPendingId(testingIds.value, server.id);
  error.value = '';
  try {
    const result = await api<{ inboundCount: number }>(`/api/admin/xui-servers/${server.id}/test`, { method: 'POST' });
    connectionTests.value = { ...connectionTests.value, [server.id]: { state: 'success', inboundCount: result.inboundCount } };
    ElMessage.success('连接成功');
  } catch (err) {
    const message = '连接失败';
    connectionTests.value = { ...connectionTests.value, [server.id]: { state: 'error', message } };
    showError(err, message);
  } finally {
    testingIds.value = removePendingId(testingIds.value, server.id);
  }
}

async function testFormCerts() {
  testingCertForm.value = true;
  error.value = '';
  try {
    const result = await api<CertResult>('/api/admin/xui/certs', { method: 'POST', body: cleanFormBody() });
    await showCertResult(result, true);
  } catch (err) {
    showError(err, '证书读取失败');
  } finally {
    testingCertForm.value = false;
  }
}

async function testSavedCerts(server: XuiServer) {
  certIds.value = addPendingId(certIds.value, server.id);
  error.value = '';
  try {
    const result = await api<CertResult>(`/api/admin/xui-servers/${server.id}/certs`);
    await showCertResult(result, false);
  } catch (err) {
    showError(err, '证书读取失败');
  } finally {
    certIds.value = removePendingId(certIds.value, server.id);
  }
}

async function showCertResult(result: CertResult, allowFill: boolean) {
  if (allowFill && result.found) {
    try {
      await ElMessageBox.confirm('已读取证书配置，是否回填？', '证书读取成功', {
        type: 'success',
        confirmButtonText: '回填',
        cancelButtonText: '取消',
        customClass: 'xui-dark-message-box'
      });
      form.tlsCertFile = result.certFile;
      form.tlsKeyFile = result.keyFile;
      ElMessage.success('证书回填成功');
    } catch {
      ElMessage.success('证书读取成功');
    }
    return;
  }
  if (result.found) ElMessage.success('证书读取成功');
  else ElMessage.warning('未读取到证书');
}

async function syncServer(server: XuiServer) {
  try {
    await ElMessageBox.confirm(
      `确认从“${server.name}”读取远端入站，并同步为本地路由节点？此操作不会同步远端用户。`,
      '同步远端节点',
      { type: 'warning', customClass: 'xui-dark-message-box' }
    );
  } catch {
    return;
  }
  syncingIds.value = addPendingId(syncingIds.value, server.id);
  error.value = '';
  try {
    await api(`/api/admin/xui-servers/${server.id}/sync`, { method: 'POST' });
    ElMessage.success('同步成功');
  } catch (err) {
    showError(err, '同步远端节点失败');
  } finally {
    syncingIds.value = removePendingId(syncingIds.value, server.id);
  }
}

async function syncServerSocks(server: XuiServer) {
  try {
    await ElMessageBox.confirm(
      `确认从“${server.name}”读取远端 Xray 配置并导入 SOCKS 出站？只会写入本地出站节点列表。`,
      '导入远端 SOCKS',
      { type: 'warning', customClass: 'xui-dark-message-box' }
    );
  } catch {
    return;
  }
  syncingSocksIds.value = addPendingId(syncingSocksIds.value, server.id);
  error.value = '';
  try {
    await api(`/api/admin/xui-servers/${server.id}/sync-socks`, { method: 'POST' });
    ElMessage.success('导入成功');
  } catch (err) {
    showError(err, '导入远端 SOCKS 失败');
  } finally {
    syncingSocksIds.value = removePendingId(syncingSocksIds.value, server.id);
  }
}

async function showServerStatus(server: XuiServer) {
  statusIds.value = addPendingId(statusIds.value, server.id);
  error.value = '';
  try {
    const result = await api<{ status?: Record<string, unknown>; versions?: unknown[] }>(`/api/admin/xui-servers/${server.id}/status`);
    const status = objectValue(result.status);
    const xray = objectValue(status.xray);
    const mem = objectValue(status.mem);
    const disk = objectValue(status.disk);
    const versions = (result.versions || []).slice(0, 5).map(formatShortValue).filter(Boolean);
    await ElMessageBox.alert([
      `Xray：${xray.state || status.xrayState || '-'} ${xray.version || status.xrayVersion || ''}`.trim(),
      `CPU：${status.cpu ?? '-'}%`,
      `内存：${formatBytes(Number(mem.current || 0))} / ${formatBytes(Number(mem.total || 0))}`,
      `磁盘：${formatBytes(Number(disk.current || 0))} / ${formatBytes(Number(disk.total || 0))}`,
      `可用版本：${versions.join(', ') || '-'}`
    ].join('\n'), `${server.name} 运行状态`, { type: 'info', customClass: 'xui-dark-message-box' });
  } catch (err) {
    showError(err, '读取面板连接状态失败');
  } finally {
    statusIds.value = removePendingId(statusIds.value, server.id);
  }
}

async function showClientPresence(server: XuiServer) {
  presenceIds.value = addPendingId(presenceIds.value, server.id);
  error.value = '';
  try {
    const result = await api<{ online?: unknown[]; lastOnline?: Record<string, unknown> }>(`/api/admin/xui-servers/${server.id}/client-presence`);
    const online = (result.online || []).map(String);
    const lastOnline = Object.entries(result.lastOnline || {}).slice(0, 12).map(([email, time]) => `${email}：${formatUnixTime(time)}`);
    await ElMessageBox.alert([
      `在线客户端：${online.length}`,
      online.length ? online.slice(0, 20).join(', ') : '-',
      '',
      '最近在线：',
      lastOnline.length ? lastOnline.join('\n') : '-'
    ].join('\n'), `${server.name} 客户端状态`, { type: 'info', customClass: 'xui-dark-message-box' });
  } catch (err) {
    showError(err, '读取客户端在线状态失败');
  } finally {
    presenceIds.value = removePendingId(presenceIds.value, server.id);
  }
}

function openDialog() {
  resetForm();
  dialogVisible.value = true;
}

function editServer(server: XuiServer) {
  const connection = splitServerBaseUrl(server.baseUrl);
  editingId.value = server.id;
  clearPassword.value = false;
  clearToken.value = false;
  Object.assign(form, {
    name: server.name,
    protocol: connection.protocol,
    host: connection.host,
    port: connection.port,
    basePath: normalizeBasePathForForm(server.basePath),
    shareHost: server.config?.shareHost || '',
    username: server.username || '',
    password: '',
    token: '',
    tlsServerName: server.config?.tlsServerName || '',
    tlsCertFile: server.config?.tlsCertFile || '',
    tlsKeyFile: server.config?.tlsKeyFile || '',
    realityTarget: server.config?.realityTarget || '',
    realityServerName: server.config?.realityServerName || '',
    realityFingerprint: server.config?.realityFingerprint || 'chrome',
    realitySpiderX: server.config?.realitySpiderX || '/',
    enabled: server.enabled,
    remark: server.remark || ''
  });
  dialogVisible.value = true;
}

async function revealServerSecrets() {
  if (!editingId.value) return;
  revealingSecrets.value = true;
  error.value = '';
  try {
    const secrets = await api<{ password: string; token: string }>(`/api/admin/xui-servers/${editingId.value}/secrets`);
    form.password = secrets.password || '';
    form.token = secrets.token || '';
    clearPassword.value = false;
    clearToken.value = false;
    ElMessage.success('已读取保存的密码和 Token');
  } catch (err) {
    showError(err, '读取保存凭据失败');
  } finally {
    revealingSecrets.value = false;
  }
}

async function removeServer(server: XuiServer) {
  try {
    await ElMessageBox.confirm(
      `确认删除面板连接“${server.name}”？存在关联路由节点时后端会拒绝删除，请先处理关联节点。`,
      '删除面板连接',
      { type: 'warning', customClass: 'xui-dark-message-box' }
    );
  } catch {
    return;
  }
  deletingIds.value = addPendingId(deletingIds.value, server.id);
  error.value = '';
  try {
    await api(`/api/admin/xui-servers/${server.id}`, { method: 'DELETE' });
    ElMessage.success('面板连接已删除');
    await loadServers();
  } catch (err) {
    showError(err, '删除面板连接失败');
  } finally {
    deletingIds.value = removePendingId(deletingIds.value, server.id);
  }
}

async function toggleServerEnabled(server: XuiServer, enabled = !server.enabled) {
  if (togglingIds.value.has(server.id)) return;
  const previous = server.enabled;
  server.enabled = enabled;
  togglingIds.value = addPendingId(togglingIds.value, server.id);
  error.value = '';
  try {
    await api(`/api/admin/xui-servers/${server.id}`, { method: 'PATCH', body: { enabled } });
    ElMessage.success(enabled ? '面板连接已启用' : '面板连接已停用');
  } catch (err) {
    server.enabled = previous;
    showError(err, '更新面板连接状态失败');
  } finally {
    togglingIds.value = removePendingId(togglingIds.value, server.id);
  }
}

function handleServerCommand(server: XuiServer, command: string) {
  if (command === 'test') void testSaved(server);
  if (command === 'status') void showServerStatus(server);
  if (command === 'presence') void showClientPresence(server);
  if (command === 'certs') void testSavedCerts(server);
  if (command === 'sync-socks') void syncServerSocks(server);
  if (command === 'toggle') void toggleServerEnabled(server);
  if (command === 'delete') void removeServer(server);
}

async function copyServerAddress(server: XuiServer) {
  const address = serverEndpoint(server);
  try {
    await navigator.clipboard.writeText(address);
  } catch {
    const input = document.createElement('textarea');
    input.value = address;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
  }
  ElMessage.success('面板地址已复制');
}

function resetFilters() {
  searchQuery.value = '';
  selectedStatus.value = '';
  selectedCredential.value = '';
}

function resetForm() {
  editingId.value = '';
  clearPassword.value = false;
  clearToken.value = false;
  Object.assign(form, {
    name: '',
    protocol: 'https',
    host: '',
    port: 2053,
    basePath: '/',
    shareHost: '',
    username: '',
    password: '',
    token: '',
    tlsServerName: '',
    tlsCertFile: '',
    tlsKeyFile: '',
    realityTarget: '',
    realityServerName: '',
    realityFingerprint: 'chrome',
    realitySpiderX: '/',
    enabled: true,
    remark: ''
  });
}

function cleanFormBody() {
  const body = {
    name: form.name.trim(),
    baseUrl: buildServerBaseUrl(),
    basePath: normalizeBasePathForApi(form.basePath),
    username: form.username.trim() || undefined,
    password: clearPassword.value ? '' : form.password || undefined,
    token: clearToken.value ? '' : form.token || undefined,
    shareHost: form.shareHost.trim() || undefined,
    tlsServerName: form.tlsServerName.trim() || undefined,
    tlsCertFile: form.tlsCertFile.trim() || undefined,
    tlsKeyFile: form.tlsKeyFile.trim() || undefined,
    realityTarget: form.realityTarget.trim() || undefined,
    realityServerName: form.realityServerName.trim() || undefined,
    realityFingerprint: form.realityFingerprint.trim() || undefined,
    realitySpiderX: form.realitySpiderX.trim() || undefined,
    enabled: form.enabled,
    remark: form.remark.trim() || undefined
  };
  return body;
}

function buildServerBaseUrl() {
  const rawHost = form.host.trim();
  const normalizedHost = rawHost.includes(':') && !rawHost.startsWith('[') && !rawHost.endsWith(']') ? '[' + rawHost + ']' : rawHost;
  return form.protocol + '://' + normalizedHost + ':' + form.port;
}

function splitServerBaseUrl(baseUrl: string) {
  try {
    const parsed = new URL(baseUrl);
    const protocol: 'http' | 'https' = parsed.protocol === 'http:' ? 'http' : 'https';
    const defaultPort = protocol === 'https' ? 443 : 80;
    return { protocol, host: parsed.hostname, port: Number(parsed.port || defaultPort) };
  } catch {
    return { protocol: 'https' as const, host: baseUrl.replace(/^https?:\/\//i, '').split('/')[0] || '', port: 2053 };
  }
}

function normalizeBasePathForForm(basePath?: string | null) {
  const value = String(basePath || '').trim();
  if (!value || value === '/') return '/';
  return '/' + value.replace(/^\/+|\/+$/g, '');
}

function normalizeBasePathForApi(basePath: string) {
  const value = basePath.trim();
  if (!value || value === '/') return undefined;
  return value.replace(/^\/+|\/+$/g, '');
}

function connectionStatus(server: XuiServer) {
  if (syncingIds.value.has(server.id)) return { label: '同步中', className: 'is-syncing' };
  if (!server.enabled) return { label: '已停用', className: 'is-disabled' };
  const result = connectionTests.value[server.id];
  if (result?.state === 'success') return { label: '本次测试正常', className: 'is-online' };
  if (result?.state === 'error') return { label: '本次测试失败', className: 'is-error' };
  return { label: '尚未测试', className: 'is-untested' };
}

function credentialLabel(server: XuiServer) {
  if (server.hasToken && server.hasPassword) return 'Token + 账号密码';
  if (server.hasToken) return 'API Token';
  if (server.hasPassword) return '账号密码';
  return '未保存凭据';
}

function serverEndpoint(server: XuiServer) {
  return `${server.baseUrl.replace(/\/$/, '')}${server.basePath ? `/${server.basePath.replace(/^\/+|\/+$/g, '')}` : ''}`;
}

function hasTlsConfig(server: XuiServer) {
  return Boolean(server.config?.tlsCertFile && server.config?.tlsKeyFile);
}

function hasRealityCandidate(server: XuiServer) {
  return Boolean(server.config?.realityTarget || server.config?.realityServerName);
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function formatShortValue(value: unknown) {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const record = objectValue(value);
  return String(record.version || record.name || record.tag || '').trim();
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}

function formatUnixTime(value: unknown) {
  const time = Number(value);
  if (!Number.isFinite(time) || time <= 0) return '-';
  return new Date(time * 1000).toLocaleString('zh-CN', { hour12: false });
}

function serverSearchText(server: XuiServer) {
  return [
    server.name,
    server.baseUrl,
    server.basePath,
    server.username,
    server.enabled ? '启用' : '停用',
    credentialLabel(server),
    server.config?.tlsServerName,
    server.config?.shareHost,
    server.config?.tlsCertFile,
    server.config?.realityTarget,
    server.config?.realityServerName,
    server.remark
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

onMounted(loadServers);
</script>

<template>
  <section class="xui-management-page" :class="{ loading }">
    <header class="xui-page-header">
      <div>
        <h1>面板连接</h1>
        <p>维护真实 3x-ui 面板地址、访问凭据、分享地址、TLS 证书和 Reality 探测配置。</p>
      </div>
      <div class="xui-page-actions">
        <el-button class="xui-secondary-button" :loading="loading" @click="loadServers"><RefreshCw :size="15" />刷新</el-button>
        <el-button type="primary" @click="openDialog"><Plus :size="15" />添加面板</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="xui-page-alert" />

    <div class="xui-stat-grid">
      <article class="xui-stat-card">
        <span class="xui-stat-icon tone-indigo"><Server :size="18" /></span>
        <div><small>面板连接</small><strong>{{ servers.length }}</strong><span>真实保存的 3x-ui 连接</span></div>
      </article>
      <article class="xui-stat-card">
        <span class="xui-stat-icon tone-emerald"><CheckCircle2 :size="18" /></span>
        <div><small>已启用</small><strong>{{ enabledServerCount }}</strong><span>{{ servers.length - enabledServerCount }} 个已停用</span></div>
      </article>
      <article class="xui-stat-card">
        <span class="xui-stat-icon tone-cyan"><KeyRound :size="18" /></span>
        <div><small>已保存密码</small><strong>{{ passwordServerCount }}</strong><span>账号密码登录凭据</span></div>
      </article>
      <article class="xui-stat-card">
        <span class="xui-stat-icon tone-amber"><ShieldCheck :size="18" /></span>
        <div><small>已保存 Token</small><strong>{{ tokenServerCount }}</strong><span>可直接用于 API 认证</span></div>
      </article>
    </div>

    <div class="xui-filter-panel">
      <div class="xui-search-field">
        <Search :size="15" />
        <el-input v-model="searchQuery" clearable placeholder="搜索面板名称、地址、账号、分享主机或备注" />
      </div>
      <el-select v-model="selectedStatus" clearable placeholder="全部状态" class="xui-filter-select">
        <el-option label="已启用" value="enabled" />
        <el-option label="已停用" value="disabled" />
        <el-option label="本次测试正常" value="tested-success" />
        <el-option label="本次测试失败" value="tested-error" />
      </el-select>
      <el-select v-model="selectedCredential" clearable placeholder="全部凭据" class="xui-filter-select">
        <el-option label="已保存 Token" value="token" />
        <el-option label="已保存密码" value="password" />
        <el-option label="未保存凭据" value="missing" />
      </el-select>
      <el-button v-if="hasActiveFilters" class="xui-reset-filter" text @click="resetFilters">重置</el-button>
    </div>

    <div v-loading="loading" class="xui-panel-grid">
      <article v-for="server in filteredServers" :key="server.id" class="xui-panel-card entity-runtime-card" :class="connectionStatus(server).className === 'is-online' ? 'runtime-state-online' : connectionStatus(server).className === 'is-error' ? 'runtime-state-error' : server.enabled ? 'runtime-state-unknown' : 'runtime-state-disabled'">
        <header class="xui-panel-card-header">
          <div class="xui-panel-identity">
            <span class="xui-panel-icon entity-name-avatar" :style="entityAvatarStyle(server.name, server.id)">{{ entityInitial(server.name, '面') }}</span>
            <div>
              <strong :title="server.name">{{ server.name }}</strong>
              <span>3x-ui · {{ credentialLabel(server) }}</span>
            </div>
          </div>
          <span class="xui-status-chip" :class="connectionStatus(server).className"><i></i>{{ connectionStatus(server).label }}</span>
        </header>

        <div class="xui-panel-address">
          <Network :size="14" />
          <div>
            <small>面板接口地址</small>
            <strong :title="serverEndpoint(server)">{{ serverEndpoint(server) }}</strong>
          </div>
          <el-tooltip content="复制面板接口地址" placement="top">
            <button type="button" class="xui-copy-button" aria-label="复制面板接口地址" @click="copyServerAddress(server)"><Clipboard :size="14" /></button>
          </el-tooltip>
        </div>

        <div class="xui-panel-meta runtime-metric-grid">
          <div class="runtime-metric tone-indigo"><span>访问凭据</span><strong>{{ credentialLabel(server) }}</strong></div>
          <div class="runtime-metric" :class="hasTlsConfig(server) ? 'tone-emerald' : 'tone-neutral'"><span>TLS 证书</span><strong>{{ hasTlsConfig(server) ? '已配置' : '未配置' }}</strong></div>
          <div class="runtime-metric tone-amber"><span>入站数量</span><strong>{{ connectionTests[server.id]?.state === 'success' ? (connectionTests[server.id]?.inboundCount ?? 0) : '未测试' }}</strong></div>
        </div>

        <div class="runtime-info-line xui-runtime-info">
          <span><KeyRound :size="13" />{{ server.username || '未保存登录账号' }}</span>
          <span><ShieldCheck :size="13" />{{ server.config?.shareHost || '使用面板域名分享' }}</span>
        </div>

        <div class="xui-panel-tags">
          <span v-if="server.hasToken" class="xui-panel-tag token">Token</span>
          <span v-if="server.hasPassword" class="xui-panel-tag password">密码</span>
          <span v-if="server.config?.tlsServerName" class="xui-panel-tag tls" :title="server.config.tlsServerName">TLS {{ server.config.tlsServerName }}</span>
          <span class="xui-panel-tag reality">Reality {{ hasRealityCandidate(server) ? '候选已配置' : '自动探测' }}</span>
          <span v-if="connectionTests[server.id]?.state === 'success'" class="xui-panel-tag inbound">入站 {{ connectionTests[server.id]?.inboundCount ?? 0 }}</span>
        </div>

        <p v-if="server.remark" class="xui-panel-remark">{{ server.remark }}</p>

        <footer class="xui-panel-actions runtime-card-footer">
          <span class="runtime-footer-label"><Network :size="13" />路径 {{ server.basePath || '/' }}</span>
          <div class="runtime-action-group">
          <el-tooltip content="测试连接" placement="top">
            <el-button class="runtime-icon-button" :loading="testingIds.has(server.id)" aria-label="测试连接" @click="testSaved(server)"><Wifi :size="15" /></el-button>
          </el-tooltip>
          <el-tooltip content="同步节点" placement="top">
          <el-button
            class="xui-sync-button runtime-icon-button"
            :loading="syncingIds.has(server.id)"
            :disabled="!server.enabled"
            aria-label="同步节点"
            @click="syncServer(server)"
          ><RefreshCw :size="15" /></el-button>
          </el-tooltip>
          <el-tooltip content="编辑连接" placement="top">
            <el-button class="runtime-icon-button" aria-label="编辑连接" @click="editServer(server)"><Edit3 :size="15" /></el-button>
          </el-tooltip>
          <el-tooltip :content="server.enabled ? '停用连接' : '启用连接'" placement="top">
            <el-switch
              class="runtime-toggle-switch"
              :model-value="server.enabled"
              :loading="togglingIds.has(server.id)"
              :disabled="togglingIds.has(server.id)"
              @change="(enabled: boolean | string | number) => toggleServerEnabled(server, Boolean(enabled))"
            />
          </el-tooltip>
          <el-dropdown trigger="click" @command="(command: string) => handleServerCommand(server, command)">
            <el-button class="xui-more-button runtime-icon-button" aria-label="更多面板操作"><MoreHorizontal :size="16" /></el-button>
            <template #dropdown>
              <el-dropdown-menu class="xui-action-menu">
                <el-dropdown-item command="test" :disabled="testingIds.has(server.id)"><Wifi :size="14" />测试连接</el-dropdown-item>
                <el-dropdown-item command="status" :disabled="statusIds.has(server.id)"><Activity :size="14" />查看面板状态</el-dropdown-item>
                <el-dropdown-item command="presence" :disabled="presenceIds.has(server.id)"><Users :size="14" />查看在线客户端</el-dropdown-item>
                <el-dropdown-item command="certs" :disabled="certIds.has(server.id)"><FileKey2 :size="14" />读取证书状态</el-dropdown-item>
                <el-dropdown-item command="sync-socks" :disabled="!server.enabled || syncingSocksIds.has(server.id)"><RefreshCw :size="14" />导入 SOCKS 出站</el-dropdown-item>
                <el-dropdown-item command="delete" divided :disabled="deletingIds.has(server.id)"><Trash2 :size="14" />删除连接</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
          </div>
        </footer>
      </article>

      <div v-if="!filteredServers.length && !loading" class="xui-empty-state">
        <CloudCog :size="28" />
        <strong>{{ servers.length ? '没有符合筛选条件的面板连接' : '暂无面板连接' }}</strong>
        <span>{{ servers.length ? '调整筛选条件后再查看' : '使用右上角按钮添加真实 3x-ui 面板连接' }}</span>
      </div>
    </div>

    <footer class="xui-list-footer">显示 {{ filteredServers.length }} / {{ servers.length }} 个真实面板连接</footer>
  </section>

  <el-dialog
    v-model="dialogVisible"
    :title="editingId ? '编辑面板连接' : '添加面板连接'"
    width="min(940px, 94vw)"
    class="xui-dark-dialog"
    destroy-on-close
  >
    <div class="xui-dialog-intro">
      <Server :size="18" />
      <div>
        <strong>{{ editingId ? '更新已保存的 3x-ui 连接配置' : '接入新的 3x-ui 面板' }}</strong>
        <span>连接测试、证书读取、状态查询和同步操作都会直接使用这里保存的真实地址与凭据。</span>
      </div>
    </div>

    <el-form :model="form" label-position="top" class="xui-dialog-form">
      <section class="xui-dialog-section">
        <header><strong>连接设置</strong><span>填写远程面板地址与 API 令牌，现有接口字段保持不变</span></header>
        <div class="xui-dialog-grid xui-connection-grid">
          <el-form-item label="名称" class="xui-connection-name" required><el-input v-model="form.name" maxlength="100" placeholder="例如：de-frankfurt-1" /></el-form-item>
          <el-form-item label="备注" class="xui-connection-remark"><el-input v-model="form.remark" maxlength="500" placeholder="可选" /></el-form-item>
          <el-form-item label="协议" class="xui-connection-protocol">
            <el-select v-model="form.protocol" style="width: 100%">
              <el-option label="https" value="https" />
              <el-option label="http" value="http" />
            </el-select>
          </el-form-item>
          <el-form-item label="地址" class="xui-connection-host" required><el-input v-model="form.host" maxlength="255" placeholder="panel.example.com 或 1.2.3.4" /></el-form-item>
          <el-form-item label="端口" class="xui-connection-port" required><el-input-number v-model="form.port" :min="1" :max="65535" :controls="false" style="width: 100%" /></el-form-item>
          <el-form-item label="基础路径" class="xui-connection-path"><el-input v-model="form.basePath" maxlength="120" placeholder="/" /></el-form-item>
          <el-form-item label="已启用" class="xui-switch-item xui-connection-enabled">
            <div class="xui-enabled-control"><el-switch v-model="form.enabled" /><span>保存后启用</span></div>
          </el-form-item>
        </div>
      </section>

      <section class="xui-dialog-section">
        <header><strong>访问凭据</strong><span>可保存用户名和密码，也可保存 API Token；编辑时留空会保留原值</span></header>
        <div class="xui-dialog-grid">
          <el-form-item label="用户名"><el-input v-model="form.username" maxlength="100" placeholder="3x-ui 登录账号" /></el-form-item>
          <el-form-item label="密码">
            <el-input v-model="form.password" type="password" show-password maxlength="256" :disabled="clearPassword" placeholder="编辑时留空不修改" />
            <el-checkbox v-if="editingId" v-model="clearPassword" class="xui-clear-secret">清除已保存密码</el-checkbox>
          </el-form-item>
          <el-form-item label="API Token" class="xui-dialog-full">
            <el-input v-model="form.token" type="password" show-password maxlength="2048" :disabled="clearToken" placeholder="编辑时留空不修改" />
            <el-checkbox v-if="editingId" v-model="clearToken" class="xui-clear-secret">清除已保存 Token</el-checkbox>
          </el-form-item>
          <el-form-item v-if="editingId" label="已保存凭据" class="xui-dialog-full">
            <el-button class="xui-secondary-button" :loading="revealingSecrets" @click="revealServerSecrets"><Eye :size="15" />读取已保存密码和 Token</el-button>
          </el-form-item>
        </div>
      </section>

      <section class="xui-dialog-section">
        <header><strong>分享链接</strong><span>分享主机用于生成真实客户端链接；留空时使用面板地址中的主机名</span></header>
        <div class="xui-dialog-grid">
          <el-form-item label="分享主机"><el-input v-model="form.shareHost" maxlength="255" placeholder="代理入口域名或 IP" /></el-form-item>
          <el-form-item label="TLS Server Name"><el-input v-model="form.tlsServerName" maxlength="255" placeholder="例如 node.example.com" /></el-form-item>
        </div>
      </section>

      <section class="xui-dialog-section">
        <header><strong>TLS 证书</strong><span>填写远端服务器上的真实证书文件与私钥文件路径</span></header>
        <div class="xui-dialog-grid">
          <el-form-item label="证书文件"><el-input v-model="form.tlsCertFile" maxlength="500" placeholder="例如 /root/cert/fullchain.pem" /></el-form-item>
          <el-form-item label="私钥文件"><el-input v-model="form.tlsKeyFile" maxlength="500" placeholder="例如 /root/cert/privkey.pem" /></el-form-item>
          <el-form-item label="从面板读取" class="xui-dialog-full">
            <el-button class="xui-secondary-button" :loading="testingCertForm" :disabled="!baseConnectionReady" @click="testFormCerts"><FileKey2 :size="15" />读取 3x-ui 证书配置</el-button>
          </el-form-item>
        </div>
      </section>

      <section class="xui-dialog-section">
        <header><strong>Reality 探测</strong><span>目标与 Server Name 可留空，创建 Reality 节点时会优先调用 3x-ui 自动扫描</span></header>
        <div class="xui-dialog-grid">
          <el-form-item label="目标候选"><el-input v-model="form.realityTarget" maxlength="255" placeholder="例如 example.com:443" /></el-form-item>
          <el-form-item label="Server Name 候选"><el-input v-model="form.realityServerName" maxlength="255" placeholder="例如 example.com" /></el-form-item>
          <el-form-item label="浏览器指纹"><el-input v-model="form.realityFingerprint" maxlength="40" placeholder="chrome" /></el-form-item>
          <el-form-item label="SpiderX"><el-input v-model="form.realitySpiderX" maxlength="120" placeholder="/" /></el-form-item>
        </div>
      </section>

    </el-form>

    <template #footer>
      <el-button class="xui-secondary-button" :loading="testingForm" :disabled="!baseConnectionReady" @click="testForm"><Wifi :size="15" />测试连接</el-button>
      <el-button class="xui-secondary-button" @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!baseConnectionReady" @click="saveServer">{{ editingId ? '保存修改' : '添加面板' }}</el-button>
    </template>
  </el-dialog>
</template>
