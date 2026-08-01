import './styles.css';
import { createApp } from 'vue';
import App from './App.vue';
import { installAssetRecovery } from './stability';
import { router } from './router';

installAssetRecovery();

createApp(App).use(router).mount('#app');
