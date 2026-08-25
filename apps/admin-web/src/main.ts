import 'element-plus/es/components/container/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/tag/style/css';
import 'element-plus/es/components/loading/style/css';
import 'element-plus/es/components/message/style/css';
import 'element-plus/es/components/message-box/style/css';
import './styles.css';
import { createApp } from 'vue';
import { ElAside, ElButton, ElContainer, ElHeader, ElLoading, ElMain, ElMessage, ElTag } from 'element-plus';
import App from './App.vue';
import { installAssetRecovery } from './stability';
import { router } from './router';

installAssetRecovery();

const app = createApp(App);
for (const component of [ElAside, ElButton, ElContainer, ElHeader, ElMain, ElTag]) {
  app.component(component.name!, component);
}

app.use(ElLoading).use(router);

const originalError = ElMessage.error;
ElMessage.error = (options) => originalError(typeof options === 'string'
  ? { message: options, duration: 8000, showClose: true, grouping: true, customClass: 'admin-error-message' }
  : { duration: 8000, showClose: true, grouping: true, customClass: 'admin-error-message', ...options });

void router.isReady().then(() => app.mount('#app'));
