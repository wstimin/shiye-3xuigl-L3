<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
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
};

const nodes = ref<SocksNode[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref('');
const editingId = ref('');
const dialogVisible = ref(false);
const form = reactive({ name: '', host: '', port: 1080, username: '', password: '', enabled: true, remark: '' });

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    nodes.value = await api<SocksNode[]>('/api/admin/socks-nodes');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载出站节点失败';
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
    error.value = err instanceof Error ? err.message : '保存出站节点失败';
  } finally {
    saving.value = false;
  }
}

function openDialog() {
  resetForm();
  dialogVisible.value = true;
}

function editNode(node: SocksNode) {
  editingId.value = node.id;
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

async function removeNode(node: SocksNode) {
  await ElMessageBox.confirm(`确认删除出站节点“${node.name}”？正在被路由节点使用时，后端会拒绝删除。`, '删除确认', { type: 'warning' });
  await api(`/api/admin/socks-nodes/${node.id}`, { method: 'DELETE' });
  ElMessage.success('出站节点已删除');
  await loadNodes();
}

function resetForm() {
  editingId.value = '';
  Object.assign(form, { name: '', host: '', port: 1080, username: '', password: '', enabled: true, remark: '' });
}

function cleanFormBody() {
  return {
    ...form,
    username: form.username.trim() || undefined,
    password: form.password || undefined,
    remark: form.remark.trim() || undefined
  };
}

onMounted(loadNodes);
</script>

<template>
  <h1 class="page-title">出站节点</h1>
  <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="page-alert" />

  <div class="panel list-panel">
    <div class="panel-toolbar">
      <strong>出站节点列表</strong>
      <div class="table-toolbar-actions">
        <el-button type="primary" @click="openDialog">添加出站节点</el-button>
        <el-button :loading="loading" @click="loadNodes">刷新</el-button>
      </div>
    </div>
    <el-table :data="nodes" v-loading="loading" style="width: 100%">
      <el-table-column prop="name" label="名称" min-width="140" />
      <el-table-column prop="host" label="地址" min-width="180" />
      <el-table-column prop="port" label="端口" width="90" />
      <el-table-column label="认证" width="130">
        <template #default="{ row }: { row: SocksNode }">
          <el-tag v-if="row.username || row.hasPassword" size="small" type="success">账号密码</el-tag>
          <el-tag v-else size="small" type="info">无认证</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="90">
        <template #default="{ row }: { row: SocksNode }"><el-tag :type="row.enabled ? 'success' : 'info'">{{ row.enabled ? '启用' : '停用' }}</el-tag></template>
      </el-table-column>
      <el-table-column prop="remark" label="备注" min-width="160" />
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }: { row: SocksNode }">
          <el-button size="small" @click="editNode(row)">编辑</el-button>
          <el-button size="small" type="danger" @click="removeNode(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>
  </div>

  <el-dialog v-model="dialogVisible" :title="editingId ? '编辑出站节点' : '添加出站节点'" width="720px" destroy-on-close>
    <el-form :model="form" label-width="92px" class="dialog-form-grid">
      <el-form-item label="名称"><el-input v-model="form.name" /></el-form-item>
      <el-form-item label="地址"><el-input v-model="form.host" placeholder="127.0.0.1 或域名" /></el-form-item>
      <el-form-item label="端口"><el-input-number v-model="form.port" :min="1" :max="65535" style="width: 100%" /></el-form-item>
      <el-form-item label="账号"><el-input v-model="form.username" /></el-form-item>
      <el-form-item label="密码"><el-input v-model="form.password" type="password" show-password placeholder="编辑时留空不修改" /></el-form-item>
      <el-form-item label="启用"><el-switch v-model="form.enabled" /></el-form-item>
      <el-form-item label="备注"><el-input v-model="form.remark" /></el-form-item>
    </el-form>
    <template #footer>
      <el-button @click="dialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="saving" :disabled="!form.name || !form.host || !form.port" @click="saveNode">保存</el-button>
    </template>
  </el-dialog>
</template>
