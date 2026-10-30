<script setup lang="ts">
import XrayCoreDialog from '../components/XrayCoreDialog.vue';
import { splitPanelAddress, fullPanelAddress } from '../panel-address';
import { computed, onMounted, reactive, ref } from 'vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/checkbox/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/dropdown/style/css';
import 'element-plus/es/components/dropdown-item/style/css';
import 'element-plus/es/components/dropdown-menu/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/input/style/css';

import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/switch/style/css';
import { ElAlert, ElButton, ElCheckbox, ElDialog, ElDropdown, ElDropdownItem, ElDropdownMenu, ElForm, ElFormItem, ElInput, ElMessage, ElMessageBox, ElOption, ElSelect, ElSwitch } from 'element-plus';
import {
  Activity,
  CheckCircle2,
  Clipboard,
  Edit3,
  FileKey2,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Users,
  Wifi
} from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { notifyError } from '../notify';

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
    panelCompatibility?: {
      detectedVersion?: string;
      apiProfile?: 'v3.6';
      detectedAt?: string;
    };
  } | null;
  hasPassword?: boolean;
  hasToken?: boolean;
};

type CertResult = { found: boolean; certFile: string; keyFile: string; message?: string; raw?: unknown };
type ConnectionTest = { state: 'success' | 'error'; inboundCount?: number; message?: string };
type ServerSyncResult = { created: number; updated: number; skipped: number };
type SocksSyncResult = { remoteSocksFound: number; remoteSocksImported: number };

const servers = ref<XuiServer[]>([]);
const coreServer = ref<XuiServer | null>(null);
const loading = ref(false);
const saving = ref(false);
const testingForm = ref(false);
const testingCertForm = ref(false);
const testingIds = ref<Set<string>>(new Set());
const certIds = ref<Set<string>>(new Set());
const syncingIds = ref<Set<string>>(new Set());
const syncingSocksIds = ref<Set<string>>(new Set());
const statusIds = ref<Set<string>>(new Set());
const versionIds = ref<Set<string>>(new Set());
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
  address: '',
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
const baseConnectionReady = computed(() => {
  try { splitPanelAddress(form.address); return Boolean(form.name.trim() && (form.token.trim() || form.username.trim() && (form.password || editingId.value))); }
  catch { return false; }
});
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
    error.value = readableError(err, '加载面板连接失败');
  } finally {
    loading.value = false;
  }
}

async function saveServer() {
  if (saving.value) return;
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
  if (testingForm.value) return;
  testingForm.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/xui-servers/${editingId.value}/test-draft` : '/api/admin/xui/test';
    await api<{ connected: boolean; inbounds: unknown }>(path, { method: 'POST', body: cleanFormBody() });
    ElMessage.success('连接成功');
  } catch (err) {
    showError(err, '测试连接失败');
  } finally {
    testingForm.value = false;
  }
}

async function testSaved(server: XuiServer) {
  if (testingIds.value.has(server.id)) return;
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

async function detectServerVersion(server: XuiServer) {
  if (versionIds.value.has(server.id)) return;
  versionIds.value = addPendingId(versionIds.value, server.id);
  error.value = '';
  try {
    const result = await api<{ label: string }>(`/api/admin/xui-servers/${server.id}/detect-version`, { method: 'POST' });
    ElMessage.success(`检测结果：${result.label}`);
    await loadServers();
  } catch (err) {
    showError(err, '检测面板版本失败');
  } finally {
    versionIds.value = removePendingId(versionIds.value, server.id);
  }
}

async function testFormCerts() {
  if (testingCertForm.value) return;
  testingCertForm.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/xui-servers/${editingId.value}/certs-draft` : '/api/admin/xui/certs';
    const result = await api<CertResult>(path, { method: 'POST', body: cleanFormBody() });
    await showCertResult(result, true);
  } catch (err) {
    showError(err, '证书读取失败');
  } finally {
    testingCertForm.value = false;
  }
}

