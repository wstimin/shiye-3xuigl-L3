<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowRight, ChevronRight, CircleAlert, CircleUserRound, Home, LockKeyhole, LogOut, Network, ReceiptText, ShieldCheck, UserRound } from 'lucide-vue-next';
import BrandMark from '../../web-shared/BrandMark.vue';
import ThemeToggle from '../../web-shared/ThemeToggle.vue';
import { applyBranding } from '../../web-shared/branding';
import { api, onSessionExpired } from './api';
import { userAvatarStyle, userInitial } from './avatar';
import { onNotify, type NotifyPayload } from './notify';
import { preloadRoute, routeLoadError, routeLoading } from './router';

type SessionUser = { role: string; username: string };
type Branding = { brandName: string; logoDataUrl: string };
type UserIdentity = { customer: { name: string; loginUsername: string } };

const fallbackBrandName = '十夜服务中心';
const appVersion = __SHIYE_BUILD_INFO__.version;
const nav = [
  { to: '/', label: '服务总览', icon: Home },
  { to: '/nodes', label: '连接服务', icon: Network },
  { to: '/finance', label: '账单与余额', icon: ReceiptText },
  { to: '/profile', label: '账户设置', icon: CircleUserRound }
];

const route = useRoute();
const checking = ref(true);
const loggingIn = ref(false);
const loginError = ref('');
const user = ref<SessionUser | null>(null);
const userIdentity = ref<UserIdentity['customer'] | null>(null);
const branding = reactive<Branding>({ brandName: fallbackBrandName, logoDataUrl: '' });
const loginForm = reactive({ username: '', password: '' });
const notices = ref<Array<NotifyPayload & { id: number }>>([]);
const currentPageTitle = computed(() => {
  if (route.path === '/payment/result') return '支付结果';
  return nav.find((item) => item.to === route.path)?.label || '用户中心';
});
const displayName = computed(() => userIdentity.value?.name || user.value?.username || '用户');
const displayLoginUsername = computed(() => userIdentity.value?.loginUsername || user.value?.username || '');
const currentUserInitial = computed(() => userInitial(displayName.value));
let noticeId = 0;
let stopNotify: (() => void) | undefined;
let stopSessionExpired: (() => void) | undefined;

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
    if (user.value) await loadUserIdentity();
    else userIdentity.value = null;
  } catch {
    user.value = null;
    userIdentity.value = null;
  } finally {
    checking.value = false;
  }
}

async function loadUserIdentity() {
  try {
    const payload = await api<UserIdentity>('/api/user/me');
    userIdentity.value = payload.customer;
  } catch {
    userIdentity.value = null;
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
    await loadUserIdentity();
    Object.assign(loginForm, { username: '', password: '' });
  } catch {
    loginError.value = '登录失败';
  } finally {
    loggingIn.value = false;
  }
}

async function logout() {
  await api('/api/logout', { method: 'POST', body: { entry: 'user' } }).catch(() => undefined);
  user.value = null;
  userIdentity.value = null;
}

function applyBrowserBranding(settings: Branding) { applyBranding(settings, fallbackBrandName); }

function handleSessionExpired() {
  if (!user.value) return;
  user.value = null;
  userIdentity.value = null;
  loginError.value = '登录已失效';
}

function pushNotice(payload: NotifyPayload) {
  const id = ++noticeId;
  notices.value = [...notices.value, { id, ...payload }].slice(-3);
  window.setTimeout(() => closeNotice(id), payload.type === 'error' ? 5200 : 3600);
}

function closeNotice(id: number) {
  notices.value = notices.value.filter((notice) => notice.id !== id);
}

function reloadPage() {
  window.location.reload();
}

onMounted(async () => {
  stopNotify = onNotify(pushNotice);
  stopSessionExpired = onSessionExpired(handleSessionExpired);
  await loadBranding();
  await loadMe();
});

onUnmounted(() => {
  stopNotify?.();
  stopSessionExpired?.();
});

</script>

