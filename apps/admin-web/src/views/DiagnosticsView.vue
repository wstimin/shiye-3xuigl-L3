<script setup lang="ts">
import type { Component } from 'vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/empty/style/css';
import 'element-plus/es/components/table/style/css';
import 'element-plus/es/components/table-column/style/css';
import 'element-plus/es/components/tag/style/css';
import 'element-plus/es/components/tooltip/style/css';
import { computed, onMounted, ref } from 'vue';
import { ElAlert, ElButton, ElDialog, ElEmpty, ElMessage, ElTable as ElTableComponent, ElTableColumn as ElTableColumnComponent, ElTag, ElTooltip } from 'element-plus';
const ElTable = ElTableComponent as any;
const ElTableColumn = ElTableColumnComponent as any;
import {
  Activity,
  CircleCheckBig,
  Clock3,
  Cpu,
  CreditCard,
  Database,
  Eye,
  Gauge,
  HardDrive,
  Info,
  MemoryStick,
  Network,
  PanelTop,
  RefreshCw,
  Server,
  Timer,
  TriangleAlert,
  XCircle
} from 'lucide-vue-next';
import { api } from '../api';

type CheckStatus = 'ok' | 'warning' | 'error' | 'skipped';
type CheckMeta = { label: string; value: string };
type DiagnosticCheck = {
  key: string;
  label: string;
  status: CheckStatus;
  message: string;
  detail?: unknown;
  meta?: CheckMeta[];
  checkedAt: string;
  durationMs: number;
};
type SyncLog = {
  id: string;
  action: string;
  status: string;
  message?: string | null;
  detail?: unknown;
  createdAt: string;
  server?: { id: string; name: string; baseUrl: string } | null;
};
type ResourceUsage = {
  cpu: { cores: number; model: string; usagePercent: number; loadAverage: number };
  memory: { totalBytes: number; freeBytes: number; usedBytes: number; usagePercent: number };
  disk: { available: boolean; path: string; totalBytes: number; freeBytes: number; usedBytes: number; usagePercent: number; message?: string };
  uptime: { processSeconds: number; systemSeconds: number; startedAt: string };
  runtime: { nodeVersion: string; platform: string };
};
type DiagnosticsPayload = {
  checkedAt: string;
  startedAt: string;
  durationMs: number;
  summary: {
    status: CheckStatus;
    score: number;
    total: number;
    passed: number;
    ok: number;
    warnings: number;
    errors: number;
    skipped: number;
  };
  counts: Record<string, number>;
  resources: ResourceUsage;
  checks: DiagnosticCheck[];
  recentFailures: SyncLog[];
};

const loading = ref(false);
const initialized = ref(false);
const error = ref('');
const diagnostics = ref<DiagnosticsPayload | null>(null);
const detailVisible = ref(false);
const selectedCheck = ref<DiagnosticCheck | null>(null);
const logVisible = ref(false);
const selectedLog = ref<SyncLog | null>(null);

const scoreTone = computed(() => {
  const status = diagnostics.value?.summary.status;
  if (status === 'error') return 'bad';
  if (status === 'warning') return 'warn';
  return 'good';
});

const scoreLabel = computed(() => {
  const status = diagnostics.value?.summary.status;
  if (status === 'error') return '异常';
  if (status === 'warning') return '需注意';
  return '良好';
});

const scoreDescription = computed(() => {
  const data = diagnostics.value;
  if (!data) return '正在读取系统状态。';
  const parts = [`${data.summary.ok} 项正常`];
  if (data.summary.skipped) parts.push(`${data.summary.skipped} 项跳过`);
  if (data.summary.warnings) parts.push(`${data.summary.warnings} 项需注意`);
  if (data.summary.errors) parts.push(`${data.summary.errors} 项异常`);
  return `${parts.join('，')}。已检查数据库、任务、路由节点、支付配置、运行环境和所有启用面板。`;
});

