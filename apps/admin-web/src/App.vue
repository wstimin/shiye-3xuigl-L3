<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { useRoute } from 'vue-router';
import { ArrowRight, ChevronRight, CircleAlert, ClipboardList, CreditCard, GitBranch, HeartPulse, LayoutDashboard, LockKeyhole, LogOut, Menu, Network, ReceiptText, Router, Settings, ShieldCheck, UserRound, Users, WalletCards, X } from 'lucide-vue-next';
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
    <div class="login-theme"><ThemeToggle /></div>
    <div class="login-layout">
      <section class="login-intro" aria-labelledby="admin-login-title">
        <div class="intro-brand-row">
          <BrandMark :src="branding.logoDataUrl" :name="branding.brandName" />
          <div class="intro-brand-copy">
            <strong>{{ branding.brandName }}</strong>
            <span><i></i>运维控制台运行中</span>
          </div>
        </div>

        <div class="intro-content">
          <p class="intro-kicker">ONE WORKSPACE. EVERY CONNECTION.</p>
          <h1 id="admin-login-title">连接每个节点，<br />掌握每一程。</h1>
          <p class="intro-description">集中维护面板连接、入站用户和节点配置，完成创建、删除、同步、流量状态检查与运行诊断。</p>
          <div class="login-feature-list">
            <div class="login-feature-item">
              <span class="feature-icon"><Network :size="18" /></span>
              <div><strong>双引擎，一个工作区</strong><span>集中接入 3x-ui 与 S-UI，管理 Xray 与 sing-box</span></div>
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
            <BrandMark :src="branding.logoDataUrl" :name="branding.brandName" />
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

  <div v-else class="shell overview-shell" :class="{ 'mobile-nav-open': mobileNavOpen, 'overview-home': route.path === '/'  }">
    <a class="skip-link" href="#admin-content">跳到页面内容</a>
    <header class="workspace-header">
      <router-link to="/" class="workspace-brand"><BrandMark :src="branding.logoDataUrl" :name="branding.brandName" /><span><strong>{{ branding.brandName }}</strong><small>管理控制台</small></span></router-link>
      <nav class="workspace-sections" aria-label="工作区分组"><router-link v-for="section in navSections" :key="section.label" :to="section.items[0]!.to" :class="{ selected: activeSection === section }">{{ section.label }}</router-link></nav>
      <div class="workspace-tools"><ThemeToggle /><span class="admin-identity"><UserRound :size="17" />{{ user.username }}</span><button class="icon-button" aria-label="退出登录" title="退出登录" @click="logout"><LogOut :size="17" /></button></div>
    </header>
    <button v-if="mobileNavOpen" class="mobile-nav-backdrop" type="button" aria-label="关闭导航" @click="mobileNavOpen = false"></button>
    <aside class="sidebar" aria-label="管理后台导航">
      <div class="context-label"><span>{{ activeSection.label }}</span><button class="mobile-nav-close" aria-label="关闭导航" @click="mobileNavOpen = false"><X :size="18" /></button></div>
      <nav class="sidebar-scroll"><section v-for="section in navSections" :key="section.label" class="nav-section" :class="{ 'context-active': activeSection === section }"><div class="nav-section-title">{{ section.label }}</div><router-link v-for="item in section.items" :key="item.to" :to="item.to" class="nav-item" :class="{ 'router-link-active': route.path === '/xui-native' && item.to === '/xui-servers' }" @mouseenter="preloadRoute(item.to)" @focus="preloadRoute(item.to)"><component :is="item.icon" :size="19" /><span>{{ item.label }}</span><ArrowRight :size="14" class="nav-arrow" /></router-link></section></nav>
      <div class="workspace-note"><ShieldCheck :size="19" /><strong>统一服务管理</strong><span>面板、业务与网络<br />集中协作，清晰可控。</span><small>v{{ appVersion }}</small></div>
    </aside>
    <div class="admin-workspace"><div class="topbar"><button class="mobile-nav-toggle" type="button" aria-label="打开导航" @click="mobileNavOpen = true"><Menu :size="20" /></button><span>{{ activeSection.label }}</span><ChevronRight :size="14" /><strong>{{ currentRouteLabel }}</strong><router-link to="/diagnostics" class="workspace-status"><i></i>运行诊断</router-link></div>
      <main id="admin-content" class="route-stage"><div class="route-progress" :class="{ active: routeLoading }" aria-hidden="true"><span></span></div><div v-if="routeLoadError" class="route-load-error" role="alert"><CircleAlert :size="20" /><div><strong>页面加载失败</strong><span>{{ routeLoadError }}</span></div><button type="button" @click="reloadPage">刷新重试</button></div><router-view v-else v-slot="{ Component }"><Suspense><component :is="Component" /><template #fallback><div class="route-loading-panel"><span></span><strong>正在加载页面</strong></div></template></Suspense></router-view></main>
    </div>
  </div>
</template>
