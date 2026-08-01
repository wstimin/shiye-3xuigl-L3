import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const adminStyles = readFileSync('apps/admin-web/src/styles.css', 'utf8');
const userStyles = readFileSync('apps/user-web/src/styles.css', 'utf8');

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
