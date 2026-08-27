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
      '/panel/api/clients/traffic/{email}': {},
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
    openApiVersion: '3.0.0',
    trafficEndpointVerified: true
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

test('3.6 capability detection rejects a panel without official client traffic reads', async () => {
  const paths = { ...openApiDocument().paths } as Record<string, unknown>;
  delete paths['/panel/api/clients/traffic/{email}'];
  const client = new XuiClient({
    baseUrl: 'https://incomplete.example.com',
    fetchImpl: async () => jsonResponse(openApiDocument(paths))
  });

  await assert.rejects(() => client.detectCapabilities(), /不支持 3x-ui 3\.6 官方 API/);
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

test('official Xray diagnostics and connectivity checks use documented form fields', async () => {
  const requests: Array<{ path: string; method: string; body: string }> = [];
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      requests.push({
        path: new URL(String(input)).pathname,
        method: init?.method || 'GET',
        body: String(init?.body || '')
      });
      return jsonResponse({ success: true, obj: { outboundTag: 'proxy-us' } });
    }
  });

  await client.getXrayResult();
  await client.testOutbound({ tag: 'proxy-us', protocol: 'freedom' }, [{ tag: 'proxy-us', protocol: 'freedom' }], 'real');
  await client.routeTest({ inboundTag: 'inbound-us', domain: 'example.com', port: 443, network: 'tcp' });

  assert.equal(requests[0]?.path, '/panel/api/xray/getXrayResult');
  assert.equal(requests[0]?.method, 'GET');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[1]?.body)), {
    outbound: JSON.stringify({ tag: 'proxy-us', protocol: 'freedom' }),
    allOutbounds: JSON.stringify([{ tag: 'proxy-us', protocol: 'freedom' }]),
    mode: 'real'
  });
  assert.deepEqual(Object.fromEntries(new URLSearchParams(requests[2]?.body)), {
    inboundTag: 'inbound-us',
    domain: 'example.com',
    port: '443',
    network: 'tcp'
  });
});

test('specific network routes are inserted before broad rules but preserve existing order on edits', () => {
  const service = new XuiService({} as never, {} as never, testLocks()) as any;
  const rules = [
    { type: 'field', inboundTag: ['inbound-eu'], outboundTag: 'eu' },
    { type: 'field', domain: ['geosite:private'], outboundTag: 'block' },
    { type: 'field', outboundTag: 'direct' }
  ];

  assert.equal(service.networkRouteInsertionIndex(rules, { type: 'field', inboundTag: ['inbound-us'], outboundTag: 'us' }), 1);
  assert.equal(service.networkRouteInsertionIndex(rules, { type: 'field', outboundTag: 'direct-2' }), rules.length);
});

test('inbound-only route conflicts are detected while conditional rules are inserted before catch-all routes', () => {
  const service = new XuiService({} as never, {} as never, testLocks()) as any;
  const rules = [
    { type: 'field', inboundTag: ['inbound-us'], outboundTag: 'old-proxy' },
    { type: 'field', outboundTag: 'direct' }
  ];

  assert.deepEqual(service.conflictingInboundOnlyRouteIndexes(rules, {
    type: 'field', inboundTag: ['inbound-us'], outboundTag: 'new-proxy'
  }), [0]);
  assert.deepEqual(service.conflictingInboundOnlyRouteIndexes(rules, {
    type: 'field', inboundTag: ['inbound-us'], domain: ['domain:example.com'], outboundTag: 'new-proxy'
  }), []);
  assert.equal(service.networkRouteInsertionIndex(rules, {
    type: 'field', inboundTag: ['inbound-us'], domain: ['domain:example.com'], outboundTag: 'new-proxy'
  }), 0);
});

test('editing an inbound-only route still detects another rule that already owns the target inbound', async () => {
  const oldRule = { type: 'field', inboundTag: ['inbound-old'], outboundTag: 'proxy-us' };
  const occupiedRule = { type: 'field', inboundTag: ['inbound-new'], outboundTag: 'proxy-eu' };
  const fingerprintService = new XuiService({} as never, {} as never, testLocks()) as any;
  const oldFingerprint = fingerprintService.configFingerprint(oldRule);
  const service = new XuiService({
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true }) },
    networkRoute: { findUnique: async () => ({
      id: 'route-1', serverId: 'server-1', ownership: 'managed', remoteFingerprint: oldFingerprint, remoteOrder: 0,
      normalizedConfig: oldRule, remoteKey: 'route-old', lastSyncedAt: new Date()
    }) },
    networkOutbound: { findUnique: async () => ({ id: 'outbound-1', serverId: 'server-1', tag: 'proxy-us' }) },
    serviceNode: { findUnique: async () => null }
  } as never, {} as never, testLocks()) as any;
  service.loadXrayState = async () => ({
    client: {}, xrayObj: {}, setting: { routing: { rules: [oldRule, occupiedRule] } },
    originalSetting: { routing: { rules: [oldRule, occupiedRule] } }
  });

  await assert.rejects(() => service.upsertNetworkRouteUnlocked({
    serverId: 'server-1',
    name: 'move route',
    outboundId: 'outbound-1',
    ownership: 'managed',
    rule: { type: 'field', inboundTag: ['inbound-new'] },
    pushRemote: true,
    conflict: 'reject'
  }, 'route-1'), /同一入站不能同时指向多个出站/);
});

