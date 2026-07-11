<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { AlertTriangle, Database, RefreshCw, Server, Timer } from 'lucide-vue-next';
import { api } from '../api';

type CheckStatus = 'ok' | 'warning' | 'error' | 'skipped';
type DiagnosticCheck = { key: string; label: string; status: CheckStatus; message: string; detail?: unknown; checkedAt: string };
type SyncLog = {
  id: string;
  action: string;
  status: string;
  message?: string | null;
  detail?: unknown;
  createdAt: string;
  server?: { id: string; name: string; baseUrl: string } | null;
};
type DiagnosticsPayload = {
  checkedAt: string;
  summary: { status: CheckStatus; total: number; ok: number; warnings: number; errors: number; skipped: number };
  counts: Record<string, number>;
  checks: DiagnosticCheck[];
  recentFailures: SyncLog[];
};

const loading = ref(false);
const error = ref('');
const diagnostics = ref<DiagnosticsPayload | null>(null);

const databaseCheck = computed(() => diagnostics.value?.checks.find((item) => item.key === 'database'));
const jobsCheck = computed(() => diagnostics.value?.checks.find((item) => item.key === 'jobs'));
const xuiChecks = computed(() => diagnostics.value?.checks.filter((item) => item.key.startsWith('xui-')) || []);

async function loadDiagnostics() {
  loading.value = true;
  error.value = '';
  try {
    diagnostics.value = await api<DiagnosticsPayload>('/api/admin/diagnostics');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载健康诊断失败';
    ElMessage.error(error.value);
  } finally {
    loading.value = false;
  }
}

function statusType(status?: CheckStatus | string) {
  if (status === 'ok' || status === 'success') return 'success';
  if (status === 'warning' || status === 'partial') return 'warning';
  if (status === 'error' || status === 'failed') return 'danger';
  return 'info';
}

function statusLabel(status?: CheckStatus | string) {
  const map: Record<string, string> = { ok: '正常', warning: '注意', error: '异常', skipped: '跳过', success: '成功', partial: '部分成功', failed: '失败' };
  return status ? map[status] || status : '-';
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
    'disable-traffic-exceeded-nodes': '自动停用流量用尽节点'
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

function summaryText() {
  const summary = diagnostics.value?.summary;
  if (!summary) return '尚未检查';
  if (summary.errors) return `${summary.errors} 项异常，需要优先处理`;
  if (summary.warnings) return `${summary.warnings} 项需要注意`;
  return '核心服务检查正常';
}

onMounted(loadDiagnostics);
</script>

<template>
  <div class="page-head">
    <div class="page-head-main">
      <h1 class="page-title">健康诊断</h1>
      <p>集中检查 API、数据库、自动任务、3-x-ui 面板连接和最近失败同步日志。</p>
    </div>
    <div class="page-actions">
      <el-button type="primary" :loading="loading" @click="loadDiagnostics"><RefreshCw :size="15" />重新诊断</el-button>
    </div>
  </div>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div v-if="diagnostics" class="metric-grid compact-metrics" :class="{ loading }">
    <div class="metric"><span>整体状态</span><strong>{{ statusLabel(diagnostics.summary.status) }}</strong><small>{{ summaryText() }}</small></div>
    <div class="metric"><span>用户 / 路由节点</span><strong>{{ diagnostics.counts.activeCustomers }}/{{ diagnostics.counts.enabledServiceNodes }}</strong><small>启用用户 / 启用路由节点</small></div>
    <div class="metric"><span>面板连接</span><strong>{{ diagnostics.counts.enabledXuiServers }}/{{ diagnostics.counts.xuiServers }}</strong><small>启用面板 / 总面板</small></div>
    <div class="metric"><span>待支付订单</span><strong>{{ diagnostics.counts.pendingOrders }}</strong><small>pending 状态订单数量</small></div>
  </div>

  <div class="diagnostic-grid" v-if="diagnostics">
    <div class="panel diagnostic-card">
      <div class="diagnostic-card-head"><Database :size="20" /><strong>数据库</strong><el-tag :type="statusType(databaseCheck?.status)">{{ statusLabel(databaseCheck?.status) }}</el-tag></div>
      <p>{{ databaseCheck?.message || '未检查' }}</p>
      <small>{{ formatDate(databaseCheck?.checkedAt) }}</small>
    </div>
    <div class="panel diagnostic-card">
      <div class="diagnostic-card-head"><Timer :size="20" /><strong>自动任务</strong><el-tag :type="statusType(jobsCheck?.status)">{{ statusLabel(jobsCheck?.status) }}</el-tag></div>
      <p>{{ jobsCheck?.message || '未检查' }}</p>
      <small>{{ formatDate(jobsCheck?.checkedAt) }}</small>
    </div>
  </div>

  <div class="panel list-panel" v-if="diagnostics">
    <div class="panel-toolbar">
      <strong>3-x-ui 面板连接检查</strong>
      <span class="muted-text">只检查已启用的面板连接</span>
    </div>
    <div class="diagnostic-check-list">
      <div v-for="check in xuiChecks" :key="check.key" class="diagnostic-check-row">
        <Server :size="18" />
        <div><strong>{{ check.label }}</strong><span>{{ check.message }}</span></div>
        <el-tag :type="statusType(check.status)">{{ statusLabel(check.status) }}</el-tag>
      </div>
    </div>
  </div>

  <div class="panel list-panel" v-if="diagnostics">
    <div class="panel-toolbar">
      <strong>最近异常同步</strong>
      <span class="muted-text">最近 10 条失败或部分成功记录</span>
    </div>
    <el-table :data="diagnostics.recentFailures" v-loading="loading" row-key="id" style="width: 100%">
      <el-table-column label="时间" min-width="165"><template #default="{ row }: { row: SyncLog }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      <el-table-column label="面板" min-width="150"><template #default="{ row }: { row: SyncLog }">{{ row.server?.name || '-' }}</template></el-table-column>
      <el-table-column label="动作" min-width="190"><template #default="{ row }: { row: SyncLog }">{{ actionLabel(row.action) }}</template></el-table-column>
      <el-table-column label="状态" width="110"><template #default="{ row }: { row: SyncLog }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
      <el-table-column prop="message" label="消息" min-width="260" show-overflow-tooltip />
      <el-table-column label="详情" type="expand"><template #default="{ row }: { row: SyncLog }"><pre class="json-preview">{{ formatDetail(row.detail) }}</pre></template></el-table-column>
      <template #empty><el-empty description="最近没有异常同步记录" /></template>
    </el-table>
  </div>

  <div v-if="!diagnostics && !error" class="panel diagnostic-loading">
    <AlertTriangle :size="22" />
    <span>{{ loading ? '正在执行健康诊断...' : '等待诊断' }}</span>
  </div>
</template>
