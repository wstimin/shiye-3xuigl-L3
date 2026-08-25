import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiClient } from '../packages/xui-client/src/index.js';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';
import { testLocks } from './test-locks.js';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function openApiDocument(paths?: Record<string, unknown>) {
  return {
    openapi: '3.0.0',
    info: { version: '3.6.0' },
    paths: paths || {
      '/panel/api/clients/add': {},
      '/panel/api/clients/update/{email}': {},
      '/panel/api/clients/{email}/detach': {},
      '/panel/api/inbounds/{id}/resetTraffic': {}
    }
  };
}

test('3.6 capability detection requires the official OpenAPI fingerprint', async () => {
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    fetchImpl: async () => jsonResponse(openApiDocument())
  });

  assert.deepEqual(await client.detectCapabilities(), {
    apiProfile: 'v3.6',
    detectedVersion: '3.6.0',
    source: 'openapi',
    openApiVersion: '3.0.0'
  });
});

test('missing official 3.6 OpenAPI rejects the panel with a Chinese version error', async () => {
  const missingDocument = new XuiClient({
    baseUrl: 'https://old.example.com',
    fetchImpl: async () => jsonResponse({ message: 'not found' }, 404)
  });
  const incompleteDocument = new XuiClient({
    baseUrl: 'https://incomplete.example.com',
    fetchImpl: async () => jsonResponse(openApiDocument({ '/panel/api/clients/add': {} }))
  });

  await assert.rejects(() => missingDocument.detectCapabilities(), /不支持 3x-ui 3\.6 官方 API/);
  await assert.rejects(() => incompleteDocument.detectCapabilities(), /不支持 3x-ui 3\.6 官方 API/);
});

test('official 3.6 client and inbound operations use only the documented paths', async () => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined
      });
      return jsonResponse({ success: true });
    }
  });

  await client.resetInboundTraffic(9);
  await client.setInboundEnable(9, false);
  await client.addClient(9, { id: 'v36-uuid', email: 'user@example.com' });
  await client.detachClient(9, 'user@example.com');
  await client.deleteClient(9, 'user@example.com');

  assert.deepEqual(requests, [
    { path: '/panel/api/inbounds/9/resetTraffic', body: undefined },
    { path: '/panel/api/inbounds/setEnable/9', body: { enable: false } },
    { path: '/panel/api/clients/add', body: { client: { email: 'user@example.com', uuid: 'v36-uuid' }, inboundIds: [9] } },
    { path: '/panel/api/clients/user%40example.com/detach', body: { inboundIds: [9] } },
    { path: '/panel/api/clients/del/user%40example.com', body: undefined }
  ]);
});

test('official 3.6 client creation accepts universal fields and lets the panel generate protocol secrets', async () => {
  let requestBody: unknown;
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (_input, init) => {
      requestBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      return jsonResponse({ success: true, msg: 'Client added' });
    }
  });

  await client.addClient(3, {
    email: 'managed-user-3',
    totalGB: 0,
    expiryTime: 0,
    tgId: 0,
    limitIp: 0,
    enable: true
  });

  assert.deepEqual(requestBody, {
    client: {
      email: 'managed-user-3',
      totalGB: 0,
      expiryTime: 0,
      tgId: 0,
      limitIp: 0,
      enable: true
    },
    inboundIds: [3]
  });
});

test('3.6 client patches preserve unrelated writable fields and omit read-only fields', async () => {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: init?.method || 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
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

  assert.deepEqual(requests.at(-1), {
    path: '/panel/api/clients/update/old%40example.com',
    method: 'POST',
    body: {
      email: 'new@example.com',
      uuid: 'new-uuid',
      password: 'keep-password',
      auth: 'keep-auth',
      enable: false,
      totalGB: 1024,
      reverse: { tag: 'keep-reverse' },
      comment: 'keep-comment',
      group_name: 'keep-group'
    }
  });
});

test('3.6 request errors include the panel response message', async () => {
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async () => jsonResponse({ success: false, msg: 'Client email already exists' }, 400)
  });

  await assert.rejects(
    () => client.updateClient(9, 'old@example.com', { email: 'new@example.com' }),
    /3x-ui request failed: 400 - Client email already exists/
  );
});

test('binding refresh reads identity and links without any remote write', async () => {
  const requests: Array<{ path: string; method: string }> = [];
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      requests.push({ path, method: init?.method || 'GET' });
      if (path === '/panel/api/inbounds/list') {
        return jsonResponse({ success: true, obj: [{ id: 9, protocol: 'vless', settings: { clients: [{ email: 'user@example.com' }] } }] });
      }
      if (path === '/panel/api/clients/list') {
        return jsonResponse({ success: true, obj: [{ email: 'user@example.com', uuid: 'real-v36-uuid', subId: 'real-sub', inboundIds: [9] }] });
      }
      if (path === '/panel/api/clients/links/user%40example.com') {
        return jsonResponse({ success: true, obj: ['vless://real-v36-uuid@node.example.com:443#node'] });
      }
      return jsonResponse({ message: `unexpected request ${path}` }, 500);
    }
  });
  const customerNode = customerNodeFixture();
  let localPatch: any;
  const service = new XuiService({
    customerNode: {
      findFirst: async ({ where }: any) => typeof where.id === 'object' ? null : customerNode,
      update: async ({ data }: any) => {
        localPatch = data;
        return { ...customerNode, ...data };
      }
    },
    renewalLog: { findFirst: async () => null },
    syncLog: { create: async () => ({}) }
  } as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => client;

  const result = await service.refreshCustomerNodeBinding('customer-1', 'customer-node-1');

  assert.equal(result.remoteWrite, false);
  assert.equal(localPatch.uuid, 'real-v36-uuid');
  assert.equal(localPatch.config.subId, 'real-sub');
  assert.deepEqual(requests, [
    { path: '/panel/api/inbounds/list', method: 'GET' },
    { path: '/panel/api/clients/list', method: 'GET' },
    { path: '/panel/api/clients/links/user%40example.com', method: 'GET' }
  ]);
});

