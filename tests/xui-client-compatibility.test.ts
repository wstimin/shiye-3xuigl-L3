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
  await v36.addClient(9, { id: 'v36-uuid', email: 'v36@example.com' });
  await v36.deleteClient(9, 'v36@example.com');

  assert.deepEqual(legacyRequests, [
    '/panel/api/inbounds/resetTraffic/7',
    '/panel/api/inbounds/addClient'
  ]);
  assert.deepEqual(v36Requests, [
    { path: '/panel/api/inbounds/9/resetTraffic', body: undefined },
    { path: '/panel/api/clients/add', body: { client: { email: 'v36@example.com', uuid: 'v36-uuid' }, inboundIds: [9] } },
    { path: '/panel/api/clients/v36%40example.com/detach', body: { inboundIds: [9] } }
  ]);
});

test('3.6 client updates preserve the full record and translate legacy UUID fields', async () => {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const client = new XuiClient({
    baseUrl: 'https://v36.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({
        path,
        method: init?.method || 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      if (path === '/panel/api/clients/get/old%40example.com') {
        return jsonResponse({
          success: true,
          obj: JSON.stringify({
            client: {
              id: 42,
              email: 'old@example.com',
              uuid: 'old-uuid',
              password: 'keep-password',
              auth: 'keep-auth',
              reverse: { tag: 'keep-reverse' },
              comment: 'keep-comment',
              group_name: 'keep-group',
              inboundIds: [9],
              traffic: { up: 1, down: 2 },
              externalConfigIds: [5],
              createdAt: 100,
              updatedAt: 200
            },
            inboundIds: [9]
          })
        });
      }
      return jsonResponse({ success: true });
    }
  });

  await client.updateClient(9, 'old@example.com', {
    id: 'new-uuid',
    email: 'new@example.com',
    enable: false,
    totalGB: 1024
  });

  assert.deepEqual(requests, [
    { path: '/panel/api/clients/get/old%40example.com', method: 'GET', body: undefined },
    {
      path: '/panel/api/clients/update/old%40example.com',
      method: 'POST',
      body: {
        email: 'new@example.com',
        uuid: 'new-uuid',
        password: 'keep-password',
        auth: 'keep-auth',
        reverse: { tag: 'keep-reverse' },
        comment: 'keep-comment',
        group_name: 'keep-group',
        enable: false,
        totalGB: 1024
      }
    }
  ]);
});

test('legacy client updates keep the existing form endpoint and do not fetch 3.6 details', async () => {
  const requests: Array<{ path: string; contentType: string; body: string }> = [];
  const client = new XuiClient({
    baseUrl: 'https://legacy.example.com',
    fetchImpl: async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        contentType: new Headers(init?.headers).get('content-type') || '',
        body: String(init?.body || '')
      });
      return jsonResponse({ success: true });
    }
  });

  await client.updateClient(7, 'legacy-uuid', { id: 'legacy-uuid', email: 'legacy@example.com', enable: true });

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.path, '/panel/api/inbounds/updateClient/legacy-uuid');
  assert.equal(requests[0]?.contentType, 'application/x-www-form-urlencoded; charset=UTF-8');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[0]?.body)), {
    id: '7',
    settings: JSON.stringify({ clients: [{ id: 'legacy-uuid', email: 'legacy@example.com', enable: true }] })
  });
});

test('3.6 inbound validation resolves the real client identity from the global client API', async () => {
  const requests: string[] = [];
  const client = new XuiClient({
    baseUrl: 'https://v36.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path === '/panel/api/inbounds/get/9') {
        return jsonResponse({
          success: true,
          obj: {
            id: 9,
            protocol: 'vless',
            enable: true,
            port: 443,
            settings: JSON.stringify({ clients: [{ email: 'user@example.com', enable: true, comment: '' }] }),
            streamSettings: JSON.stringify({ network: 'tcp', security: 'none' })
          }
        });
      }
      if (path === '/panel/api/clients/list') {
        return jsonResponse({
          success: true,
          obj: [{ id: 51, email: 'user@example.com', uuid: 'real-v36-uuid', subId: 'real-sub', inboundIds: [9] }]
        });
      }
      return jsonResponse({ message: 'unexpected request' }, 500);
    }
  });
  const service = new XuiService({
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true }) }
  } as never, {} as never) as any;
  service.createAuthenticatedClient = async () => client;

  const result = await service.validateServiceNodeInbound('server-1', 9);

  assert.deepEqual(requests, ['/panel/api/inbounds/get/9', '/panel/api/clients/list']);
  assert.deepEqual(result.remoteClient, {
    email: 'user@example.com',
    uuid: 'real-v36-uuid',
    subId: 'real-sub'
  });
});

