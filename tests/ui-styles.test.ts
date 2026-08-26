import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const adminStyles = readFileSync('apps/admin-web/src/styles.css', 'utf8');
const userStyles = readFileSync('apps/user-web/src/styles.css', 'utf8');
const financeView = readFileSync('apps/admin-web/src/views/FinanceView.vue', 'utf8');
const adminMain = readFileSync('apps/admin-web/src/main.ts', 'utf8');

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
    '.node-dialog-section, .xui-dialog-section, .socks-dialog-section, .operations-dark-dialog .dialog-form-section'
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
  assert.equal(userStyles.includes('.user-nav-backdrop'), true);
  assert.equal(userStyles.includes('background: #1c2027;'), true);
});

test('user shell base styles do not depend on later overrides to hide light surfaces', () => {
  for (const lightRule of [
    'background: rgba(255, 255, 255, 0.94)',
    '.secondary-button { height: 36px; border: 1px solid #cbd5e1; border-radius: 8px; background: #fff;',
    '.payment-method-button { min-width: 0; min-height: 96px; display: grid; grid-template-rows: 30px minmax(20px, auto) 18px; justify-items: center; align-content: center; gap: 5px; border: 1px solid #d7dde8; border-radius: 8px; background: #fff;',
    '.finance-form input, .finance-form select { min-width: 0; height: 42px; border: 1px solid #cbd5e1; border-radius: 8px; padding: 0 12px; background: #fff;',
    '.toast-card { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 12px; align-items: start; border: 1px solid #dbe3ef; border-left-width: 4px; border-radius: 8px; background: #fff;'
  ]) {
    assert.equal(userStyles.includes(lightRule), false, 'Light base surface returned: ' + lightRule);
  }

  assert.equal(userStyles.includes('.user-sidebar { min-height: 100vh; position: sticky; top: 0; display: flex; flex-direction: column; gap: 18px; background: #1c2027;'), true);
  assert.equal(userStyles.includes('.qr-box img { width: 220px; height: 220px; max-width: 100%; background: #fff; }'), true);
});

test('user console uses the same surface palette as the admin console', () => {
  for (const color of ['#171a20', '#1c2027', '#20252d', '#252b34', '#2a313b', '#272e38']) {
    assert.equal(userStyles.includes(color), true, 'Missing shared console color: ' + color);
  }

  for (const retiredColor of ['#242a32', '#303946', '#35404e', '#2c3440', '#29323d']) {
    assert.equal(userStyles.includes(retiredColor), false, 'Retired user surface color returned: ' + retiredColor);
  }
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
  assert.equal(adminStyles.includes('.is-message-box .el-overlay-message-box::after'), true);
  assert.equal(adminStyles.includes('max-height: calc(100vh - 48px);'), true);
});
