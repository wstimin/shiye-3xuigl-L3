import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const adminRouter = readFileSync('apps/admin-web/src/router.ts', 'utf8');
const userRouter = readFileSync('apps/user-web/src/router.ts', 'utf8');
const adminMain = readFileSync('apps/admin-web/src/main.ts', 'utf8');
const userMain = readFileSync('apps/user-web/src/main.ts', 'utf8');
const adminVite = readFileSync('apps/admin-web/vite.config.ts', 'utf8');
const userVite = readFileSync('apps/user-web/vite.config.ts', 'utf8');

test('frontend views remain route-lazy and expose transition state', () => {
  for (const source of [adminRouter, userRouter]) {
    assert.equal(source.includes("() => import('./views/"), true);
    assert.equal(source.includes('export const routeLoading = ref(false)'), true);
    assert.equal(source.includes('router.onError'), true);
  }
  assert.doesNotMatch(adminRouter, /import DashboardView from/);
  assert.doesNotMatch(userRouter, /import HomeView from/);
});

test('frontend entrypoints avoid unused stores and full Element Plus installation', () => {
  assert.equal(adminMain.includes('createPinia'), false);
  assert.equal(adminMain.includes('.use(ElementPlus)'), false);
  assert.doesNotMatch(userMain, /createPinia|pinia/);
  assert.equal(adminMain.includes('app.use(ElLoading).use(router)'), true);
});

test('frontend builds keep stable vendor chunks', () => {
  assert.match(adminVite, /manualChunks/);
  assert.equal(adminVite.includes("return 'ui-vendor'"), false);
  assert.match(adminVite, /return 'vue-vendor'/);
  assert.match(userVite, /manualChunks/);
  assert.match(userVite, /return 'qrcode-vendor'/);
  assert.match(userVite, /return 'vue-vendor'/);
});
