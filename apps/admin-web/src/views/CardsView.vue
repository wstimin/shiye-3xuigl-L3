<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/dialog/style/css';
import 'element-plus/es/components/empty/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/input/style/css';
import 'element-plus/es/components/input-number/style/css';
import 'element-plus/es/components/option/style/css';
import 'element-plus/es/components/pagination/style/css';
import 'element-plus/es/components/segmented/style/css';
import 'element-plus/es/components/select/style/css';
import 'element-plus/es/components/switch/style/css';
import 'element-plus/es/components/table/style/css';
import 'element-plus/es/components/table-column/style/css';
import 'element-plus/es/components/tag/style/css';
import { ElAlert, ElButton, ElDialog, ElEmpty, ElForm, ElFormItem, ElInput, ElInputNumber, ElMessage, ElMessageBox, ElOption, ElPagination, ElSegmented, ElSelect, ElSwitch, ElTable as ElTableComponent, ElTableColumn as ElTableColumnComponent, ElTag } from 'element-plus';
const ElTable = ElTableComponent as any;
const ElTableColumn = ElTableColumnComponent as any;
import { Copy, CreditCard, Download, Edit3, Layers, LayoutTemplate, Plus, RefreshCw, RotateCcw, Search, TicketCheck, TicketX, Trash2 } from 'lucide-vue-next';
import { api } from '../api';

type CardTemplate = { id: string; name: string; amount: string; quantity: number; prefix?: string | null; enabled: boolean; remark?: string | null };
type BatchCard = { id: string; code: string | null; codePreview: string; amount: string; status: string; usedAt?: string | null; createdAt: string; usedBy?: { name: string; loginUsername: string } | null };
type CardBatch = { id: string; name: string; amount: string; quantity: number; prefix?: string | null; templateId?: string | null; createdAt: string; template?: CardTemplate | null; cards?: BatchCard[]; _count?: { cards: number } };
type Card = { id: string; codePreview: string; amount: string; status: string; usedAt?: string | null; createdAt: string; batch?: { id: string; name: string } | null; usedBy?: { name: string; loginUsername: string } | null };
type CardStatus = '' | 'unused' | 'used' | 'disabled';
type CardResult = {
  items: Card[];
  batches: CardBatch[];
  templates: CardTemplate[];
  page: number;
  pageSize: number;
  total: number;
  statusCounts: { all: number; unused: number; used: number; disabled: number };
};
type TemplateGroup = { id: string; template: CardTemplate | null; name: string; amount: string; quantity: number | string; enabled: boolean; batches: CardBatch[] };

const loading = ref(false);
const generating = ref(false);
const savingTemplate = ref(false);
const clearingUsed = ref(false);
const error = ref('');
const cards = ref<Card[]>([]);
const batches = ref<CardBatch[]>([]);
const templates = ref<CardTemplate[]>([]);
const cardTotal = ref(0);
const statusCounts = reactive({ all: 0, unused: 0, used: 0, disabled: 0 });
const cardFilters = reactive<{ keyword: string; status: CardStatus }>({ keyword: '', status: '' });
const cardPage = reactive({ page: 1, pageSize: 20 });
const editingTemplateId = ref('');
const deletingUnusedTemplateIds = ref<Set<string>>(new Set());
const clearingUsedBatchIds = ref<Set<string>>(new Set());
const templateManagementVisible = ref(false);
const batchManagementVisible = ref(false);
const templateDialogVisible = ref(false);
const generateDialogVisible = ref(false);
const generatedCodes = ref<string[]>([]);
const generatedBatchName = ref('');
const generateForm = reactive({ templateId: '', name: defaultBatchName(), amount: 10, quantity: 10, prefix: '' });
const templateForm = reactive({ name: '', amount: 10, quantity: 10, prefix: '', enabled: true, remark: '' });