test('service-node route writes force the confirmed official inbound and selected outbound tags', async () => {
  let writtenSetting: any;
  let savedRoute: any;
  const prisma = {
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true, baseUrl: 'https://panel.example.com', config: {} }) },
    networkRoute: {
      findUnique: async () => null,
      create: async ({ data }: any) => { savedRoute = data; return { id: 'route-1', ...data }; },
      updateMany: async () => ({ count: 0 })
    },
    networkOutbound: { findUnique: async () => ({ id: 'outbound-1', serverId: 'server-1', tag: 'proxy-us' }) },
    serviceNode: { findUnique: async () => ({ id: 'node-1', serverId: 'server-1', config: { remoteInboundTag: 'inbound-us' } }) },
    $transaction: async (operation: (tx: any) => Promise<unknown>) => operation(prisma)
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.loadXrayState = async () => ({
    client: {},
    xrayObj: { outboundTestUrl: 'https://example.com/generate_204' },
    setting: { routing: { rules: [{ type: 'field', outboundTag: 'direct' }] } },
    originalSetting: { routing: { rules: [{ type: 'field', outboundTag: 'direct' }] } }
  });
  service.writeAndVerifyXrayState = async (_serverId: string, state: any) => { writtenSetting = state.setting; return {}; };

  await service.upsertNetworkRouteUnlocked({
    serverId: 'server-1',
    name: 'US route',
    serviceNodeId: 'node-1',
    outboundId: 'outbound-1',
    ownership: 'managed',
    rule: { type: 'field', inboundTag: ['wrong'], outboundTag: 'wrong' },
    pushRemote: true,
    conflict: 'reject'
  });

  assert.deepEqual(writtenSetting.routing.rules[0], { type: 'field', inboundTag: ['inbound-us'], outboundTag: 'proxy-us' });
  assert.deepEqual(savedRoute.normalizedConfig, { type: 'field', inboundTag: ['inbound-us'], outboundTag: 'proxy-us' });
  assert.equal(savedRoute.remoteOrder, 0);
});

test('remote service-node routes reject missing confirmed inbound tags before writing', async () => {
  let remoteReads = 0;
  const service = new XuiService({
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true }) },
    networkRoute: { findUnique: async () => null },
    networkOutbound: { findUnique: async () => ({ id: 'outbound-1', serverId: 'server-1', tag: 'proxy-us' }) },
    serviceNode: { findUnique: async () => ({ id: 'node-1', serverId: 'server-1', config: {} }) }
  } as never, {} as never, testLocks()) as any;
  service.loadXrayState = async () => { remoteReads += 1; return {}; };

  await assert.rejects(() => service.upsertNetworkRouteUnlocked({
    serverId: 'server-1',
    name: 'US route',
    serviceNodeId: 'node-1',
    outboundId: 'outbound-1',
    ownership: 'managed',
    rule: { type: 'field' },
    pushRemote: true,
    conflict: 'reject'
  }), /缺少已确认的官方入站标签/);
  assert.equal(remoteReads, 0);
});

test('automatic route replacement only permits a precisely matched managed local rule', async () => {
  const existingRule = { type: 'field', inboundTag: ['inbound-us'], outboundTag: 'proxy-old' };
  const fingerprintService = new XuiService({} as never, {} as never, testLocks()) as any;
  const existingFingerprint = fingerprintService.configFingerprint(existingRule);
  const service = new XuiService({
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true }) },
    networkOutbound: { findMany: async () => [] },
    networkRoute: { findMany: async () => [{
      id: 'route-1', serverId: 'server-1', ownership: 'referenced', remoteOrder: 0,
      remoteFingerprint: existingFingerprint
    }] }
  } as never, {} as never, testLocks()) as any;
  service.parseOutboundInput = () => [{
    name: 'US proxy', format: 'xray_json', outbound: { tag: 'proxy-us', protocol: 'freedom' }
  }];
  service.loadXrayState = async () => ({
    client: { listInbounds: async () => ({ success: true, obj: [{ tag: 'inbound-us' }] }) },
    xrayObj: {},
    setting: { outbounds: [], routing: { rules: [existingRule] } },
    originalSetting: { outbounds: [], routing: { rules: [existingRule] } }
  });

  await assert.rejects(() => service.importNetworkOutboundsUnlocked({
    serverId: 'server-1', input: '{}', format: 'xray_json', ownership: 'managed', strategy: 'target_panel',
    conflict: 'replace_managed', createRoute: true, inboundTags: ['inbound-us']
  }), /不是本系统精确确认的托管规则/);
});

