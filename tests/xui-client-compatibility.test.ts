import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiClient } from '../packages/xui-client/src/index.js';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('3.6 capability detection uses the OpenAPI path fingerprint', async () => {
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    fetchImpl: async () => jsonResponse({
      openapi: '3.0.0',
      info: { version: '3.x' },
      paths: {
        '/panel/api/clients/add': {},
        '/panel/api/clients/update/{email}': {},
        '/panel/api/clients/{email}/detach': {},
        '/panel/api/inbounds/{id}/resetTraffic': {}
      }
    })
  });

  assert.deepEqual(await client.detectCapabilities(), {
    apiProfile: 'v3.6',
    detectedVersion: undefined,
    source: 'openapi',
    openApiVersion: '3.0.0'
  });
});

test('legacy and 3.6 clients keep their API paths isolated', async () => {
  const legacyRequests: string[] = [];
  const v36Requests: Array<{ path: string; body: unknown }> = [];
  const legacy = new XuiClient({
    baseUrl: 'https://legacy.example.com',
    fetchImpl: async (input) => {
      legacyRequests.push(new URL(String(input)).pathname);
      return jsonResponse({ success: true });
    }
  });
  const v36 = new XuiClient({
    baseUrl: 'https://v36.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      v36Requests.push({ path: new URL(String(input)).pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return jsonResponse({ success: true });
    }
  });

  await legacy.resetInboundTraffic(7);
  await legacy.addClient(7, { email: 'legacy@example.com' });
  await v36.resetInboundTraffic(9);
  await v36.addClient(9, { email: 'v36@example.com' });
  await v36.deleteClient(9, 'v36@example.com');

  assert.deepEqual(legacyRequests, [
    '/panel/api/inbounds/resetTraffic/7',
    '/panel/api/inbounds/addClient'
  ]);
  assert.deepEqual(v36Requests, [
    { path: '/panel/api/inbounds/9/resetTraffic', body: undefined },
    { path: '/panel/api/clients/add', body: { client: { email: 'v36@example.com' }, inboundIds: [9] } },
    { path: '/panel/api/clients/v36%40example.com/detach', body: { inboundIds: [9] } }
  ]);
});

test('missing OpenAPI endpoint keeps an older panel on the legacy profile', async () => {
  const client = new XuiClient({
    baseUrl: 'https://legacy.example.com',
    fetchImpl: async () => jsonResponse({ message: 'not found' }, 404)
  });

  assert.deepEqual(await client.detectCapabilities(), { apiProfile: 'legacy', source: 'fallback' });
});

test('temporary OpenAPI failures remain visible to callers', async () => {
  const client = new XuiClient({
    baseUrl: 'https://unavailable.example.com',
    fetchImpl: async () => jsonResponse({ message: 'temporary failure' }, 503)
  });

  await assert.rejects(() => client.detectCapabilities(), /3x-ui request failed: 503/);
});

test('automatic detection failures do not block existing legacy operations', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let persisted = false;
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === '/panel/api/openapi.json') return jsonResponse({ message: 'temporary failure' }, 503);
    return jsonResponse({ success: true, obj: [] });
  };

  try {
    const service = new XuiService({
      xuiServer: { update: async () => { persisted = true; } }
    } as never, {} as never) as any;
    const client = await service.createAuthenticatedClient({
      id: 'server-1',
      baseUrl: 'https://legacy.example.com',
      token: 'token',
      config: {}
    });
    await client.listInbounds();

    assert.deepEqual(requests, ['/panel/api/openapi.json', '/panel/api/inbounds/list']);
    assert.equal(persisted, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('3.6 last-client deletion uses detach instead of the legacy empty-inbound fallback', async () => {
  const service = new XuiService({} as never, {} as never) as any;
  let deleteCalls = 0;
  let updateCalls = 0;
  let existenceChecks = 0;
  service.remoteClientExists = async () => {
    existenceChecks += 1;
    return existenceChecks === 1
      ? { exists: true, clientCount: 1, inbound: { id: 9 }, settings: { clients: [{ email: 'user@example.com' }] } }
      : { exists: false, clientCount: 0 };
  };
  service.writeSyncLog = async () => undefined;
  const client = {
    usesApiProfile: (profile: string) => profile === 'v3.6',
    deleteClient: async () => { deleteCalls += 1; return { success: true }; },
    updateInbound: async () => { updateCalls += 1; return { success: true }; }
  };

  const result = await service.deleteRemoteClientWithClient(client, 'server-1', 9, 'user@example.com', false, {});

  assert.equal(deleteCalls, 1);
  assert.equal(updateCalls, 0);
  assert.equal(result.lastClientFallback, undefined);
});
