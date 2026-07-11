<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { Copy, RefreshCw, RotateCcw, Search } from 'lucide-vue-next';
import { api } from '../api';

type XuiServer = { id: string; name: string; baseUrl: string };
type SyncLog = {
  id: string;
  serverId?: string | null;
  action: string;
  status: string;
  message?: string | null;
  detail?: unknown;
  createdAt: string;
  server?: XuiServer | null;
};
type SyncLogResponse = {
  items: SyncLog[];
  filters: { actions: string[]; statuses: string[]; servers: XuiServer[] };
};

const loading = ref(false);
const error = ref('');
const logs = ref<SyncLog[]>([]);
const actions = ref<string[]>([]);
const statuses = ref<string[]>([]);
const servers = ref<XuiServer[]>([]);
const filters = reactive({ serverId: '', action: '', status: '', limit: 100 });
const detailDialogVisible = ref(false);
const selectedLog = ref<SyncLog | null>(null);

const failedCount = computed(() => logs.value.filter((item) => item.status === 'failed').length);
const partialCount = computed(() => logs.value.filter((item) => item.status === 'partial').length);
const successCount = computed(() => logs.value.filter((item) => item.status === 'success').length);

async function loadLogs() {
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    if (filters.serverId) params.set('serverId', filters.serverId);
    if (filters.action) params.set('action', filters.action);
    if (filters.status) params.set('status', filters.status);
    params.set('limit', String(filters.limit || 100));
    const result = await api<SyncLogResponse>(`/api/admin/sync-logs?${params.toString()}`);
    logs.value = result.items;
    actions.value = result.filters.actions;
    statuses.value = result.filters.statuses;
    servers.value = result.filters.servers;
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载同步日志失败';
    ElMessage.error(error.value);
  } finally {
    loading.value = false;
  }
}

function setStatusFilter(status: string) {
  filters.status = status;
  void loadLogs();
}

function resetFilters() {
  Object.assign(filters, { serverId: '', action: '', status: '', limit: 100 });
  void loadLogs();
}

function showDetail(log: SyncLog) {
  selectedLog.value = log;
  detailDialogVisible.value = true;
}

async function copyDetail(log = selectedLog.value) {
  if (!log) return;
  const text = formatDetail(log.detail);
  try {
    await navigator.clipboard.writeText(text);
    ElMessage.success('日志详情已复制');
  } catch {
    ElMessage.error('复制失败，请手动选择复制');
  }
}

function statusType(status: string) {
  if (status === 'success') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'partial') return 'warning';
  return 'info';
}

function statusLabel(status: string) {
  const map: Record<string, string> = { success: '成功', failed: '失败', partial: '部分成功', skipped: '已跳过' };
  return map[status] || status || '-';
}

