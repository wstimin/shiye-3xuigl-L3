<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  CheckCircle2,
  CircleSlash2,
  Clipboard,
  CloudCog,
  Edit3,
  Gauge,
  Layers3,
  LockKeyhole,
  MoreHorizontal,
  Network,
  Plus,
  RadioTower,
  RefreshCw,
  RotateCcw,
  Router,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  UploadCloud,
  Waypoints,
  Zap
} from 'lucide-vue-next';
import { api } from '../api';

type XuiServer = { id: string; name: string; baseUrl: string; enabled: boolean };
type SocksNode = { id: string; name: string; host: string; port: number; enabled: boolean };
type ServiceNodeConfig = {
  encryption?: string;
  transport?: string;
  tcpHeaderType?: string;
  transportHost?: string;
  transportPath?: string;
  grpcServiceName?: string;
  grpcAuthority?: string;
  grpcMultiMode?: boolean;
  xhttpMode?: string;
  socksRelayEnabled?: boolean;
  socksNodeId?: string | null;
  remoteMode?: 'create' | 'bind';
  remoteManaged?: boolean;
  remoteInboundPort?: number;
};
type ServiceNode = {
  id: string;
  serverId: string;
  name: string;
  protocol: string;
  priceMonthly: string;
  trafficLimitGb: string;
  enabled: boolean;
  inboundId?: number | null;
  remark?: string | null;
  config?: ServiceNodeConfig | null;
  server?: XuiServer;
};
type CleanupResult = {
  skipped?: boolean;
  deleted?: boolean;
  alreadyAbsent?: boolean;
  synced?: boolean;
  action?: string;
  reason?: string;
  message?: string;
  verified?: { retried?: boolean; absent?: boolean };
  remoteClientCleanup?: CleanupResult;
};
type DeleteServiceNodeResult = {
  deleted: boolean;
  id: string;
  remoteClientCleanup?: CleanupResult;
  remoteConfigCleanup?: CleanupResult;
  remoteInboundCleanup?: CleanupResult;
};
type RemoteConfigSyncResult = {
  synced: boolean;
  action: string;
  serviceNodeId: string;
  inboundId?: number;
  inboundTag?: string;
  outboundTag?: string;
  socks?: { host?: string; port?: number; username?: string } | null;
};
type TrafficSyncItem = { target: string; updated: boolean; skipped?: boolean; message?: string };
type TrafficSyncResult = {
  synced: boolean;
  serviceNodeId: string;
  inboundId?: number;
  trafficLimitGb?: string | number;
  updated: number;
  skipped: number;
  failed: number;
  results?: TrafficSyncItem[];
};
type RegionDefinition = { value: string; label: string; keywords: string[]; codes?: string[] };

const protocolOptions = [
  { label: 'VLESS', value: 'vless' },
  { label: 'VMess', value: 'vmess' },
  { label: 'Trojan', value: 'trojan' },
  { label: 'Shadowsocks', value: 'shadowsocks' },
  { label: 'Hysteria', value: 'hysteria' }
];
const encryptionOptions = [
  { label: '无加密', value: 'none' },
  { label: 'TLS', value: 'tls' },
  { label: 'Reality', value: 'reality' }
];
const transportOptions = [
  { label: 'TCP', value: 'tcp' },
  { label: 'WebSocket', value: 'ws' },
  { label: 'gRPC', value: 'grpc' },
  { label: 'HTTPUpgrade', value: 'httpupgrade' },
  { label: 'XHTTP', value: 'xhttp' }
];
const xhttpModeOptions = [
  { label: '自动', value: 'auto' },
  { label: 'Packet Up', value: 'packet-up' },
  { label: 'Stream Up', value: 'stream-up' },
  { label: 'Stream One', value: 'stream-one' }
];
const regionDefinitions: RegionDefinition[] = [
  { value: 'hong-kong', label: '香港', keywords: ['香港', 'hong kong', 'hongkong'], codes: ['hk'] },
  { value: 'japan', label: '日本', keywords: ['日本', '东京', '大阪', 'japan', 'tokyo', 'osaka'], codes: ['jp'] },
  { value: 'singapore', label: '新加坡', keywords: ['新加坡', 'singapore'], codes: ['sg'] },
  { value: 'taiwan', label: '台湾', keywords: ['台湾', '台北', 'taiwan', 'taipei'], codes: ['tw'] },
  { value: 'united-states', label: '美国', keywords: ['美国', '洛杉矶', '西雅图', '纽约', 'united states', 'los angeles', 'seattle', 'new york'], codes: ['us', 'usa'] },
  { value: 'united-kingdom', label: '英国', keywords: ['英国', '伦敦', 'united kingdom', 'london'], codes: ['uk', 'gb'] },
  { value: 'germany', label: '德国', keywords: ['德国', '法兰克福', 'germany', 'frankfurt'], codes: ['de'] },
  { value: 'canada', label: '加拿大', keywords: ['加拿大', '多伦多', '温哥华', 'canada', 'toronto', 'vancouver'], codes: ['ca'] },
  { value: 'korea', label: '韩国', keywords: ['韩国', '首尔', 'korea', 'seoul'], codes: ['kr'] },
  { value: 'australia', label: '澳大利亚', keywords: ['澳大利亚', '澳洲', '悉尼', 'australia', 'sydney'], codes: ['au'] },
  { value: 'netherlands', label: '荷兰', keywords: ['荷兰', '阿姆斯特丹', 'netherlands', 'amsterdam'], codes: ['nl'] }
];