test('3.6 customer binding updates the existing global client without creating another client', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const client = new XuiClient({
    baseUrl: 'https://v36.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/panel/api/inbounds/list') {
        return jsonResponse({
          success: true,
          obj: [{
            id: 9,
            protocol: 'vless',
            settings: JSON.stringify({ clients: [{ email: 'user@example.com', enable: true, comment: '' }] })
          }]
        });
      }
      if (path === '/panel/api/clients/list') {
        return jsonResponse({
          success: true,
          obj: [{ id: 51, email: 'user@example.com', uuid: 'real-v36-uuid', subId: 'real-sub', inboundIds: [9] }]
        });
      }
      if (path === '/panel/api/clients/get/user%40example.com') {
        return jsonResponse({
          success: true,
          obj: {
            id: 51,
            email: 'user@example.com',
            uuid: 'real-v36-uuid',
            subId: 'real-sub',
            comment: 'preserve-me',
            inboundIds: [9]
          }
        });
      }
      if (path === '/panel/api/clients/update/user%40example.com') return jsonResponse({ success: true, msg: 'Client updated' });
      if (path === '/panel/api/clients/links/user%40example.com') {
        return jsonResponse({ success: true, obj: ['vless://real-v36-uuid@node.example.com:443#node'] });
      }
      return jsonResponse({ message: 'unexpected request' }, 500);
    }
  });
  const customerNode = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    serviceNodeId: 'service-node-1',
    xuiEmail: 'user@example.com',
    uuid: null,
    expireAt: null,
    trafficLimitGb: 100,
    status: 'active',
    config: {},
    customer: { id: 'customer-1', name: 'User', loginUsername: 'user' },
    serviceNode: {
      id: 'service-node-1',
      name: 'Node',
      protocol: 'vless',
      enabled: true,
      inboundId: 9,
      trafficLimitGb: 100,
      config: { encryption: 'none', remoteClientEmail: 'user@example.com' },
      server: { id: 'server-1', enabled: true, baseUrl: 'https://v36.example.com', config: {} }
    }
  };
  let localUpdate: any;
  let serviceUpdate: any;
  const tx = {
    customerNode: {
      update: async ({ data }: any) => {
        localUpdate = data;
        return { ...customerNode, ...data };
      }
    },
    serviceNode: {
      update: async ({ data }: any) => {
        serviceUpdate = data;
        return {};
      }
    }
  };
  const service = new XuiService({
    customerNode: {
      findFirst: async () => customerNode,
      update: async ({ data }: any) => {
        localUpdate = data;
        return { ...customerNode, ...data };
      }
    },
    $transaction: async (operation: any) => operation(tx),
    syncLog: { create: async () => ({}) }
  } as never, {} as never) as any;
  service.createAuthenticatedClient = async () => client;

  const result = await service.syncCustomerNode('customer-1', 'customer-node-1', {
    createIfMissing: false,
    requireExisting: true
  });

  assert.equal(result.synced, true);
  assert.equal(localUpdate.uuid, 'real-v36-uuid');
  assert.equal(serviceUpdate.config.remoteClientEmail, 'user@example.com');
  assert.equal(requests.some((request) => request.path === '/panel/api/clients/add'), false);
  assert.deepEqual(requests.map((request) => request.path), [
    '/panel/api/inbounds/list',
    '/panel/api/clients/list',
    '/panel/api/clients/get/user%40example.com',
    '/panel/api/clients/update/user%40example.com',
    '/panel/api/clients/links/user%40example.com'
  ]);
  const update = requests.find((request) => request.path === '/panel/api/clients/update/user%40example.com');
  assert.deepEqual(update?.body, {
    email: 'user@example.com',
    uuid: 'real-v36-uuid',
    subId: 'real-sub',
    comment: 'preserve-me',
    enable: true,
    expiryTime: 0,
    totalGB: 107374182400,
    limitIp: 0,
    flow: '',
    tgId: 0,
    reset: 0
  });
});