const templateCount = computed(() => templates.value.length);
const batchCount = computed(() => batches.value.length);
const unusedCardCount = computed(() => statusCounts.unused);
const usedCardCount = computed(() => statusCounts.used);
const enabledTemplates = computed(() => templates.value.filter((template) => template.enabled));
const selectedTemplate = computed(() => templates.value.find((item) => item.id === generateForm.templateId));
const generatedCodesText = computed(() => generatedCodes.value.join('\n'));
const templateGroups = computed<TemplateGroup[]>(() => {
  const groups: TemplateGroup[] = templates.value.map((template) => ({
    id: template.id,
    template,
    name: template.name,
    amount: template.amount,
    quantity: template.quantity,
    enabled: template.enabled,
    batches: batches.value.filter((batch) => batch.templateId === template.id)
  }));
  const customBatches = batches.value.filter((batch) => !batch.templateId);
  if (customBatches.length) {
    groups.push({ id: '__custom__', template: null, name: '未归属模板', amount: '-', quantity: '-', enabled: true, batches: customBatches });
  }
  return groups;
});

async function loadCards(resetPage = false) {
  if (resetPage) cardPage.page = 1;
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({ page: String(cardPage.page), pageSize: String(cardPage.pageSize) });
    if (cardFilters.keyword.trim()) params.set('keyword', cardFilters.keyword.trim());
    if (cardFilters.status) params.set('status', cardFilters.status);
    const result = await api<CardResult>(`/api/admin/cards?${params.toString()}`);
    cards.value = result.items;
    batches.value = result.batches;
    templates.value = result.templates;
    cardPage.page = result.page;
    cardPage.pageSize = result.pageSize;
    cardTotal.value = result.total;
    Object.assign(statusCounts, result.statusCounts);
  } catch {
    error.value = '加载失败';
  } finally {
    loading.value = false;
  }
}

function resetCardFilters() {
  Object.assign(cardFilters, { keyword: '', status: '' });
  void loadCards(true);
}

function handleCardPageChange(page: number) {
  cardPage.page = page;
  void loadCards();
}

function handleCardPageSizeChange(pageSize: number) {
  cardPage.pageSize = pageSize;
  void loadCards(true);
}

async function saveTemplate() {
  savingTemplate.value = true;
  error.value = '';
  try {
    const path = editingTemplateId.value ? `/api/admin/card-templates/${editingTemplateId.value}` : '/api/admin/card-templates';
    await api(path, { method: editingTemplateId.value ? 'PATCH' : 'POST', body: templateForm });
    ElMessage.success(editingTemplateId.value ? '模板已更新' : '模板已新增');
    templateDialogVisible.value = false;
    resetTemplateForm();
    await loadCards();
  } catch {
    error.value = '保存失败';
    ElMessage.error(error.value);
  } finally {
    savingTemplate.value = false;
  }
}

async function generateCards() {
  generating.value = true;
  error.value = '';
  try {
    const template = selectedTemplate.value;
    const body = template
      ? { templateId: template.id, name: generateForm.name || defaultBatchName(template.name), amount: Number(template.amount), quantity: template.quantity, prefix: template.prefix || '' }
      : { ...generateForm, templateId: undefined };
    const result = await api<{ batchId: string; generated: number; codes: string[] }>('/api/admin/cards/generate', { method: 'POST', body });
    generatedCodes.value = result.codes;
    generatedBatchName.value = body.name;
    ElMessage.success('生成成功');
    resetGenerateForm(template?.id || '');
    await loadCards();
  } catch {
    error.value = '生成失败';
    ElMessage.error(error.value);
  } finally {
    generating.value = false;
  }
}

function openTemplateDialog() {
  resetTemplateForm();
  templateDialogVisible.value = true;
}

function openGenerateDialog(template?: CardTemplate) {
  generatedCodes.value = [];
  generatedBatchName.value = '';
  resetGenerateForm();
  if (template) useTemplate(template);
  generateDialogVisible.value = true;
}

function useTemplate(template: CardTemplate) {
  generateForm.templateId = template.id;
  generateForm.name = defaultBatchName(template.name);
  generateForm.amount = Number(template.amount);
  generateForm.quantity = template.quantity;
  generateForm.prefix = template.prefix || '';
}

function onTemplateChange(templateId: string) {
  const template = templates.value.find((item) => item.id === templateId);
  if (template) useTemplate(template);
}

function editTemplate(template: CardTemplate) {
  editingTemplateId.value = template.id;
  Object.assign(templateForm, { name: template.name, amount: Number(template.amount), quantity: template.quantity, prefix: template.prefix || '', enabled: template.enabled, remark: template.remark || '' });
  templateDialogVisible.value = true;
}