test('route persistence failure after an official write restores the previous Xray config', async () => {
  const oldRule = { type: 'field', inboundTag: ['inbound-eu'], outboundTag: 'direct' };
  let restores = 0;
  const prisma = {
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true }) },
    networkRoute: { findUnique: async () => null },
    networkOutbound: { findUnique: async () => ({ id: 'outbound-1', serverId: 'server-1', tag: 'proxy-us' }) },
    serviceNode: { findUnique: async () => null },
    $transaction: async () => { throw new Error('database unavailable'); }
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.loadXrayState = async () => ({
    client: {}, xrayObj: {}, setting: { routing: { rules: [oldRule] } }, originalSetting: { routing: { rules: [oldRule] } }
  });
  service.writeAndVerifyXrayState = async () => ({});
  service.restoreXrayState = async () => { restores += 1; };
  service.writeSyncLog = async () => undefined;

  await assert.rejects(() => service.upsertNetworkRouteUnlocked({
    serverId: 'server-1', name: 'US route', outboundId: 'outbound-1', ownership: 'managed',
    rule: { type: 'field', inboundTag: ['inbound-us'] }, pushRemote: true, conflict: 'reject'
  }), /已自动恢复到写入前状态/);
  assert.equal(restores, 1);
});

test('explicit route takeover reuses the precisely matched local route record', async () => {
  const oldRule = { type: 'field', inboundTag: ['inbound-us'], outboundTag: 'proxy-old' };
  const fingerprintService = new XuiService({} as never, {} as never, testLocks()) as any;
  const oldFingerprint = fingerprintService.configFingerprint(oldRule);
  let updatedId = '';
  let createCalls = 0;
  const prisma = {
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true }) },
    networkRoute: {
      findUnique: async () => null,
      findFirst: async ({ where }: any) => where.remoteOrder === 0 && where.remoteFingerprint === oldFingerprint
        ? { id: 'route-existing', serverId: 'server-1', ownership: 'referenced', remoteOrder: 0, remoteFingerprint: oldFingerprint, normalizedConfig: oldRule, lastSyncedAt: null }
        : null,
      update: async ({ where, data }: any) => { updatedId = where.id; return { id: where.id, ...data }; },
      create: async () => { createCalls += 1; return { id: 'route-new' }; },
      updateMany: async () => ({ count: 0 })
    },
    networkOutbound: { findUnique: async () => ({ id: 'outbound-1', serverId: 'server-1', tag: 'proxy-us' }) },
    serviceNode: { findUnique: async () => null },
    $transaction: async (operation: (tx: any) => Promise<unknown>) => operation(prisma)
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.loadXrayState = async () => ({
    client: {}, xrayObj: {}, setting: { routing: { rules: [oldRule] } }, originalSetting: { routing: { rules: [oldRule] } }
  });
  service.writeAndVerifyXrayState = async () => ({});

  const result = await service.upsertNetworkRouteUnlocked({
    serverId: 'server-1', name: 'US route', outboundId: 'outbound-1', ownership: 'managed',
    rule: { type: 'field', inboundTag: ['inbound-us'] }, pushRemote: true, conflict: 'takeover'
  });

  assert.equal(result.id, 'route-existing');
  assert.equal(updatedId, 'route-existing');
  assert.equal(createCalls, 0);
});