test('3.6 customer binding renames the remote client and persists both local identities', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const client = new XuiClient({
    baseUrl: 'https://v36.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (path === '/panel/api/inbounds/list') {
        return jsonResponse({ success: true, obj: [{ id: 9, protocol: 'vless', settings: JSON.stringify({ clients: [{ email: 'old@example.com' }] }) }] });
      }
      if (path === '/panel/api/clients/list') {
        return jsonResponse({ success: true, obj: [{ email: 'old@example.com', uuid: 'real-v36-uuid', subId: 'real-sub', inboundIds: [9] }] });
      }
      if (path === '/panel/api/clients/get/old%40example.com') {
        return jsonResponse({ success: true, obj: { email: 'old@example.com', uuid: 'real-v36-uuid', subId: 'real-sub', comment: 'keep-me' } });
      }
      if (path === '/panel/api/clients/update/old%40example.com') return jsonResponse({ success: true });
      if (path === '/panel/api/clients/links/%E5%BC%A0-%E4%B8%89-9') {
        return jsonResponse({ success: true, obj: ['vless://real-v36-uuid@node.example.com:443#node'] });
      }
      return jsonResponse({ message: `unexpected request ${path}` }, 500);
    }
  });
  const customerNode = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    serviceNodeId: 'service-node-1',
    xuiEmail: 'old@example.com',
    uuid: null,
    expireAt: null,
    trafficLimitGb: 100,
    status: 'active',
    config: {},
    customer: { id: 'customer-1', name: '张 三', loginUsername: 'zhangsan' },
    serviceNode: {
      id: 'service-node-1',
      name: 'Node',
      protocol: 'vless',
      enabled: true,
      inboundId: 9,
      trafficLimitGb: 100,
      config: { encryption: 'none', remoteClientEmail: 'old@example.com', remoteClientUuid: 'real-v36-uuid', remoteClientSubId: 'real-sub' },
      server: { id: 'server-1', enabled: true, baseUrl: 'https://v36.example.com', config: {} }
    }
  };
  let customerPatch: any;
  let servicePatch: any;
  const tx = {
    customerNode: {
      update: async ({ data }: any) => {
        customerPatch = data;
        return { ...customerNode, ...data };
      }
    },
    serviceNode: {
      update: async ({ data }: any) => {
        servicePatch = data;
        return {};
      }
    }
  };
  const service = new XuiService({
    customerNode: { findFirst: async () => customerNode },
    $transaction: async (operation: any) => operation(tx),
    syncLog: { create: async () => ({}) }
  } as never, {} as never) as any;
  service.createAuthenticatedClient = async () => client;

  const result = await service.syncCustomerNode('customer-1', 'customer-node-1', {
    createIfMissing: false,
    requireExisting: true,
    preferredClientEmail: '张-三-9'
  });

  assert.equal(result.synced, true);
  assert.equal(customerPatch.xuiEmail, '张-三-9');
  assert.equal(servicePatch.config.remoteClientEmail, '张-三-9');
  assert.equal(servicePatch.config.remoteClientUuid, 'real-v36-uuid');
  assert.equal(servicePatch.config.remoteClientSubId, 'real-sub');
  assert.deepEqual(requests.map((request) => request.path), [
    '/panel/api/inbounds/list',
    '/panel/api/clients/list',
    '/panel/api/clients/get/old%40example.com',
    '/panel/api/clients/update/old%40example.com',
    '/panel/api/clients/links/%E5%BC%A0-%E4%B8%89-9'
  ]);
  const update = requests.find((request) => request.path === '/panel/api/clients/update/old%40example.com');
  assert.equal((update?.body as any).email, '张-三-9');
  assert.equal((update?.body as any).comment, 'keep-me');
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