const servers = ref<XuiServer[]>([]);
const socksNodes = ref<SocksNode[]>([]);
const nodes = ref<ServiceNode[]>([]);
const loading = ref(false);
const saving = ref(false);
const syncingConfigIds = ref<Set<string>>(new Set());
const syncingTrafficLimitIds = ref<Set<string>>(new Set());
const resettingTrafficIds = ref<Set<string>>(new Set());
const togglingIds = ref<Set<string>>(new Set());
const deletingIds = ref<Set<string>>(new Set());
const error = ref('');
const searchQuery = ref('');
const selectedServerId = ref('');
const selectedStatus = ref('');
const selectedProtocol = ref('');
const selectedRegion = ref('');
const editingId = ref('');
const dialogVisible = ref(false);
const form = reactive({
  name: '',
  serverId: '',
  remoteMode: 'create' as 'create' | 'bind',
  inboundId: undefined as number | undefined,
  inboundPort: undefined as number | undefined,
  protocol: 'vless',
  encryption: 'none',
  transport: 'tcp',
  tcpHeaderType: 'none',
  transportHost: '',
  transportPath: '/',
  grpcServiceName: '',
  grpcAuthority: '',
  grpcMultiMode: false,
  xhttpMode: 'auto',
  priceMonthly: 0,
  trafficLimitGb: 0,
  enabled: true,
  socksRelayEnabled: false,
  socksNodeId: '',
  remark: ''
});

const enabledSocksNodes = computed(() => socksNodes.value.filter((item) => item.enabled));
const enabledNodeCount = computed(() => nodes.value.filter((item) => item.enabled).length);
const socksRelayNodeCount = computed(() => nodes.value.filter((item) => item.config?.socksRelayEnabled).length);
const inboundReadyNodeCount = computed(() => nodes.value.filter((item) => item.inboundId).length);
const availableRegions = computed(() => regionDefinitions.filter((region) => nodes.value.some((node) => nodeRegion(node)?.value === region.value)));
const availableProtocols = computed(() => {
  const values = new Set(nodes.value.map((node) => node.protocol));
  return protocolOptions.filter((item) => values.has(item.value));
});
const filteredNodes = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
  return nodes.value.filter((node) => {
    if (keyword && !nodeSearchText(node).includes(keyword)) return false;
    if (selectedServerId.value && node.serverId !== selectedServerId.value) return false;
    if (selectedStatus.value === 'enabled' && !node.enabled) return false;
    if (selectedStatus.value === 'disabled' && node.enabled) return false;
    if (selectedProtocol.value && node.protocol !== selectedProtocol.value) return false;
    if (selectedRegion.value && nodeRegion(node)?.value !== selectedRegion.value) return false;
    return true;
  });
});
const hasActiveFilters = computed(() => Boolean(
  searchQuery.value.trim() || selectedServerId.value || selectedStatus.value || selectedProtocol.value || selectedRegion.value
));
const selectableTransportOptions = computed(() => {
  if (form.encryption === 'reality' || ['shadowsocks', 'hysteria'].includes(form.protocol)) {
    return transportOptions.filter((item) => item.value === 'tcp');
  }
  return transportOptions;
});
const selectableEncryptionOptions = computed(() => {
  if (['vless', 'trojan'].includes(form.protocol)) return encryptionOptions;
  return encryptionOptions.filter((item) => item.value !== 'reality');
});
const transportNeedsHostPath = computed(() => ['ws', 'httpupgrade', 'xhttp'].includes(form.transport));
const transportSummary = computed(() => {
  if (form.transport === 'ws') return 'WebSocket 会把 Path 与 Host 同步到远端入站和分享链接。';
  if (form.transport === 'grpc') return 'gRPC 会把 Service Name、Authority 与多路模式同步到远端。';
  if (form.transport === 'httpupgrade') return 'HTTPUpgrade 会把 Path 与 Host 同步到远端入站和分享链接。';
  if (form.transport === 'xhttp') return 'XHTTP 会把 Path、Host 与 Mode 同步到远端及分享链接。';
  if (form.tcpHeaderType === 'http') return 'TCP HTTP 伪装会把 Host 与 Path 写入请求头配置。';
  return 'TCP 无伪装使用 3x-ui 标准原始传输配置。';
});

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    const [serverList, nodeList, socksList] = await Promise.all([
      api<XuiServer[]>('/api/admin/xui-servers'),
      api<ServiceNode[]>('/api/admin/service-nodes'),
      api<SocksNode[]>('/api/admin/socks-nodes')
    ]);
    servers.value = serverList;
    nodes.value = nodeList;
    socksNodes.value = socksList;
    if (!form.serverId && serverList[0]) form.serverId = serverList[0].id;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载路由节点失败';
  } finally {
    loading.value = false;
  }
}

