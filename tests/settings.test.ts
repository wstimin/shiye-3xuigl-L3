import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SettingsService } from '../apps/api/src/modules/settings/settings.service.js';

type SettingRow = { key: string; value: unknown };

function settingsFixture(initial: SettingRow[] = []) {
  const rows = new Map(initial.map((row) => [row.key, row]));
  const prisma = {
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
    systemSetting: {
      findUnique: async ({ where }: any) => rows.get(where.key) || null,
      upsert: async ({ where, create, update }: any) => {
        const saved = rows.has(where.key) ? { ...rows.get(where.key), ...update } : { ...create };
        rows.set(where.key, saved);
        return saved;
      }
    }
  };
  return { rows, service: new SettingsService(prisma as never) };
}

test('system settings remain available after saving and creating a fresh service instance', async () => {
  const { rows, service } = settingsFixture();
  await service.updateSettings({
    brand: { brandName: '自定义面板', logoDataUrl: 'data:image/png;base64,AA==' },
    business: { cardPurchaseUrl: 'https://example.com/cards' }
  });

  const reloaded = new SettingsService({
    systemSetting: { findUnique: async ({ where }: any) => rows.get(where.key) || null }
  } as never);
  const settings = await reloaded.adminSettings();
  assert.equal(settings.brand.brandName, '自定义面板');
  assert.equal(settings.brand.logoDataUrl, 'data:image/png;base64,AA==');
  assert.equal(settings.business.cardPurchaseUrl, 'https://example.com/cards');
  assert.deepEqual(rows.get('brand:custom')?.value, { brandName: '自定义面板', logoDataUrl: 'data:image/png;base64,AA==' });
});

test('custom branding takes priority over the installer default after reload', async () => {
  const { service } = settingsFixture([
    { key: 'brand', value: { brandName: '默认品牌', logoDataUrl: '' } },
    { key: 'brand:custom', value: { brandName: '用户品牌', logoDataUrl: 'data:image/png;base64,BB==' } }
  ]);
  const settings = await service.adminSettings();
  assert.equal(settings.brand.brandName, '用户品牌');
  assert.equal(settings.brand.logoDataUrl, 'data:image/png;base64,BB==');
});

test('saved runtime path is read from the database instead of a stale process value', async () => {
  const previousPath = process.env.ADMIN_PATH;
  process.env.ADMIN_PATH = '/old-admin';
  try {
    const { service } = settingsFixture([{ key: 'runtime', value: { adminPath: '/new-admin' } }]);
    const settings = await service.adminSettings();
    assert.equal(settings.runtime.adminPath, '/new-admin');
    assert.equal(settings.runtime.activeAdminPath, '/new-admin');
  } finally {
    if (previousPath === undefined) delete process.env.ADMIN_PATH;
    else process.env.ADMIN_PATH = previousPath;
  }
});

test('settings endpoints and frontend reads explicitly bypass caches', async () => {
  const controller = await readFile(new URL('../apps/api/src/modules/settings/settings.controller.ts', import.meta.url), 'utf8');
  const adminApi = await readFile(new URL('../apps/admin-web/src/api.ts', import.meta.url), 'utf8');
  const settingsView = await readFile(new URL('../apps/admin-web/src/views/SettingsView.vue', import.meta.url), 'utf8');
  assert.match(controller, /Cache-Control', 'no-store, no-cache, must-revalidate/);
  assert.match(adminApi, /cache: safeRead \? 'no-store'/);
  assert.ok(settingsView.includes("await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: payload });"));
  assert.match(settingsView, /const settings = await fetchSettings\(\);\s*assertSettingsMatch\(payload, settings\);/);
});