async function removeTemplate(template: CardTemplate) {
  await ElMessageBox.confirm(`确认删除模板「${template.name}」？已经生成的批次和卡密会保留。`, '删除确认', { type: 'warning', customClass: 'operations-dark-message-box' });
  await api(`/api/admin/card-templates/${template.id}`, { method: 'DELETE' });
  ElMessage.success('模板已删除');
  if (editingTemplateId.value === template.id) resetTemplateForm();
  if (generateForm.templateId === template.id) clearTemplateSelection();
  await loadCards();
}

async function removeUnusedTemplateCards(template: CardTemplate) {
  await ElMessageBox.confirm(`确认删除模板「${template.name}」下所有未使用卡密？已使用卡密和兑换记录会保留。`, '删除未使用卡密', { type: 'warning', customClass: 'operations-dark-message-box' });
  deletingUnusedTemplateIds.value = new Set(deletingUnusedTemplateIds.value).add(template.id);
  error.value = '';
  try {
    await api(`/api/admin/card-templates/${template.id}/unused-cards`, { method: 'DELETE' });
    ElMessage.success('删除成功');
    await loadCards();
  } catch {
    error.value = '删除失败';
    ElMessage.error(error.value);
  } finally {
    const next = new Set(deletingUnusedTemplateIds.value);
    next.delete(template.id);
    deletingUnusedTemplateIds.value = next;
  }
}

async function removeBatch(batch: CardBatch) {
  await ElMessageBox.confirm(`确认删除批次「${batch.name}」及其未使用卡密？如果批次内已有使用记录，系统会拒绝删除。`, '删除确认', { type: 'warning', customClass: 'operations-dark-message-box' });
  await api(`/api/admin/card-batches/${batch.id}`, { method: 'DELETE' });
  ElMessage.success('批次已删除');
  await loadCards();
}

async function removeCard(card: Card) {
  await ElMessageBox.confirm(`确认删除卡密 ${card.codePreview}？已使用卡密不能删除。`, '删除确认', { type: 'warning', customClass: 'operations-dark-message-box' });
  await api(`/api/admin/cards/${card.id}`, { method: 'DELETE' });
  ElMessage.success('卡密已删除');
  await loadCards();
}

async function removeUsedCards() {
  await ElMessageBox.confirm('确认清除所有已使用卡密记录？用户余额不会回退，余额流水会保留。', '清除已使用记录', { type: 'warning', customClass: 'operations-dark-message-box' });
  clearingUsed.value = true;
  error.value = '';
  try {
    await api('/api/admin/cards/used/history', { method: 'DELETE' });
    ElMessage.success('清除成功');
    await loadCards();
  } catch {
    error.value = '清除失败';
    ElMessage.error(error.value);
  } finally {
    clearingUsed.value = false;
  }
}

async function removeUsedBatchCards(batch: CardBatch) {
  await ElMessageBox.confirm(`确认清除批次「${batch.name}」里的已使用卡密记录？用户余额不会回退，余额流水会保留。`, '清除批次已使用记录', { type: 'warning', customClass: 'operations-dark-message-box' });
  clearingUsedBatchIds.value = new Set(clearingUsedBatchIds.value).add(batch.id);
  error.value = '';
  try {
    await api(`/api/admin/card-batches/${batch.id}/used-cards`, { method: 'DELETE' });
    ElMessage.success('清除成功');
    await loadCards();
  } catch {
    error.value = '清除失败';
    ElMessage.error(error.value);
  } finally {
    const next = new Set(clearingUsedBatchIds.value);
    next.delete(batch.id);
    clearingUsedBatchIds.value = next;
  }
}

async function copyCodes(codes: string[], message = '复制成功') {
  try {
    await copyText(codes.join('\n'));
    ElMessage.success(message);
  } catch {
    ElMessage.error('复制失败');
  }
}

function exportCodes(codes: string[], filename: string) {
  if (!codes.length) {
    ElMessage.warning('没有可导出的卡密');
    return;
  }
  downloadText(`${safeFileName(filename)}.txt`, codes.join('\n'));
  ElMessage.success('导出成功');
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function safeFileName(value: string) {
  return value.trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-').slice(0, 80) || 'card-codes';
}

async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('复制失败');
}

function resetTemplateForm() {
  editingTemplateId.value = '';
  Object.assign(templateForm, { name: '', amount: 10, quantity: 10, prefix: '', enabled: true, remark: '' });
}

