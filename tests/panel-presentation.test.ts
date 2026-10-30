import test from 'node:test';
import assert from 'node:assert/strict';
import { configGroups, detailSummary, detailText, templateParts, templateText } from '../apps/admin-web/src/panel-presentation.js';
import { decodePanelValue, encodePanelValue, fieldLabel } from '../apps/admin-web/src/panel-fields.js';

test('settings categories cover every upstream field once without dropping unknown settings', () => {
  const settings = { webPort: 1101, subHappTunMode: true, subJsonRules: '[]', smtpPassword: 'secret', ldapUseTLS: false, futureUpstreamOption: { keep: true } };
  const groups = configGroups(settings, 'settings');
  assert.deepEqual(groups.flatMap(group => group.keys).sort(), Object.keys(settings).sort());
  assert.equal(groups.find(group => group.id === 'happ')?.keys.includes('subHappTunMode'), true);
  const draft = decodePanelValue(settings) as Record<string, unknown>;
  const group = groups.find(group => group.id === 'access')!;
  const fields = Object.fromEntries(group.keys.map(key => [key, draft[key]]));
  fields.webPort = 1102;
  const saved = encodePanelValue({ ...draft, ...fields }, settings);
  assert.deepEqual(saved, { ...settings, webPort: 1102 });
});

test('visual remark templates retain text, separators and unknown upstream placeholders', () => {
  const value = '{{INBOUND}}-{{EMAIL}}|📊{{TRAFFIC_LEFT}}|⏳{{DAYS_LEFT}}D{{FUTURE_FIELD}}';
  const parts = templateParts(value);
  assert.equal(templateText(parts), value);
  assert.equal(templateText(templateParts('')), '');
  assert.equal(detailText('{{EMAIL}}-{{DAYS_LEFT}}天', 'remarkTemplate'), '【客户端用户名】-【剩余天数】天');
  parts[0]!.value = '{{EMAIL}}';
  assert.equal(templateText(parts), value.replace('{{INBOUND}}', '{{EMAIL}}'));
});

test('core categories keep rules and outbounds in separate complete sections', () => {
  const config = { inbounds: [], outbounds: [], routing: { rules: [] }, dns: {}, log: {}, policy: {}, futureCoreOption: 1 };
  const groups = configGroups(config, 'core');
  assert.deepEqual(groups.flatMap(group => group.keys).sort(), Object.keys(config).sort());
  assert.deepEqual(groups.find(group => group.id === 'routing')?.keys, ['routing']);
  assert.deepEqual(groups.find(group => group.id === 'outbounds')?.keys, ['outbounds']);
});

test('detail summaries decode serialized objects and never stringify nested configuration', () => {
  assert.equal(detailSummary('{"port":50001,"enabled":false,"settings":{"a":1}}'), '端口：50001，启用：否，协议设置：已记录');
  assert.equal(detailSummary([]), '暂无记录');
  assert.equal(detailText(false), '否');
  assert.equal(detailText(0), '0');
  assert.equal(detailText(1101, 'webPort'), '1101');
  assert.equal(detailText(null), '未设置');
  assert.equal(detailText(1024 ** 3, 'current', 'mem'), '1 GB');
  assert.equal(detailText(1024, 'up', 'netIO'), '1 KB/s');
  assert.equal(detailText(90061, 'uptime'), '1 天 1 小时 1 分钟');
  assert.equal(fieldLabel('subHappTunMode'), 'Happ 客户端 · 虚拟网卡模式');
  assert.equal(fieldLabel('ldapUseTLS'), '账号目录 · 启用 TLS');
});
