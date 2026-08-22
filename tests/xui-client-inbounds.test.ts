import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiClient } from '../packages/xui-client/src/index.js';

test('inbound writes use the 3x-ui form model and serialize JSON fields', async () => {
  let submitted = '';
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    auth: { kind: 'token', token: 'test-token' },
    fetchImpl: async (_input, init) => {
      submitted = String(init?.body || '');
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
  });

  await client.updateInbound(4, {
    id: 4,
    remark: 'US test',
    enable: true,
    port: 30318,
    protocol: 'vless',
    settings: { clients: [] },
    streamSettings: { network: 'ws', security: 'tls' },
    sniffing: { enabled: true },
    clientStats: null,
    _shiyeManaged: true
  });

  const form = new URLSearchParams(submitted);
  assert.equal(form.get('id'), '4');
  assert.equal(form.get('remark'), 'US test');
  assert.deepEqual(JSON.parse(form.get('settings') || ''), { clients: [] });
  assert.deepEqual(JSON.parse(form.get('streamSettings') || ''), { network: 'ws', security: 'tls' });
  assert.deepEqual(JSON.parse(form.get('sniffing') || ''), { enabled: true });
  assert.equal(form.has('clientStats'), false);
  assert.equal(form.has('_shiyeManaged'), false);
});
