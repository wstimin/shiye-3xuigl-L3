import { ref, type Component } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { cancelPendingReadRequests } from './api';

const viewLoaders: Record<string, () => Promise<{ default: Component }>> = {
  '/': () => import('./views/DashboardView.vue'),
  '/customers': () => import('./views/CustomersView.vue'),
  '/xui-servers': () => import('./views/XuiServersView.vue'),
  '/xui-native': () => import('./views/XuiNativeView.vue'),
  '/sui-servers': () => import('./views/SuiServersView.vue'),
  '/nodes': () => import('./views/NodesView.vue'),
  '/network-config': () => import('./views/NetworkConfigView.vue'),
  '/sync-logs': () => import('./views/SyncLogsView.vue'),
  '/diagnostics': () => import('./views/DiagnosticsView.vue'),
  '/finance': () => import('./views/FinanceView.vue'),
  '/cards': () => import('./views/CardsView.vue'),
  '/payments': () => import('./views/PaymentsView.vue'),
  '/settings': () => import('./views/SettingsView.vue'),
  '/maintenance': () => import('./views/MaintenanceView.vue')
};

export const routeLoading = ref(false);
export const routeLoadError = ref('');

export const router = createRouter({
  history: createWebHistory(adminBasePath()),
  scrollBehavior: () => ({ top: 0 }),
  routes: [{ path: '/socks-nodes', redirect: '/network-config?tab=library' }, ...Object.entries(viewLoaders).map(([path, component]) => ({ path, component }))]
});

router.beforeEach(() => {
  cancelPendingReadRequests();
  routeLoading.value = true;
  routeLoadError.value = '';
  return true;
});

router.afterEach(() => {
  routeLoading.value = false;
});

router.onError((error) => {
  routeLoading.value = false;
  routeLoadError.value = '页面加载失败，请刷新重试';
  console.error('Admin route loading failed', error);
});

export function preloadRoute(path: string) {
  void viewLoaders[path]?.().catch(() => undefined);
}

function adminBasePath() {
  const runtimeBase = (window as Window & { __SHIYE_ADMIN_BASE__?: string }).__SHIYE_ADMIN_BASE__;
  if (runtimeBase) return runtimeBase;
  return import.meta.env.BASE_URL === './' ? '/' : import.meta.env.BASE_URL || '/admin/';
}
