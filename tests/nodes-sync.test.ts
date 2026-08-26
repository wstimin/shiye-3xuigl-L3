import test from 'node:test';
import assert from 'node:assert/strict';
import { NodesService } from '../apps/api/src/modules/nodes/nodes.service.js';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';
import { XuiClient } from '../packages/xui-client/src/index.js';
import { testLocks } from './test-locks.js';

const baseInput = {
  name: '东京路由',
  serverId: 'server-1',
  remoteMode: 'create' as const,
  inboundId: undefined,
  inboundPort: 24443,
  protocol: 'vless',
  encryption: 'none',
  transport: 'tcp',
  tcpHeaderType: 'none',
  transportHost: '',
  transportPath: '/',
  grpcServiceName: '',
  grpcAuthority: '',
  grpcMultiMode: false,
  xhttpMode: 'auto',
  priceMonthly: 10,
  trafficLimitGb: 100,
  enabled: true,
  socksRelayEnabled: false,
  socksNodeId: '',
  remark: ''
};

function encryption() {
  return { encryptNullable: (value: unknown) => value || null, decryptNullable: (value: unknown) => value || null } as any;
}

test('binding an existing inbound never creates a remote inbound or client', async () => {
  let createdRemote = 0;
  const prisma = {
    xuiServer: { findUnique: async () => ({ id: 'server-1' }) },
    serviceNode: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({ id: 'node-1', ...data, server: { id: 'server-1', name: '面板', baseUrl: 'https://panel.example.com', enabled: true } })
    },
    socksNode: { findUnique: async () => null }
  } as any;
  const xui = {
    createServiceNodeInbound: async () => { createdRemote += 1; throw new Error('must not create'); },
    validateServiceNodeInbound: async () => ({
      protocol: 'vless',
      encryption: 'none',
      port: 443,
      transportConfig: { transport: 'tcp', tcpHeaderType: 'none', transportHost: '', transportPath: '/', grpcServiceName: '', grpcAuthority: '', grpcMultiMode: false, xhttpMode: 'auto' },
      remoteClient: { email: 'existing@example.com', uuid: '11111111-2222-4333-8444-555555555555', subId: 'existing-sub' }
    })
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());
  const result = await service.createServiceNode({ ...baseInput, remoteMode: 'bind', inboundId: 12 });
  assert.equal(createdRemote, 0);
  assert.equal(result.state, 'success');
  assert.equal(result.inboundId, 12);
});

test('SOCKS sync failure after local create returns partial and keeps the remote inbound', async () => {
  let deletedRemote = 0;
  let taskWrites = 0;
  const prisma = {
    xuiServer: { findUnique: async () => ({ id: 'server-1' }) },
    serviceNode: {
      findFirst: async () => null,
      create: async ({ data }: any) => ({ id: 'node-1', ...data, server: { id: 'server-1', name: '面板', baseUrl: 'https://panel.example.com', enabled: true } })
    },
    socksNode: { findUnique: async () => ({ id: 'socks-1', enabled: true }) },
    syncTask: {
      upsert: async () => { taskWrites += 1; return {}; },
      updateMany: async () => ({ count: 0 })
    }
  } as any;
  const xui = {
    createServiceNodeInbound: async () => ({
      inboundId: 20,
      port: 24443,
      tag: 'shiye-20',
      remark: '东京路由',
      remoteClientEmail: 'service@example.com',
      remoteClientUuid: '11111111-2222-4333-8444-555555555555',
      remoteClientSubId: 'service-sub',
      links: ['vless://example']
    }),
    syncServiceNodeRemoteConfig: async () => { throw new Error('remote offline'); },
    deleteRemoteInbound: async () => { deletedRemote += 1; }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());
  const result = await service.createServiceNode({ ...baseInput, socksRelayEnabled: true, socksNodeId: 'socks-1' });
  assert.equal(result.state, 'partial');
  assert.equal(result.message, '创建成功，同步失败');
  assert.deepEqual(result.pendingActions, ['service-config']);
  assert.equal(taskWrites, 1);
  assert.equal(deletedRemote, 0);
});

