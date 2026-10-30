<script setup lang="ts">
import { randomUuid } from '@shiye/shared';
import { computed, onMounted, ref } from 'vue';
import QRCode from 'qrcode';
import { useRoute } from 'vue-router';
import { ArrowUpRight, ChevronDown, Copy, Network, QrCode, RefreshCw, Search, X } from 'lucide-vue-next';
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
  trafficStatus?: 'live' | 'cached' | 'error';
  trafficError?: string | null;
  officialTrafficTotalBytes?: number | null;
  officialTrafficRemainingBytes?: number | null;
  officialTrafficUnlimited?: boolean | null;
  links?: string[];
  linkError?: string | null;
  subId?: string;
  serviceNode: { name: string; protocol: string; priceMonthly: string; server: { name: string } };
};

const route = useRoute();
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
  return hasFiniteTrafficQuota(node) && Number(node.officialTrafficTotalBytes) > 0
    ? Math.min((Number(node.officialTrafficRemainingBytes) / Number(node.officialTrafficTotalBytes)) * 100, 100)
    : 0;
};

function totalAndRemainingTrafficText(node: UserNode) {
  if (node.trafficStatus !== 'live') return '获取失败';
  if (node.officialTrafficUnlimited === true) return '总流量 无限，剩余流量 无限';
  return hasFiniteTrafficQuota(node)
    ? `总流量 ${formatTraffic(node.officialTrafficTotalBytes as number)}，剩余流量 ${formatTraffic(node.officialTrafficRemainingBytes as number)}`
    : '额度未返回';
}

function hasFiniteTrafficQuota(node: UserNode) {
  return hasBytes(node.officialTrafficTotalBytes) && hasBytes(node.officialTrafficRemainingBytes);
}

function hasBytes(value?: number | null) {
  return value !== null && value !== undefined && Number.isFinite(Number(value)) && Number(value) >= 0;
}

function trafficStateText(node: UserNode) {
  if (node.trafficStatus === 'cached') return node.trafficError || '官方实时流量获取失败，当前显示上次成功同步的数据。';
  if (node.trafficStatus === 'error') return node.trafficError || '官方实时流量暂不可用，请联系管理员检查面板连接。';
  return '';
}