const resourceCards = computed(() => {
  const resources = diagnostics.value?.resources;
  if (!resources) return [];
  return [
    {
      key: 'cpu',
      label: 'CPU 使用率',
      value: formatPercent(resources.cpu.usagePercent),
      sub: `${resources.cpu.cores} 核 · 1 分钟负载 ${resources.cpu.loadAverage.toFixed(2)}`,
      percent: resources.cpu.usagePercent,
      icon: Cpu,
      tone: 'indigo'
    },
    {
      key: 'memory',
      label: '内存',
      value: `${formatBytes(resources.memory.usedBytes)} / ${formatBytes(resources.memory.totalBytes)}`,
      sub: `已用 ${formatPercent(resources.memory.usagePercent)}`,
      percent: resources.memory.usagePercent,
      icon: MemoryStick,
      tone: 'cyan'
    },
    {
      key: 'disk',
      label: '磁盘',
      value: resources.disk.available ? `${formatBytes(resources.disk.usedBytes)} / ${formatBytes(resources.disk.totalBytes)}` : '暂不可用',
      sub: resources.disk.available ? `${resources.disk.path} · 已用 ${formatPercent(resources.disk.usagePercent)}` : (resources.disk.message || '系统未返回磁盘信息'),
      percent: resources.disk.available ? resources.disk.usagePercent : 0,
      icon: HardDrive,
      tone: 'emerald'
    },
    {
      key: 'uptime',
      label: 'API 运行时长',
      value: formatDuration(resources.uptime.processSeconds),
      sub: `启动于 ${formatDate(resources.uptime.startedAt)}`,
      percent: null,
      icon: Clock3,
      tone: 'amber'
    }
  ];
});

async function loadDiagnostics(notify = false) {
  loading.value = true;
  error.value = '';
  try {
    diagnostics.value = await api<DiagnosticsPayload>('/api/admin/diagnostics');
    if (notify) ElMessage.success('诊断成功');
  } catch {
    error.value = '诊断失败';
    ElMessage.error(error.value);
  } finally {
    loading.value = false;
    initialized.value = true;
  }
}

function openCheckDetail(check: DiagnosticCheck) {
  selectedCheck.value = check;
  detailVisible.value = true;
}

function openLogDetail(log: SyncLog) {
  selectedLog.value = log;
  logVisible.value = true;
}

function checkIcon(key: string): Component {
  if (key === 'database') return Database;
  if (key === 'jobs') return Activity;
  if (key === 'service-nodes') return Network;
  if (key === 'payment') return CreditCard;
  if (key === 'runtime') return Server;
  if (key.startsWith('xui-')) return PanelTop;
  return Gauge;
}

function statusIcon(status: CheckStatus): Component {
  if (status === 'ok') return CircleCheckBig;
  if (status === 'warning') return TriangleAlert;
  if (status === 'error') return XCircle;
  return Info;
}

function statusType(status?: CheckStatus | string) {
  if (status === 'ok' || status === 'success') return 'success';
  if (status === 'warning' || status === 'partial') return 'warning';
  if (status === 'error' || status === 'failed') return 'danger';
  return 'info';
}