test('route deletion restores the official config when the local transaction fails', async () => {
  const rule = { type: 'field', inboundTag: ['inbound-us'], outboundTag: 'proxy-us' };
  const fingerprintService = new XuiService({} as never, {} as never, testLocks()) as any;
  const fingerprint = fingerprintService.configFingerprint(rule);
  let restores = 0;
  const route = {
    id: 'route-1', serverId: 'server-1', ownership: 'managed', remoteOrder: 0, remoteFingerprint: fingerprint,
    normalizedConfig: rule, server: { id: 'server-1', enabled: true }
  };
  const prisma = {
    networkRoute: { findUnique: async () => route },
    $transaction: async () => { throw new Error('database unavailable'); }
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.loadXrayState = async () => ({
    client: {}, xrayObj: {}, setting: { routing: { rules: [rule] } }, originalSetting: { routing: { rules: [rule] } }
  });
  service.writeAndVerifyXrayState = async () => ({});
  service.restoreXrayState = async () => { restores += 1; };
  service.writeSyncLog = async () => undefined;

  await assert.rejects(() => service.deleteNetworkRouteUnlocked('route-1', true, false), /已自动恢复到删除前状态/);
  assert.equal(restores, 1);
});

test('Xray state verification waits for running, tests outbound and restores the previous config on failure', async () => {
  const updates: string[] = [];
  let restartCalls = 0;
  const service = new XuiService({} as never, {} as never, testLocks()) as any;
  const client = {
    updateXrayConfig: async ({ xraySetting }: any) => { updates.push(xraySetting); return { success: true }; },
    restartXrayService: async () => { restartCalls += 1; return { success: true }; },
    serverStatus: async () => ({ success: true, obj: { xray: { state: 'running', errorMsg: '' } } }),
    getXrayConfig: async () => ({ success: true, obj: { xraySetting: { outbounds: [{ tag: 'proxy-us', protocol: 'freedom' }], routing: { rules: [] } } } }),
    testOutbound: async () => ({ success: true, obj: { success: false, error: 'connection refused' } }),
    getXrayResult: async () => ({ success: true, obj: '' })
  };

  await assert.rejects(() => service.writeAndVerifyXrayState('server-1', {
    client,
    xrayObj: {},
    setting: { outbounds: [{ tag: 'proxy-us', protocol: 'freedom' }], routing: { rules: [] } },
    originalSetting: { outbounds: [{ tag: 'direct', protocol: 'freedom' }], routing: { rules: [] } }
  }, ['proxy-us']), /connection refused/);

  assert.equal(updates.length, 2);
  assert.match(updates[0]!, /proxy-us/);
  assert.match(updates[1]!, /direct/);
  assert.equal(restartCalls, 2);
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
    email: 'managed-user-3@example.com',
    totalGB: 0,
    expiryTime: 0,
    tgId: 0,
    limitIp: 0,
    enable: true
  });

  assert.deepEqual(requestBody, {
    client: {
      email: 'managed-user-3@example.com',
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

test('3.6 request errors preserve structured validation details', async () => {
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async () => jsonResponse({
      detail: [
        { loc: ['body', 'client', 'email'], msg: 'value is not a valid email address', type: 'value_error.email' },
        { loc: ['body', 'inboundIds'], msg: 'field required', type: 'value_error.missing' }
      ]
    }, 422)
  });

  await assert.rejects(
    () => client.addClient(9, { email: 'invalid-client' }),
    /body\.client\.email: value is not a valid email address; body\.inboundIds: field required/
  );
});

test('3.6 success-false validation details remain available to callers', async () => {
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async () => jsonResponse({
      success: false,
      errors: [{ field: 'client.email', message: 'invalid email' }]
    })
  });
  const service = new XuiService({} as never, {} as never, testLocks()) as any;

  const response = await client.addClient(9, { email: 'invalid-client' });
  assert.throws(() => service.assertXuiSuccess(response), /client\.email: invalid email/);
});

test('generated managed client identifiers are short valid emails and stable per inbound', () => {
  const service = new XuiService({} as never, {} as never, testLocks());
  const first = service.customerClientEmail('测试', 'ceshi1', 9);
  const second = service.customerClientEmail('不同显示名', 'ceshi1', 9);

  assert.equal(first, 'ceshi1.9@shiye.io');
  assert.equal(first, second);
});

