<script setup lang="ts">
import { ref } from 'vue';
import { ElButton, ElDialog, ElMessage, ElMessageBox, ElTable, ElTableColumn, ElTag } from 'element-plus';
import { api } from '../api';
import { notifyError } from '../notify';

type Receipt = { id: string; code: string; status: string; amount: string | null; lastError: string | null; createdAt: string; customer?: { name: string; loginUsername: string } };
const open = ref(false), loading = ref(false), resolving = ref('');
const items = ref<Receipt[]>([]);
const labels: Record<string, string> = { processing: '待核实', uncertain: '待核实', activated: '待入账', completed: '已到账', failed: '核销失败' };
async function load() {
  loading.value = true;
  try { items.value = await api<Receipt[]>('/api/admin/external-card-redemptions'); }
  catch (error) { notifyError(error, '读取兑换记录失败'); }
  finally { loading.value = false; }
}
async function show() { open.value = true; await load(); }
async function resolve(row: Receipt) {
  let amount = Number(row.amount || 0);
  try {
    if (row.status === 'activated') {
      await ElMessageBox.confirm(`确认将已核销的 ${amount.toFixed(2)} 元补入 ${row.customer?.loginUsername || '该用户'} 的余额？`, '重试入账');
    } else {
      const result = await ElMessageBox.prompt('请先在卡密平台核实这张卡已由本项目核销，再输入确认的面额。系统会记录本次人工补账。', '核实并补入余额', { inputType: 'number', inputValidator: value => /^\d+(\.\d{1,2})?$/.test(value) && Number(value) > 0 && Number(value) <= 99999999.99 || '请输入有效金额，最多两位小数' });
      amount = Number(result.value);
    }
  } catch { return; }
  resolving.value = row.id;
  try {
    await api(`/api/admin/external-card-redemptions/${row.id}/resolve`, { method: 'POST', body: { amount } });
    ElMessage.success('已补入余额'); await load();
  } catch (error) { notifyError(error, '补入余额失败，记录已保留'); }
  finally { resolving.value = ''; }
}
</script>

<template>
  <div class="panel-toolbar">
    <div><strong>外部卡密兑换</strong><p class="muted-text">核销与到账分开记录，异常兑换可核实后补账。</p></div>
    <el-button @click="show">查看兑换与补账记录</el-button>
  </div>
  <el-dialog v-model="open" title="外部卡密兑换记录" width="1000px" class="operations-dialog" destroy-on-close>
    <el-button :loading="loading" @click="load">刷新记录</el-button>
    <el-table :data="items" style="width: 100%" empty-text="暂无外部卡密兑换记录">
      <el-table-column label="用户" width="140"><template #default="{ row }">{{ row.customer?.name }}<small class="muted-text"> {{ row.customer?.loginUsername }}</small></template></el-table-column>
      <el-table-column prop="code" label="卡密" min-width="180" />
      <el-table-column label="面额" width="90"><template #default="{ row }">{{ row.amount ? `${row.amount} 元` : '待核实' }}</template></el-table-column>
      <el-table-column label="状态" width="100"><template #default="{ row }"><el-tag :type="row.status === 'completed' ? 'success' : 'warning'">{{ labels[row.status] || row.status }}</el-tag></template></el-table-column>
      <el-table-column prop="lastError" label="处理说明" min-width="200" />
      <el-table-column label="操作" width="150"><template #default="{ row }"><el-button v-if="['processing', 'uncertain', 'activated'].includes(row.status)" :loading="resolving === row.id" :disabled="Boolean(resolving)" @click="resolve(row as Receipt)">{{ row.status === 'activated' ? '重试入账' : '核实后补账' }}</el-button><span v-else>—</span></template></el-table-column>
    </el-table>
  </el-dialog>
</template>