async function saveNode() {
  saving.value = true;
  error.value = '';
  try {
    const path = editingId.value ? `/api/admin/service-nodes/${editingId.value}` : '/api/admin/service-nodes';
    const body = form.remoteMode === 'bind'
      ? Object.fromEntries(Object.entries(form).filter(([key]) => ![
        'transport',
        'tcpHeaderType',
        'transportHost',
        'transportPath',
        'grpcServiceName',
        'grpcAuthority',
        'grpcMultiMode',
        'xhttpMode'
      ].includes(key)))
      : form;
    await api(path, { method: editingId.value ? 'PATCH' : 'POST', body });
    ElMessage.success(editingId.value ? '路由节点已更新' : '路由节点已创建');
    dialogVisible.value = false;
    resetForm();
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '保存路由节点失败';
  } finally {
    saving.value = false;
  }
}

async function syncRemoteConfig(node: ServiceNode) {
  try {
    await ElMessageBox.confirm(
      `确认把「${node.name}」的出站中转配置写入远端 Xray？系统只会管理本项目标记的出站和路由。`,
      '同步出站配置',
      { type: 'warning', customClass: 'node-dark-message-box' }
    );
  } catch {
    return;
  }
  syncingConfigIds.value = addPendingId(syncingConfigIds.value, node.id);
  error.value = '';
  try {
    const result = await api<RemoteConfigSyncResult>(`/api/admin/service-nodes/${node.id}/sync-config`, { method: 'POST' });
    ElMessage.success(result.action === 'updated' ? '远端出站中转配置已同步' : '远端出站中转配置已清理');
    await showRemoteConfigResult(result);
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步远端配置失败';
  } finally {
    syncingConfigIds.value = removePendingId(syncingConfigIds.value, node.id);
  }
}

async function syncTrafficLimit(node: ServiceNode) {
  syncingTrafficLimitIds.value = addPendingId(syncingTrafficLimitIds.value, node.id);
  error.value = '';
  try {
    const result = await api<TrafficSyncResult>(`/api/admin/service-nodes/${node.id}/sync-traffic-limit`, { method: 'POST' });
    if (result.failed > 0) {
      ElMessage.warning(`流量额度部分同步：成功 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}`);
    } else {
      ElMessage.success(`流量额度已同步：成功 ${result.updated}，跳过 ${result.skipped}`);
    }
    await showTrafficSyncResult(result);
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '同步流量额度失败';
  } finally {
    syncingTrafficLimitIds.value = removePendingId(syncingTrafficLimitIds.value, node.id);
  }
}

async function resetRemoteTraffic(node: ServiceNode) {
  try {
    await ElMessageBox.confirm(
      `确认重置「${node.name}」远端入站的流量统计？此操作不会清空每个客户端的流量。`,
      '重置远端流量',
      { type: 'warning', customClass: 'node-dark-message-box' }
    );
  } catch {
    return;
  }
  resettingTrafficIds.value = addPendingId(resettingTrafficIds.value, node.id);
  error.value = '';
  try {
    await api(`/api/admin/service-nodes/${node.id}/reset-traffic`, { method: 'POST' });
    ElMessage.success('远端入站流量已重置');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '重置远端流量失败';
  } finally {
    resettingTrafficIds.value = removePendingId(resettingTrafficIds.value, node.id);
  }
}

function openDialog() {
  resetForm();
  dialogVisible.value = true;
}

function editNode(node: ServiceNode) {
  const config = node.config || {};
  editingId.value = node.id;
  Object.assign(form, {
    name: node.name,
    serverId: node.serverId,
    remoteMode: config.remoteMode || (config.remoteManaged ? 'create' : 'bind'),
    inboundId: node.inboundId ?? undefined,
    inboundPort: config.remoteInboundPort ?? undefined,
    protocol: node.protocol || 'vless',
    encryption: config.encryption || 'none',
    transport: config.transport || 'tcp',
    tcpHeaderType: config.tcpHeaderType || 'none',
    transportHost: config.transportHost || '',
    transportPath: config.transportPath || '/',
    grpcServiceName: config.grpcServiceName || '',
    grpcAuthority: config.grpcAuthority || '',
    grpcMultiMode: Boolean(config.grpcMultiMode),
    xhttpMode: config.xhttpMode || 'auto',
    priceMonthly: Number(node.priceMonthly),
    trafficLimitGb: Number(node.trafficLimitGb),
    enabled: node.enabled,
    socksRelayEnabled: Boolean(config.socksRelayEnabled),
    socksNodeId: config.socksNodeId || '',
    remark: node.remark || ''
  });
  dialogVisible.value = true;
}