function resetGenerateForm(templateId = '') {
  Object.assign(generateForm, { templateId: '', name: defaultBatchName(), amount: 10, quantity: 10, prefix: '' });
  if (templateId) {
    const template = templates.value.find((item) => item.id === templateId);
    if (template) useTemplate(template);
  }
}

function clearTemplateSelection() {
  resetGenerateForm();
}

function fullCodes(batch: CardBatch) {
  return (batch.cards || []).map((card) => card.code).filter((code): code is string => Boolean(code));
}

function unusedFullCodes(batch: CardBatch) {
  return (batch.cards || []).filter((card) => card.status === 'unused').map((card) => card.code).filter((code): code is string => Boolean(code));
}

function fullCodesForGroup(group: TemplateGroup) {
  return group.batches.flatMap((batch) => fullCodes(batch));
}

function unusedFullCodesForGroup(group: TemplateGroup) {
  return group.batches.flatMap((batch) => unusedFullCodes(batch));
}

function cardsForGroup(group: TemplateGroup) {
  return group.batches.flatMap((batch) => batch.cards || []);
}

function totalCountForGroup(group: TemplateGroup) {
  return cardsForGroup(group).length;
}

function unusedCountForGroup(group: TemplateGroup) {
  return cardsForGroup(group).filter((card) => card.status === 'unused').length;
}

function usedCountForGroup(group: TemplateGroup) {
  return cardsForGroup(group).filter((card) => card.status === 'used').length;
}

function unusedCount(batch: CardBatch) {
  return (batch.cards || []).filter((card) => card.status === 'unused').length;
}

function usedCount(batch: CardBatch) {
  return (batch.cards || []).filter((card) => card.status === 'used').length;
}

function hasFullCodes(batch: CardBatch) {
  return fullCodes(batch).length > 0;
}

function hasUnusedFullCodes(batch: CardBatch) {
  return unusedFullCodes(batch).length > 0;
}

