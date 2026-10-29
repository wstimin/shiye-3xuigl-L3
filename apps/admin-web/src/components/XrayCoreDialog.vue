<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElAlert, ElButton, ElDialog, ElMessage, ElMessageBox, ElOption, ElSelect } from 'element-plus';
import { api } from '../api';
const props = defineProps<{ server: { id: string; name: string } }>();
const emit = defineEmits<{ close: [] }>();
const busy = ref(false), loading = ref(false), error = ref(''), current = ref(''), version = ref('');
const versions = ref<string[]>([]);
async function load() {
  loading.value = true; error.value = '';
  try {
    const result = await api<{ status: { xray?: { version?: string; state?: string } }; versions: unknown[] }>(`/api/admin/xui-servers/${props.server.id}/status`);
    current.value = result.status.xray?.version || '未运行';
    versions.value = result.versions.map(item => typeof item === 'string' ? item : String((item as Record<string, unknown>)?.tag_name || (item as Record<string, unknown>)?.version || (item as Record<string, unknown>)?.name || '')).filter(value => /^v?\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*$/.test(value));
    version.value = versions.value.find(item => item.replace(/^v/, '') === current.value.replace(/^v/, '')) || '';
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { loading.value = false; }
}
async function install() {
  try { await ElMessageBox.confirm(`将「${props.server.name}」的 Xray 内核更换为 ${version.value}。期间代理连接会短暂中断，完成后会核对版本和运行状态。`, '确认更换内核', { type: 'warning', confirmButtonText: '确认更换', cancelButtonText: '取消' }); }
  catch { return; }
  busy.value = true; error.value = '';
  try {
    const result = await api<{ version: string; state: string; changed: boolean }>(`/api/admin/xui-servers/${props.server.id}/xray-version`, { method: 'POST', body: { version: version.value, confirmed: true }, timeoutMs: 180000 });
    current.value = result.version;
    ElMessage.success(result.changed ? `Xray ${result.version} 已运行` : '当前已运行该版本');
  } catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); }
  finally { busy.value = false; }
}
onMounted(load);
</script>
<template>
  <ElDialog :model-value="true" title="Xray 内核版本" width="min(540px, 94vw)" :close-on-click-modal="!busy" :close-on-press-escape="!busy" :show-close="!busy" @close="emit('close')">
    <p>{{ server.name }} · 当前版本：<strong>{{ current || '读取中…' }}</strong></p>
    <p class="muted-text">选择面板提供的版本。更换失败时系统会尝试恢复原版本，并明确报告恢复结果。</p>
    <ElAlert v-if="error" :title="error" type="error" show-icon :closable="false" />
    <label class="panel-field-label">目标内核版本</label>
    <ElSelect v-model="version" aria-label="目标内核版本" :loading="loading" :disabled="busy" filterable placeholder="选择 Xray 版本" style="width: 100%">
      <ElOption v-for="item in versions" :key="item" :label="item" :value="item" />
    </ElSelect>
    <template #footer><ElButton :disabled="busy" :loading="loading" @click="load">刷新版本</ElButton><ElButton :disabled="busy" @click="emit('close')">关闭</ElButton><ElButton type="primary" :loading="busy" :disabled="loading || !version" @click="install">更换内核</ElButton></template>
  </ElDialog>
</template>
