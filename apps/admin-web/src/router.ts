import { createRouter, createWebHistory } from 'vue-router';
import DashboardView from './views/DashboardView.vue';
import CustomersView from './views/CustomersView.vue';
import NodesView from './views/NodesView.vue';
import XuiServersView from './views/XuiServersView.vue';
import SocksNodesView from './views/SocksNodesView.vue';
import SyncLogsView from './views/SyncLogsView.vue';
import DiagnosticsView from './views/DiagnosticsView.vue';
import FinanceView from './views/FinanceView.vue';
import CardsView from './views/CardsView.vue';
import PaymentsView from './views/PaymentsView.vue';
import SettingsView from './views/SettingsView.vue';

export const router = createRouter({
  history: createWebHistory(adminBasePath()),
  routes: [
    { path: '/', component: DashboardView },
    { path: '/customers', component: CustomersView },
    { path: '/xui-servers', component: XuiServersView },
    { path: '/nodes', component: NodesView },
    { path: '/socks-nodes', component: SocksNodesView },
    { path: '/sync-logs', component: SyncLogsView },
    { path: '/diagnostics', component: DiagnosticsView },
    { path: '/finance', component: FinanceView },
    { path: '/cards', component: CardsView },
    { path: '/payments', component: PaymentsView },
    { path: '/settings', component: SettingsView }
  ]
});

function adminBasePath() {
  const runtimeBase = (window as Window & { __SHIYE_ADMIN_BASE__?: string }).__SHIYE_ADMIN_BASE__;
  if (runtimeBase) return runtimeBase;
  return import.meta.env.BASE_URL === './' ? '/' : import.meta.env.BASE_URL || '/admin/';
}