function defaultBatchName(templateName = '卡密批次') {
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
  return `${templateName}-${stamp}`;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function statusLabel(status: string) {
  if (status === 'unused') return '未使用';
  if (status === 'used') return '已使用';
  if (status === 'disabled') return '已禁用';
  return status;
}

onMounted(loadCards);
</script>

<template>
  <div class="operations-page cards-page" :class="{ loading }">
  <div class="page-head operations-page-header">
    <div class="page-head-main">
      <h1 class="page-title">卡密管理</h1>
      <p>按模板归档卡密批次，新生成的卡密会保留在对应批次里，刷新后仍可继续复制未使用卡密。</p>
    </div>
    <div class="page-actions">
      <el-button type="primary" @click="templateManagementVisible = true"><LayoutTemplate :size="16" />模板管理</el-button>
      <el-button @click="batchManagementVisible = true"><Layers :size="16" />批次管理</el-button>
      <el-button @click="openGenerateDialog()"><CreditCard :size="16" />生成卡密</el-button>
      <el-button :loading="loading" @click="loadCards()"><RefreshCw :size="16" />刷新</el-button>
    </div>
  </div>
  <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon :closable="false" />

  <div class="metric-grid compact-metrics operations-stat-grid">
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-indigo"><LayoutTemplate :size="19" /></span><div><span>模板</span><strong>{{ templateCount }}</strong><small>可按模板继续追加批次</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-cyan"><Layers :size="19" /></span><div><span>批次</span><strong>{{ batchCount }}</strong><small>同模板批次集中展示</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-emerald"><TicketCheck :size="19" /></span><div><span>未使用卡密</span><strong>{{ unusedCardCount }}</strong><small>可一键复制或清理</small></div></div>
    <div class="metric operations-stat-card"><span class="operations-stat-icon tone-amber"><TicketX :size="19" /></span><div><span>已使用记录</span><strong>{{ usedCardCount }}</strong><small>可按批次或全局清除</small></div></div>
  </div>

  <div class="panel list-panel operations-content-card cards-business-card">
    <div class="panel-toolbar">
      <strong>卡密列表</strong>
      <el-segmented
        v-model="cardFilters.status"
        class="card-status-segmented"
        :options="[
          { label: `全部 ${statusCounts.all}`, value: '' },
          { label: `未使用 ${statusCounts.unused}`, value: 'unused' },
          { label: `已使用 ${statusCounts.used}`, value: 'used' },
          { label: `已禁用 ${statusCounts.disabled}`, value: 'disabled' }
        ]"
        @change="loadCards(true)"
      />
    </div>
    <div class="filter-bar card-filter-bar">
      <el-input v-model="cardFilters.keyword" clearable placeholder="搜索卡密、批次、模板或用户" @keyup.enter="loadCards(true)" @clear="loadCards(true)">
        <template #prefix><Search :size="15" /></template>
      </el-input>
      <el-button @click="resetCardFilters"><RotateCcw :size="15" />重置</el-button>
      <el-button type="primary" :loading="loading" @click="loadCards(true)"><Search :size="15" />查询</el-button>
      <div class="card-filter-actions">
        <span class="muted-text">{{ cardTotal }} 条记录</span>
        <el-button size="small" type="danger" plain :loading="clearingUsed" @click="removeUsedCards"><Trash2 :size="15" />清除已使用记录</el-button>
      </div>
    </div>
    <el-table :data="cards" v-loading="loading" style="width: 100%">
      <el-table-column prop="codePreview" label="卡密" width="140" />
      <el-table-column prop="amount" label="金额" width="120" />
      <el-table-column label="状态" width="100"><template #default="{ row }: { row: Card }"><el-tag :type="row.status === 'unused' ? 'success' : row.status === 'used' ? 'warning' : 'info'">{{ statusLabel(row.status) }}</el-tag></template></el-table-column>
      <el-table-column label="批次" min-width="140"><template #default="{ row }: { row: Card }">{{ row.batch?.name || '-' }}</template></el-table-column>
      <el-table-column label="使用用户" min-width="160"><template #default="{ row }: { row: Card }">{{ row.usedBy?.name || '-' }}</template></el-table-column>
      <el-table-column label="创建时间" min-width="180"><template #default="{ row }: { row: Card }">{{ formatDate(row.createdAt) }}</template></el-table-column>
      <el-table-column label="使用时间" min-width="180"><template #default="{ row }: { row: Card }">{{ formatDate(row.usedAt) }}</template></el-table-column>
      <el-table-column label="操作" width="90" fixed="right"><template #default="{ row }: { row: Card }"><el-button size="small" type="danger" :disabled="row.status === 'used'" @click="removeCard(row)">删除</el-button></template></el-table-column>
      <template #empty><el-empty description="暂无卡密记录" /></template>
    </el-table>
    <div class="pagination-bar card-pagination-bar">
      <el-pagination
        background
        layout="total, sizes, prev, pager, next, jumper"
        :total="cardTotal"
        :current-page="cardPage.page"
        :page-size="cardPage.pageSize"
        :page-sizes="[10, 20, 50, 100, 200]"
        @current-change="handleCardPageChange"
        @size-change="handleCardPageSizeChange"
      />
    </div>
  </div>

  <el-dialog v-model="templateManagementVisible" title="卡密模板管理" width="min(980px, 94vw)" class="operations-dark-dialog card-management-dialog" destroy-on-close>
    <div class="management-dialog-toolbar">
      <span class="muted-text">共 {{ templates.length }} 个模板</span>
      <el-button type="primary" @click="openTemplateDialog"><Plus :size="15" />新增模板</el-button>
    </div>
    <div v-loading="loading" class="entity-card-grid template-card-grid">
      <section v-for="template in templates" :key="template.id" class="entity-card template-card">
        <div class="entity-card-head">
          <div>
            <strong>{{ template.name }}</strong>
            <span>{{ template.remark || '暂无备注' }}</span>
          </div>
          <el-tag :type="template.enabled ? 'success' : 'info'">{{ template.enabled ? '启用' : '停用' }}</el-tag>
        </div>
        <div class="entity-card-stats">
          <div><span>金额</span><strong>{{ template.amount }}</strong></div>
          <div><span>数量</span><strong>{{ template.quantity }}</strong></div>
          <div><span>前缀</span><strong>{{ template.prefix || '-' }}</strong></div>
        </div>
        <div class="entity-card-actions">
          <el-button size="small" type="primary" plain @click="openGenerateDialog(template)"><Plus :size="14" />生成</el-button>
          <el-button size="small" @click="editTemplate(template)"><Edit3 :size="14" />编辑</el-button>
          <el-button size="small" :loading="deletingUnusedTemplateIds.has(template.id)" @click="removeUnusedTemplateCards(template)"><Trash2 :size="14" />删除未使用</el-button>
          <el-button size="small" type="danger" plain @click="removeTemplate(template)">删除模板</el-button>
        </div>
      </section>
      <div v-if="!templates.length && !loading" class="empty-panel entity-empty">暂无卡密模板</div>
    </div>
  </el-dialog>

  <el-dialog v-model="batchManagementVisible" title="卡密批次管理" width="min(1120px, 96vw)" class="operations-dark-dialog card-management-dialog card-batch-dialog" destroy-on-close>
    <div class="management-dialog-toolbar">
      <span class="muted-text">共 {{ batches.length }} 个批次</span>
      <el-button type="primary" @click="openGenerateDialog()"><Plus :size="15" />生成卡密</el-button>
    </div>
    <div v-if="templateGroups.length" class="generated-template-grid">
      <section v-for="group in templateGroups" :key="group.id" class="generated-template-card">
        <div class="generated-template-head">
          <div>
            <strong>{{ group.name }}</strong>
            <span>{{ group.amount }} 元 / 默认 {{ group.quantity }} 张 / {{ group.batches.length }} 个批次</span>
          </div>
          <div class="table-toolbar-actions">
            <el-button v-if="group.template" size="small" type="primary" plain @click="openGenerateDialog(group.template)"><Plus :size="14" />继续生成</el-button>
            <el-button size="small" type="success" plain :disabled="!unusedFullCodesForGroup(group).length" @click="copyCodes(unusedFullCodesForGroup(group), `已复制 ${group.name} 未使用卡密`)"><Copy :size="14" />复制未使用</el-button>
            <el-button size="small" plain :disabled="!fullCodesForGroup(group).length" @click="copyCodes(fullCodesForGroup(group), `已复制 ${group.name} 全部可复制卡密`)"><Copy :size="14" />复制全部</el-button>
            <el-button size="small" plain :disabled="!fullCodesForGroup(group).length" @click="exportCodes(fullCodesForGroup(group), `${group.name}-all-codes`)"><Download :size="14" />导出</el-button>
          </div>
        </div>
        <div class="card-count-strip">
          <div><span>全部</span><strong>{{ totalCountForGroup(group) }}</strong></div>
          <div><span>未使用</span><strong>{{ unusedCountForGroup(group) }}</strong></div>
          <div><span>已使用</span><strong>{{ usedCountForGroup(group) }}</strong></div>
        </div>
        <div v-if="group.batches.length" class="generated-batch-stack">
          <section v-for="batch in group.batches" :key="batch.id" class="generated-batch-card">
            <div class="generated-batch-head">
              <div>
                <strong>{{ batch.name }}</strong>
                <span>{{ batch.amount }} 元 / {{ batch._count?.cards ?? batch.quantity }} 张 / 未使用 {{ unusedCount(batch) }} / 已使用 {{ usedCount(batch) }} / {{ formatDate(batch.createdAt) }}</span>
              </div>
              <div class="table-toolbar-actions batch-actions">
                <el-button size="small" type="success" plain :disabled="!hasUnusedFullCodes(batch)" @click="copyCodes(unusedFullCodes(batch), '已复制本批未使用卡密')"><Copy :size="15" />复制未使用</el-button>
                <el-button size="small" type="primary" plain :disabled="!hasFullCodes(batch)" @click="copyCodes(fullCodes(batch))"><Copy :size="15" />复制整批</el-button>
                <el-button size="small" plain :disabled="!hasFullCodes(batch)" @click="exportCodes(fullCodes(batch), `${batch.name}-all-codes`)"><Download :size="15" />导出</el-button>
                <el-button size="small" plain :loading="clearingUsedBatchIds.has(batch.id)" @click="removeUsedBatchCards(batch)"><Trash2 :size="15" />清除已使用</el-button>
                <el-button size="small" type="danger" plain @click="removeBatch(batch)">删除批次</el-button>
              </div>
            </div>
            <div v-if="hasFullCodes(batch)" class="generated-code-list">
              <div v-for="card in batch.cards || []" :key="card.id" class="generated-code-row">
                <code>{{ card.code || card.codePreview }}</code>
                <el-tag size="small" :type="card.status === 'unused' ? 'success' : card.status === 'used' ? 'warning' : 'info'">{{ statusLabel(card.status) }}</el-tag>
              </div>
            </div>
            <div v-else class="batch-empty-detail">本批次没有可复制的完整卡密，或未使用卡密已被删除。</div>
          </section>
        </div>
        <div v-else class="batch-empty-detail">该模板还没有生成卡密。</div>
      </section>
    </div>
    <div v-else class="empty-panel">暂无卡密批次</div>
  </el-dialog>

  <el-dialog v-model="templateDialogVisible" :title="editingTemplateId ? '编辑卡密模板' : '新增卡密模板'" width="680px" class="operations-dark-dialog" destroy-on-close>
    <el-form :model="templateForm" label-width="82px" class="sectioned-dialog-form">
      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>模板规则</strong><span>模板只保存默认金额、数量和前缀，生成时会在该模板下追加新批次。</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="模板名称"><el-input v-model="templateForm.name" maxlength="120" /></el-form-item>
          <el-form-item label="启用"><el-switch v-model="templateForm.enabled" /></el-form-item>
          <el-form-item label="金额"><el-input-number v-model="templateForm.amount" :min="0.01" :precision="2" style="width: 100%" /></el-form-item>
          <el-form-item label="数量"><el-input-number v-model="templateForm.quantity" :min="1" :max="500" style="width: 100%" /></el-form-item>
          <el-form-item label="前缀"><el-input v-model="templateForm.prefix" maxlength="16" placeholder="可留空" /></el-form-item>
          <el-form-item label="备注"><el-input v-model="templateForm.remark" maxlength="500" /></el-form-item>
        </div>
      </section>
    </el-form>
    <template #footer>
      <el-button @click="templateDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="savingTemplate" :disabled="!templateForm.name" @click="saveTemplate">保存</el-button>
    </template>
  </el-dialog>

  <el-dialog v-model="generateDialogVisible" title="生成卡密" width="680px" class="operations-dark-dialog" destroy-on-close>
    <el-form :model="generateForm" label-width="82px" class="sectioned-dialog-form">
      <section class="dialog-form-section">
        <div class="dialog-section-head"><strong>生成批次</strong><span>选择模板后会锁定金额、数量和前缀，生成结果会持久保存在模板批次里。</span></div>
        <div class="dialog-form-grid">
          <el-form-item label="选择模板" class="form-item-full">
            <el-select v-model="generateForm.templateId" clearable style="width: 100%" @change="onTemplateChange" @clear="clearTemplateSelection">
              <el-option v-for="item in enabledTemplates" :key="item.id" :label="`${item.name} / ${item.amount} 元 / ${item.quantity} 张`" :value="item.id" />
            </el-select>
          </el-form-item>
          <el-form-item label="批次名称" class="form-item-full"><el-input v-model="generateForm.name" maxlength="120" /></el-form-item>
          <el-form-item label="金额"><el-input-number v-model="generateForm.amount" :disabled="Boolean(selectedTemplate)" :min="0.01" :precision="2" style="width: 100%" /></el-form-item>
          <el-form-item label="数量"><el-input-number v-model="generateForm.quantity" :disabled="Boolean(selectedTemplate)" :min="1" :max="500" style="width: 100%" /></el-form-item>
          <el-form-item label="前缀"><el-input v-model="generateForm.prefix" :disabled="Boolean(selectedTemplate)" maxlength="16" /></el-form-item>
        </div>
      </section>
    </el-form>
    <section v-if="generatedCodes.length" class="dialog-form-section generated-text-section">
      <div class="dialog-section-head"><strong>生成结果</strong><span>{{ generatedCodes.length }} 张卡密，每行一张。</span></div>
      <el-input :model-value="generatedCodesText" type="textarea" :rows="10" readonly />
      <div class="table-toolbar-actions generated-text-actions">
        <el-button type="primary" plain @click="copyCodes(generatedCodes, '已复制本次生成卡密')"><Copy :size="15" />复制文本</el-button>
        <el-button plain @click="exportCodes(generatedCodes, `${generatedBatchName || 'generated'}-codes`)"><Download :size="15" />导出</el-button>
      </div>
    </section>
    <template #footer>
      <el-button @click="generateDialogVisible = false">取消</el-button>
      <el-button type="primary" :loading="generating" :disabled="!generateForm.name" @click="generateCards">生成</el-button>
    </template>
  </el-dialog>
  </div>
</template>