<template>
  <div class="toast-stack" aria-live="polite">
    <div v-for="notice in notices" :key="notice.id" class="toast-card" :class="notice.type">
      <div><strong>{{ notice.title }}</strong><p>{{ notice.message }}</p></div>
      <button type="button" @click="closeNotice(notice.id)">关闭</button>
    </div>
  </div>
  <div v-if="checking" class="boot-screen"><span class="loading-spinner"></span>正在打开个人服务中心</div>
  <section v-else-if="!user" class="login-screen">
    <header class="public-header">
      <BrandMark :src="branding.logoDataUrl" :name="branding.brandName" />
      <strong>{{ branding.brandName }}</strong><span class="public-header-note">个人服务中心</span><ThemeToggle />
    </header>
    <main class="login-stage">
      <div class="login-caption"><span class="eyebrow">PERSONAL SERVICE CENTER</span><h1>每一项服务，<br />都井然有序。</h1><p>登录后查看可用服务、获取连接信息，并管理账户余额。</p></div>
      <form class="login-panel" autocomplete="on" @submit.prevent="login">
        <div class="login-heading"><span class="section-number">欢迎回来</span><h2>登录你的账户</h2><p>使用管理员为你开通的账号。</p></div>
        <p v-if="loginError" class="user-feedback error" role="alert"><CircleAlert :size="16" />{{ loginError }}</p>
        <label class="login-form-group"><span>登录账号</span><span class="login-field"><UserRound :size="17" /><input v-model="loginForm.username" name="shiye-user-username" placeholder="输入登录账号" autocomplete="username" required /></span></label>
        <label class="login-form-group"><span>登录密码</span><span class="login-field"><LockKeyhole :size="17" /><input v-model="loginForm.password" name="shiye-user-passcode" type="password" placeholder="输入登录密码" autocomplete="current-password" required /></span></label>
        <button class="login-submit" :disabled="loggingIn || !loginForm.username || !loginForm.password"><span>{{ loggingIn ? '正在登录…' : '进入个人服务中心' }}</span><ArrowRight :size="18" /></button>
        <div class="login-security-note"><ShieldCheck :size="15" />账号或密码有疑问？请联系管理员。</div>
      </form>
    </main>
    <footer class="public-footer">{{ branding.brandName }}<span>服务管理 · 账户中心</span></footer>
  </section>
  <div v-else class="user-portal">
    <a href="#workspace-content" class="skip-link">跳到页面内容</a>
    <aside class="portal-sidebar"><router-link to="/" class="portal-brand"><BrandMark :src="branding.logoDataUrl" :name="branding.brandName" /><span><strong>{{ branding.brandName }}</strong><small>个人服务中心</small></span></router-link><div class="portal-nav-label">我的工作区</div><nav class="portal-nav" aria-label="主导航"><router-link v-for="item in nav" :key="item.to" :to="item.to" @mouseenter="preloadRoute(item.to)" @focus="preloadRoute(item.to)"><component :is="item.icon" :size="20" /><span>{{ item.label }}</span><ChevronRight :size="14" class="nav-arrow" /></router-link></nav><div class="portal-sidebar-note"><ShieldCheck :size="22" /><strong>让连接更简单</strong><p>查看服务、管理余额，<br />每一步都清晰可见。</p></div><div class="portal-sidebar-account"><span class="user-avatar" :style="userAvatarStyle(displayName)">{{ currentUserInitial }}</span><span><strong>{{ displayName }}</strong><small>@{{ displayLoginUsername }}</small></span><button class="icon-button" title="退出登录" aria-label="退出登录" @click="logout"><LogOut :size="17" /></button></div></aside>
    <div class="portal-workspace"><header class="portal-header"><div class="portal-mobile-brand"><BrandMark :src="branding.logoDataUrl" :name="branding.brandName" /><strong>{{ branding.brandName }}</strong></div><div class="portal-location"><span>个人中心</span><ChevronRight :size="14" /><strong>{{ currentPageTitle }}</strong></div><div class="portal-account"><ThemeToggle /><router-link to="/profile" class="account-entry" aria-label="账户设置"><span class="user-avatar" :style="userAvatarStyle(displayName)">{{ currentUserInitial }}</span><span>{{ displayName }}</span></router-link><button class="icon-button mobile-logout" aria-label="退出登录" @click="logout"><LogOut :size="17" /></button></div></header>
    <main id="workspace-content" class="user-main route-stage" :aria-label="currentPageTitle"><div class="route-progress" :class="{ active: routeLoading }" aria-hidden="true"><span></span></div><div v-if="routeLoadError" class="route-load-error" role="alert"><CircleAlert :size="20" /><div><strong>页面加载失败</strong><span>{{ routeLoadError }}</span></div><button type="button" @click="reloadPage">刷新重试</button></div><router-view v-else v-slot="{ Component }"><Suspense><component :is="Component" /><template #fallback><div class="route-loading-panel"><span class="loading-spinner"></span><strong>正在加载页面</strong></div></template></Suspense></router-view></main>
    <footer class="portal-footer"><span>{{ branding.brandName }} · 个人服务中心</span><span>v{{ appVersion }}</span></footer></div>
  </div>
</template>
