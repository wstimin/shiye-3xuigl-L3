<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowRight, ChevronRight, CircleAlert, ClipboardList, CreditCard, GitBranch, HeartPulse, LayoutDashboard, LogOut, Menu, Network, ReceiptText, Router, Settings, ShieldCheck, UserRound, Users, WalletCards, X } from 'lucide-vue-next';
import LoginScreen from '../../web-shared/LoginScreen.vue';
import BrandMark from '../../web-shared/BrandMark.vue';
import ThemeToggle from '../../web-shared/ThemeToggle.vue';
import { applyBranding } from '../../web-shared/branding';
import { api, onSessionExpired } from './api';
import { preloadRoute, routeLoadError, routeLoading } from './router';

type SessionUser = { role: string; username: string };
type Branding = { brandName: string; logoDataUrl: string };

const fallbackBrandName = '十夜服务中心';
const brandingUpdatedEvent = 'shiye:branding-updated';
const appVersion = __SHIYE_BUILD_INFO__.version;
const navSections = [
  { label: '总览看板', items: [{ to: '/', label: '数据概览', icon: LayoutDashboard }] },
  {
    label: '业务管理',
    items: [
      { to: '/customers', label: '用户管理', icon: Users },
      { to: '/nodes', label: '服务入站', icon: Router }
    ]
  },
  {
    label: '网络配置',
    items: [
      { to: '/xui-servers', label: '3x-ui 面板', icon: Network },
      { to: '/sui-servers', label: 'S-UI 面板', icon: Router },
      { to: '/network-config', label: '网络规则', icon: GitBranch },
      { to: '/sync-logs', label: '同步日志', icon: ClipboardList },
      { to: '/diagnostics', label: '健康诊断', icon: HeartPulse }
    ]
  },
  {
    label: '财务管理',
    items: [
      { to: '/finance', label: '财务记录', icon: WalletCards },
      { to: '/cards', label: '卡密管理', icon: CreditCard },
      { to: '/payments', label: '支付设置', icon: ReceiptText }
    ]
  },
  { label: '系统配置', items: [{ to: '/settings', label: '系统设置', icon: Settings }, { to: '/maintenance', label: '更新与迁移', icon: ShieldCheck }] }
];

const checking = ref(true);
const loggingIn = ref(false);
const loginError = ref('');
const mobileNavOpen = ref(false);
const user = ref<SessionUser | null>(null);
const branding = reactive<Branding>({ brandName: fallbackBrandName, logoDataUrl: '' });
const loginForm = reactive({ username: '', password: '' });
const route = useRoute();
let stopSessionExpired: (() => void) | undefined;
const activeSection = computed(() => navSections.find(section => section.items.some(item => item.to === route.path || item.to === '/xui-servers' && route.path === '/xui-native')) || navSections[0]!);
const currentRouteLabel = computed(() => route.path === '/xui-native' ? '3x-ui 面板管理' : navSections.flatMap(section => section.items).find(item => item.to === route.path)?.label || '');

watch(() => route.path, () => {
  mobileNavOpen.value = false;
});

watch(user, session => {
  if (session) window.setTimeout(() => {
    if (user.value) for (const path of ['/customers', '/nodes', '/xui-servers']) preloadRoute(path);
  }, 800);
});

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
    const session = await api<SessionUser>('/api/auth/me?entry=admin');
    user.value = session.role === 'admin' ? session : null;
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
    const session = await api<SessionUser>('/api/login', { method: 'POST', body: { ...loginForm, entry: 'admin' } });
    if (session.role !== 'admin') {
      await api('/api/logout', { method: 'POST', body: { entry: 'admin' } }).catch(() => undefined);
      throw new Error('当前账号不是管理员');
    }
    user.value = session;
    Object.assign(loginForm, { username: '', password: '' });
  } catch {
    loginError.value = '登录失败';
  } finally {
    loggingIn.value = false;
  }
}

async function logout() {
  mobileNavOpen.value = false;
  await api('/api/logout', { method: 'POST', body: { entry: 'admin' } }).catch(() => undefined);
  user.value = null;
}

