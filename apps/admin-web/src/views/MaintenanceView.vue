<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { Archive, ArrowUpCircle, CheckCircle2, Download, FileCheck2, RefreshCw, ShieldCheck, Upload, AlertCircle } from 'lucide-vue-next';
import { ElAlert, ElDialog, ElMessageBox } from 'element-plus';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/dialog/style/css';
import { api } from '../api';

type Job = { id: string; kind: 'update' | 'backup' | 'inspect' | 'restore'; state: string; progress: number; stage?: string; message: string; createdAt: string; recovery?: { state: string; message: string }; result?: { version?: string; createdAt?: string; bytes?: number; siteUrl?: string; inspectionId?: string; downloadReady?: boolean } };
type Status = { available: boolean; current: { version: string; commit: string; buildTime: string }; job: Job | null; queued: boolean; maxUploadBytes: number };
type Release = { checkId: string; version: string; hasUpdate: boolean; checkedAt: string; publishedAt: string; notes: string; releaseUrl: string };
const status = ref<Status>(), job = ref<Job | null>(null), release = ref<Release>(), error = ref('');
const checking = ref(false), starting = ref(false), uploading = ref(false), uploadPercent = ref(0), file = ref<File>(), inspection = ref<Job>();
const offlineSince = ref(0), reconnecting = ref(false), refreshing = ref(false);
const taskDialog = ref(false), dismissedTask = ref(''), dismissedFailure = ref(''), polledAt = ref(Date.now());
let timer: ReturnType<typeof setTimeout> | undefined, stopped = false, request: XMLHttpRequest | undefined;
const running = computed(() => job.value?.state === 'queued' || job.value?.state === 'running');
const busy = computed(() => starting.value || uploading.value || running.value || job.value?.recovery?.state === 'running');
const unavailable = computed(() => !status.value?.available);
const connectionUnknown = computed(() => offlineSince.value > 0 && polledAt.value - offlineSince.value > 120_000);
const taskTitle = computed(() => ({ update: '网站更新', backup: '生成迁移备份', inspect: '校验迁移备份', restore: '恢复网站' })[job.value?.kind || 'update']);
const percent = computed(() => Math.min(100, Math.max(0, job.value?.progress || 0)));
const formatTime = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';
const sizeLabel = (bytes?: number) => bytes ? bytes < 1024 ** 2 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB` : '—';
const message = (value: unknown) => value instanceof Error ? value.message : '操作失败，请稍后重试';

function arm(next: Job) {
  job.value = next; taskDialog.value = true;
  if (next.kind === 'update' || next.kind === 'restore') sessionStorage.setItem('shiye:maintenance-refresh', next.id);
  schedule(500);
}
function schedule(delay = 2000) { if (timer) clearTimeout(timer); if (!stopped) timer = setTimeout(poll, delay); }
async function poll() {
  if (stopped) return;
  polledAt.value = Date.now();
  try {
    // A restore changes signing keys. Handle that login transition without losing this view early.
    const response = await fetch('/api/admin/maintenance', { credentials: 'include', cache: 'no-store' });
    if (response.status === 401 && job.value?.kind === 'restore' && sessionStorage.getItem('shiye:maintenance-refresh') === job.value.id) {
      const health = await fetch('/api/health', { cache: 'no-store' });
      if (health.ok) { refreshing.value = true; sessionStorage.removeItem('shiye:maintenance-refresh'); window.location.reload(); return; }
    }
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw new Error(payload.message || '暂时无法读取维护状态');
    status.value = payload.data;
    offlineSince.value = 0; reconnecting.value = false;
    const current = status.value!.job;
    if (current) {
      job.value = current;
      if (['queued', 'running'].includes(current.state)) taskDialog.value = dismissedTask.value !== current.id;
      else taskDialog.value = false;
      if (current.kind === 'inspect' && current.state === 'succeeded') inspection.value = current;
      if (current.state === 'running' && ['update', 'restore'].includes(current.kind)) sessionStorage.setItem('shiye:maintenance-refresh', current.id);
      if (current.state === 'succeeded' && ['update', 'restore'].includes(current.kind) && sessionStorage.getItem('shiye:maintenance-refresh') === current.id) {
        refreshing.value = true; sessionStorage.removeItem('shiye:maintenance-refresh');
        timer = setTimeout(() => window.location.reload(), 300); return;
      }
      if (current.state === 'failed') sessionStorage.removeItem('shiye:maintenance-refresh');
    }
  } catch (cause) {
    if (busy.value || offlineSince.value) { if (!offlineSince.value) offlineSince.value = Date.now(); reconnecting.value = true; }
    else error.value = message(cause);
  }
  schedule(reconnecting.value ? 3000 : 2000);
}
async function check() {
  checking.value = true; error.value = ''; release.value = undefined;
  try { release.value = await api<Release>('/api/admin/maintenance/check', { method: 'POST', timeoutMs: 25000 }); }
  catch (cause) { error.value = message(cause); }
  finally { checking.value = false; }
}
async function update() {
  if (!release.value?.hasUpdate) return;
  try { await ElMessageBox.confirm(`将从 v${status.value?.current.version} 更新到 v${release.value.version}。更新前自动保留数据，切换版本时网站会短暂重启。`, '确认更新网站', { confirmButtonText: '开始更新', cancelButtonText: '取消', type: 'warning' }); } catch { return; }
  starting.value = true; error.value = '';
  try { arm(await api<Job>('/api/admin/maintenance/update', { method: 'POST', body: { checkId: release.value.checkId, confirmed: true } })); release.value = undefined; }
  catch (cause) { error.value = message(cause); }
  finally { starting.value = false; }
}
async function backup() {
  starting.value = true; error.value = '';
  try { arm(await api<Job>('/api/admin/maintenance/backups', { method: 'POST' })); }
  catch (cause) { error.value = message(cause); }
  finally { starting.value = false; }
}
function selectFile(event: Event) {
  const selected = (event.target as HTMLInputElement).files?.[0]; inspection.value = undefined; error.value = '';
  if (selected && (!selected.name.endsWith('.shiye') || selected.size > (status.value?.maxUploadBytes || 2 * 1024 ** 3))) { file.value = undefined; error.value = '请选择不超过 2 GB 的 .shiye 备份文件'; return; }
  file.value = selected;
}
async function upload() {
  if (!file.value) return;
  uploading.value = true; uploadPercent.value = 0; error.value = ''; inspection.value = undefined;
  try {
    const next = await new Promise<Job>((ok, fail) => {
      request = new XMLHttpRequest(); request.open('POST', '/api/admin/maintenance/uploads'); request.withCredentials = true; request.timeout = 15 * 60_000;
      request.setRequestHeader('Content-Type', 'application/octet-stream');
      request.upload.onprogress = event => { if (event.lengthComputable) uploadPercent.value = Math.round(event.loaded / event.total * 100); };
      request.onload = () => { try { const result = JSON.parse(request!.responseText); if (request!.status >= 200 && request!.status < 300 && result.ok) ok(result.data); else fail(new Error(result.message || '上传失败')); } catch { fail(new Error('上传响应无效')); } };
      request.onerror = () => fail(new Error('连接中断，请重新上传')); request.ontimeout = () => fail(new Error('上传超时，请重试')); request.onabort = () => fail(new Error('上传已取消'));
      request.send(file.value!);
    });
    arm(next);
  } catch (cause) { error.value = message(cause); }
  finally { uploading.value = false; request = undefined; }
}
async function restore() {
  if (!inspection.value) return;
  try { await ElMessageBox.confirm('恢复会覆盖本站用户、余额、账单和面板连接。本站会先自动备份；服务器地址保持当前配置，管理账号改为备份时的账号。请确认旧站已停用，避免两套系统同时管理面板。', '确认恢复网站', { confirmButtonText: '确认恢复', cancelButtonText: '取消', type: 'warning' }); } catch { return; }
  starting.value = true; error.value = '';
  try { arm(await api<Job>('/api/admin/maintenance/restore', { method: 'POST', body: { inspectionId: inspection.value.id, confirmed: true } })); }
  catch (cause) { error.value = message(cause); }
  finally { starting.value = false; }
}
onMounted(poll);
onUnmounted(() => { stopped = true; if (timer) clearTimeout(timer); request?.abort(); });
</script>

<template>
  <div class="operations-page maintenance-page">
    <header class="page-head"><div><div class="eyebrow">SYSTEM MAINTENANCE</div><h1>更新与迁移</h1><p>检测版本后手动更新，或将网站完整数据迁移到新服务器。</p></div><span class="maintenance-version"><ShieldCheck :size="16" />当前 v{{ status?.current.version || '读取中' }}</span></header>
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
    <el-alert v-if="status && unavailable" title="此部署尚未启用维护服务，需要使用新版安装程序升级一次。" type="warning" :closable="false" show-icon />

    <el-button v-if="running && !taskDialog" @click="dismissedTask = ''; taskDialog = true">查看{{ taskTitle }}进度</el-button>
    <el-dialog v-model="taskDialog" :title="taskTitle" width="min(520px, calc(100vw - 32px))" align-center append-to-body :close-on-click-modal="false" @close="dismissedTask = job?.id || ''" class="maintenance-dialog">
      <div v-if="job" aria-live="polite">
      <template v-if="running && !connectionUnknown">
        <div class="maintenance-progress-copy"><strong>{{ refreshing ? '操作完成，正在自动刷新页面…' : job.message }}</strong><span>{{ percent }}%</span></div>
        <div class="maintenance-progress" role="progressbar" :aria-label="taskTitle" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: percent + '%' }"></span></div>
        <p v-if="reconnecting" class="maintenance-note">服务正在重启，连接恢复后会自动继续显示结果。</p>
      </template>
      <div v-else-if="connectionUnknown" class="maintenance-failure" role="alert"><AlertCircle :size="19" /><div><strong>连接尚未恢复，已停止显示进度</strong><p>页面会继续尝试连接，也可稍后刷新查看。</p></div></div>
      <p class="maintenance-note">任务在服务器继续执行，切换页面不会中断。完成后弹窗自动关闭；更新或恢复成功后自动刷新网页。</p>
      </div>
    </el-dialog>
    <div v-if="job?.state === 'failed' && (dismissedFailure !== job.id || job.recovery?.state === 'running')" class="maintenance-failure" role="alert"><AlertCircle :size="19" /><div><strong>{{ taskTitle }}未完成：{{ job.message }}</strong><p v-if="job.recovery">{{ job.recovery.message }}</p></div><el-button v-if="job.recovery?.state !== 'running'" text @click="dismissedFailure = job.id">关闭</el-button></div>

    <section class="panel maintenance-update">
      <header class="panel-toolbar"><div class="maintenance-section-title"><ArrowUpCircle :size="22" /><div><h2>网站版本更新</h2><p>先检测，再由你决定是否更新。</p></div></div><el-button :loading="checking" :disabled="busy || unavailable" @click="check"><RefreshCw :size="15" />检测最新版</el-button></header>
      <div class="maintenance-version-grid"><div><span>当前版本</span><strong>v{{ status?.current.version || '—' }}</strong><small>{{ status?.current.commit?.slice(0, 12) }}</small></div><div><span>最新稳定版本</span><strong>{{ release ? 'v' + release.version : '等待检测' }}</strong><small>{{ release ? release.hasUpdate ? '有可用更新' : '当前已是最新版' : '不会自动下载或更新' }}</small></div></div>
      <div v-if="release" class="maintenance-release"><div><span>检测于 {{ formatTime(release.checkedAt) }}</span><a :href="release.releaseUrl" target="_blank" rel="noreferrer">查看版本说明 ↗</a></div><details v-if="release.notes"><summary>更新说明</summary><p>{{ release.notes }}</p></details><el-button v-if="release.hasUpdate" type="primary" :disabled="busy" @click="update"><ArrowUpCircle :size="16" />更新到 v{{ release.version }}</el-button></div>
      <p class="maintenance-note">更新前保留数据与配置，校验发布包后再切换；健康检查通过后自动刷新。失败与回滚单独显示。</p>
    </section>

    <div class="maintenance-migration-grid">
      <section class="panel"><header class="maintenance-section-title"><Archive :size="22" /><div><h2>下载网站备份</h2><p>一个备份包，保留完整业务数据。</p></div></header><ul class="maintenance-includes"><li>用户、余额、账单和卡密记录</li><li>3x-ui、S-UI 连接及路由关联</li><li>站点设置、管理员账号和解密密钥</li></ul><el-button type="primary" :disabled="busy || unavailable" @click="backup"><Download :size="16" />生成迁移备份</el-button><a v-if="job?.kind === 'backup' && job.state === 'succeeded'" class="hub-button primary maintenance-download" :href="`/api/admin/maintenance/backups/${job.id}/download`"><Download :size="16" />下载备份 · {{ sizeLabel(job.result?.bytes) }}</a><p class="maintenance-note">备份包含账号和密钥，请妥善保存。服务器保留 7 天，请及时下载。生成时短暂暂停业务写入，完成后自动恢复。</p></section>
      <section class="panel"><header class="maintenance-section-title"><Upload :size="22" /><div><h2>上传备份并恢复</h2><p>在新服务器安装本系统后，上传备份即可恢复。</p></div></header><ol class="maintenance-steps"><li>选择旧站下载的 .shiye 文件。</li><li>上传并校验版本与完整性。</li><li>停用旧站，再确认恢复；完成后重新登录。</li></ol><label class="maintenance-file"><Upload :size="18" /><span>{{ file ? file.name + ' · ' + sizeLabel(file.size) : '选择迁移备份（最大 2 GB）' }}</span><input type="file" accept=".shiye" :disabled="busy || unavailable" aria-label="选择迁移备份" @change="selectFile" /></label><el-button :disabled="!file || busy || unavailable" :loading="uploading" @click="upload"><FileCheck2 :size="16" />上传并校验</el-button>
        <div v-if="uploading" class="maintenance-upload"><span>上传 {{ uploadPercent }}%</span><div class="maintenance-progress" role="progressbar" aria-label="上传备份" :aria-valuenow="uploadPercent" aria-valuemin="0" aria-valuemax="100"><span :style="{ width: uploadPercent + '%' }"></span></div></div>
        <div v-if="inspection" class="maintenance-inspection"><strong><CheckCircle2 :size="16" />备份校验通过</strong><dl><div><dt>备份版本</dt><dd>v{{ inspection.result?.version }}</dd></div><div><dt>生成时间</dt><dd>{{ formatTime(inspection.result?.createdAt) }}</dd></div><div><dt>原站地址</dt><dd>{{ inspection.result?.siteUrl || '未记录' }}</dd></div></dl><el-button type="danger" plain :disabled="busy" @click="restore">确认恢复网站</el-button></div>
        <p class="maintenance-note">保留新服务器地址与数据库连接，自动恢复站点密钥。恢复失败时独立还原本站原数据，不改动远端面板配置。</p>
      </section>
    </div>
  </div>
</template>
