import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: './',
  plugins: [vue()],
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
