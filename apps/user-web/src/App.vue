<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref } from 'vue';
import { ArrowRight, CalendarClock, CircleAlert, CircleUserRound, Gauge, Home, LockKeyhole, LogOut, Network, QrCode, ReceiptText, ShieldCheck, UserRound } from 'lucide-vue-next';
import { api } from './api';
import { onNotify, type NotifyPayload } from './notify';

type SessionUser = { role: string; username: string };
type Branding = { brandName: string; logoDataUrl: string };

const fallbackBrandName = '十夜用户中心';
const nav = [
  { to: '/', label: '首页', icon: Home },
  { to: '/nodes', label: '节点', icon: Network },
  { to: '/finance', label: '财务', icon: ReceiptText },
  { to: '/profile', label: '资料', icon: CircleUserRound }
];

const checking = ref(true);
const loggingIn = ref(false);
const loginError = ref('');
const user = ref<SessionUser | null>(null);
const branding = reactive<Branding>({ brandName: fallbackBrandName, logoDataUrl: '' });
const loginForm = reactive({ username: '', password: '' });
const notices = ref<Array<NotifyPayload & { id: number }>>([]);
let noticeId = 0;
let stopNotify: (() => void) | undefined;

async function loadBranding() {
  try {
    const payload = await api<{ settings: Branding }>('/api/public/branding');
    branding.brandName = payload.settings.brandName || fallbackBrandName;
    branding.logoDataUrl = payload.settings.logoDataUrl || '';
  } catch {
    branding.brandName = fallbackBrandName;
    branding.logoDataUrl = '';
  } finally {
    applyBrowserBranding(branding);
  }
}

async function loadMe() {
  checking.value = true;
  try {
    const session = await api<SessionUser>('/api/auth/me?entry=user');
    user.value = session.role === 'user' ? session : null;
  } catch {
    user.value = null;
  } finally {
    checking.value = false;
  }
}

async function login() {
  loggingIn.value = true;
  loginError.value = '';
  try {
    const session = await api<SessionUser>('/api/login', { method: 'POST', body: { ...loginForm, entry: 'user' } });
    if (session.role !== 'user') {
      await api('/api/logout', { method: 'POST', body: { entry: 'user' } }).catch(() => undefined);
      throw new Error('当前账号不是用户账号');
    }
    user.value = session;
    Object.assign(loginForm, { username: '', password: '' });
  } catch (err) {
    loginError.value = err instanceof Error ? err.message : '登录失败';
  } finally {
    loggingIn.value = false;
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: { entry: 'user' } }).catch(() => undefined);
  user.value = null;
}

function applyBrowserBranding(settings: Branding) {
  document.title = settings.brandName || fallbackBrandName;
  const icon = ensureFaviconElement();
  icon.type = settings.logoDataUrl ? '' : 'image/svg+xml';
  icon.href = settings.logoDataUrl || createTextFavicon(settings.brandName || fallbackBrandName);
}

function ensureFaviconElement() {
  const existing = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (existing) return existing;
  const link = document.createElement('link');
  link.rel = 'icon';
  document.head.appendChild(link);
  return link;
}

function createTextFavicon(name: string) {
  const initial = Array.from(name.trim())[0] || '十';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#0f172a"/><text x="50%" y="54%" text-anchor="middle" dominant-baseline="middle" font-size="32" font-family="Arial, sans-serif" font-weight="700" fill="#ffffff">${escapeSvg(initial)}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function escapeSvg(value: string) {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] || char);
}

function pushNotice(payload: NotifyPayload) {
  const id = ++noticeId;
  notices.value = [...notices.value, { id, ...payload }].slice(-3);
  window.setTimeout(() => closeNotice(id), payload.type === 'error' ? 5200 : 3600);
}

function closeNotice(id: number) {
  notices.value = notices.value.filter((notice) => notice.id !== id);
}

onMounted(async () => {
  stopNotify = onNotify(pushNotice);
  await loadBranding();
  await loadMe();
});