async function testSavedCerts(server: XuiServer) {
  if (certIds.value.has(server.id)) return;
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
        customClass: 'xui-message-box'
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
  if (syncingIds.value.has(server.id)) return;
  try {
    await ElMessageBox.confirm(
      `确认从“${server.name}”读取远端入站，并同步为本地路由节点？此操作不会同步远端用户。`,
      '同步远端节点',
      { type: 'warning', customClass: 'xui-message-box' }
    );
  } catch {
    return;
  }
  syncingIds.value = addPendingId(syncingIds.value, server.id);
  error.value = '';
  try {
    const result = await api<ServerSyncResult>(`/api/admin/xui-servers/${server.id}/sync`, { method: 'POST' });
    if (result.skipped > 0) ElMessage.warning('部分同步失败');
    else ElMessage.success('同步成功');
  } catch (err) {
    showError(err, '同步远端节点失败');
  } finally {
    syncingIds.value = removePendingId(syncingIds.value, server.id);
  }
}

async function syncServerSocks(server: XuiServer) {
  if (syncingSocksIds.value.has(server.id)) return;
  try {
    await ElMessageBox.confirm(
      `确认从“${server.name}”读取远端 Xray 配置并导入 SOCKS 出站？只会写入本地出站节点列表。`,
      '导入远端 SOCKS',
      { type: 'warning', customClass: 'xui-message-box' }
    );
  } catch {
    return;
  }
  syncingSocksIds.value = addPendingId(syncingSocksIds.value, server.id);
  error.value = '';
  try {
    const result = await api<SocksSyncResult>(`/api/admin/xui-servers/${server.id}/sync-socks`, { method: 'POST' });
    ElMessage.success(result.remoteSocksFound > 0 ? '导入成功' : '没有可导入节点');
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
    ].join('\n'), `${server.name} 运行状态`, { type: 'info', customClass: 'xui-message-box' });
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
    ].join('\n'), `${server.name} 客户端状态`, { type: 'info', customClass: 'xui-message-box' });
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

