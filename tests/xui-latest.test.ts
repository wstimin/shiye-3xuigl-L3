import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiClient } from '../packages/xui-client/src/index.js';

test('3x-ui 3.11 updates preserve native protocol id, host rules, tunnel credentials and reset policy', async () => {
  let submitted: any;
  const record = { id: 42, uuid: 'protocol-uuid', email: 'alice', group: 'paid', clientHostRuleIds: [2, 5], privateKey: 'key', allowedIPs: '["10.0.0.2/32"]', keepAlive: '15-25', reverse: '{"tag":"reverse"}', resetDay: 15, resetWeekday: 3, resetMax: 12, trafficReset: 'monthly', trafficResetDay: 1, limitHwid: 2 };
  const client = new XuiClient({ baseUrl: 'https://example.com', fetchImpl: async (_url, init) => {
    if (init?.body) submitted = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ success: true, obj: { client: record } }));
  } });
  await client.updateClient(1, 'alice', { email: 'alice', enable: true, expiryTime: 2000000000000 });
  assert.equal(submitted.id, 'protocol-uuid');
  assert.equal(submitted.enable, true);
  assert.deepEqual(submitted.allowedIPs, ['10.0.0.2/32']);
  assert.deepEqual(submitted.reverse, { tag: 'reverse' });
  for (const key of ['group', 'privateKey', 'keepAlive', 'resetDay', 'resetWeekday', 'resetMax', 'trafficReset', 'trafficResetDay', 'limitHwid']) assert.deepEqual(submitted[key], record[key as keyof typeof record]);
  assert.deepEqual(submitted.clientHostRuleIds, [2, 5]);
});

test('3x-ui 3.11 capability detection follows documented paths rather than a pinned version', async () => {
  const client = new XuiClient({ baseUrl: 'https://example.com', fetchImpl: async () => new Response(JSON.stringify({ openapi: '3.0.3', info: { version: '3.11.0' }, paths: Object.fromEntries(['/clients/add', '/clients/update/{email}', '/clients/{email}/detach', '/clients/traffic/{email}', '/inbounds/{id}/resetTraffic'].map(path => ['/panel/api' + path, {}])) })) });
  assert.equal((await client.detectCapabilities()).detectedVersion, '3.11.0');
});

test('3x-ui empty database strings become valid native fields and an explicit group clear is preserved', async () => {
  let submitted: any;
  const client = new XuiClient({ baseUrl: 'https://example.com', fetchImpl: async (_url, init) => {
    if (init?.body) submitted = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ success: true, obj: { client: { email: 'alice', uuid: 'u1', reverse: '', allowedIPs: '', group_name: 'legacy' } } }));
  } });
  await client.updateClient(1, 'alice', { group: '' });
  assert.equal(submitted.group, '');
  assert.deepEqual(submitted.allowedIPs, []);
  assert.equal('reverse' in submitted, false);
});