test('single outbound custom name becomes the official outbound tag in preview', () => {
  const service = new XuiService({} as never, {} as never, testLocks());
  const preview = service.previewOutboundImport({
    format: 'xray_json',
    name: '美国出口',
    input: JSON.stringify({ protocol: 'freedom', tag: 'generated-long-tag', settings: {} })
  });

  assert.equal(preview.count, 1);
  assert.equal(preview.items[0].name, '美国出口');
  assert.equal(preview.items[0].tag, '美国出口');
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

test('node authorization uses the official full-row update endpoint without adding or deleting clients', async () => {
  const requests: Array<{ path: string; method: string; body: any }> = [];
  let remoteClient = {
    email: 'shared@example.com',
    uuid: 'shared-uuid',
    password: 'keep-password',
    flow: 'xtls-rprx-vision',
    comment: '东京节点',
    totalGB: 107374182400,
    expiryTime: 0,
    enable: false,
    inboundIds: [9],
    createdAt: 100
  };
  const client = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, method: init?.method || 'GET', body });
      if (path === '/panel/api/inbounds/list') return jsonResponse({ success: true, obj: [{ id: 9 }] });
      if (path === '/panel/api/clients/list') return jsonResponse({ success: true, obj: [{ client: remoteClient, inboundIds: [9] }] });
      if (path === '/panel/api/clients/get/shared%40example.com') {
        return jsonResponse({ success: true, obj: JSON.stringify({ client: remoteClient, inboundIds: [9] }) });
      }
      if (path === '/panel/api/clients/update/shared%40example.com') {
        remoteClient = { ...remoteClient, ...body };
        return jsonResponse({ success: true, msg: 'Client updated' });
      }
      return jsonResponse({ message: `unexpected request ${path}` }, 500);
    }
  });
  const serviceNode = customerNodeFixture().serviceNode;
  let storedConfig: any = serviceNode.config;
  const service = new XuiService({
    serviceNode: {
      findUnique: async () => ({ ...serviceNode, config: storedConfig }),
      update: async ({ data }: any) => {
        storedConfig = data.config;
        return { ...serviceNode, config: storedConfig };
      }
    },
    syncLog: { create: async () => ({}) }
  } as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => client;

  const expireAt = new Date('2030-01-01T00:00:00Z');
  const result = await service.updateServiceNodeRemoteAuthorization('service-node-1', {
    email: 'shared@example.com',
    uuid: 'shared-uuid'
  }, expireAt, true);

  const updateRequest = requests.find((request) => request.path === '/panel/api/clients/update/shared%40example.com');
  assert.equal(result.remoteWrite, true);
  assert.equal(updateRequest?.method, 'POST');
  assert.deepEqual(updateRequest?.body, {
    email: 'shared@example.com',
    uuid: 'shared-uuid',
    password: 'keep-password',
    flow: 'xtls-rprx-vision',
    totalGB: 107374182400,
    expiryTime: expireAt.getTime(),
    enable: true,
    comment: '东京节点'
  });
  assert.equal(requests.some((request) => request.path === '/panel/api/clients/add'), false);
  assert.equal(requests.some((request) => request.path.includes('/panel/api/clients/del/')), false);
  assert.equal(storedConfig.remoteClientExpireAt, expireAt.toISOString());
  assert.equal(storedConfig.remoteClientEnabled, true);
});

test('customer links reject every inactive authorization layer before contacting the panel', async () => {
  const cases = [
    { patch: { customer: { status: 'disabled' } }, message: /用户账号已停用/ },
    { patch: { serviceNode: { enabled: false } }, message: /服务节点已停用/ },
    { patch: { status: 'disabled' }, message: /节点已停用/ },
    { patch: { expireAt: new Date('2020-01-01T00:00:00Z') }, message: /节点已到期/ }
  ];

  for (const item of cases) {
    const fixture = customerNodeFixture();
    const node = {
      ...fixture,
      ...item.patch,
      customer: { status: 'active', ...(item.patch as any).customer },
      serviceNode: { ...fixture.serviceNode, ...(item.patch as any).serviceNode }
    };
    const service = new XuiService({
      customerNode: { findFirst: async () => node }
    } as never, {} as never, testLocks()) as any;
    service.createAuthenticatedClient = async () => {
      throw new Error('inactive authorization must not contact the panel');
    };

    await assert.rejects(() => service.customerNodeLinks('customer-1', 'customer-node-1'), item.message);
  }
});

test('user bindings can synchronize node authorization but never own shared client lifecycle operations', async () => {
  const service = new XuiService({
    customerNode: { findFirst: async () => ({ ...customerNodeFixture(), remoteControl: 'reference' }) }
  } as never, {} as never, testLocks()) as any;
  let authorizationPatch: any;
  service.patchCustomerNodeRemote = async (_customerId: string, _customerNodeId: string, patch: unknown, operation: string) => {
    authorizationPatch = { patch, operation };
    return { synced: true, remoteWrite: true };
  };

  const expiry = await service.updateCustomerNodeExpiry('customer-1', 'customer-node-1', new Date('2030-01-01T00:00:00Z'), true);
  assert.equal(expiry.remoteWrite, true);
  assert.deepEqual(authorizationPatch, {
    patch: { expiryTime: new Date('2030-01-01T00:00:00Z').getTime(), enable: true },
    operation: 'expiry'
  });
  await assert.rejects(
    () => service.createCustomerNodeRemoteClient('customer-1', 'customer-node-1', {
      email: 'new@example.com',
      trafficLimitGb: 100,
      enabled: true
    }),
    /绑定用户不会创建官方客户端/
  );
  await assert.rejects(
    () => service.patchCustomerNodeRemoteClient('customer-1', 'customer-node-1', { enabled: false }),
    /用户绑定不拥有官方客户端/
  );
  await assert.rejects(
    () => service.deleteCustomerNodeRemoteClient('customer-1', 'customer-node-1'),
    /用户绑定不拥有官方客户端/
  );
  await assert.rejects(
    () => service.resetCustomerNodeTraffic('customer-1', 'customer-node-1'),
    /用户绑定不拥有官方客户端/
  );
});