test('new Reality service nodes persist a manually supplied minimum client version', async () => {
  let createdConfig: any;
  const prisma = {
    xuiServer: { findUnique: async () => ({ id: 'server-1' }) },
    serviceNode: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        createdConfig = data.config;
        return { id: 'node-1', ...data, server: { id: 'server-1', name: '面板', baseUrl: 'https://panel.example.com', enabled: true } };
      }
    },
    socksNode: { findUnique: async () => null }
  } as any;
  const xui = {
    createServiceNodeInbound: async () => ({
      inboundId: 20,
      port: 24443,
      tag: 'shiye-20',
      remark: 'Reality 节点',
      remoteClientEmail: 'service@example.com',
      remoteClientUuid: '11111111-2222-4333-8444-555555555555',
      remoteClientSubId: 'service-sub',
      links: ['vless://example'],
      realityTarget: 'cdn.example.com:443',
      realityServerName: 'cdn.example.com'
    })
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  await service.createServiceNode({
    ...baseInput,
    name: 'Reality 节点',
    encryption: 'reality',
    realityTarget: 'cdn.example.com:443',
    realityServerName: 'cdn.example.com',
    realityMinClientVersion: '1.0.0'
  });

  assert.equal(createdConfig.realityMinClientVersion, '1.0.0');
});

test('binding refreshes remote identity without creating or modifying the remote client', async () => {
  let refreshCalls = 0;
  let remoteWriteCalls = 0;
  let storedNode: any;
  const serviceNode = {
    id: 'service-node-1',
    inboundId: 12,
    trafficLimitGb: 100,
    config: {
      remoteClientEmail: 'shiye-long-generated-client@example.com',
      remoteClientUuid: '11111111-2222-4333-8444-555555555555',
      remoteClientSubId: 'service-sub'
    }
  };
  const prisma = {
    customer: { findUnique: async () => ({ id: 'customer-1', name: '张 三', loginUsername: 'zhangsan' }) },
    serviceNode: { findUnique: async () => serviceNode },
    customerNode: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        storedNode = { id: 'customer-node-1', ...data, trafficLimitGb: 100 };
        return storedNode;
      },
      findUnique: async () => storedNode,
      delete: async () => ({})
    }
  } as any;
  const xui = {
    refreshCustomerNodeBinding: async () => {
      refreshCalls += 1;
      return { synced: true, remoteWrite: false, node: storedNode };
    },
    createCustomerNodeRemoteClient: async () => { remoteWriteCalls += 1; },
    patchCustomerNodeRemoteClient: async () => { remoteWriteCalls += 1; },
    deleteCustomerNodeRemoteClient: async () => { remoteWriteCalls += 1; }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  await service.bindCustomerNode('customer-1', {
    serviceNodeId: 'service-node-1',
    xuiEmail: 'existing-client@example.com',
    trafficLimitGb: 100,
    remoteControl: 'reference',
    takeover: false
  });

  assert.equal(refreshCalls, 1);
  assert.equal(remoteWriteCalls, 0);
});

test('managed binding separates the readable name from the official email identifier', async () => {
  let storedNode: any;
  let createInput: any;
  const serviceNode = { id: 'service-node-1', inboundId: 12, trafficLimitGb: 100 };
  const prisma = {
    customer: { findUnique: async () => ({ id: 'customer-1', name: '马来用户', loginUsername: 'malai' }) },
    serviceNode: { findUnique: async () => serviceNode },
    customerNode: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        storedNode = { id: 'customer-node-1', ...data, trafficLimitGb: 100 };
        return storedNode;
      },
      findUnique: async () => storedNode,
      delete: async () => ({})
    }
  } as any;
  const xui = {
    customerClientEmail: (_name: string, loginUsername: string, inboundId: number) => `${loginUsername}.${inboundId}@shiye.io`,
    createCustomerNodeRemoteClient: async (_customerId: string, _customerNodeId: string, input: any) => {
      createInput = input;
      return { created: true, remoteWrite: true, binding: storedNode };
    }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  await service.bindCustomerNode('customer-1', {
    serviceNodeId: 'service-node-1',
    remoteAction: 'create',
    remoteControl: 'fully_managed',
    takeover: true,
    trafficLimitGb: 100
  });

  assert.equal(storedNode.clientName, 'malai');
  assert.equal(storedNode.xuiEmail, 'malai.12@shiye.io');
  assert.equal(createInput.clientName, 'malai');
  assert.equal(createInput.email, 'malai.12@shiye.io');
});