onUnmounted(() => {
  stopNotify?.();
});
</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <div v-for="notice in notices" :key="notice.id" class="toast-card" :class="notice.type">
      <div>
        <strong>{{ notice.title }}</strong>
        <p>{{ notice.message }}</p>
      </div>
      <button type="button" @click="closeNotice(notice.id)">关闭</button>
    </div>
  </div>

  <div v-if="checking" class="boot-screen">正在检查登录状态</div>

  <div v-else-if="!user" class="login-screen user-login-screen">
    <div class="login-layout">
      <section class="login-intro" aria-labelledby="user-login-title">
        <div class="intro-brand-row">
          <div class="intro-brand-mark">
            <img v-if="branding.logoDataUrl" :src="branding.logoDataUrl" alt="Logo" />
            <span v-else>{{ branding.brandName.slice(0, 1) }}</span>
          </div>
          <div class="intro-brand-copy">
            <strong>{{ branding.brandName }}</strong>
            <span><i></i>用户服务正常</span>
          </div>
        </div>

        <div class="intro-content">
          <p class="intro-kicker">XUI USER SERVICE</p>
          <h1 id="user-login-title">连接服务，从这里开始</h1>
          <p class="intro-description">查看账户可用节点、连接信息与使用状态，集中获取分享链接、二维码、流量和到期信息。</p>
          <div class="login-feature-list">
            <div class="login-feature-item">
              <span class="feature-icon"><Network :size="18" /></span>
              <div><strong>可用节点</strong><span>查看当前账号可连接的服务节点与状态</span></div>
            </div>
            <div class="login-feature-item">
              <span class="feature-icon"><QrCode :size="18" /></span>
              <div><strong>分享与二维码</strong><span>获取可直接导入客户端的分享链接和二维码</span></div>
            </div>
            <div class="login-feature-item">
              <span class="feature-icon"><Gauge :size="18" /></span>
              <div><strong>用量与有效期</strong><span>查看流量使用情况、到期时间和账户服务</span></div>
            </div>
          </div>
        </div>
      </section>

      <main class="login-area">
        <form class="login-panel refined-login" autocomplete="on" @submit.prevent="login">
          <div class="login-card-brand">
            <div class="login-brand">
              <img v-if="branding.logoDataUrl" :src="branding.logoDataUrl" alt="Logo" />
              <span v-else>{{ branding.brandName.slice(0, 1) }}</span>
            </div>
            <div><strong>{{ branding.brandName }}</strong><span>用户端</span></div>
          </div>

          <div class="login-heading">
            <h2>登录用户中心</h2>
            <p>使用您的用户账号进入服务中心</p>
          </div>

          <div v-if="loginError" class="login-error" role="alert">
            <CircleAlert :size="17" />
            <span>{{ loginError }}</span>
          </div>

          <label class="login-form-group">
            <span>用户账号</span>
            <span class="login-field">
              <UserRound :size="18" />
              <input v-model="loginForm.username" name="shiye-user-account" placeholder="请输入用户账号" autocomplete="username" />
            </span>
          </label>
          <label class="login-form-group">
            <span>密码</span>
            <span class="login-field">
              <LockKeyhole :size="18" />
              <input v-model="loginForm.password" name="shiye-user-passcode" type="password" placeholder="请输入密码" autocomplete="current-password" />
            </span>
          </label>
          <button class="login-submit" :disabled="loggingIn || !loginForm.username || !loginForm.password">
            <span>{{ loggingIn ? '正在验证' : '进入用户中心' }}</span>
            <ArrowRight :size="18" />
          </button>
          <div class="login-security-note"><ShieldCheck :size="15" /><CalendarClock :size="15" />账户服务安全连接</div>
        </form>
      </main>
    </div>
  </div>

  <div v-else class="app-shell">
    <aside class="user-sidebar">
      <div class="header-brand">
        <img v-if="branding.logoDataUrl" :src="branding.logoDataUrl" alt="Logo" />
        <span v-else class="brand-mark">{{ branding.brandName.slice(0, 1) }}</span>
        <strong>{{ branding.brandName }}</strong>
      </div>
      <nav class="user-nav">
        <router-link v-for="item in nav" :key="item.to" :to="item.to" class="nav-link">
          <component :is="item.icon" :size="18" />
          <span>{{ item.label }}</span>
        </router-link>
      </nav>
      <div class="user-sidebar-footer">
        <span>当前账号</span>
        <strong>{{ user.username }}</strong>
        <button class="logout-button" @click="logout"><LogOut :size="16" />退出</button>
      </div>
    </aside>
    <main class="main">
      <router-view />
    </main>
  </div>
</template>