test('legacy subscription-managed bindings still cannot own shared clients', async () => {
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
    /绑定用户不会创建官方客户端/
  );
  await assert.rejects(
    () => service.deleteCustomerNodeRemoteClient('customer-1', 'customer-node-1'),
    /用户绑定不拥有官方客户端/
  );
  await assert.rejects(
    () => service.resetCustomerNodeTraffic('customer-1', 'customer-node-1'),
    /用户绑定不拥有官方客户端/
  );
});

test('shared client deletion uses the global delete endpoint and not detach', async () => {
  const service = new XuiService({} as never, {} as never, testLocks()) as any;
  let deleteCalls = 0;
  let detachCalls = 0;
  let existenceChecks = 0;
  const client = {
    getClientRecord: async () => {
      existenceChecks += 1;
      if (existenceChecks === 1) return { email: 'user@example.com', inboundIds: [9] };
      const error = new Error('3x-ui request failed: 404 - not found');
      (error as any).status = 404;
      throw error;
    },
    deleteClient: async () => { deleteCalls += 1; return { success: true }; },
    detachClient: async () => { detachCalls += 1; return { success: true }; }
  };
  service.isRemoteNotFound = (error: any) => error.status === 404;
  service.writeSyncLog = async () => undefined;

  const result = await service.deleteRemoteClientWithClient(client, 'server-1', 9, 'user@example.com', false, {});

  assert.equal(result.deleted, true);
  assert.equal(deleteCalls, 1);
  assert.equal(detachCalls, 0);
});

test('service-node client settings can rename the official email and synchronize every binding', async () => {
  const bindings = [
    { id: 'binding-1', config: { subId: 'old-sub' } },
    { id: 'binding-2', config: { subId: 'old-sub' } }
  ];
  const bindingUpdates: any[] = [];
  let serviceConfig: any;
  let updateRequest: any;
  let renamed = false;
  const serviceNode = {
    id: 'service-node-1',
    serverId: 'server-1',
    inboundId: 9,
    name: '美国节点',
    protocol: 'vless',
    ownership: 'managed',
    config: { remoteClientEmail: 'old-client', remoteClientUuid: 'uuid-1', remoteClientSubId: 'sub-1', encryption: 'none' },
    server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} }
  };
  const prisma = {
    serviceNode: {
      findUnique: async () => serviceNode,
      update: async ({ data }: any) => { serviceConfig = data.config; return serviceNode; }
    },
    customerNode: {
      findMany: async () => bindings,
      update: async ({ where, data }: any) => { bindingUpdates.push({ id: where.id, data }); return data; }
    },
    syncLog: { create: async () => ({}) },
    $transaction: async (operation: any) => operation({
      serviceNode: { update: async ({ data }: any) => { serviceConfig = data.config; return serviceNode; } },
      customerNode: {
        findMany: async () => bindings,
        update: async ({ where, data }: any) => { bindingUpdates.push({ id: where.id, data }); return data; }
      }
    })
  };
  const client = {
    getClientRecord: async (email: string) => {
      if (email === 'old-client') return { email: 'old-client', uuid: 'uuid-1', subId: 'sub-1', comment: '旧名称', inboundIds: [9], enable: true };
      if (email === 'short-us' && renamed) return { email: 'short-us', uuid: 'uuid-1', subId: 'sub-1', comment: '美国短名', inboundIds: [9], enable: true };
      const error = new Error('3x-ui request failed: 404 - not found');
      (error as any).status = 404;
      throw error;
    },
    updateClient: async (inboundId: number, email: string, payload: any) => {
      updateRequest = { inboundId, email, payload };
      renamed = true;
      return { success: true };
    },
    listClients: async () => ({ success: true, obj: [{ client: { email: 'short-us', uuid: 'uuid-1', subId: 'sub-1', comment: '美国短名', enable: true }, inboundIds: [9] }] }),
    clientLinks: async () => ({ success: true, obj: ['vless://uuid-1@example.com:443#old'] })
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.isRemoteNotFound = (error: any) => error.status === 404;
  service.createAuthenticatedClient = async () => client;

  const result = await service.patchServiceNodeRemoteClient('service-node-1', { email: 'short-us', clientName: '美国短名' });

  assert.equal(result.updated, true);
  assert.equal(updateRequest.inboundId, 9);
  assert.equal(updateRequest.email, 'old-client');
  assert.equal(updateRequest.payload.email, 'short-us');
  assert.equal(updateRequest.payload.comment, '美国短名');
  assert.equal(serviceConfig.remoteClientEmail, 'short-us');
  assert.equal(serviceConfig.remoteClientName, '美国短名');
  assert.equal(bindingUpdates.length, 2);
  assert.deepEqual(bindingUpdates.map((item) => item.data.xuiEmail), ['short-us', 'short-us']);
  assert.deepEqual(bindingUpdates.map((item) => item.data.clientName), ['美国短名', '美国短名']);
});