async function removeNode(node: ServiceNode) {
  try {
    await ElMessageBox.confirm(
      `确认删除路由节点「${node.name}」？系统会清理本项目写入的远端出站路由，并在该入站由本系统创建时删除远端入站。`,
      '删除路由节点',
      { type: 'warning', customClass: 'node-dark-message-box' }
    );
  } catch {
    return;
  }
  deletingIds.value = addPendingId(deletingIds.value, node.id);
  error.value = '';
  try {
    const result = await api<DeleteServiceNodeResult>(`/api/admin/service-nodes/${node.id}`, { method: 'DELETE' });
    ElMessage.success('路由节点已删除');
    await showDeleteResult(result);
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '删除路由节点失败';
  } finally {
    deletingIds.value = removePendingId(deletingIds.value, node.id);
  }
}

async function toggleNodeEnabled(node: ServiceNode, enabled = !node.enabled) {
  const previous = node.enabled;
  togglingIds.value = addPendingId(togglingIds.value, node.id);
  error.value = '';
  try {
    await api(`/api/admin/service-nodes/${node.id}`, { method: 'PATCH', body: { enabled } });
    node.enabled = enabled;
    ElMessage.success(enabled ? '路由节点已启用' : '路由节点已停用');
  } catch (err) {
    node.enabled = previous;
    error.value = err instanceof Error ? err.message : '更新路由节点状态失败';
    ElMessage.error(error.value);
  } finally {
    togglingIds.value = removePendingId(togglingIds.value, node.id);
  }
}

function handleNodeCommand(node: ServiceNode, command: string) {
  if (command === 'traffic-limit') void syncTrafficLimit(node);
  if (command === 'reset-traffic') void resetRemoteTraffic(node);
  if (command === 'toggle') void toggleNodeEnabled(node);
  if (command === 'delete') void removeNode(node);
}

