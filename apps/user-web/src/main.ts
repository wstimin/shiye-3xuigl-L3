import '../../web-shared/theme.css';
import './styles.css';
import { createApp } from 'vue';
import App from './App.vue';
import { installAssetRecovery } from './stability';
import { router } from './router';

installAssetRecovery();

const app = createApp(App).use(router);

void router.isReady().then(() => app.mount('#app'));
import './workspace.css';
