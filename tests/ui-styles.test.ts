import test from 'node:test';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { readFileSync } from 'node:fs';

const adminStyles = readFileSync('apps/admin-web/src/styles.css', 'utf8');
const userStyles = readFileSync('apps/user-web/src/styles.css', 'utf8');
const financeView = readFileSync('apps/admin-web/src/views/FinanceView.vue', 'utf8');
const adminMain = readFileSync('apps/admin-web/src/main.ts', 'utf8');
const adminHtml = readFileSync('apps/admin-web/index.html', 'utf8');
const themeStyles = readFileSync('apps/web-shared/theme.css', 'utf8');

test('bootstrap supports both themes before application code loads', () => {
  const workspaceBackground = themeStyles.match(/--bg:\s*(#[\da-f]{6})/i)?.[1];
  assert.ok(workspaceBackground);
  const canvasBackground = adminHtml.match(/html, body, #app\s*\{[^}]*background:\s*(#[\da-f]{6})/i)?.[1];
  assert.equal(canvasBackground, workspaceBackground);
  assert.ok(adminHtml.includes(`name="theme-color" content="${workspaceBackground}"`));
  assert.ok(adminHtml.includes('name="color-scheme" content="light dark"'));
  assert.ok(adminHtml.includes('localStorage.getItem("shiye:theme")'));
  assert.ok(adminHtml.includes('prefers-color-scheme: dark'));
  assert.ok(adminHtml.includes('html[data-theme="dark"]'));
});

test('runtime-generated UI classes keep their visual rules', () => {
  for (const selector of [
    '.el-table .cell',
    '.customer-management-page .el-pagination.is-background .btn-next',
    '.operations-page .el-pagination.is-background .btn-next',
    '.runtime-metric.tone-success',
    '.runtime-metric.tone-warning',
    '.runtime-metric.tone-danger',
    '.payment-console-card.provider-wechat',
    '.payment-console-card.provider-epay',
    '.payment-console-card.provider-bepusdt',
    '.diagnostics-resource-card.tone-cyan',
    '.diagnostics-resource-card.tone-emerald',
    '.diagnostics-resource-card.tone-amber',
    '.node-dialog-section, .xui-dialog-section, .socks-dialog-section, .operations-dialog .dialog-form-section'
  ]) {
    assert.equal(adminStyles.includes(selector), true, 'Missing runtime selector: ' + selector);
  }
});

test('retired UI layers stay removed', () => {
  for (const selector of [
    '.el-drawer',
    '.payment-dialog-form',
    '.bind-panel',
    '.job-card-grid',
    '.diagnostic-grid',
    '.settings-module-card',
    '.route-node-address',
    '.xui-panel-address',
    '.socks-endpoint'
  ]) {
    assert.equal(adminStyles.includes(selector), false, 'Retired admin selector returned: ' + selector);
  }

  for (const selector of ['.app-shell', '.header-brand', '.quick-link-grid', '.profile-panel']) {
    assert.equal(userStyles.includes(selector), false, 'Retired user selector returned: ' + selector);
  }
});

test('user pages remove decorative overlays while retaining functional modal backdrops', () => {
  for (const selector of [
    '.login-screen::before',
    '.login-screen::after',
    '.user-stat-card::after',
    '.node-stat-grid article::after'
  ]) {
    assert.equal(userStyles.includes(selector), false, 'Decorative overlay returned: ' + selector);
  }

  assert.equal(userStyles.includes('.qr-modal'), true);
  assert.equal(userStyles.includes('.user-nav-backdrop'), false);
  assert.equal(userStyles.includes('.user-sidebar'), false);
  assert.equal(userStyles.includes('.user-stat-grid'), false);
  assert.equal(themeStyles.includes('--panel-bg: var(--surface)'), true);
});

test('user and admin load the same theme palette rather than independent color overrides', () => {
  assert.ok(adminMain.includes("import '../../web-shared/theme.css'"));
  assert.ok(readFileSync('apps/user-web/src/main.ts', 'utf8').includes("import '../../web-shared/theme.css'"));
  assert.ok(themeStyles.includes(':root[data-theme="dark"]'));
  const html = readFileSync('apps/user-web/index.html', 'utf8');
  assert.ok(html.includes('background: #f7f8fa'));
  assert.ok(html.includes('name="color-scheme" content="light dark"'));
});

test('user stylesheet has no repeated selectors in the same media context', () => {
  const seen = new Set<string>();
  postcss.parse(userStyles).walkRules(rule => {
    const parents: string[] = [];
    for (let parent: any = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule') parents.unshift(parent.name + ' ' + parent.params);
    }
    const key = parents.join('|') + '|' + rule.selector;
    assert.equal(seen.has(key), false, 'Repeated rule: ' + key);
    seen.add(key);
  });
});

test('lazy Element Plus styles cannot expand desktop management filters', () => {
  for (const selector of [
    '.overview-shell .customer-filter-select',
    '.overview-shell .customer-balance-filter',
    '.overview-shell .node-filter-select',
    '.overview-shell .node-server-filter',
    '.overview-shell .xui-filter-select',
    '.overview-shell .socks-filter-select'
  ]) {
    assert.equal(adminStyles.includes(selector), true, 'Missing compact filter rule: ' + selector);
  }

  assert.equal(adminStyles.includes('--el-select-width: 136px'), true);
  assert.equal(adminStyles.includes('--el-select-width: 168px'), true);
  assert.equal(financeView.includes('尚未启用在线支付方式；用户仍可使用卡密兑换，管理员也可手工调整余额。'), false);
});

test('message boxes load their base layout and stay viewport-centered', () => {
  const baseStyle = "import 'element-plus/es/components/message-box/style/css';";
  assert.equal(adminMain.includes(baseStyle), true);
  assert.equal(adminMain.indexOf(baseStyle) < adminMain.indexOf("import './styles.css';"), true);
  assert.equal(adminStyles.includes('.is-message-box .el-overlay-message-box {'), true);
  assert.equal(adminStyles.includes('align-items: center;'), true);
  assert.equal(adminStyles.includes('justify-content: center;'), true);
  assert.match(adminStyles, /\.is-message-box \.el-overlay-message-box::?after/);
  assert.equal(adminStyles.includes('max-height: calc(100vh - 48px);'), true);
});
