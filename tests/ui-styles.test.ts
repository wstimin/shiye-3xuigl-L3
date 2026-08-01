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