function actionLabel(action: string) {
  const map: Record<string, string> = {
    'service-node-config-sync': '路由出站配置同步',
    'service-node-inbound-create': '远端入站创建',
    'service-node-inbound-update': '远端入站更新',
    'service-node-enable-sync': '远端入站启停同步',
    'service-node-traffic-limit-sync': '路由节点流量额度同步',
    'service-node-reset-traffic': '路由节点流量重置',
    'service-node-inbound-delete': '远端入站删除',
    'server-inbounds-import': '远端入站导入',
    'customer-node-sync': '用户绑定节点同步',
    'customer-node-links': '用户节点链接获取',
    'customer-node-delete': '远端客户端删除',
    'customer-node-reset-traffic': '用户节点流量重置',
    'service-node-link-verify': '节点链接校验',
    'service-node-inbound-create-rollback': '创建失败回滚',
    'disable-expired-nodes': '自动停用过期节点',
    'disable-traffic-exceeded-nodes': '自动停用流量用尽节点',
    sync_service_node: '同步路由节点',
    delete_service_node: '删除路由节点',
    update_customer_node: '更新绑定节点',
    disable_expired_node: '停用过期节点',
    sync_traffic: '同步远端流量'
  };
  return map[action] || action;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function formatDetail(value: unknown) {
  if (value === undefined || value === null) return '没有详情';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function shortDetail(value: unknown) {
  const object = objectValue(value);
  const parts = [
    labelValue('入站ID', object.inboundId),
    labelValue('端口', object.port),
    labelValue('协议', object.protocol),
    labelValue('用户端', object.xuiEmail || object.remoteClientEmail),
    labelValue('结果', object.action),
    labelValue('原因', object.message || object.cause)
  ].filter(Boolean);
  if (parts.length) return parts.join('，');
  const text = formatDetail(value).replace(/\s+/g, ' ');
  return text.length > 110 ? `${text.slice(0, 110)}...` : text;
}

function readableMessage(log: SyncLog) {
  if (!log.message) return '-';
  return log.message
    .replace(/^Created inbound (\d+) for (.+)$/i, '已为 $2 创建远端入站 $1')
    .replace(/^Updated inbound (\d+) for (.+)$/i, '已为 $2 更新远端入站 $1')
    .replace(/^Deleted inbound (\d+)$/i, '已删除远端入站 $1')
    .replace(/^Inbound (\d+) already absent$/i, '远端入站 $1 已不存在')
    .replace(/^Synced (.+)$/i, '已同步用户端 $1')
    .replace(/^Deleted (.+)$/i, '已删除用户端 $1')
    .replace(/^Remote client already absent: (.+)$/i, '远端用户端已不存在：$1')
    .replace(/^Service node (.+) remote config updated$/i, '路由节点 $1 出站规则已更新')
    .replace(/^Service node (.+) remote config removed$/i, '路由节点 $1 出站规则已移除')
    .replace(/^Expired node disable job by (.+): success (\d+), failed (\d+), total (\d+)$/i, '过期停用任务：成功 $2，失败 $3，总数 $4')
    .replace(/^Traffic limit disable job by (.+): disabled (\d+), failed (\d+), checked (\d+)$/i, '流量停用任务：停用 $2，失败 $3，检查 $4');
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function labelValue(label: string, value: unknown) {
  if (value === undefined || value === null || value === '') return '';
  return `${label}：${String(value)}`;
}

onMounted(loadLogs);
</script>

<template>
  <div class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">同步日志</h1>
      <p>查看管理后台对 3-x-ui 的同步、删除、流量读取等真实执行结果。</p>
    </div>
    <div class="page-actions">
      <el-button :loading="loading" @click="loadLogs"><RefreshCw :size="15" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid compact-metrics">
    <div class="metric"><span>当前显示</span><strong>{{ logs.length }}</strong><small>最多 {{ filters.limit }} 条</small></div>
    <div class="metric"><span>成功</span><strong>{{ successCount }}</strong><small>远端操作已完成</small></div>
    <div class="metric"><span>部分成功</span><strong>{{ partialCount }}</strong><small>需要查看详情</small></div>
    <div class="metric"><span>失败</span><strong>{{ failedCount }}</strong><small>优先排查这些记录</small></div>
  </div>

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>3-x-ui 操作记录</strong>
      <div class="status-segment" role="group" aria-label="状态筛选">
        <button :class="{ active: !filters.status }" type="button" @click="setStatusFilter('')">全部</button>
        <button :class="{ active: filters.status === 'success' }" type="button" @click="setStatusFilter('success')">成功</button>
        <button :class="{ active: filters.status === 'partial' }" type="button" @click="setStatusFilter('partial')">部分</button>
        <button :class="{ active: filters.status === 'failed' }" type="button" @click="setStatusFilter('failed')">失败</button>
      </div>
    </div>

    <div class="filter-bar">
      <el-select v-model="filters.serverId" clearable placeholder="面板连接" style="width: 190px" @change="loadLogs">
        <el-option v-for="server in servers" :key="server.id" :label="server.name" :value="server.id" />
      </el-select>
      <el-select v-model="filters.action" clearable placeholder="动作" style="width: 240px" @change="loadLogs">
        <el-option v-for="action in actions" :key="action" :label="actionLabel(action)" :value="action" />
      </el-select>
      <el-select v-model="filters.status" clearable placeholder="状态" style="width: 130px" @change="loadLogs">
        <el-option v-for="status in statuses" :key="status" :label="statusLabel(status)" :value="status" />
      </el-select>
      <el-input-number v-model="filters.limit" :min="20" :max="300" :step="20" controls-position="right" style="width: 126px" @change="loadLogs" />
      <el-button @click="resetFilters"><RotateCcw :size="15" />重置</el-button>
      <el-button type="primary" :loading="loading" @click="loadLogs"><Search :size="15" />查询</el-button>
    </div>

    <el-table :data="logs" v-loading="loading" style="width: 100%" row-key="id">
      <el-table-column label="时间" min-width="170"><template #default="{ row }: { row: SyncLog }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      <el-table-column label="面板连接" min-width="160"><template #default="{ row }: { row: SyncLog }">{{ row.server?.name || '-' }}</template></el-table-column>
      <el-table-column label="动作" min-width="210"><template #default="{ row }: { row: SyncLog }">{{ actionLabel(row.action) }}</template></el-table-column>
      <el-table-column label="状态" width="110"><template #default="{ row }: { row: SyncLog }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
      <el-table-column label="消息" min-width="280" show-overflow-tooltip><template #default="{ row }: { row: SyncLog }">{{ readableMessage(row) }}</template></el-table-column>
      <el-table-column label="详情摘要" min-width="280" show-overflow-tooltip><template #default="{ row }: { row: SyncLog }"><span class="muted-text">{{ shortDetail(row.detail) }}</span></template></el-table-column>
      <el-table-column label="操作" width="90" fixed="right"><template #default="{ row }: { row: SyncLog }"><el-button size="small" @click="showDetail(row)">详情</el-button></template></el-table-column>
      <template #empty><el-empty description="暂无同步日志" /></template>
    </el-table>
  </div>

  <el-dialog v-model="detailDialogVisible" title="同步日志详情" width="min(760px, 92vw)" destroy-on-close>
    <div v-if="selectedLog" class="log-detail-dialog">
      <div class="log-detail-meta">
        <span>{{ formatDate(selectedLog.createdAt) }}</span>
        <span>{{ selectedLog.server?.name || '未关联服务器' }}</span>
        <span>{{ actionLabel(selectedLog.action) }}</span>
        <el-tag :type="statusType(selectedLog.status)">{{ statusLabel(selectedLog.status) }}</el-tag>
      </div>
      <el-alert v-if="selectedLog.message" :title="readableMessage(selectedLog)" :type="selectedLog.status === 'failed' ? 'warning' : 'info'" show-icon :closable="false" />
      <pre class="json-preview">{{ formatDetail(selectedLog.detail) }}</pre>
    </div>
    <template #footer>
      <el-button @click="detailDialogVisible = false">关闭</el-button>
      <el-button type="primary" @click="copyDetail()"><Copy :size="15" />复制详情</el-button>
    </template>
  </el-dialog>
</template>