test('reference bindings skip subscription writes and reject lifecycle writes', async () => {
  const service = new XuiService({
    customerNode: { findFirst: async () => ({ ...customerNodeFixture(), remoteControl: 'reference' }) }
  } as never, {} as never, testLocks()) as any;

  const expiry = await service.updateCustomerNodeExpiry('customer-1', 'customer-node-1', new Date('2030-01-01T00:00:00Z'), true);
  assert.equal(expiry.skipped, true);
  assert.equal(expiry.remoteWrite, false);
  await assert.rejects(
    () => service.createCustomerNodeRemoteClient('customer-1', 'customer-node-1', {
      email: 'new@example.com',
      trafficLimitGb: 100,
      enabled: true
    }),
    /只有完全托管绑定允许创建远端账号/
  );
  await assert.rejects(
    () => service.patchCustomerNodeRemoteClient('customer-1', 'customer-node-1', { enabled: false }),
    /只读引用绑定不能修改远端账号/
  );
  await assert.rejects(
    () => service.deleteCustomerNodeRemoteClient('customer-1', 'customer-node-1'),
    /只有完全托管账号允许从远端删除/
  );
  await assert.rejects(
    () => service.resetCustomerNodeTraffic('customer-1', 'customer-node-1'),
    /只有完全托管账号允许重置远端流量/
  );
});

test('subscription-managed bindings can renew but cannot create or delete remote clients', async () => {
  const service = new XuiService({
    customerNode: { findFirst: async () => ({ ...customerNodeFixture(), remoteControl: 'subscription_managed' }) }
  } as never, {} as never, testLocks()) as any;

  service.patchCustomerNodeRemote = async () => ({ synced: true, remoteWrite: true, operation: 'expiry' });
  const expiry = await service.updateCustomerNodeExpiry('customer-1', 'customer-node-1', new Date('2030-01-01T00:00:00Z'), true);
  assert.equal(expiry.synced, true);
  await assert.rejects(
    () => service.createCustomerNodeRemoteClient('customer-1', 'customer-node-1', {
      email: 'new@example.com',
      trafficLimitGb: 100,
      enabled: true
    }),
    /只有完全托管绑定允许创建远端账号/
  );
  await assert.rejects(
    () => service.deleteCustomerNodeRemoteClient('customer-1', 'customer-node-1'),
    /只有完全托管账号允许从远端删除/
  );
  await assert.rejects(
    () => service.resetCustomerNodeTraffic('customer-1', 'customer-node-1'),
    /只有完全托管账号允许重置远端流量/
  );
});

test('fully-managed client deletion uses the global delete endpoint and not detach', async () => {
  const service = new XuiService({} as never, {} as never, testLocks()) as any;
  let deleteCalls = 0;
  let detachCalls = 0;
  let existenceChecks = 0;
  service.remoteClientExists = async () => {
    existenceChecks += 1;
    return existenceChecks === 1
      ? { exists: true, clientCount: 1, inbound: { id: 9 }, settings: { clients: [{ email: 'user@example.com' }] } }
      : { exists: false, clientCount: 0 };
  };
  service.writeSyncLog = async () => undefined;
  const client = {
    deleteClient: async () => { deleteCalls += 1; return { success: true }; },
    detachClient: async () => { detachCalls += 1; return { success: true }; }
  };

  const result = await service.deleteRemoteClientWithClient(client, 'server-1', 9, 'user@example.com', false, {});

  assert.equal(result.deleted, true);
  assert.equal(deleteCalls, 1);
  assert.equal(detachCalls, 0);
});

test('explicit detach remains a separate official 3.6 operation', async () => {
  const requests: string[] = [];
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input) => {
      requests.push(new URL(String(input)).pathname);
      return jsonResponse({ success: true });
    }
  });

  await client.detachClient(9, 'user@example.com');
  assert.deepEqual(requests, ['/panel/api/clients/user%40example.com/detach']);
});

test('certificate reads use the official token-compatible server API', async () => {
  const service = new XuiService({} as never, {} as never, testLocks()) as any;
  let apiCalls = 0;
  const result = await service.readWebCertFiles({
    getWebCertFiles: async () => {
      apiCalls += 1;
      return { success: true, obj: { webCertFile: '/cert/fullchain.pem', webKeyFile: '/cert/privkey.pem' } };
    }
  });

  assert.equal(apiCalls, 1);
  assert.equal(result.found, true);
  assert.equal(result.certFile, '/cert/fullchain.pem');
  assert.equal(result.keyFile, '/cert/privkey.pem');
});

function customerNodeFixture() {
  return {
    id: 'customer-node-1',
    customerId: 'customer-1',
    serviceNodeId: 'service-node-1',
    xuiEmail: 'user@example.com',
    uuid: null,
    expireAt: null,
    trafficLimitGb: 100,
    status: 'active',
    remoteControl: 'fully_managed',
    config: {},
    serviceNode: {
      id: 'service-node-1',
      serverId: 'server-1',
      name: 'Node',
      protocol: 'vless',
      enabled: true,
      inboundId: 9,
      trafficLimitGb: 100,
      config: { encryption: 'none', remoteClientEmail: 'user@example.com' },
      server: { id: 'server-1', enabled: true, baseUrl: 'https://panel.example.com', config: {} }
    }
  };
}
