import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import buildInfo from '../../build-info.json';

const buildInfoPlugin = {
  name: 'shiye-build-info',
  transformIndexHtml: {
    order: 'pre' as const,
    handler: () => ({
      tags: [
        { tag: 'meta', attrs: { name: 'shiye-version', content: buildInfo.version }, injectTo: 'head' as const },
        { tag: 'meta', attrs: { name: 'shiye-commit', content: buildInfo.commit }, injectTo: 'head' as const },
        { tag: 'meta', attrs: { name: 'shiye-build-time', content: buildInfo.buildTime }, injectTo: 'head' as const }
      ]
    })
  }
};

export default defineConfig({
  base: './',
  plugins: [vue(), buildInfoPlugin],
  define: { __SHIYE_BUILD_INFO__: JSON.stringify(buildInfo) },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3388'
    }
  },
  build: {
    outDir: '../../dist/admin-web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('element-plus') || id.includes('@element-plus') || id.includes('@vueuse') || id.includes('lodash')) return;
          if (id.includes('lucide-vue-next')) return 'icons-vendor';
          if (id.includes('/vue/') || id.includes('vue-router') || id.includes('@vue/')) return 'vue-vendor';
          return 'vendor';
        }
      }
    }
  }
});
