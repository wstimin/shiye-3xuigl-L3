<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowRight, CircleAlert, ClipboardList, CreditCard, GitBranch, HeartPulse, LayoutDashboard, LockKeyhole, LogOut, Menu, Network, ReceiptText, Router, Settings, ShieldCheck, UserRound, Users, WalletCards, X } from 'lucide-vue-next';
import { api, onSessionExpired } from './api';
import { preloadRoute, routeLoadError, routeLoading } from './router';

type SessionUser = { role: string; username: string };
type Branding = { brandName: string; logoDataUrl: string };

const fallbackBrandName = '十夜管理后台';
const brandingUpdatedEvent = 'shiye:branding-updated';
const appVersion = __SHIYE_BUILD_INFO__.version;
const navSections = [
  { label: '总览看板', items: [{ to: '/', label: '数据概览', icon: LayoutDashboard }] },
  {
    label: '业务管理',
    items: [
      { to: '/customers', label: '用户管理', icon: Users },
      { to: '/nodes', label: '路由节点', icon: Router }
    ]
  },
  {
    label: '网络配置',
    items: [
      { to: '/xui-servers', label: '面板连接', icon: Network },
      { to: '/socks-nodes', label: '出站节点', icon: ShieldCheck },
      { to: '/network-config', label: '出站与路由', icon: GitBranch },
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
  { label: '系统配置', items: [{ to: '/settings', label: '系统设置', icon: Settings }] }
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
const isDashboardRoute = computed(() => route.path === '/');
const darkAdminRoutes = new Set(['/', '/customers', '/nodes', '/xui-servers', '/socks-nodes', '/network-config', '/sync-logs', '/diagnostics', '/finance', '/cards', '/payments', '/settings']);
const isDarkAdminRoute = computed(() => darkAdminRoutes.has(route.path));
const currentRouteLabel = computed(() => {
  if (route.path === '/') return '数据概览';
  if (route.path === '/customers') return '用户管理';
  if (route.path === '/nodes') return '路由节点';
  if (route.path === '/xui-servers') return '\u9762\u677f\u8fde\u63a5';
  if (route.path === '/socks-nodes') return '\u51fa\u7ad9\u8282\u70b9';
  if (route.path === '/network-config') return '\u51fa\u7ad9\u4e0e\u8def\u7531';
  if (route.path === '/sync-logs') return '\u540c\u6b65\u65e5\u5fd7';
  if (route.path === '/diagnostics') return '\u5065\u5eb7\u8bca\u65ad';
  if (route.path === '/finance') return '\u8d22\u52a1\u8bb0\u5f55';
  if (route.path === '/cards') return '\u5361\u5bc6\u7ba1\u7406';
  if (route.path === '/payments') return '\u652f\u4ed8\u8bbe\u7f6e';
  if (route.path === '/settings') return '\u7cfb\u7edf\u8bbe\u7f6e';
  return '';
});

watch(() => route.path, () => {
  mobileNavOpen.value = false;
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

onMounted(async () => {
  stopSessionExpired = onSessionExpired(handleSessionExpired);
  window.addEventListener(brandingUpdatedEvent, handleBrandingUpdated);
  await loadBranding();
  await loadMe();
});

onUnmounted(() => {
  stopSessionExpired?.();
  window.removeEventListener(brandingUpdatedEvent, handleBrandingUpdated);
});
</script>

<template>
  <div v-if="checking" class="boot-screen">正在检查登录状态</div>

  <div v-else-if="!user" class="login-screen admin-login-screen">
    <div class="login-layout">
      <section class="login-intro" aria-labelledby="admin-login-title">
        <div class="intro-brand-row">
          <div class="intro-brand-mark">
            <img v-if="branding.logoDataUrl" :src="branding.logoDataUrl" alt="Logo" />
            <span v-else>{{ branding.brandName.slice(0, 1) }}</span>
          </div>
          <div class="intro-brand-copy">
            <strong>{{ branding.brandName }}</strong>
            <span><i></i>运维控制台运行中</span>
          </div>
        </div>

        <div class="intro-content">
          <p class="intro-kicker">XUI MANAGEMENT CONSOLE</p>
          <h1 id="admin-login-title">统一管理 XUI 节点与用户服务</h1>
          <p class="intro-description">集中维护面板连接、入站用户和节点配置，完成创建、删除、同步、流量状态检查与运行诊断。</p>
          <div class="login-feature-list">
            <div class="login-feature-item">
              <span class="feature-icon"><Network :size="18" /></span>
              <div><strong>面板与节点</strong><span>维护 XUI 面板连接、路由节点与出站配置</span></div>
            </div>
            <div class="login-feature-item">
              <span class="feature-icon"><Users :size="18" /></span>
              <div><strong>用户与入站</strong><span>创建、删除用户并管理入站及服务配置</span></div>
            </div>
            <div class="login-feature-item">
              <span class="feature-icon"><HeartPulse :size="18" /></span>
              <div><strong>同步与诊断</strong><span>同步节点数据，查看流量状态和执行日志</span></div>
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
            <div><strong>{{ branding.brandName }}</strong><span>管理端</span></div>
          </div>

          <div class="login-heading">
            <h2>登录管理端</h2>
            <p>请输入管理员账号和密码继续</p>
          </div>

          <div v-if="loginError" class="login-error" role="alert">
            <CircleAlert :size="17" />
            <span>{{ loginError }}</span>
          </div>

          <label class="login-form-group">
            <span>管理员账号</span>
            <span class="login-field">
              <UserRound :size="18" />
              <input v-model="loginForm.username" name="shiye-admin-account" placeholder="请输入管理员账号" autocomplete="username" />
            </span>
          </label>
          <label class="login-form-group">
            <span>密码</span>
            <span class="login-field">
              <LockKeyhole :size="18" />
              <input v-model="loginForm.password" name="shiye-admin-passcode" type="password" placeholder="请输入密码" autocomplete="current-password" />
            </span>
          </label>
          <button class="login-submit" :disabled="loggingIn || !loginForm.username || !loginForm.password">
            <span>{{ loggingIn ? '正在验证' : '登录控制台' }}</span>
            <ArrowRight :size="18" />
          </button>
          <div class="login-security-note"><ShieldCheck :size="15" />管理员身份验证</div>
        </form>
      </main>
    </div>
  </div>

  <el-container v-else class="shell" :class="{ 'overview-shell': isDarkAdminRoute, 'mobile-nav-open': mobileNavOpen }">
    <button v-if="mobileNavOpen" class="mobile-nav-backdrop" type="button" aria-label="关闭导航" @click="mobileNavOpen = false"></button>
    <el-aside width="220px" class="sidebar" aria-label="管理后台导航">
      <div class="brand">
        <img v-if="branding.logoDataUrl" :src="branding.logoDataUrl" alt="Logo" />
        <span v-else class="brand-mark">{{ branding.brandName.slice(0, 1) }}</span>
        <strong>{{ branding.brandName }}</strong>
        <button class="mobile-nav-close" type="button" aria-label="关闭导航" title="关闭导航" @click="mobileNavOpen = false"><X :size="18" /></button>
      </div>
      <nav class="sidebar-scroll">
        <section v-for="section in navSections" :key="section.label" class="nav-section">
          <div class="nav-section-title">{{ section.label }}</div>
          <router-link v-for="item in section.items" :key="item.to" :to="item.to" class="nav-item" :title="item.label" @mouseenter="preloadRoute(item.to)" @focus="preloadRoute(item.to)">
            <component :is="item.icon" :size="18" />
            <span>{{ item.label }}</span>
          </router-link>
        </section>
      </nav>
      <div class="sidebar-footer">
        <div class="sidebar-user-card">
          <span class="sidebar-user-avatar">{{ user.username.slice(0, 1).toUpperCase() }}</span>
          <div class="sidebar-user">
            <strong>{{ user.username }}</strong>
            <span>超级管理员</span>
          </div>
        </div>
        <el-button text class="logout-button" @click="logout"><LogOut :size="16" />退出登录</el-button>
        <div class="sidebar-version" aria-label="当前版本">Version {{ appVersion }}</div>
      </div>
    </el-aside>
    <el-container class="admin-workspace">
      <el-header class="topbar">
        <div class="topbar-heading">
          <button class="mobile-nav-toggle" type="button" aria-label="打开导航" title="打开导航" @click="mobileNavOpen = true"><Menu :size="19" /></button>
          <strong>管理后台</strong>
          <span v-if="currentRouteLabel">/ <b>{{ currentRouteLabel }}</b></span>
        </div>
        <div v-if="isDarkAdminRoute" class="topbar-user-badge"><i></i>{{ user.username }}</div>
        <el-tag v-else size="small" type="success">{{ user.username }}</el-tag>
      </el-header>
      <el-main class="route-stage">
        <div class="route-progress" :class="{ active: routeLoading }" aria-hidden="true"><span></span></div>
        <div v-if="routeLoadError" class="route-load-error" role="alert">
          <CircleAlert :size="20" />
          <div><strong>页面加载失败</strong><span>{{ routeLoadError }}</span></div>
          <button type="button" @click="reloadPage">刷新重试</button>
        </div>
        <router-view v-else v-slot="{ Component }">
          <Suspense>
            <component :is="Component" />
            <template #fallback><div class="route-loading-panel"><span></span><strong>正在加载页面</strong></div></template>
          </Suspense>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>
