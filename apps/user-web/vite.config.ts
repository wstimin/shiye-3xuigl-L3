import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  base: '/',
  plugins: [vue()],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3388'
    }
  },
  build: {
    outDir: '../../dist/user-web',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('qrcode')) return 'qrcode-vendor';
          if (id.includes('lucide-vue-next')) return 'icons-vendor';
          if (id.includes('/vue/') || id.includes('vue-router') || id.includes('@vue/')) return 'vue-vendor';
          return 'vendor';
        }
      }
    }
  }
});
