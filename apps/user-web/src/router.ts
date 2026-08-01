import { ref, type Component } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import { cancelPendingReadRequests } from './api';

const viewLoaders: Record<string, () => Promise<{ default: Component }>> = {
  '/': () => import('./views/HomeView.vue'),
  '/nodes': () => import('./views/NodesView.vue'),
  '/finance': () => import('./views/FinanceView.vue'),
  '/profile': () => import('./views/ProfileView.vue'),
  '/payment/result': () => import('./views/PaymentResultView.vue')
};

export const routeLoading = ref(false);
export const routeLoadError = ref('');

export const router = createRouter({
  history: createWebHistory('/'),
  routes: Object.entries(viewLoaders).map(([path, component]) => ({ path, component }))
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
  console.error('User route loading failed', error);
});

export function preloadRoute(path: string) {
  void viewLoaders[path]?.().catch(() => undefined);
}
