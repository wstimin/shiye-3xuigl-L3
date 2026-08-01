import test from 'node:test';
import assert from 'node:assert/strict';
import { NodesService } from '../apps/api/src/modules/nodes/nodes.service.js';

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
  const service = new NodesService(prisma, encryption(), xui);
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
  const service = new NodesService(prisma, encryption(), xui);
  const result = await service.createServiceNode({ ...baseInput, socksRelayEnabled: true, socksNodeId: 'socks-1' });
  assert.equal(result.state, 'partial');
  assert.equal(result.message, '创建成功，同步失败');
  assert.deepEqual(result.pendingActions, ['service-config']);
  assert.equal(taskWrites, 1);
  assert.equal(deletedRemote, 0);
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
  const service = new NodesService(prisma, encryption(), xui);
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
    serviceNode: { count: async () => 2 }
  } as any;
  const service = new NodesService(prisma, encryption(), {} as any);
  await assert.rejects(() => service.deleteServer('server-1'), /请先删除关联路由节点/);
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
    syncTask: { updateMany: async () => ({ count: 0 }), upsert: async () => ({}) }
  } as any;
  const xui = {
    updateServiceNodeInbound: async () => { inboundSyncs += 1; return { updated: true }; },
    syncServiceNodeTrafficLimit: async () => { clientSyncs += 1; return { synced: true, failed: 0 }; }
  } as any;
  const service = new NodesService(prisma, encryption(), xui);
  const result = await service.updateServiceNode('node-1', { name: '新名称' });
  assert.equal(result.state, 'success');
  assert.equal(inboundSyncs, 1);
  assert.equal(clientSyncs, 0);
});
