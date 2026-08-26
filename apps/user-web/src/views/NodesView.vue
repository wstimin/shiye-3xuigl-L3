<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { Activity, CalendarClock, Copy, ListFilter, Network, QrCode, RefreshCw, Search, X } from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { notifyError, notifySuccess } from '../notify';
import { createNodeQrImage } from '../node-qr';
import { formatTraffic } from '../traffic';

type UserNode = {
  id: string;
  status: string;
  remoteControl: 'reference' | 'subscription_managed' | 'fully_managed';
  disabledReason?: 'expired' | 'traffic_exceeded' | 'admin' | null;
  expireAt?: string | null;
  trafficLimitGb: string;
  usedTrafficGb: string;
  usedTrafficBytes?: number;
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
const renewErrorDialog = ref<{ title: string; message: string } | null>(null);

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
const trafficPercent = (node: UserNode) => {
  const limit = numericValue(node.trafficLimitGb);
  return limit > 0 ? Math.min((numericValue(node.usedTrafficGb) / limit) * 100, 100) : 0;
};

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    nodes.value = await api<UserNode[]>('/api/user/nodes');
  } catch (caught) {
    error.value = readableError(caught, '加载失败');
  } finally {
    loading.value = false;
  }
}

async function renewNode(nodeId: string) {
  const node = nodes.value.find((item) => item.id === nodeId);
  if (!node) return;
  renewingId.value = nodeId;
  message.value = '';
  renewErrorDialog.value = null;
  const months = monthsByNode.value[nodeId] || 1;
  const requestKey = `${nodeId}:${months}`;
  try {
    const requestId = renewalRequestId(requestKey);
    await api('/api/user/renewals', { method: 'POST', body: { nodeId, months, requestId } });
    clearRenewalRequestId(requestKey);
    message.value = '续费成功';
    notifySuccess(message.value);
    await loadNodes();
  } catch (caught) {
    const text = readableError(caught, '续费失败');
    if (!shouldReuseRenewalRequest(text)) clearRenewalRequestId(requestKey);
    renewErrorDialog.value = { title: '续费失败', message: text };
  } finally {
    renewingId.value = '';
  }
}

function shouldReuseRenewalRequest(message: string) {
  return /请求超时|网络异常|不会重复扣款|系统将自动恢复|正在续费/.test(message);
}

function renewalRequestId(requestKey: string) {
  const storageKey = `shiye:renewal:${requestKey}`;
  const existing = window.sessionStorage.getItem(storageKey);
  if (existing) return existing;
  const created = crypto.randomUUID();
  window.sessionStorage.setItem(storageKey, created);
  return created;
}

function clearRenewalRequestId(requestKey: string) {
  window.sessionStorage.removeItem(`shiye:renewal:${requestKey}`);
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
    } catch (caught) {
      notifyError(caught, '复制失败');
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
      image: await createNodeQrImage(link, QRCode.toDataURL)
    };
  } catch (caught) {
    notifyError(caught, '生成失败');
  }
}

function closeQrCode() {
  qrPreview.value = null;
}