function applyBrowserBranding(settings: Branding) { applyBranding(settings, fallbackBrandName); }

function handleSessionExpired() {
  if (!user.value) return;
  user.value = null;
  mobileNavOpen.value = false;
  loginError.value = '登录已失效';
}

function handleBrandingUpdated(event: Event) {
  const next = (event as CustomEvent<Partial<Branding>>).detail || {};
  branding.brandName = next.brandName || fallbackBrandName;
  branding.logoDataUrl = next.logoDataUrl || '';
  applyBrowserBranding(branding);
}

function reloadPage() {
  window.location.reload();
}

onMounted(() => {
  stopSessionExpired = onSessionExpired(handleSessionExpired);
  window.addEventListener(brandingUpdatedEvent, handleBrandingUpdated);
  void loadBranding();
  void loadMe();
});

onUnmounted(() => {
  stopSessionExpired?.();
  window.removeEventListener(brandingUpdatedEvent, handleBrandingUpdated);
});
</script>

<template>
  <div v-if="checking" class="boot-screen">正在检查登录状态</div>

  <LoginScreen v-else-if="!user" entry="admin" :brand="branding" v-model:username="loginForm.username" v-model:password="loginForm.password" :busy="loggingIn" :error="loginError" @submit="login" />
  <div v-else class="shell overview-shell" :class="{ 'mobile-nav-open': mobileNavOpen }">
    <a class="skip-link" href="#admin-content">跳到页面内容</a>
    <button v-if="mobileNavOpen" class="mobile-nav-backdrop" type="button" aria-label="关闭导航" @click="mobileNavOpen = false"></button>
    <aside class="sidebar" aria-label="管理后台导航">
      <div class="sidebar-heading"><router-link to="/" class="workspace-brand"><BrandMark :src="branding.logoDataUrl" :name="branding.brandName" /><span><strong>{{ branding.brandName }}</strong><small>管理控制台</small></span></router-link><button class="mobile-nav-close" aria-label="关闭导航" @click="mobileNavOpen = false"><X :size="18" /></button></div>
      <nav class="sidebar-scroll"><section v-for="section in navSections" :key="section.label" class="nav-section"><div class="nav-section-title">{{ section.label }}</div><router-link v-for="item in section.items" :key="item.to" :to="item.to" class="nav-item" :class="{ 'router-link-active': route.path === '/xui-native' && item.to === '/xui-servers' }" @mouseenter="preloadRoute(item.to)" @focus="preloadRoute(item.to)"><component :is="item.icon" :size="18" /><span>{{ item.label }}</span><ArrowRight :size="14" class="nav-arrow" /></router-link></section></nav>
      <footer class="sidebar-footer"><div class="admin-identity"><UserRound :size="18" /><span><strong>{{ user.username }}</strong><small>管理员 · v{{ appVersion }}</small></span></div><button class="icon-button" aria-label="退出登录" title="退出登录" @click="logout"><LogOut :size="17" /></button></footer>
    </aside>
    <div class="admin-workspace"><header class="topbar"><button class="mobile-nav-toggle" type="button" aria-label="打开导航" :aria-expanded="mobileNavOpen" @click="mobileNavOpen = true"><Menu :size="20" /></button><span>{{ activeSection.label }}</span><ChevronRight :size="14" /><strong>{{ currentRouteLabel }}</strong><div class="workspace-tools"><router-link to="/diagnostics" class="workspace-status"><i></i>运行诊断</router-link><ThemeToggle /></div></header>
      <main id="admin-content" class="route-stage"><div class="route-progress" :class="{ active: routeLoading }" aria-hidden="true"><span></span></div><div v-if="routeLoadError" class="route-load-error" role="alert"><CircleAlert :size="20" /><div><strong>页面加载失败</strong><span>{{ routeLoadError }}</span></div><button type="button" @click="reloadPage">刷新重试</button></div><router-view v-else v-slot="{ Component }"><Suspense><component :is="Component" /><template #fallback><div class="route-loading-panel"><span></span><strong>正在加载页面</strong></div></template></Suspense></router-view></main>
    </div>
  </div>
</template>