function statusLabel(status?: CheckStatus | string) {
  const map: Record<string, string> = {
    ok: '正常',
    warning: '注意',
    error: '异常',
    skipped: '已跳过',
    success: '成功',
    partial: '部分成功',
    failed: '失败'
  };
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
  if (value === undefined || value === null) return '没有详细数据';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / 1024 ** index).toFixed(index > 2 ? 1 : 0)} ${units[index]}`;
}

function formatPercent(value: number) {
  return `${Math.max(0, Math.min(100, value)).toFixed(value % 1 ? 1 : 0)}%`;
}

function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes) return `${minutes} 分钟`;
  return `${seconds} 秒`;
}

function formatElapsed(milliseconds?: number) {
  if (milliseconds === undefined) return '-';
  return milliseconds < 1000 ? `${milliseconds} ms` : `${(milliseconds / 1000).toFixed(2)} s`;
}

onMounted(() => loadDiagnostics(false));
</script>

<template>
  <div class="operations-page diagnostics-health-page" :class="{ 'is-loading': loading }">
    <div class="page-head operations-page-header diagnostics-page-header">
      <div class="page-head-main">
        <h1 class="page-title">健康诊断</h1>
        <p>检测面板连接、路由配置、自动任务、支付配置和本机资源状态。</p>
      </div>
      <div class="page-actions">
        <el-button class="diagnostics-run-button" type="primary" :loading="loading" @click="loadDiagnostics(true)">
          <Activity v-if="!loading" :size="16" />
          立即诊断
        </el-button>
      </div>
    </div>

    <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

    <template v-if="diagnostics">
      <section class="diagnostics-health-score" :class="`is-${scoreTone}`">
        <div class="diagnostics-score-ring" :style="{ '--score': `${diagnostics.summary.score * 3.6}deg` }">
          <div class="diagnostics-score-center">
            <strong>{{ diagnostics.summary.score }}</strong>
            <span>分</span>
          </div>
        </div>
        <div class="diagnostics-score-copy">
          <div class="diagnostics-score-title">
            <h2>系统整体健康</h2>
            <span class="diagnostics-score-badge">{{ scoreLabel }}</span>
          </div>
          <p>{{ scoreDescription }}</p>
          <div class="diagnostics-score-meta">
            <span>诊断时间 <strong>{{ formatDate(diagnostics.checkedAt) }}</strong></span>
            <span>通过 <strong>{{ diagnostics.summary.passed }} / {{ diagnostics.summary.total }}</strong></span>
            <span>耗时 <strong>{{ formatElapsed(diagnostics.durationMs) }}</strong></span>
          </div>
        </div>
        <RefreshCw class="diagnostics-score-mark" :size="92" aria-hidden="true" />
      </section>

      <section>
        <div class="diagnostics-section-head">
          <div>
            <h2>核心检查</h2>
            <p>每张卡片均来自本次实时诊断，点击可查看完整详情。</p>
          </div>
          <span>{{ diagnostics.summary.total }} 项检查</span>
        </div>
        <div class="diagnostics-check-grid">
          <button
            v-for="check in diagnostics.checks"
            :key="check.key"
            type="button"
            class="diagnostics-check-card"
            :class="`is-${check.status}`"
            @click="openCheckDetail(check)"
          >
            <span class="diagnostics-check-top">
              <span class="diagnostics-check-icon"><component :is="checkIcon(check.key)" :size="19" /></span>
              <span class="diagnostics-status-icon"><component :is="statusIcon(check.status)" :size="16" /></span>
            </span>
            <strong class="diagnostics-check-name">{{ check.label }}</strong>
            <span class="diagnostics-check-message">{{ check.message }}</span>
            <span class="diagnostics-check-footer">
              <span>{{ check.meta?.[0]?.value || statusLabel(check.status) }}</span>
              <span class="diagnostics-check-latency">{{ formatElapsed(check.durationMs) }}</span>
            </span>
          </button>
        </div>
      </section>

      <section>
        <div class="diagnostics-section-head">
          <div>
            <h2>本机资源</h2>
            <p>由当前 API 服务所在主机实时采集。</p>
          </div>
          <span>{{ diagnostics.resources.runtime.nodeVersion }}</span>
        </div>
        <div class="diagnostics-resource-grid">
          <article v-for="resource in resourceCards" :key="resource.key" class="diagnostics-resource-card" :class="`tone-${resource.tone}`">
            <div class="diagnostics-resource-head">
              <span>{{ resource.label }}</span>
              <component :is="resource.icon" :size="18" />
            </div>
            <strong>{{ resource.value }}</strong>
            <div v-if="resource.percent !== null" class="diagnostics-progress-track">
              <span :style="{ width: `${Math.min(100, Math.max(0, resource.percent))}%` }"></span>
            </div>
            <div v-else class="diagnostics-runtime-line"><Timer :size="14" /> 持续运行中</div>
            <p>{{ resource.sub }}</p>
          </article>
        </div>
      </section>

      <section class="diagnostics-log-panel">
        <div class="diagnostics-section-head diagnostics-log-head">
          <div>
            <h2>最近异常同步</h2>
            <p>最近 10 条失败或部分成功记录，数据来自同步日志。</p>
          </div>
          <span>{{ diagnostics.recentFailures.length }} 条记录</span>
        </div>
        <el-table :data="diagnostics.recentFailures" v-loading="loading" row-key="id" style="width: 100%">
          <el-table-column label="时间" min-width="168">
            <template #default="{ row }: { row: SyncLog }"><span class="diagnostics-time-cell">{{ formatDate(row.createdAt) }}</span></template>
          </el-table-column>
          <el-table-column label="面板" min-width="145">
            <template #default="{ row }: { row: SyncLog }">{{ row.server?.name || '-' }}</template>
          </el-table-column>
          <el-table-column label="动作" min-width="190">
            <template #default="{ row }: { row: SyncLog }">{{ actionLabel(row.action) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="112">
            <template #default="{ row }: { row: SyncLog }"><el-tag :type="statusType(row.status)">{{ statusLabel(row.status) }}</el-tag></template>
          </el-table-column>
          <el-table-column prop="message" label="消息" min-width="250" show-overflow-tooltip />
          <el-table-column label="操作" width="96" fixed="right">
            <template #default="{ row }: { row: SyncLog }">
              <el-tooltip content="查看日志详情" placement="top">
                <el-button class="diagnostics-detail-button" size="small" @click="openLogDetail(row)"><Eye :size="14" />详情</el-button>
              </el-tooltip>
            </template>
          </el-table-column>
          <template #empty><el-empty description="最近没有异常同步记录" /></template>
        </el-table>
      </section>
    </template>

    <div v-else-if="loading || !initialized" class="diagnostics-loading-state">
      <Activity :size="24" />
      <strong>正在执行健康诊断</strong>
      <span>正在连接数据库、面板并采集系统资源。</span>
    </div>

    <el-dialog v-model="detailVisible" class="operations-dark-dialog diagnostics-detail-dialog" width="620px" append-to-body>
      <template #header>
        <div v-if="selectedCheck" class="diagnostics-dialog-title">
          <span class="diagnostics-check-icon" :class="`is-${selectedCheck.status}`"><component :is="checkIcon(selectedCheck.key)" :size="19" /></span>
          <div><strong>{{ selectedCheck.label }}</strong><span>{{ statusLabel(selectedCheck.status) }}</span></div>
        </div>
      </template>
      <template v-if="selectedCheck">
        <p class="diagnostics-dialog-message">{{ selectedCheck.message }}</p>
        <div class="diagnostics-detail-meta">
          <div><span>检查时间</span><strong>{{ formatDate(selectedCheck.checkedAt) }}</strong></div>
          <div><span>检查耗时</span><strong>{{ formatElapsed(selectedCheck.durationMs) }}</strong></div>
          <div v-for="item in selectedCheck.meta || []" :key="item.label"><span>{{ item.label }}</span><strong>{{ item.value }}</strong></div>
        </div>
        <div class="diagnostics-json-block">
          <span>原始详情</span>
          <pre class="json-preview">{{ formatDetail(selectedCheck.detail) }}</pre>
        </div>
      </template>
      <template #footer><el-button @click="detailVisible = false">关闭</el-button></template>
    </el-dialog>

    <el-dialog v-model="logVisible" class="operations-dark-dialog diagnostics-detail-dialog" title="同步日志详情" width="660px" append-to-body>
      <template v-if="selectedLog">
        <div class="diagnostics-detail-meta diagnostics-log-meta">
          <div><span>时间</span><strong>{{ formatDate(selectedLog.createdAt) }}</strong></div>
          <div><span>状态</span><strong>{{ statusLabel(selectedLog.status) }}</strong></div>
          <div><span>面板</span><strong>{{ selectedLog.server?.name || '-' }}</strong></div>
          <div><span>动作</span><strong>{{ actionLabel(selectedLog.action) }}</strong></div>
        </div>
        <div class="diagnostics-json-block">
          <span>消息</span>
          <p>{{ selectedLog.message || '没有附加消息' }}</p>
        </div>
        <div class="diagnostics-json-block">
          <span>原始详情</span>
          <pre class="json-preview">{{ formatDetail(selectedLog.detail) }}</pre>
        </div>
      </template>
      <template #footer><el-button @click="logVisible = false">关闭</el-button></template>
    </el-dialog>
  </div>
</template>