test('unsaved 3.6 panel drafts detect their API profile before certificate reads', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === '/panel/api/openapi.json') {
      return jsonResponse({
        openapi: '3.0.0',
        info: { version: '3.6.0' },
        paths: {
          '/panel/api/clients/add': {},
          '/panel/api/clients/update/{email}': {},
          '/panel/api/clients/{email}/detach': {},
          '/panel/api/inbounds/{id}/resetTraffic': {}
        }
      });
    }
    if (path === '/panel/api/server/getWebCertFiles') {
      return jsonResponse({ success: true, obj: { webCertFile: '/cert/fullchain.pem', webKeyFile: '/cert/privkey.pem' } });
    }
    return jsonResponse({ message: 'unexpected request' }, 500);
  };

  try {
    const service = new XuiService({} as never, {} as never) as any;
    const client = await service.createAuthenticatedClient({
      baseUrl: 'https://draft.example.com',
      token: 'token'
    }, true, true);
    const result = await service.readWebCertFiles(client);

    assert.deepEqual(requests, ['/panel/api/openapi.json', '/panel/api/server/getWebCertFiles']);
    assert.equal(result.found, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('saved 3.6 panel drafts detect their API profile before certificate reads', async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    requests.push(path);
    if (path === '/panel/api/openapi.json') {
      return jsonResponse({
        openapi: '3.0.0',
        info: { version: '3.6.0' },
        paths: {
          '/panel/api/clients/add': {},
          '/panel/api/clients/update/{email}': {},
          '/panel/api/clients/{email}/detach': {},
          '/panel/api/inbounds/{id}/resetTraffic': {}
        }
      });
    }
    if (path === '/panel/api/server/getWebCertFiles') {
      return jsonResponse({ success: true, obj: { webCertFile: '/cert/fullchain.pem', webKeyFile: '/cert/privkey.pem' } });
    }
    return jsonResponse({ message: 'unexpected request' }, 500);
  };

  try {
    const service = new XuiService({
      xuiServer: {
        findUnique: async () => ({
          id: 'server-1',
          basePath: null,
          username: null,
          passwordEnc: null,
          tokenEnc: 'encrypted-token'
        })
      }
    } as never, {
      decrypt: () => 'token'
    } as never) as any;

    const result = await service.testStoredServerDraftCertFiles('server-1', {
      name: '3.6 panel',
      baseUrl: 'https://saved-draft.example.com',
      enabled: true
    });

    assert.deepEqual(requests, ['/panel/api/openapi.json', '/panel/api/server/getWebCertFiles']);
    assert.equal(result.found, true);
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

test('3.6 certificate reads use the token-compatible server API', async () => {
  const service = new XuiService({} as never, {} as never) as any;
  let apiCalls = 0;
  let legacyCalls = 0;
  const client = {
    usesApiProfile: (profile: string) => profile === 'v3.6',
    getWebCertFiles: async () => {
      apiCalls += 1;
      return { success: true, obj: { webCertFile: '/cert/fullchain.pem', webKeyFile: '/cert/privkey.pem' } };
    },
    getPanelSettings: async () => {
      legacyCalls += 1;
      return { success: true, obj: {} };
    }
  };

  const result = await service.readWebCertFiles(client);

  assert.equal(apiCalls, 1);
  assert.equal(legacyCalls, 0);
  assert.equal(result.found, true);
  assert.equal(result.certFile, '/cert/fullchain.pem');
  assert.equal(result.keyFile, '/cert/privkey.pem');
});

test('legacy certificate reads keep using the existing panel settings API', async () => {
  const service = new XuiService({} as never, {} as never) as any;
  let apiCalls = 0;
  let legacyCalls = 0;
  const client = {
    usesApiProfile: () => false,
    getWebCertFiles: async () => {
      apiCalls += 1;
      return { success: true, obj: {} };
    },
    getPanelSettings: async () => {
      legacyCalls += 1;
      return { success: true, obj: { webCertFile: '/legacy/fullchain.pem', webKeyFile: '/legacy/privkey.pem' } };
    }
  };

  const result = await service.readWebCertFiles(client);

  assert.equal(apiCalls, 0);
  assert.equal(legacyCalls, 1);
  assert.equal(result.found, true);
  assert.equal(result.certFile, '/legacy/fullchain.pem');
  assert.equal(result.keyFile, '/legacy/privkey.pem');
});
