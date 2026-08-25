import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiClient } from '../packages/xui-client/src/index.js';

test('inbound writes use the official 3x-ui 3.6 JSON model', async () => {
  let submitted: Record<string, unknown> = {};
  let contentType = '';
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    auth: { kind: 'token', token: 'test-token' },
    fetchImpl: async (_input, init) => {
      contentType = new Headers(init?.headers).get('content-type') || '';
      submitted = JSON.parse(String(init?.body || '{}')) as Record<string, unknown>;
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

  assert.equal(contentType, 'application/json');
  assert.equal(submitted.id, 4);
  assert.equal(submitted.remark, 'US test');
  assert.deepEqual(submitted.settings, { clients: [] });
  assert.deepEqual(submitted.streamSettings, { network: 'ws', security: 'tls' });
  assert.deepEqual(submitted.sniffing, { enabled: true });
  assert.equal('clientStats' in submitted, false);
  assert.equal('_shiyeManaged' in submitted, false);
});
