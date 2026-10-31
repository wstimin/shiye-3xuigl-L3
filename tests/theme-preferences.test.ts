import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync('apps/web-shared/theme.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText;

function openTheme(entry: 'admin' | 'user', storage = new Map<string, string>(), systemDark = false, blocked = false) {
  const listeners = new Map<string, (event: any) => void>();
  const dataset = { themeEntry: entry, theme: '' };
  const media = { matches: systemDark, addEventListener: (_: string, handler: (event: any) => void) => listeners.set('media', handler) };
  const exports: any = {};
  runInNewContext(source, {
    exports, require: createRequire(import.meta.url),
    localStorage: {
      getItem: (key: string) => { if (blocked) throw Error('Storage blocked'); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw Error('Storage blocked'); storage.set(key, value); }
    },
    document: { documentElement: { dataset, classList: { toggle() {} } }, querySelector: () => null },
    window: { matchMedia: () => media, addEventListener: (name: string, handler: (event: any) => void) => listeners.set(name, handler) }
  });
  return { ...exports, dataset, storage, listeners };
}

test('admin and user themes remain separate on the same origin', () => {
  const storage = new Map<string, string>();
  const admin = openTheme('admin', storage), user = openTheme('user', storage);
  admin.setTheme('dark');
  user.setTheme('light');
  user.listeners.get('storage')!({ key: 'shiye:theme:admin' });
  admin.listeners.get('storage')!({ key: 'shiye:theme:user' });
  assert.equal(admin.dataset.theme, 'dark');
  assert.equal(user.dataset.theme, 'light');
  assert.equal(openTheme('admin', storage).dataset.theme, 'dark');
  assert.equal(openTheme('user', storage).dataset.theme, 'light');
});

test('accounts restore their own choice by stable customer ID and do not inherit another account or guest', () => {
  const user = openTheme('user');
  user.setTheme('dark');
  user.setThemeAccount('customer-a');
  assert.equal(user.dataset.theme, 'light');
  user.setTheme('dark');
  user.setThemeAccount('customer-b');
  assert.equal(user.dataset.theme, 'light');
  user.setTheme('light');
  user.setThemeAccount('customer-a');
  assert.equal(user.dataset.theme, 'dark');
  user.setThemeAccount(null);
  assert.equal(user.dataset.theme, 'dark');
  const refreshed = openTheme('user', user.storage);
  refreshed.setThemeAccount('customer-b');
  assert.equal(refreshed.dataset.theme, 'light');
});

test('storage events synchronize only the current account, including clearing storage', () => {
  const storage = new Map<string, string>();
  const a = openTheme('user', storage), aTab = openTheme('user', storage), b = openTheme('user', storage);
  a.setThemeAccount('a'); aTab.setThemeAccount('a'); b.setThemeAccount('b');
  a.setTheme('dark');
  for (const tab of [aTab, b]) tab.listeners.get('storage')!({ key: 'shiye:theme:user:a' });
  assert.equal(aTab.dataset.theme, 'dark');
  assert.equal(b.dataset.theme, 'light');
  storage.clear(); aTab.listeners.get('storage')!({ key: null });
  assert.equal(aTab.dataset.theme, 'light');
});

test('following the system stays independent and overrides the old shared preference', () => {
  const storage = new Map([['shiye:theme', 'dark']]);
  const admin = openTheme('admin', storage), user = openTheme('user', storage);
  assert.equal(admin.dataset.theme, 'dark');
  assert.equal(user.dataset.theme, 'light');
  admin.setTheme('system');
  assert.equal(openTheme('admin', storage).dataset.theme, 'light');
  admin.listeners.get('media')!({ matches: true });
  assert.equal(admin.dataset.theme, 'dark');
  user.setTheme('light'); user.listeners.get('media')!({ matches: true });
  assert.equal(user.dataset.theme, 'light');
});

test('blocked browser storage does not break switching themes or accounts', () => {
  const user = openTheme('user', new Map(), false, true);
  user.setThemeAccount('a'); user.setTheme('dark');
  assert.equal(user.dataset.theme, 'dark');
  user.setThemeAccount('b');
  assert.equal(user.dataset.theme, 'light');
});

test('first-paint themes use separate entry keys and never reuse a previous user account', () => {
  for (const entry of ['admin', 'user']) {
    const html = readFileSync(`apps/${entry === 'admin' ? 'admin' : 'user'}-web/index.html`, 'utf8');
    const bootstrap = html.match(/<script>\s*(try \{[^<]+)<\/script>/)?.[1];
    assert.ok(bootstrap);
    const storage = new Map([['shiye:theme:admin', 'dark'], ['shiye:theme:user', 'light'], ['shiye:theme:user:a', 'dark']]);
    const document = { documentElement: { dataset: { theme: '' } } };
    runInNewContext(bootstrap, { document, localStorage: { getItem: (key: string) => storage.get(key) ?? null }, matchMedia: () => ({ matches: false }) });
    assert.equal(document.documentElement.dataset.theme, entry === 'admin' ? 'dark' : 'light');
  }
});