async function loadNodes() {
  loading.value = true;
  error.value = '';
  try {
    nodes.value = await api<UserNode[]>('/api/user/nodes');
    for (const node of nodes.value) {
      if (![1, 3, 6, 12].includes(monthsByNode.value[node.id] || 0)) monthsByNode.value[node.id] = 1;
    }
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
  const created = randomUuid();
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

  if (node.status !== 'active' && node.disabledReason === 'expired') return { type: 'danger', label: '已到期', text: '节点已到期，续费成功后会恢复服务。' };
  if (node.status !== 'active' && node.disabledReason === 'traffic_exceeded') return { type: 'danger', label: '流量用尽', text: '续费只延长有效期，不会重置流量，请联系管理员处理流量额度。' };
  if (node.status !== 'active' && node.disabledReason === 'admin') return { type: 'danger', label: '管理员停用', text: '该节点不能通过用户续费恢复，请联系管理员。' };
  if (node.status !== 'active') return { type: 'danger', label: '已停用', text: '该节点当前不可用，请联系管理员核对停用原因。' };
  if (diff !== null && diff <= 0) return { type: 'danger', label: '已到期', text: '节点已到期，续费成功后会恢复服务。' };
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
  <div class="user-page connections-page" :aria-busy="loading">
    <header class="page-heading"><div><span class="eyebrow">连接与有效期</span><h1>连接服务</h1><p>所有连接集中管理。展开服务，获取链接、扫码导入或续费。</p></div><button class="button secondary" :disabled="loading" @click="loadNodes"><RefreshCw :size="15" :class="{ spinning: loading }" />刷新服务</button></header>
    <div v-if="message" class="user-feedback success" role="status">{{ message }}</div><div v-if="error" class="user-feedback error" role="alert">{{ error }}</div>
    <section class="surface connections-surface">
      <header class="connections-toolbar"><div class="connection-totals"><strong>{{ nodes.length }} <span>项服务</span></strong><span class="live-dot">{{ activeCount }} 项启用</span><span v-if="expiringCount" class="attention-text">{{ expiringCount }} 项即将到期</span></div><label class="search-field"><Search :size="16" /><input v-model="searchQuery" type="search" aria-label="搜索服务" placeholder="搜索名称、协议或状态" /></label></header>
      <div class="connection-list-head" aria-hidden="true"><span>服务 / 位置</span><span>流量情况</span><span>有效期</span><span>状态</span><span></span></div>
      <div class="node-list">
        <details v-for="node in filteredNodes" :id="'service-' + node.id" :key="node.id" class="node-entry" :open="String(route.query.node || '') === node.id">
          <summary class="node-summary">
            <div class="service-identity"><span class="protocol-symbol">{{ node.serviceNode.protocol.slice(0, 1).toLowerCase() }}</span><div><strong>{{ node.serviceNode.name }}</strong><small>{{ node.serviceNode.server.name }} · {{ node.serviceNode.protocol.toLowerCase() }}</small></div></div>
            <div class="summary-usage"><strong>{{ node.trafficStatus === 'live' ? node.officialTrafficUnlimited ? '无限流量' : hasFiniteTrafficQuota(node) ? formatTraffic(Number(node.officialTrafficRemainingBytes)) + ' 剩余' : '额度未返回' : '用量暂不可用' }}</strong><small>{{ Number(node.serviceNode.priceMonthly).toFixed(2) }} 元 / 月</small></div>
            <div class="summary-expiry"><strong>{{ node.expireAt ? new Date(node.expireAt).toLocaleDateString('zh-CN') : '长期有效' }}</strong><small>{{ node.links?.length || 0 }} 个连接入口</small></div>
            <span class="status-pill" :class="nodeStatusHint(node).type"><i></i>{{ nodeStatusHint(node).label }}</span>
            <ChevronDown class="entry-chevron" :size="17" />
          </summary>
          <div class="node-detail">
            <section class="connection-access"><header class="detail-heading"><span class="section-number">01 / CONNECT</span><h2>连接与导入</h2><p>复制订阅链接或扫描二维码，导入支持此协议的客户端。</p></header>
              <div v-if="node.links?.length" class="link-list"><div v-for="(link, index) in node.links" :key="link" class="connection-link"><div><span class="connection-link-label">{{ /^https?:/.test(link) ? '订阅地址' : '线路 ' + (index + 1) }}</span><code :title="link">{{ link }}</code></div><div class="connection-link-actions"><button class="button small secondary" type="button" title="复制节点" @click="copyText(link)"><Copy :size="14" />复制</button><button class="button small secondary" type="button" title="显示二维码" @click="showQrCode(node, link, index)"><QrCode :size="14" /><span>二维码</span></button></div></div></div>
              <div v-else class="user-feedback warning">{{ node.linkError || '连接信息暂不可用，请联系管理员同步此服务。' }}</div>
              <div class="connection-quota"><div><span>流量与用量</span><strong>{{ totalAndRemainingTrafficText(node) }}</strong></div><span v-if="hasFiniteTrafficQuota(node)" class="progress-track"><i :style="{ width: `${trafficPercent(node)}%` }"></i></span><small v-if="trafficStateText(node)" class="attention-text">{{ trafficStateText(node) }}</small><small class="quiet-text">服务有效期：{{ node.expireAt ? formatDate(node.expireAt) : '长期有效' }}</small><small v-if="node.subId" class="quiet-text">订阅标识：{{ node.subId }}</small></div>
            </section>
            <section class="renew-box"><header class="detail-heading"><span class="section-number">02 / RENEW</span><h2>延长服务有效期</h2></header><div class="renew-price"><strong>¥{{ Number(node.serviceNode.priceMonthly).toFixed(2) }}</strong><span> / 月</span></div><p v-if="nodeStatusHint(node).type !== 'success'" class="user-feedback" :class="nodeStatusHint(node).type">{{ nodeStatusHint(node).text }}</p><form class="renew-form" @submit.prevent="renewNode(node.id)"><label :for="'renew-' + node.id">续费时长</label><select :id="'renew-' + node.id" v-model.number="monthsByNode[node.id]"><option :value="1">1 个月</option><option :value="3">3 个月</option><option :value="6">6 个月</option><option :value="12">12 个月</option></select><button class="button primary" :disabled="Boolean(renewingId)">{{ renewingId === node.id ? '续费处理中…' : '使用余额续费' }}<ArrowUpRight :size="16" /></button></form><small class="renew-note">续费延长有效期，不重置流量。请确认账户余额充足。</small></section>
          </div>
        </details>
      </div>
      <div v-if="!loading && !filteredNodes.length" class="empty-state"><Network :size="28" /><strong>{{ searchQuery ? '没有找到匹配的服务' : '暂无连接服务' }}</strong><p>{{ searchQuery ? '试试其他服务名称或协议。' : '服务开通后，你可以在这里获取连接信息。' }}</p></div>
      <footer class="panel-footnote"><span>显示 {{ filteredNodes.length }} / {{ nodes.length }} 项服务</span><span>展开一项服务即可查看完整操作</span></footer>
    </section>
  <div v-if="qrPreview" class="qr-modal" role="dialog" aria-modal="true" @click.self="closeQrCode">
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

  <div v-if="renewErrorDialog" class="qr-modal" role="dialog" aria-modal="true" @click.self="closeRenewError">
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