test('legacy binding requests treat xuiEmail as a display name instead of sending it to the official email field', async () => {
  let storedNode: any;
  let createInput: any;
  const serviceNode = { id: 'service-node-1', inboundId: 8, trafficLimitGb: 100 };
  const prisma = {
    customer: { findUnique: async () => ({ id: 'customer-1', name: '测试', loginUsername: 'ceshi1' }) },
    serviceNode: { findUnique: async () => serviceNode },
    customerNode: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        storedNode = { id: 'customer-node-1', ...data, trafficLimitGb: 100 };
        return storedNode;
      },
      findUnique: async () => storedNode,
      delete: async () => ({})
    }
  } as any;
  const xui = {
    customerClientEmail: (_name: string, loginUsername: string, inboundId: number) => `${loginUsername}.${inboundId}@shiye.io`,
    createCustomerNodeRemoteClient: async (_customerId: string, _customerNodeId: string, input: any) => {
      createInput = input;
      return { created: true, remoteWrite: true, binding: storedNode };
    }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  await service.bindCustomerNode('customer-1', {
    serviceNodeId: 'service-node-1',
    xuiEmail: 'ceshi1',
    remoteAction: 'create',
    remoteControl: 'fully_managed',
    takeover: true,
    trafficLimitGb: 100
  });

  assert.equal(storedNode.clientName, 'ceshi1');
  assert.equal(storedNode.xuiEmail, 'ceshi1.8@shiye.io');
  assert.equal(createInput.clientName, 'ceshi1');
  assert.equal(createInput.email, 'ceshi1.8@shiye.io');
});

test('screenshot binding reaches the official 3.6 add endpoint with separate email and comment fields', async () => {
  let storedNode: any;
  let remoteCreated = false;
  let officialRequest: { path: string; body: unknown } | undefined;
  const customer = { id: 'customer-1', name: '测试', loginUsername: 'ceshi1' };
  const serviceNode = {
    id: 'service-node-1',
    serverId: 'server-1',
    name: '美国8',
    inboundId: 8,
    protocol: 'vless',
    config: {},
    trafficLimitGb: 100,
    server: { id: 'server-1', enabled: true, baseUrl: 'https://panel.example.com', config: {} }
  };
  const prisma = {
    customer: { findUnique: async () => customer },
    serviceNode: { findUnique: async () => serviceNode },
    customerNode: {
      findFirst: async ({ where }: any) => {
        if (where.id === 'customer-node-1' && where.customerId === 'customer-1') return storedNode;
        return null;
      },
      create: async ({ data }: any) => {
        storedNode = { id: 'customer-node-1', ...data, serviceNode, customer };
        return storedNode;
      },
      update: async ({ data }: any) => {
        storedNode = { ...storedNode, ...data };
        return storedNode;
      },
      findUnique: async () => storedNode,
      delete: async () => ({})
    },
    renewalLog: { findFirst: async () => null },
    syncLog: { create: async () => ({}) }
  } as any;
  const officialClient = new XuiClient({
    baseUrl: 'https://panel.example.com',
    apiProfile: 'v3.6',
    fetchImpl: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path === '/panel/api/inbounds/get/8') {
        return new Response(JSON.stringify({ success: true, obj: { id: 8, protocol: 'vless' } }), { status: 200 });
      }
      if (path === '/panel/api/clients/get/ceshi1.8%40shiye.io') {
        return new Response(JSON.stringify({ detail: 'not found' }), { status: 404 });
      }
      if (path === '/panel/api/clients/list') {
        const obj = remoteCreated
          ? [{ client: { email: 'ceshi1.8@shiye.io', comment: 'ceshi1' }, inboundIds: [8] }]
          : [];
        return new Response(JSON.stringify({ success: true, obj }), { status: 200 });
      }
      if (path === '/panel/api/clients/add') {
        officialRequest = { path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
        remoteCreated = true;
        return new Response(JSON.stringify({ success: true, msg: 'Client added' }), { status: 200 });
      }
      return new Response(JSON.stringify({ detail: `unexpected request ${path}` }), { status: 500 });
    }
  });
  const xui = new XuiService(prisma, {} as never, testLocks()) as any;
  xui.createAuthenticatedClient = async () => officialClient;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  await service.bindCustomerNode('customer-1', {
    serviceNodeId: 'service-node-1',
    clientName: 'ceshi1',
    expireAt: new Date('2026-09-26T13:56:41+08:00'),
    remoteAction: 'create',
    remoteControl: 'fully_managed',
    takeover: true
  });

  assert.deepEqual(officialRequest, {
    path: '/panel/api/clients/add',
    body: {
      client: {
        email: 'ceshi1.8@shiye.io',
        comment: 'ceshi1',
        enable: true,
        expiryTime: new Date('2026-09-26T13:56:41+08:00').getTime(),
        totalGB: 100 * 1024 ** 3,
        limitIp: 0,
        tgId: 0
      },
      inboundIds: [8]
    }
  });
  assert.equal(storedNode.clientName, 'ceshi1');
  assert.equal(storedNode.xuiEmail, 'ceshi1.8@shiye.io');
});

