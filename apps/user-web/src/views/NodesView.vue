<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { Copy, QrCode, RefreshCw, Search, X } from 'lucide-vue-next';
import { api } from '../api';
import { notifyError, notifySuccess } from '../notify';

type UserNode = {
  id: string;
  status: string;
  expireAt?: string | null;
  trafficLimitGb: string;
  usedTrafficGb: string;
  links?: string[];
  linkError?: string | null;
  subId?: string;
  serviceNode: { name: string; protocol: string; priceMonthly: string; server: { name: string } };
};

const loading = ref(false);
const renewingId = ref('');
const error = ref('');
const message = ref('');
const nodes = ref<UserNode[]>([]);
const searchQuery = ref('');
const monthsByNode = ref<Record<string, number>>({});
const qrPreview = ref<{ title: string; image: string } | null>(null);

const filteredNodes = computed(() => {
  const keyword = searchQuery.value.trim().toLowerCase();
  if (!keyword) return nodes.value;
  return nodes.value.filter((node) => nodeSearchText(node).includes(keyword));
});
const activeCount = computed(() => nodes.value.filter((node) => node.status === 'active').length);
const expiringCount = computed(() => nodes.value.filter((node) => {
  if (!node.expireAt) return false;
  const diff = new Date(node.expireAt).getTime() - Date.now();
  return diff > 0 && diff <= 7 * 24 * 60 * 60 * 1000;
}).length);

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    nodes.value = await api<UserNode[]>('/api/user/nodes');
  } catch (err) {
    error.value = err instanceof Error ? err.message : '加载节点失败';
    notifyError(error.value);
  } finally {
    loading.value = false;
  }
}

async function renewNode(nodeId: string) {
  renewingId.value = nodeId;
  error.value = '';
  message.value = '';
  try {
    const months = monthsByNode.value[nodeId] || 1;
    await api('/api/user/renewals', { method: 'POST', body: { nodeId, months } });
    message.value = '续费成功，节点已同步远端';
    notifySuccess(message.value);
    await loadNodes();
  } catch (err) {
    error.value = err instanceof Error ? err.message : '续费失败';
    notifyError(error.value);
  } finally {
    renewingId.value = '';
  }
}

async function copyText(text: string) {
  error.value = '';
  message.value = '';
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      fallbackCopyText(text);
    }
    message.value = '节点链接已复制';
    notifySuccess(message.value, '复制成功');
  } catch (err) {
    try {
      fallbackCopyText(text);
      message.value = '节点链接已复制';
      notifySuccess(message.value, '复制成功');
    } catch {
      error.value = err instanceof Error ? err.message : '复制失败，请使用 HTTPS 访问后重试';
      notifyError(error.value);
    }
  }
}

function fallbackCopyText(text: string) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  if (!copied) throw new Error('复制失败，请手动复制或使用 HTTPS 访问');
}

async function showQrCode(node: UserNode, link: string, index: number) {
  try {
    qrPreview.value = {
      title: `${node.serviceNode.name} / 线路 ${index + 1}`,
      image: await QRCode.toDataURL(link, { width: 260, margin: 1 })
    };
  } catch (err) {
    error.value = err instanceof Error ? err.message : '生成二维码失败';
    notifyError(error.value);
  }
}

function closeQrCode() {
  qrPreview.value = null;
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '-';
}

function nodeSearchText(node: UserNode) {
  return [node.serviceNode.name, node.serviceNode.server.name, node.serviceNode.protocol, node.status, node.subId, node.expireAt].filter(Boolean).join(' ').toLowerCase();
}

function nodeStatusHint(node: UserNode) {
  const limit = numericValue(node.trafficLimitGb);
  const used = numericValue(node.usedTrafficGb);
  const remaining = limit > 0 ? Math.max(limit - used, 0) : null;
  const expireTime = node.expireAt ? new Date(node.expireAt).getTime() : null;
  const diff = expireTime ? expireTime - Date.now() : null;

  if (node.status !== 'active') return { type: 'danger', label: '已停用', text: '该节点当前不可用，请续费或联系管理员处理。' };
  if (diff !== null && diff <= 0) return { type: 'danger', label: '已到期', text: '节点已到期，续费成功后会重新同步远端状态。' };
  if (limit > 0 && used >= limit) return { type: 'danger', label: '流量用尽', text: '可用流量已用完，续费或增加流量后再使用。' };
  if (diff !== null && diff <= 3 * 24 * 60 * 60 * 1000) return { type: 'warning', label: '临近到期', text: `还剩 ${daysLeft(diff)} 天到期，建议提前续费。` };
  if (diff !== null && diff <= 7 * 24 * 60 * 60 * 1000) return { type: 'warning', label: '即将到期', text: `还剩 ${daysLeft(diff)} 天到期。` };
  if (remaining !== null && limit > 0 && remaining / limit <= 0.1) return { type: 'warning', label: '流量不足', text: `剩余约 ${remaining.toFixed(2)} GB。` };
  return { type: 'success', label: '正常可用', text: '节点状态正常，复制链接或扫码即可使用。' };
}