async function editServer(server: XuiServer) {
  editingId.value = server.id;
  clearPassword.value = false;
  clearToken.value = false;
  Object.assign(form, {
    name: server.name,
    address: fullPanelAddress(server.baseUrl, server.basePath),
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
  await revealServerSecrets();
  if (editingId.value !== server.id) return;
  dialogVisible.value = true;
}

async function revealServerSecrets() {
  if (!editingId.value) return;
  const requestedId = editingId.value;
  revealingSecrets.value = true;
  error.value = '';
  try {
    const secrets = await api<{ password: string; token: string }>(`/api/admin/xui-servers/${editingId.value}/secrets`);
    if (editingId.value !== requestedId) return;
    form.password = secrets.password || '';
    form.token = secrets.token || '';
    clearPassword.value = false;
    clearToken.value = false;
  } catch (err) {
    showError(err, '读取保存凭据失败');
  } finally {
    revealingSecrets.value = false;
  }
}

async function removeServer(server: XuiServer) {
  if (deletingIds.value.has(server.id)) return;
  try {
    await ElMessageBox.confirm(
      `确认删除面板连接“${server.name}”？存在关联路由节点时后端会拒绝删除，请先处理关联节点。`,
      '删除面板连接',
      { type: 'warning', customClass: 'xui-message-box' }
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
  if (command === 'core-version') coreServer.value = server;
  if (command === 'test') void testSaved(server);
  if (command === 'status') void showServerStatus(server);
  if (command === 'version') void detectServerVersion(server);
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
    address: '',
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
    ...splitPanelAddress(form.address),
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
  if (server.hasToken) return '访问令牌';
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

function compatibilityLabel(server: XuiServer) {
  const compatibility = server.config?.panelCompatibility;
  if (!compatibility) return '版本未检测';
  if (compatibility.detectedVersion) return compatibility.detectedVersion;
  return compatibility.apiProfile === 'v3.6' ? '3.6+ 官方 API' : '未检测';
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

function showError(err: unknown, fallback: string) {
  notifyError(err, fallback);
}

onMounted(loadServers);
</script>

<template>
  <section class="xui-management-page" :class="{ loading }">
    <header class="xui-page-header">
      <div>
        <h1>3x-ui 面板</h1>
        <p>统一维护面板连接与访问凭据，按需进入管理面板管理完整功能。</p>
      </div>
      <div class="xui-page-actions">
          <router-link class="hub-button" to="/xui-native">管理面板</router-link>
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
        <div><small>已保存 Token</small><strong>{{ tokenServerCount }}</strong><span>可直接用于 面板认证</span></div>
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

    <div v-loading="loading" class="hub-card hub-table-wrap">
      <table class="hub-table hub-connections resource-table" aria-label="3x-ui 面板连接列表">
        <thead><tr><th>面板</th><th>访问地址</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="server in filteredServers" :key="server.id">
            <td><div class="hub-entity"><span class="hub-avatar"><Server :size="20" /></span><div><strong :title="server.name">{{ server.name }}</strong><small>{{ compatibilityLabel(server) }} · {{ credentialLabel(server) }}</small><small v-if="server.remark">{{ server.remark }}</small></div></div></td>
            <td><span :title="serverEndpoint(server)">{{ serverEndpoint(server) }}</span> <button class="hub-link" aria-label="复制面板地址" @click="copyServerAddress(server)"><Clipboard :size="14" /></button><small class="resource-note">{{ server.username || '未保存登录账号' }} · {{ server.config?.shareHost || '使用面板主机分享' }}</small></td>
            <td><span class="xui-status-chip" :class="connectionStatus(server).className"><i></i>{{ connectionStatus(server).label }}</span><small class="resource-note">{{ server.enabled ? '已启用' : '已停用' }}<template v-if="connectionTests[server.id]?.state === 'success'"> · 入站 {{ connectionTests[server.id]?.inboundCount ?? 0 }}</template></small><small class="resource-note">TLS {{ hasTlsConfig(server) ? '已配置' : '未配置' }} · Reality {{ hasRealityCandidate(server) ? '候选已配置' : '自动探测' }}</small></td>
            <td><div class="hub-actions">
              <el-button link :loading="syncingIds.has(server.id)" :disabled="!server.enabled" aria-label="同步面板" @click="syncServer(server)"><RefreshCw :size="14" />同步面板</el-button>
              <el-button link :loading="testingIds.has(server.id)" aria-label="测试连接" @click="testSaved(server)">测试连接</el-button>
              <router-link class="hub-link" :to="{ path: '/xui-native', query: { serverId: server.id } }">管理</router-link>
              <button class="icon-button" aria-label="编辑连接" @click="editServer(server)"><Edit3 :size="16" /></button>
              <el-switch :model-value="server.enabled" :aria-label="server.enabled ? '停用连接' : '启用连接'" :loading="togglingIds.has(server.id)" :disabled="togglingIds.has(server.id)" @change="(enabled: boolean | string | number) => toggleServerEnabled(server, Boolean(enabled))" />
          <el-dropdown trigger="click" @command="(command: string) => handleServerCommand(server, command)">
            <el-button class="icon-button" aria-label="更多面板操作"><MoreHorizontal :size="16" /></el-button>
            <template #dropdown>
              <el-dropdown-menu class="xui-action-menu">
                <el-dropdown-item command="test" :disabled="testingIds.has(server.id)"><Wifi :size="14" />测试连接</el-dropdown-item>
                <el-dropdown-item command="version" :disabled="versionIds.has(server.id)"><Search :size="14" />检测版本</el-dropdown-item>
                <el-dropdown-item command="status" :disabled="statusIds.has(server.id)"><Activity :size="14" />查看面板状态</el-dropdown-item>
                <el-dropdown-item command="core-version" :disabled="!server.enabled"><RefreshCw :size="14" />更换 Xray 内核版本</el-dropdown-item>
                <el-dropdown-item command="presence" :disabled="presenceIds.has(server.id)"><Users :size="14" />查看在线客户端</el-dropdown-item>
                <el-dropdown-item command="certs" :disabled="certIds.has(server.id)"><FileKey2 :size="14" />读取证书状态</el-dropdown-item>
                <el-dropdown-item command="sync-socks" :disabled="!server.enabled || syncingSocksIds.has(server.id)"><RefreshCw :size="14" />导入 SOCKS 出站</el-dropdown-item>
                <el-dropdown-item command="delete" divided :disabled="deletingIds.has(server.id)"><Trash2 :size="14" />删除连接</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
            </div></td>
          </tr>
          <tr v-if="!filteredServers.length && !loading"><td colspan="4" class="table-empty">{{ servers.length ? '没有符合筛选条件的面板连接' : '暂无面板连接，请使用右上角按钮添加' }}</td></tr>
        </tbody>
      </table>
    </div>

    <footer class="xui-list-footer">显示 {{ filteredServers.length }} / {{ servers.length }} 个真实面板连接</footer>
  </section>

  <el-dialog
    v-model="dialogVisible"
    :title="editingId ? '编辑面板连接' : '添加面板连接'"
    width="min(680px, 94vw)"
    class="xui-dialog"
    destroy-on-close
  >
    <el-form :model="form" label-position="top" class="xui-dialog-form" :disabled="saving || testingForm">
      <div class="xui-dialog-grid">
        <el-form-item label="面板名称" required><el-input v-model="form.name" maxlength="100" placeholder="方便识别的名称" /></el-form-item>
        <el-form-item label="完整面板地址" class="xui-dialog-full" required><el-input v-model="form.address" type="url" maxlength="2048" placeholder="https://panel.example.com:2053/面板路径/" /><small>直接粘贴浏览器中的面板地址，端口与路径自动识别。</small></el-form-item>
        <el-form-item label="用户名" :required="!form.token.trim()"><el-input v-model="form.username" maxlength="100" placeholder="面板登录账号" /></el-form-item>
        <el-form-item label="密码" :required="!form.token.trim()"><el-input v-model="form.password" type="text" maxlength="256" :disabled="clearPassword" placeholder="面板登录密码" /></el-form-item>
      </div>
      <details class="xui-dialog-section connection-advanced">
        <summary>高级设置 <small>令牌、分享地址与证书 · 通常无需填写</small></summary>
        <div class="xui-dialog-grid">
          <el-form-item label="访问令牌" class="xui-dialog-full"><el-input v-model="form.token" type="text" maxlength="2048" :disabled="clearToken" placeholder="使用令牌接入时填写" /><el-checkbox v-if="editingId" v-model="clearToken">清除已保存令牌</el-checkbox></el-form-item>
          <el-form-item v-if="editingId" label="凭据管理"><el-checkbox v-model="clearPassword">清除已保存密码</el-checkbox></el-form-item>
          <el-form-item label="分享主机"><el-input v-model="form.shareHost" maxlength="255" placeholder="留空使用面板主机" /></el-form-item>
          <el-form-item label="TLS 域名"><el-input v-model="form.tlsServerName" maxlength="255" /></el-form-item>
          <el-form-item label="证书文件"><el-input v-model="form.tlsCertFile" maxlength="500" /></el-form-item>
          <el-form-item label="私钥文件"><el-input v-model="form.tlsKeyFile" maxlength="500" /></el-form-item>
          <el-form-item label="读取证书" class="xui-dialog-full"><el-button :loading="testingCertForm" :disabled="!baseConnectionReady" @click="testFormCerts"><FileKey2 :size="15" />从面板读取证书</el-button></el-form-item>
          <el-form-item label="备注"><el-input v-model="form.remark" maxlength="500" /></el-form-item>
          <el-form-item label="启用连接"><el-switch v-model="form.enabled" /></el-form-item>
        </div>
      </details>
    </el-form>

    <template #footer>
      <el-button class="xui-secondary-button" :loading="testingForm" :disabled="!baseConnectionReady" @click="testForm"><Wifi :size="15" />测试连接</el-button>
      <el-button class="xui-secondary-button" @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!baseConnectionReady" @click="saveServer">{{ editingId ? '保存修改' : '添加面板' }}</el-button>
    </template>
  </el-dialog>
  <XrayCoreDialog v-if="coreServer" :server="coreServer" @close="coreServer = null" />
</template>

<style scoped>
.connection-advanced > summary { cursor: pointer; font-weight: 600; color: var(--text); padding: 16px 0; }
.connection-advanced > summary small { font-weight: 400; font-size: 13px; margin-left: 8px; color: var(--muted); }
.connection-advanced > .xui-dialog-grid { padding-top: 12px; }
.xui-dialog-form small { color: var(--muted); line-height: 1.6; margin-top: 6px; }
</style>