function closeRenewError() {
  renewErrorDialog.value = null;
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

  if (node.status !== 'active' && node.disabledReason === 'expired') return { type: 'danger', label: '已到期', text: '节点因本系统授权到期停用，续费成功后会恢复本地访问授权。' };
  if (node.status !== 'active' && node.disabledReason === 'traffic_exceeded') return { type: 'danger', label: '流量用尽', text: '续费只延长有效期，不会重置流量，请联系管理员处理流量额度。' };
  if (node.status !== 'active' && node.disabledReason === 'admin') return { type: 'danger', label: '管理员停用', text: '该节点不能通过用户续费恢复，请联系管理员。' };
  if (node.status !== 'active') return { type: 'danger', label: '已停用', text: '该节点当前不可用，请联系管理员核对停用原因。' };
  if (diff !== null && diff <= 0) return { type: 'danger', label: '已到期', text: '本系统访问授权已到期，续费成功后会恢复本地授权。' };
  if (limit > 0 && used >= limit) return { type: 'danger', label: '流量用尽', text: '可用流量已用完，续费不会重置流量，请联系管理员增加额度或重置流量。' };
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
  <div class="user-page">
  <div class="user-page-header">
    <div>
      <span class="user-page-kicker">NODE SERVICES</span>
      <h2>我的节点</h2>
      <p>查看真实节点状态、连接链接、二维码、流量与续费信息。</p>
    </div>
    <button class="user-action-button secondary" type="button" :disabled="loading" @click="loadNodes"><RefreshCw :size="16" />刷新节点</button>
  </div>
  <div v-if="message" class="user-feedback success">{{ message }}</div>
  <div v-if="error" class="user-feedback error">{{ error }}</div>

  <div v-if="!error" class="node-stat-grid">
    <article><i class="purple"><Network :size="17" /></i><span>全部节点</span><strong>{{ nodes.length }}</strong></article>
    <article><i class="green"><Activity :size="17" /></i><span>正常可用</span><strong>{{ activeCount }}</strong></article>
    <article><i class="orange"><CalendarClock :size="17" /></i><span>7 天内到期</span><strong>{{ expiringCount }}</strong></article>
    <article><i class="blue"><ListFilter :size="17" /></i><span>当前结果</span><strong>{{ filteredNodes.length }}</strong></article>
  </div>

  <div v-if="!error" class="user-section-card node-filter-panel">
    <label class="search-field">
      <Search :size="16" />
      <input v-model="searchQuery" placeholder="搜索节点、服务器、协议、状态" />
    </label>
    <span>显示 {{ filteredNodes.length }} / {{ nodes.length }}</span>
  </div>

  <div v-if="!error" class="node-list" :class="{ loading }">
    <article v-for="node in filteredNodes" :key="node.id" class="user-section-card node-card">
      <div class="node-card-head">
        <div>
          <h2>{{ node.serviceNode.name }}</h2>
          <p>{{ node.serviceNode.server.name }} / {{ node.serviceNode.protocol }}</p>
        </div>
        <span class="status-pill" :class="[node.status, nodeStatusHint(node).type]">{{ nodeStatusHint(node).label }}</span>
      </div>
      <div class="node-status-hint" :class="nodeStatusHint(node).type">{{ nodeStatusHint(node).text }}</div>
      <div class="node-traffic-block">
        <div><span>流量使用</span><strong>{{ formatTraffic(node.usedTrafficBytes, node.usedTrafficGb) }} / {{ node.trafficLimitGb }} GB</strong></div>
        <span class="node-traffic-track"><i :class="nodeStatusHint(node).type" :style="{ width: `${trafficPercent(node)}%` }"></i></span>
      </div>
      <div class="node-meta">
        <span>到期：{{ formatDate(node.expireAt) }}</span>
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
      <div class="empty-hint">续费只延长本系统访问授权，不修改路由节点共享的官方客户端。</div>
    </article>
    <div v-if="!loading && !filteredNodes.length" class="user-empty-state user-section-card">暂无符合条件的节点</div>
  </div>

  <div v-if="qrPreview" class="qr-modal" @click.self="closeQrCode">
    <div class="qr-modal-panel">
      <div class="qr-modal-head">
        <strong>{{ qrPreview.title }}</strong>
        <button class="copy-button" type="button" title="关闭" @click="closeQrCode"><X :size="16" /></button>
      </div>
      <div class="qr-modal-body">
        <img :src="qrPreview.image" alt="节点二维码" />
        <p>使用支持该节点协议的客户端扫描二维码</p>
      </div>
    </div>
  </div>

  <div v-if="renewErrorDialog" class="qr-modal" @click.self="closeRenewError">
    <div class="qr-modal-panel message-modal-panel">
      <div class="qr-modal-head">
        <strong>{{ renewErrorDialog.title }}</strong>
        <button class="copy-button" type="button" title="关闭" @click="closeRenewError"><X :size="16" /></button>
      </div>
      <div class="message-modal-body">
        <p class="message-modal-text">{{ renewErrorDialog.message }}</p>
      </div>
      <div class="message-modal-footer">
        <button class="modal-primary-button" type="button" @click="closeRenewError">知道了</button>
      </div>
    </div>
  </div>
  </div>
</template>