function numericValue(value: string) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function daysLeft(diffMs: number) {
  return Math.max(Math.ceil(diffMs / 24 / 60 / 60 / 1000), 0);
}

onMounted(loadNodes);
</script>

<template>
  <div class="page-heading">
    <div>
      <h1 class="page-title">我的节点</h1>
      <p class="page-subtitle">{{ activeCount }} 个可用，{{ expiringCount }} 个 7 天内到期</p>
    </div>
    <button class="icon-action" :disabled="loading" @click="loadNodes"><RefreshCw :size="16" />刷新</button>
  </div>
  <div v-if="message" class="panel success-text">{{ message }}</div>
  <div v-if="error" class="panel error-text">{{ error }}</div>

  <div v-if="!error" class="panel node-filter-panel">
    <label class="search-field">
      <Search :size="16" />
      <input v-model="searchQuery" placeholder="搜索节点、服务器、协议、状态" />
    </label>
    <span>显示 {{ filteredNodes.length }} / {{ nodes.length }}</span>
  </div>

  <div v-if="!error" class="node-list" :class="{ loading }">
    <article v-for="node in filteredNodes" :key="node.id" class="panel node-card">
      <div class="node-card-head">
        <div>
          <h2>{{ node.serviceNode.name }}</h2>
          <p>{{ node.serviceNode.server.name }} / {{ node.serviceNode.protocol }}</p>
        </div>
        <span class="status-pill" :class="[node.status, nodeStatusHint(node).type]">{{ nodeStatusHint(node).label }}</span>
      </div>
      <div class="node-status-hint" :class="nodeStatusHint(node).type">{{ nodeStatusHint(node).text }}</div>
      <div class="node-meta">
        <span>到期：{{ formatDate(node.expireAt) }}</span>
        <span>流量：{{ node.usedTrafficGb }} / {{ node.trafficLimitGb }} GB</span>
        <span>月费：{{ node.serviceNode.priceMonthly }} 元</span>
        <span v-if="node.subId">订阅标识：{{ node.subId }}</span>
      </div>
      <div v-if="node.links?.length" class="link-list">
        <div v-for="(link, index) in node.links" :key="link" class="link-row">
          <span class="link-label">线路 {{ index + 1 }}</span>
          <button class="copy-button" type="button" title="复制节点" @click="copyText(link)"><Copy :size="15" /></button>
          <button class="copy-button" type="button" title="显示二维码" @click="showQrCode(node, link, index)"><QrCode :size="15" /></button>
        </div>
      </div>
      <div v-else class="empty-hint">{{ node.linkError ? `节点链接获取失败：${node.linkError}` : '暂未获取到 3-x-ui 节点链接，请联系管理员同步节点。' }}</div>
      <form class="renew-form" @submit.prevent="renewNode(node.id)">
        <select v-model.number="monthsByNode[node.id]">
          <option :value="1">1 个月</option>
          <option :value="3">3 个月</option>
          <option :value="6">6 个月</option>
          <option :value="12">12 个月</option>
        </select>
        <button :disabled="renewingId === node.id">{{ renewingId === node.id ? '续费中' : '余额续费' }}</button>
      </form>
    </article>
    <div v-if="!loading && !filteredNodes.length" class="panel">暂无节点</div>
  </div>

  <div v-if="qrPreview" class="qr-modal" @click.self="closeQrCode">
    <div class="qr-modal-panel">
      <div class="qr-modal-head">
        <strong>{{ qrPreview.title }}</strong>
        <button class="copy-button" type="button" title="关闭" @click="closeQrCode"><X :size="16" /></button>
      </div>
      <img :src="qrPreview.image" alt="节点二维码" />
    </div>
  </div>
</template>