test('service-node create action restores an existing client attached to the same inbound without adding a duplicate', async () => {
  let addCalls = 0;
  let storedConfig: any;
  const serviceNode = {
    id: 'service-node-1', serverId: 'server-1', inboundId: 9, name: '美国节点', protocol: 'vless', ownership: 'managed', config: { encryption: 'none' },
    server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} }
  };
  const prisma = {
    serviceNode: { findUnique: async () => serviceNode },
    syncLog: { create: async () => ({}) },
    $transaction: async (operation: any) => operation({
      serviceNode: { update: async ({ data }: any) => { storedConfig = data.config; return serviceNode; } },
      customerNode: { findMany: async () => [], update: async () => ({}) }
    })
  };
  const client = {
    getClientRecord: async () => ({ email: 'short-us', uuid: 'uuid-1', subId: 'sub-1', comment: '美国短名', inboundIds: [9], totalGB: 107374182400, expiryTime: 0, enable: true }),
    addClient: async () => { addCalls += 1; return { success: true }; },
    clientLinks: async () => ({ success: true, obj: ['vless://uuid-1@example.com:443#old'] })
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => client;

  const result = await service.createServiceNodeRemoteClient('service-node-1', { email: 'short-us', trafficLimitGb: 0, enabled: true });

  assert.equal(result.restored, true);
  assert.equal(result.remoteWrite, false);
  assert.equal(addCalls, 0);
  assert.equal(storedConfig.remoteClientEmail, 'short-us');
  assert.equal(storedConfig.remoteClientTrafficLimitGb, 100);
});

test('service-node traffic reset uses the official client endpoint and clears all local binding counters', async () => {
  let resetArgs: any;
  let localReset: any;
  const serviceNode = {
    id: 'service-node-1', serverId: 'server-1', inboundId: 9, ownership: 'managed', config: { remoteClientEmail: 'short-us' },
    server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} }
  };
  const prisma = {
    serviceNode: { findUnique: async () => serviceNode, update: async () => serviceNode },
    customerNode: { updateMany: async (args: any) => { localReset = args; return { count: 2 }; } },
    syncLog: { create: async () => ({}) }
  };
  const client = {
    resetClientTraffic: async (inboundId: number, email: string) => { resetArgs = { inboundId, email }; return { success: true }; },
    clientTraffic: async () => ({ success: true, obj: { up: 0, down: 0 } })
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => client;

  await service.resetServiceNodeTraffic('service-node-1');

  assert.deepEqual(resetArgs, { inboundId: 9, email: 'short-us' });
  assert.equal(localReset.where.serviceNodeId, 'service-node-1');
  assert.equal(localReset.data.usedTrafficGb.toString(), '0');
  assert.equal(localReset.data.lastSyncedAt, null);
});

test('customer-node traffic sync stores the official up and down byte total', async () => {
  let storedUpdate: any;
  const customerNode = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'short-us',
    serviceNodeId: 'service-node-1',
    serviceNode: { config: { remoteClientEmail: 'short-us' }, server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} } }
  };
  const prisma = {
    customerNode: {
      findFirst: async ({ select }: any) => select ? { serviceNodeId: customerNode.serviceNodeId } : customerNode,
      update: async (args: any) => { storedUpdate = args; return customerNode; }
    }
  };
  const client = {
    clientTraffic: async (email: string) => ({ success: true, obj: { email, up: 1024 * 1024 * 1024, down: 512 * 1024 * 1024 } })
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => client;

  const result = await service.syncCustomerNodeTraffic('customer-1', 'customer-node-1');

  assert.equal(result.usedBytes, 1610612736);
  assert.equal(result.usedTrafficGb, 1.5);
  assert.equal(result.totalBytes, null);
  assert.equal(result.remainingBytes, null);
  assert.equal(result.unlimited, null);
  assert.equal(storedUpdate.where.id, 'customer-node-1');
  assert.equal(storedUpdate.data.usedTrafficGb.toString(), '1.5');
  assert.equal(storedUpdate.data.lastSyncedAt instanceof Date, true);
});

