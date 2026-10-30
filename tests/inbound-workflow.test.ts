import test from 'node:test';
import assert from 'node:assert/strict';
import { splitPanelAddress, fullPanelAddress } from '../apps/admin-web/src/panel-address.js';
import { inboundFieldGroups, applyRealityTarget } from '../apps/admin-web/src/xray-inbound-fields.js';
import { nativeCatalog } from '../apps/api/src/modules/xui/native-api.js';

test('full panel addresses preserve ports, IPv6 and secret paths without duplicating path segments', () => {
  for (const [input, baseUrl, basePath] of [
    [' https://panel.example.com:1101/private/ ', 'https://panel.example.com:1101', 'private'],
    ['http://[2001:db8::1]:3388/a/b/', 'http://[2001:db8::1]:3388', 'a/b'],
    ['https://panel.example.com/', 'https://panel.example.com', undefined],
  ]) {
    assert.deepEqual(splitPanelAddress(input!), { baseUrl, basePath });
    assert.deepEqual(splitPanelAddress(fullPanelAddress(baseUrl!, basePath)), { baseUrl, basePath });
  }
  for (const input of ['panel.example.com', 'ftp://example.com', 'https://user:password@example.com', 'https://example.com/?token=secret', 'https://example.com/#test']) assert.throws(() => splitPanelAddress(input));
});

test('compact inbound fields retain unknown options in advanced groups and show only the active transport and security', () => {
  const record = { network: 'ws', security: 'reality', wsSettings: { path: '/' }, tcpSettings: {}, tlsSettings: {}, realitySettings: { privateKey: 'keep' }, sockopt: {}, future: true };
  const groups = inboundFieldGroups(Object.keys(record), record, 'streamSettings');
  assert.deepEqual(groups[0]!.keys, ['network', 'security', 'wsSettings', 'realitySettings']);
  assert.deepEqual(groups[1]!.keys, ['sockopt', 'future']);
  assert.equal(record.realitySettings.privateKey, 'keep');
});

test('choosing a probed Reality domain preserves credentials, short IDs and unknown settings', () => {
  const original = { target: 'old:443', serverNames: ['old'], privateKey: 'private', shortIds: ['a1b2'], future: true, settings: { publicKey: 'public', serverName: 'old' } };
  const next = applyRealityTarget(original, 'new.example:443', 'new.example');
  assert.deepEqual(next, { ...original, target: 'new.example:443', serverNames: ['new.example'], settings: { publicKey: 'public', serverName: 'new.example' } });
  assert.equal(original.target, 'old:443');
  assert.equal(applyRealityTarget({ dest: 'old', privateKey: 'keep' }, 'new:443', 'new').dest, 'new:443');
});

test('Reality probes are read operations while inbound writes still require confirmation', () => {
  const operations = nativeCatalog({ paths: Object.fromEntries(['/panel/api/server/scanRealityTarget', '/panel/api/server/scanRealityTargets', '/panel/api/inbounds/add'].map(path => [path, { post: {} }])) });
  assert.deepEqual(operations.map(operation => operation.mutates), [false, false, true]);
});