async function copyPanelAddress(node: ServiceNode) {
  const address = node.server?.baseUrl;
  if (!address) return;
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

async function showDeleteResult(result: DeleteServiceNodeResult) {
  const remoteClient = result.remoteInboundCleanup?.remoteClientCleanup || result.remoteClientCleanup;
  await ElMessageBox.alert([
    cleanupStatusLine('远端出站/路由配置', result.remoteConfigCleanup),
    cleanupStatusLine('远端入站', result.remoteInboundCleanup),
    cleanupStatusLine('远端客户端', remoteClient),
    result.deleted ? '本地路由节点和用户绑定：已清理' : '本地路由节点和用户绑定：未清理'
  ].join('\n'), '删除结果', { type: 'success', customClass: 'node-dark-message-box' });
}

function cleanupStatusLine(label: string, result?: CleanupResult) {
  if (!result) return `${label}：没有返回结果`;
  if (result.skipped) return `${label}：已跳过（${result.reason || result.message || '-'}）`;
  if (result.synced) return `${label}：${result.action === 'removed' ? '已清理' : '已同步'}`;
  if (result.deleted && result.alreadyAbsent) return `${label}：远端已不存在，按删除成功处理`;
  if (result.deleted) return `${label}：已删除${result.verified?.retried ? '（复查后重试删除成功）' : ''}`;
  if (result.message) return `${label}：失败（${result.message}）`;
  return `${label}：已处理`;
}

async function showRemoteConfigResult(result: RemoteConfigSyncResult) {
  await ElMessageBox.alert([
    `远端状态：${result.synced ? '已同步' : '未同步'}`,
    `执行动作：${result.action === 'updated' ? '写入/更新出站路由' : '清理出站路由'}`,
    `入站 ID：${result.inboundId ?? '-'}`,
    `入站 Tag：${result.inboundTag || '-'}`,
    `出站 Tag：${result.outboundTag || '-'}`,
    `出站节点：${result.socks ? `${result.socks.host || '-'}:${result.socks.port || '-'}` : '未启用或已清理'}`
  ].join('\n'), '出站同步结果', {
    type: result.synced ? 'success' : 'warning',
    customClass: 'node-dark-message-box'
  });
}

async function showTrafficSyncResult(result: TrafficSyncResult) {
  const lines = [
    `远端状态：${result.synced ? '已全部同步' : '部分失败'}`,
    `入站 ID：${result.inboundId ?? '-'}`,
    `流量额度：${result.trafficLimitGb ?? '-'} GB`,
    `汇总：成功 ${result.updated}，跳过 ${result.skipped}，失败 ${result.failed}`
  ];
  const items = (result.results || []).slice(0, 8).map((item) => {
    const status = item.updated ? '成功' : item.skipped ? '跳过' : '失败';
    return `${item.target}：${status}${item.message ? `（${item.message}）` : ''}`;
  });
  if (items.length) lines.push('', ...items);
  if ((result.results || []).length > items.length) lines.push(`还有 ${(result.results || []).length - items.length} 条结果未显示`);
  await ElMessageBox.alert(lines.join('\n'), '流量同步结果', {
    type: result.failed > 0 ? 'warning' : 'success',
    customClass: 'node-dark-message-box'
  });
}

function resetFilters() {
  searchQuery.value = '';
  selectedServerId.value = '';
  selectedStatus.value = '';
  selectedProtocol.value = '';
  selectedRegion.value = '';
}

function resetForm() {
  editingId.value = '';
  Object.assign(form, {
    name: '',
    serverId: servers.value[0]?.id || '',
    remoteMode: 'create',
    inboundId: undefined,
    inboundPort: undefined,
    protocol: 'vless',
    encryption: 'none',
    transport: 'tcp',
    tcpHeaderType: 'none',
    transportHost: '',
    transportPath: '/',
    grpcServiceName: '',
    grpcAuthority: '',
    grpcMultiMode: false,
    xhttpMode: 'auto',
    priceMonthly: 0,
    trafficLimitGb: 0,
    enabled: true,
    socksRelayEnabled: false,
    socksNodeId: '',
    remark: ''
  });
}

function socksLabel(id?: string | null) {
  const node = socksNodes.value.find((item) => item.id === id);
  return node ? `${node.name} (${node.host}:${node.port})` : '-';
}

function remoteModeLabel(node: ServiceNode) {
  return node.config?.remoteManaged ? '自动创建' : '绑定已有';
}

function protocolLabel(protocol: string) {
  return protocolOptions.find((item) => item.value === protocol)?.label || protocol.toUpperCase();
}

function transportLabel(transport?: string) {
  const knownLabels: Record<string, string> = {
    http: 'HTTP/2',
    h2: 'HTTP/2',
    kcp: 'mKCP',
    quic: 'QUIC'
  };
  return transportOptions.find((item) => item.value === transport)?.label || knownLabels[String(transport || '').toLowerCase()] || String(transport || 'tcp').toUpperCase();
}

function protocolIcon(protocol: string) {
  if (protocol === 'vless') return ShieldCheck;
  if (protocol === 'vmess') return RadioTower;
  if (protocol === 'trojan') return LockKeyhole;
  if (protocol === 'shadowsocks') return Layers3;
  if (protocol === 'hysteria') return Zap;
  return Router;
}

function nodeRegion(node: ServiceNode) {
  const text = [node.name, node.remark, node.server?.name, node.server?.baseUrl].filter(Boolean).join(' ').toLowerCase();
  return regionDefinitions.find((region) => {
    if (region.keywords.some((keyword) => text.includes(keyword.toLowerCase()))) return true;
    return (region.codes || []).some((code) => new RegExp(`(^|[^a-z0-9])${escapeRegExp(code)}([^a-z0-9]|$)`, 'i').test(text));
  });
}

function nodeSearchText(node: ServiceNode) {
  return [
    node.name,
    node.server?.name,
    node.server?.baseUrl,
    node.protocol,
    protocolLabel(node.protocol),
    node.config?.encryption,
    node.config?.transport,
    transportLabel(node.config?.transport),
    remoteModeLabel(node),
    node.inboundId,
    node.config?.remoteInboundPort,
    node.priceMonthly,
    node.trafficLimitGb,
    node.remark,
    nodeRegion(node)?.label,
    socksLabel(node.config?.socksNodeId)
  ].filter(Boolean).join(' ').toLowerCase();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addPendingId(source: Set<string>, id: string) {
  return new Set(source).add(id);
}

function removePendingId(source: Set<string>, id: string) {
  const next = new Set(source);
  next.delete(id);
  return next;
}

onMounted(loadNodes);

watch(() => form.protocol, (protocol) => {
  if (!['vless', 'trojan'].includes(protocol) && form.encryption === 'reality') form.encryption = 'none';
  if (['shadowsocks', 'hysteria'].includes(protocol)) form.transport = 'tcp';
});

watch(() => form.encryption, (encryption) => {
  if (encryption === 'reality') form.transport = 'tcp';
});

watch(() => form.transport, () => {
  if (!form.transportPath.trim()) form.transportPath = '/';
});
</script>

<template>
  <section class="node-management-page" :class="{ loading }">
    <header class="node-page-header">
      <div>
        <h1>路由节点</h1>
        <p>管理服务节点、远端 3x-ui 入站、传输安全和 SOCKS 出站中转配置。</p>
      </div>
      <div class="node-page-actions">
        <el-button class="node-secondary-button" :loading="loading" @click="loadNodes"><RefreshCw :size="15" />刷新</el-button>
        <el-button type="primary" @click="openDialog"><Plus :size="15" />创建节点</el-button>
      </div>
    </header>

    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="node-page-alert" />

    <div class="node-stat-grid">
      <article class="node-stat-card">
        <span class="node-stat-icon tone-indigo"><Router :size="18" /></span>
        <div><small>节点总数</small><strong>{{ nodes.length }}</strong><span>全部路由节点</span></div>
      </article>
      <article class="node-stat-card">
        <span class="node-stat-icon tone-emerald"><CheckCircle2 :size="18" /></span>
        <div><small>已启用</small><strong>{{ enabledNodeCount }}</strong><span>{{ nodes.length - enabledNodeCount }} 个已停用</span></div>
      </article>
      <article class="node-stat-card">
        <span class="node-stat-icon tone-cyan"><Server :size="18" /></span>
        <div><small>远端入站</small><strong>{{ inboundReadyNodeCount }}</strong><span>已有远端入站 ID</span></div>
      </article>
      <article class="node-stat-card">
        <span class="node-stat-icon tone-amber"><Waypoints :size="18" /></span>
        <div><small>出站中转</small><strong>{{ socksRelayNodeCount }}</strong><span>已启用 SOCKS 中转</span></div>
      </article>
    </div>

    <div class="node-filter-panel">
      <div class="node-search-field">
        <Search :size="15" />
        <el-input v-model="searchQuery" clearable placeholder="搜索节点名称、面板连接、地址或备注" />
      </div>
      <el-select v-model="selectedServerId" clearable placeholder="全部面板连接" class="node-filter-select node-server-filter">
        <el-option v-for="server in servers" :key="server.id" :label="server.name" :value="server.id" />
      </el-select>
      <el-select v-model="selectedStatus" clearable placeholder="全部状态" class="node-filter-select">
        <el-option label="已启用" value="enabled" />
        <el-option label="已停用" value="disabled" />
      </el-select>
      <el-select v-model="selectedProtocol" clearable placeholder="全部协议" class="node-filter-select">
        <el-option v-for="item in availableProtocols" :key="item.value" :label="item.label" :value="item.value" />
      </el-select>
      <el-select v-model="selectedRegion" clearable placeholder="识别地区" class="node-filter-select">
        <el-option v-for="region in availableRegions" :key="region.value" :label="region.label" :value="region.value" />
      </el-select>
      <el-button v-if="hasActiveFilters" class="node-reset-filter" text @click="resetFilters">重置</el-button>
    </div>

    <div v-loading="loading" class="node-card-grid">
      <article v-for="node in filteredNodes" :key="node.id" class="route-node-card">
        <header class="route-node-card-header">
          <div class="route-node-identity">
            <span class="route-node-icon" :class="`protocol-${node.protocol}`">
              <component :is="protocolIcon(node.protocol)" :size="20" />
            </span>
            <div>
              <strong :title="node.name">{{ node.name }}</strong>
              <span>{{ protocolLabel(node.protocol) }} · {{ transportLabel(node.config?.transport) }} · {{ node.config?.encryption || 'none' }}</span>
            </div>
          </div>
          <span class="node-status-chip" :class="node.enabled ? 'is-enabled' : 'is-disabled'"><i></i>{{ node.enabled ? '已启用' : '已停用' }}</span>
        </header>

        <div class="route-node-address" :class="{ 'is-missing': !node.server?.baseUrl }">
          <Network :size="14" />
          <div>
            <small>面板地址</small>
            <strong :title="node.server?.baseUrl || ''">{{ node.server?.baseUrl || '未返回面板地址' }}</strong>
          </div>
          <el-tooltip v-if="node.server?.baseUrl" content="复制面板地址" placement="top">
            <button type="button" class="node-copy-button" aria-label="复制面板地址" @click="copyPanelAddress(node)"><Clipboard :size="14" /></button>
          </el-tooltip>
        </div>

        <div class="route-node-meta">
          <div><span>面板连接</span><strong :title="node.server?.name || ''">{{ node.server?.name || '-' }}</strong></div>
          <div><span>入站 ID</span><strong>{{ node.inboundId ?? '-' }}</strong></div>
          <div><span>月价格</span><strong>¥ {{ node.priceMonthly }}</strong></div>
          <div><span>流量额度</span><strong>{{ node.trafficLimitGb }} GB</strong></div>
        </div>

        <div class="route-node-tags">
          <span v-if="nodeRegion(node)" class="route-node-tag region">{{ nodeRegion(node)?.label }}</span>
          <span class="route-node-tag transport">{{ transportLabel(node.config?.transport) }}</span>
          <span class="route-node-tag security">{{ node.config?.encryption || 'none' }}</span>
          <span class="route-node-tag">{{ remoteModeLabel(node) }}</span>
          <span v-if="node.config?.remoteInboundPort" class="route-node-tag">端口 {{ node.config.remoteInboundPort }}</span>
          <span v-if="node.config?.socksRelayEnabled" class="route-node-tag relay" :title="socksLabel(node.config.socksNodeId)">SOCKS 中转</span>
        </div>

        <p class="route-node-remark" :class="{ 'is-empty': !node.remark }">{{ node.remark || '暂无备注' }}</p>

        <footer class="route-node-actions">
          <el-button type="primary" plain @click="editNode(node)"><Edit3 :size="14" />编辑</el-button>
          <el-button
            class="node-sync-button"
            :loading="syncingConfigIds.has(node.id)"
            :disabled="!node.inboundId"
            @click="syncRemoteConfig(node)"
          ><UploadCloud :size="14" />同步出站</el-button>
          <el-dropdown trigger="click" @command="(command: string) => handleNodeCommand(node, command)">
            <el-button class="node-more-button" aria-label="更多节点操作"><MoreHorizontal :size="16" /></el-button>
            <template #dropdown>
              <el-dropdown-menu class="node-action-menu">
                <el-dropdown-item command="traffic-limit" :disabled="!node.inboundId || syncingTrafficLimitIds.has(node.id)"><Gauge :size="14" />同步流量额度</el-dropdown-item>
                <el-dropdown-item command="reset-traffic" :disabled="!node.inboundId || resettingTrafficIds.has(node.id)"><RotateCcw :size="14" />重置远端流量</el-dropdown-item>
                <el-dropdown-item command="toggle" :disabled="togglingIds.has(node.id)">
                  <CircleSlash2 v-if="node.enabled" :size="14" />
                  <CheckCircle2 v-else :size="14" />
                  {{ node.enabled ? '停用节点' : '启用节点' }}
                </el-dropdown-item>
                <el-dropdown-item command="delete" divided :disabled="deletingIds.has(node.id)"><Trash2 :size="14" />删除节点</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </footer>
      </article>

      <div v-if="!filteredNodes.length && !loading" class="node-empty-state">
        <CloudCog :size="28" />
        <strong>{{ nodes.length ? '没有符合筛选条件的节点' : '暂无路由节点' }}</strong>
        <span>{{ nodes.length ? '调整筛选条件后再查看' : '使用右上角创建节点接入真实面板连接' }}</span>
      </div>
    </div>

    <footer class="node-list-footer">显示 {{ filteredNodes.length }} / {{ nodes.length }} 个真实节点</footer>
  </section>

  <el-dialog
    v-model="dialogVisible"
    :title="editingId ? '编辑路由节点' : '创建路由节点'"
    width="min(920px, 94vw)"
    class="node-dark-dialog"
    destroy-on-close
  >
    <div class="node-dialog-intro">
      <Router :size="18" />
      <div>
        <strong>{{ editingId ? '更新节点与远端入站配置' : '创建节点并接入远端 3x-ui 入站' }}</strong>
        <span>保存时会按所选模式创建或校验真实入站，并同步必要的远端配置。</span>
      </div>
    </div>

    <el-form :model="form" label-position="top" class="node-dialog-form">
      <section class="node-dialog-section">
        <header><strong>基础信息</strong><span>节点名称、所属面板连接和启用状态</span></header>
        <div class="node-dialog-grid">
          <el-form-item label="节点名称"><el-input v-model="form.name" maxlength="100" placeholder="输入节点名称" /></el-form-item>
          <el-form-item label="面板连接">
            <el-select v-model="form.serverId" placeholder="选择面板连接" style="width: 100%">
              <el-option v-for="server in servers" :key="server.id" :label="server.name" :value="server.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="启用节点" class="node-switch-item"><el-switch v-model="form.enabled" /></el-form-item>
        </div>
      </section>

      <section class="node-dialog-section">
        <header><strong>远端入站</strong><span>自动创建新入站，或绑定并校验已有入站 ID</span></header>
        <div class="node-dialog-grid">
          <el-form-item label="入站模式">
            <el-segmented v-model="form.remoteMode" :options="[{ label: '自动创建', value: 'create' }, { label: '绑定已有', value: 'bind' }]" />
          </el-form-item>
          <el-form-item v-if="form.remoteMode === 'bind'" label="入站 ID"><el-input-number v-model="form.inboundId" :min="1" placeholder="输入远端入站 ID" style="width: 100%" /></el-form-item>
          <el-form-item v-else label="指定端口"><el-input-number v-model="form.inboundPort" :min="1" :max="65535" placeholder="留空自动分配" style="width: 100%" /></el-form-item>
        </div>
      </section>

      <section class="node-dialog-section">
        <header><strong>协议与安全</strong><span>选择可生成用户分享链接的服务协议与传输安全类型</span></header>
        <div class="node-dialog-grid">
          <el-form-item label="节点协议">
            <el-select v-model="form.protocol" style="width: 100%">
              <el-option v-for="item in protocolOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
          <el-form-item label="传输安全">
            <el-select v-model="form.encryption" style="width: 100%">
              <el-option v-for="item in selectableEncryptionOptions" :key="item.value" :label="item.label" :value="item.value" />
            </el-select>
          </el-form-item>
        </div>
      </section>

      <section class="node-dialog-section">
        <header><strong>传输配置</strong><span>{{ form.remoteMode === 'bind' ? '绑定已有入站时，保存会读取并采用远端真实传输配置。' : '传输参数会直接写入 3x-ui 入站，并用于生成用户分享链接和二维码。' }}</span></header>
        <template v-if="form.remoteMode === 'create'">
          <div class="node-dialog-grid">
            <el-form-item label="传输方式">
              <el-select v-model="form.transport" style="width: 100%">
                <el-option v-for="item in selectableTransportOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="form.transport === 'tcp'" label="TCP Header">
              <el-select v-model="form.tcpHeaderType" style="width: 100%">
                <el-option label="None" value="none" />
                <el-option label="HTTP" value="http" />
              </el-select>
            </el-form-item>
            <el-form-item v-if="transportNeedsHostPath || (form.transport === 'tcp' && form.tcpHeaderType === 'http')" label="Host">
              <el-input v-model="form.transportHost" maxlength="255" placeholder="可留空；使用域名伪装时填写" />
            </el-form-item>
            <el-form-item v-if="transportNeedsHostPath || (form.transport === 'tcp' && form.tcpHeaderType === 'http')" label="Path">
              <el-input v-model="form.transportPath" maxlength="500" placeholder="例如 /service" />
            </el-form-item>
            <el-form-item v-if="form.transport === 'grpc'" label="Service Name">
              <el-input v-model="form.grpcServiceName" maxlength="255" placeholder="可留空，建议使用唯一服务名" />
            </el-form-item>
            <el-form-item v-if="form.transport === 'grpc'" label="Authority">
              <el-input v-model="form.grpcAuthority" maxlength="255" placeholder="可留空；反向代理需要时填写" />
            </el-form-item>
            <el-form-item v-if="form.transport === 'grpc'" label="多路模式" class="node-switch-item"><el-switch v-model="form.grpcMultiMode" /></el-form-item>
            <el-form-item v-if="form.transport === 'xhttp'" label="XHTTP Mode">
              <el-select v-model="form.xhttpMode" style="width: 100%">
                <el-option v-for="item in xhttpModeOptions" :key="item.value" :label="item.label" :value="item.value" />
              </el-select>
            </el-form-item>
          </div>
          <div class="node-transport-note"><Network :size="15" /><span>{{ transportSummary }}</span></div>
        </template>
        <div v-else class="node-transport-note is-remote"><RefreshCw :size="15" /><span>系统会校验入站 ID，并读取远端协议、安全类型和传输参数；表单默认值不会覆盖远端配置。</span></div>
      </section>

      <section class="node-dialog-section">
        <header><strong>SOCKS 出站中转</strong><span>启用后将该入站流量转发到已配置且启用的出站节点</span></header>
        <div class="node-dialog-grid">
          <el-form-item label="启用中转" class="node-switch-item"><el-switch v-model="form.socksRelayEnabled" /></el-form-item>
          <el-form-item label="出站节点">
            <el-select v-model="form.socksNodeId" :disabled="!form.socksRelayEnabled" placeholder="选择出站节点" style="width: 100%">
              <el-option v-for="node in enabledSocksNodes" :key="node.id" :label="`${node.name} (${node.host}:${node.port})`" :value="node.id" />
            </el-select>
          </el-form-item>
        </div>
      </section>

      <section class="node-dialog-section node-dialog-section-last">
        <header><strong>计费与备注</strong><span>月价格用于面板展示，流量额度可同步到远端已有客户端</span></header>
        <div class="node-dialog-grid">
          <el-form-item label="月价格"><el-input-number v-model="form.priceMonthly" :min="0" :precision="2" style="width: 100%" /></el-form-item>
          <el-form-item label="流量额度 (GB)"><el-input-number v-model="form.trafficLimitGb" :min="0" :precision="2" style="width: 100%" /></el-form-item>
          <el-form-item label="备注" class="node-dialog-full"><el-input v-model="form.remark" type="textarea" :rows="3" maxlength="500" placeholder="输入节点备注" /></el-form-item>
        </div>
      </section>
    </el-form>

    <template #footer>
      <el-button class="node-secondary-button" @click="dialogVisible = false">取消</el-button>
      <el-button
        type="primary"
        :loading="saving"
        :disabled="!form.name || !form.serverId || (form.remoteMode === 'bind' && !form.inboundId) || (form.socksRelayEnabled && !form.socksNodeId)"
        @click="saveNode"
      >{{ editingId ? '保存修改' : '创建节点' }}</el-button>
    </template>
  </el-dialog>
</template>