test('retrying a service config task only synchronizes current config and never creates an inbound', async () => {
  let createCalls = 0;
  let syncCalls = 0;
  let resolved = 0;
  const prisma = {
    syncTask: {
      findUnique: async () => ({ id: 'task-1', entityType: 'service-node', entityId: 'node-1', action: 'service-config', status: 'failed', detail: null }),
      updateMany: async () => { resolved += 1; return { count: 1 }; },
      upsert: async () => ({})
    }
  } as any;
  const xui = {
    syncServiceNodeRemoteConfig: async () => { syncCalls += 1; return { synced: true }; },
    createServiceNodeInbound: async () => { createCalls += 1; }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());
  const result = await service.retrySyncTask('task-1');
  assert.equal(result.state, 'success');
  assert.equal(syncCalls, 1);
  assert.equal(createCalls, 0);
  assert.equal(resolved, 1);
});

test('panel deletion is rejected while route nodes still reference it', async () => {
  let deleted = 0;
  const prisma = {
    xuiServer: { findUnique: async () => ({ id: 'server-1' }), delete: async () => { deleted += 1; } },
    serviceNode: { count: async () => 2 },
    networkOutbound: { count: async () => 1 },
    networkRoute: { count: async () => 3 }
  } as any;
  const service = new NodesService(prisma, encryption(), {} as any, testLocks());
  await assert.rejects(() => service.deleteServer('server-1'), /请先删除该面板关联的资源（入站 2、出站 1、路由 3）/);
  assert.equal(deleted, 0);
});


test('editing only the node name syncs the inbound without resyncing remote clients', async () => {
  let inboundSyncs = 0;
  let clientSyncs = 0;
  const current = {
    id: 'node-1',
    serverId: 'server-1',
    name: '旧名称',
    protocol: 'vless',
    inboundId: 12,
    ownership: 'managed',
    enabled: true,
    trafficLimitGb: 100,
    remark: null,
    config: {
      remoteMode: 'create',
      remoteManaged: true,
      remoteInboundRemark: '旧名称',
      remoteInboundPort: 24443,
      encryption: 'none',
      transport: 'tcp',
      tcpHeaderType: 'none',
      transportHost: '',
      transportPath: '/',
      grpcServiceName: '',
      grpcAuthority: '',
      grpcMultiMode: false,
      xhttpMode: 'auto'
    }
  };
  let stored = { ...current };
  const prisma = {
    serviceNode: {
      findUnique: async () => stored,
      findFirst: async () => null,
      update: async ({ data }: any) => {
        stored = {
          ...stored,
          ...Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined)),
          config: data.config || stored.config
        };
        return { ...stored, server: { id: 'server-1', name: '面板', baseUrl: 'https://panel.example.com', enabled: true } };
      }
    },
    customerNode: { updateMany: async () => ({ count: 0 }) },
    renewalLog: { count: async () => 0 },
    syncTask: { updateMany: async () => ({ count: 0 }), upsert: async () => ({}) }
  } as any;
  const xui = {
    updateServiceNodeInbound: async () => { inboundSyncs += 1; return { updated: true }; },
    syncServiceNodeTrafficLimit: async () => { clientSyncs += 1; return { synced: true, failed: 0 }; }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());
  const result = await service.updateServiceNode('node-1', { name: '新名称' });
  assert.equal(result.state, 'success');
  assert.equal(inboundSyncs, 1);
  assert.equal(clientSyncs, 0);
});