test('customer-node traffic sync treats official total zero as unlimited traffic', async () => {
  const customerNode = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'short-us',
    serviceNodeId: 'service-node-1',
    serviceNode: {
      config: { remoteClientEmail: 'short-us' },
      server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} }
    }
  };
  const prisma = {
    customerNode: {
      findFirst: async () => customerNode,
      update: async () => customerNode
    }
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => ({
    clientTraffic: async () => ({ success: true, obj: { up: 1024, down: 2048, total: 0 } })
  });

  const result = await service.syncCustomerNodeTraffic('customer-1', 'customer-node-1');

  assert.equal(result.usedBytes, 3072);
  assert.equal(result.totalBytes, 0);
  assert.equal(result.remainingBytes, null);
  assert.equal(result.unlimited, true);
});

test('customer-node traffic sync calculates official remaining traffic', async () => {
  const customerNode = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'short-us',
    serviceNodeId: 'service-node-1',
    serviceNode: {
      config: { remoteClientEmail: 'short-us' },
      server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} }
    }
  };
  const prisma = {
    customerNode: {
      findFirst: async () => customerNode,
      update: async () => customerNode
    }
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => ({
    clientTraffic: async () => ({ success: true, obj: { up: 10, down: 20, total: 100 } })
  });

  const result = await service.syncCustomerNodeTraffic('customer-1', 'customer-node-1');

  assert.equal(result.usedBytes, 30);
  assert.equal(result.totalBytes, 100);
  assert.equal(result.remainingBytes, 70);
  assert.equal(result.unlimited, false);
});

test('customer-node traffic sync rejects an official response without counters', async () => {
  let localUpdates = 0;
  const customerNode = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'short-us',
    serviceNodeId: 'service-node-1',
    serviceNode: { config: { remoteClientEmail: 'short-us' }, server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} } }
  };
  const prisma = {
    customerNode: {
      findFirst: async ({ select }: any) => select ? { serviceNodeId: customerNode.serviceNodeId } : customerNode,
      update: async () => { localUpdates += 1; }
    }
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => ({ clientTraffic: async () => ({ success: true, obj: { email: 'short-us', up: 1024 } }) });

  await assert.rejects(() => service.syncCustomerNodeTraffic('customer-1', 'customer-node-1'), /缺少 up\/down 字段/);
  assert.equal(localUpdates, 0);
});

test('customer-node traffic sync rejects a stale binding identity before reading the panel', async () => {
  let remoteReads = 0;
  const customerNode = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'old-email',
    serviceNodeId: 'service-node-1',
    serviceNode: {
      config: { remoteClientEmail: 'current-email' },
      server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} }
    }
  };
  const prisma = {
    customerNode: { findFirst: async () => customerNode }
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.createAuthenticatedClient = async () => ({
    clientTraffic: async () => { remoteReads += 1; return { success: true, obj: { up: 0, down: 0 } }; }
  });

  await assert.rejects(() => service.syncCustomerNodeTraffic('customer-1', 'customer-node-1'), /标识不一致/);
  assert.equal(remoteReads, 0);
});

test('managed service-node deletion verifies client absence before deleting and verifying the inbound', async () => {
  const operations: string[] = [];
  let clientExists = true;
  let inboundExists = true;
  const serviceNode = {
    id: 'service-node-1',
    serverId: 'server-1',
    inboundId: 9,
    ownership: 'managed',
    config: { remoteClientEmail: 'short-us' },
    server: { id: 'server-1', baseUrl: 'https://panel.example.com', config: {} },
    customerNodes: [{ xuiEmail: 'short-us', remoteControl: 'reference', lastSyncedAt: null, config: {} }]
  };
  const prisma = {
    serviceNode: { findUnique: async () => serviceNode },
    syncLog: { create: async () => ({}) }
  };
  const notFound = () => {
    const error = new Error('3x-ui request failed: 404 - not found');
    (error as any).status = 404;
    return error;
  };
  const client = {
    getClientRecord: async () => {
      operations.push('check-client');
      if (!clientExists) throw notFound();
      return { email: 'short-us', inboundIds: [9] };
    },
    deleteClient: async () => {
      operations.push('delete-client');
      clientExists = false;
      return { success: true };
    },
    getInbound: async () => {
      operations.push('check-inbound');
      if (!inboundExists) throw notFound();
      return { success: true, obj: { id: 9 } };
    },
    deleteInbound: async () => {
      operations.push('delete-inbound');
      inboundExists = false;
      return { success: true };
    }
  };
  const service = new XuiService(prisma as never, {} as never, testLocks()) as any;
  service.isRemoteNotFound = (error: any) => error.status === 404;
  service.createAuthenticatedClient = async () => client;

  const result = await service.deleteManagedServiceNodeInbound('service-node-1');

  assert.equal(result.deleted, true);
  assert.deepEqual(operations, [
    'check-client',
    'delete-client',
    'check-client',
    'check-inbound',
    'delete-inbound',
    'check-inbound'
  ]);
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
    clientName: '测试用户',
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
