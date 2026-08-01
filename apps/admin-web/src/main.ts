import 'element-plus/dist/index.css';
import './styles.css';
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ElementPlus from 'element-plus';
import App from './App.vue';
import { installAssetRecovery } from './stability';
import { router } from './router';

installAssetRecovery();

createApp(App).use(createPinia()).use(router).use(ElementPlus).mount('#app');
