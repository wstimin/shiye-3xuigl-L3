import test from 'node:test';
import assert from 'node:assert/strict';
import { NodesService } from '../apps/api/src/modules/nodes/nodes.service.js';
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

test('binding refreshes identity and synchronizes the shared client expiry without creating a client', async () => {
  let refreshCalls = 0;
  let clientLifecycleCalls = 0;
  let expirySyncCalls = 0;
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
    serviceNodeRemoteClientState: async () => ({ expiryTime: 0, enable: false }),
    updateServiceNodeRemoteAuthorization: async () => {
      expirySyncCalls += 1;
      return { synced: true, remoteWrite: true };
    },
    createCustomerNodeRemoteClient: async () => { clientLifecycleCalls += 1; },
    patchCustomerNodeRemoteClient: async () => { clientLifecycleCalls += 1; },
    deleteCustomerNodeRemoteClient: async () => { clientLifecycleCalls += 1; }
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
  assert.equal(expirySyncCalls, 1);
  assert.equal(clientLifecycleCalls, 0);
});

test('binding always uses the service node shared client and ignores legacy create fields', async () => {
  let storedNode: any;
  let remoteWriteCalls = 0;
  const serviceNode = {
    id: 'service-node-1',
    serverId: 'server-1',
    inboundId: 8,
    trafficLimitGb: 100,
    config: {
      remoteClientEmail: 'us-premium',
      remoteClientUuid: '11111111-2222-4333-8444-555555555555',
      remoteClientSubId: 'shared-sub'
    }
  };
  const prisma = {
    customer: { findUnique: async () => ({ id: 'customer-1', name: '测试', loginUsername: 'ceshi1' }) },
    serviceNode: { findUnique: async () => serviceNode },
    customerNode: {
      findFirst: async () => null,
      create: async ({ data }: any) => {
        storedNode = { id: 'customer-node-1', ...data };
        return storedNode;
      },
      findUnique: async () => storedNode,
      delete: async () => ({})
    }
  } as any;
  const xui = {
    refreshCustomerNodeBinding: async () => ({ synced: true, remoteWrite: false, node: storedNode }),
    serviceNodeRemoteClientState: async () => ({ expiryTime: 0, enable: false }),
    updateServiceNodeRemoteAuthorization: async () => ({ synced: true, remoteWrite: true }),
    createCustomerNodeRemoteClient: async () => { remoteWriteCalls += 1; },
    patchCustomerNodeRemoteClient: async () => { remoteWriteCalls += 1; }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  await service.bindCustomerNode('customer-1', {
    serviceNodeId: 'service-node-1',
    xuiEmail: 'legacy-display-name',
    clientName: 'legacy-name',
    remoteAction: 'bind',
    remoteControl: 'fully_managed',
    takeover: true,
    trafficLimitGb: 50
  });

  assert.equal(storedNode.xuiEmail, 'us-premium');
  assert.equal(storedNode.clientName, null);
  assert.equal(storedNode.uuid, '11111111-2222-4333-8444-555555555555');
  assert.equal(storedNode.remoteControl, 'reference');
  assert.equal(storedNode.config.subId, 'shared-sub');
  assert.equal(remoteWriteCalls, 0);
});

test('a service node can only be bound to one user at a time', async () => {
  const storedNodes: any[] = [];
  const serviceNode = {
    id: 'service-node-1',
    serverId: 'server-1',
    inboundId: 8,
    trafficLimitGb: 100,
    config: { remoteClientEmail: 'us-premium', remoteClientUuid: 'shared-uuid', remoteClientSubId: 'shared-sub' }
  };
  const prisma = {
    customer: { findUnique: async ({ where }: any) => ({ id: where.id, name: where.id, loginUsername: where.id }) },
    serviceNode: { findUnique: async () => serviceNode },
    customerNode: {
      findFirst: async ({ where }: any) => storedNodes.find((node) => node.serviceNodeId === where.serviceNodeId) || null,
      create: async ({ data }: any) => {
        const node = { id: `customer-node-${storedNodes.length + 1}`, ...data };
        storedNodes.push(node);
        return node;
      },
      findUnique: async ({ where }: any) => storedNodes.find((node) => node.id === where.id),
      delete: async () => ({})
    }
  } as any;
  const xui = {
    refreshCustomerNodeBinding: async (_customerId: string, nodeId: string) => ({ synced: true, remoteWrite: false, node: storedNodes.find((node) => node.id === nodeId) }),
    serviceNodeRemoteClientState: async () => ({ expiryTime: 0, enable: false }),
    updateServiceNodeRemoteAuthorization: async () => ({ synced: true, remoteWrite: true })
  };
  const service = new NodesService(prisma, encryption(), xui as any, testLocks());

  await service.bindCustomerNode('customer-1', { serviceNodeId: 'service-node-1', remoteAction: 'bind' });
  await assert.rejects(
    () => service.bindCustomerNode('customer-2', { serviceNodeId: 'service-node-1', remoteAction: 'bind' }),
    /已绑定其他用户/
  );

  assert.equal(storedNodes.length, 1);
  assert.equal(storedNodes[0].xuiEmail, 'us-premium');
});

test('failed node switching restores each remote client by explicit service-node identity', async () => {
  const oldNode = {
    id: 'service-node-old',
    serverId: 'server-1',
    inboundId: 8,
    trafficLimitGb: 100,
    config: { remoteClientEmail: 'old@example.com', remoteClientUuid: 'old-uuid', remoteClientSubId: 'old-sub' }
  };
  const newNode = {
    id: 'service-node-new',
    serverId: 'server-1',
    inboundId: 9,
    trafficLimitGb: 100,
    config: { remoteClientEmail: 'new@example.com', remoteClientUuid: 'new-uuid', remoteClientSubId: 'new-sub' }
  };
  let storedNode: any = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    serviceNodeId: oldNode.id,
    clientName: '旧节点',
    xuiEmail: 'old@example.com',
    uuid: 'old-uuid',
    expireAt: new Date('2030-01-01T00:00:00Z'),
    trafficLimitGb: 100,
    status: 'active',
    disabledReason: null,
    remoteControl: 'reference',
    config: { subId: 'old-sub' },
    serviceNode: oldNode
  };
  let localUpdateCalls = 0;
  const remoteCalls: Array<{ action: string; serviceNodeId: string; email: string; enable?: boolean }> = [];
  const prisma = {
    customerNode: {
      findFirst: async ({ where }: any) => {
        if (where.serviceNodeId) return null;
        return storedNode;
      },
      update: async ({ data }: any) => {
        localUpdateCalls += 1;
        if (localUpdateCalls === 2) throw new Error('local rollback failed');
        storedNode = { ...storedNode, ...data, serviceNode: data.serviceNodeId === newNode.id ? newNode : oldNode };
        return storedNode;
      },
      findUnique: async () => storedNode
    },
    serviceNode: { findUnique: async ({ where }: any) => where.id === newNode.id ? newNode : oldNode },
    renewalLog: { findFirst: async () => null }
  } as any;
  let newAuthorizationUpdates = 0;
  const xui = {
    serviceNodeRemoteClientState: async (serviceNodeId: string, identity: any) => ({
      serviceNodeId,
      xuiEmail: identity.email,
      expiryTime: 0,
      enable: true
    }),
    setServiceNodeRemoteClientEnabled: async (serviceNodeId: string, identity: any, enable: boolean) => {
      remoteCalls.push({ action: 'enable', serviceNodeId, email: identity.email, enable });
      return { synced: true };
    },
    refreshCustomerNodeBinding: async () => ({ synced: true }),
    updateServiceNodeRemoteAuthorization: async (serviceNodeId: string, identity: any, _expireAt: Date | null, enable: boolean) => {
      remoteCalls.push({ action: 'authorization', serviceNodeId, email: identity.email, enable });
      if (serviceNodeId === newNode.id && newAuthorizationUpdates++ === 0) throw new Error('target panel rejected update');
      return { synced: true, remoteWrite: true };
    }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  await assert.rejects(
    () => service.updateCustomerNode('customer-1', 'customer-node-1', { serviceNodeId: newNode.id }),
    /target panel rejected update/
  );

  assert.deepEqual(remoteCalls, [
    { action: 'enable', serviceNodeId: oldNode.id, email: 'old@example.com', enable: false },
    { action: 'authorization', serviceNodeId: newNode.id, email: 'new@example.com', enable: true },
    { action: 'authorization', serviceNodeId: newNode.id, email: 'new@example.com', enable: true },
    { action: 'authorization', serviceNodeId: oldNode.id, email: 'old@example.com', enable: true }
  ]);
});

test('unbinding disables the shared client, deletes only the local binding, and restores remote state on local failure', async () => {
  for (const localDeleteFails of [false, true]) {
    let remoteDeleteCalls = 0;
    const authorizationCalls: Array<{ serviceNodeId: string; email: string; enable: boolean }> = [];
    const node = {
      id: 'customer-node-1',
      serviceNodeId: 'service-node-1',
      xuiEmail: 'shared@example.com',
      uuid: 'shared-uuid',
      config: { subId: 'shared-sub' }
    };
    const prisma = {
      customerNode: {
        findFirst: async () => node,
        delete: async () => {
          if (localDeleteFails) throw new Error('local delete failed');
          return node;
        }
      },
      renewalLog: { findFirst: async () => null }
    } as any;
    const xui = {
      serviceNodeRemoteClientState: async () => ({ expiryTime: new Date('2030-01-01T00:00:00Z').getTime(), enable: true }),
      setServiceNodeRemoteClientEnabled: async (serviceNodeId: string, identity: any, enable: boolean) => {
        authorizationCalls.push({ serviceNodeId, email: identity.email, enable });
        return { synced: true };
      },
      updateServiceNodeRemoteAuthorization: async (serviceNodeId: string, identity: any, _expireAt: Date | null, enable: boolean) => {
        authorizationCalls.push({ serviceNodeId, email: identity.email, enable });
        return { synced: true };
      },
      deleteCustomerNodeRemoteClient: async () => { remoteDeleteCalls += 1; }
    } as any;
    const service = new NodesService(prisma, encryption(), xui, testLocks());

    if (localDeleteFails) {
      await assert.rejects(() => service.unbindCustomerNode('customer-1', node.id), /local delete failed/);
      assert.deepEqual(authorizationCalls.map((call) => call.enable), [false, true]);
    } else {
      const result = await service.unbindCustomerNode('customer-1', node.id);
      assert.equal(result.deleted, true);
      assert.deepEqual(authorizationCalls.map((call) => call.enable), [false]);
    }
    assert.equal(remoteDeleteCalls, 0);
  }
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

test('user node listing returns freshly synchronized official traffic', async () => {
  const node = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'short-us',
    usedTrafficGb: 0,
    lastSyncedAt: null,
    config: { subId: 'sub-1' },
    serviceNode: { server: { id: 'server-1', name: '面板', baseUrl: 'https://panel.example.com' } }
  };
  const syncedAt = new Date('2026-08-27T00:00:00Z');
  const prisma = { customerNode: { findMany: async () => [node] } } as any;
  const xui = {
    customerNodeLinks: async () => ['vless://example'],
    syncCustomerNodeTraffic: async () => ({ usedTrafficGb: 1.5, usedBytes: 1.5 * 1024 ** 3, syncedAt })
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  const result = await service.listUserNodes('customer-1');

  assert.equal(result[0].usedTrafficGb.toString(), '1.5');
  assert.equal(result[0].usedTrafficBytes, 1.5 * 1024 ** 3);
  assert.equal(result[0].lastSyncedAt, syncedAt);
  assert.equal(result[0].trafficStatus, 'live');
  assert.equal(result[0].trafficError, null);
  assert.deepEqual(result[0].links, ['vless://example']);
});

test('user node listing falls back to stored traffic when the official read fails', async () => {
  const storedAt = new Date('2026-08-26T00:00:00Z');
  const node = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'short-us',
    usedTrafficGb: 2.25,
    lastSyncedAt: storedAt,
    config: {},
    serviceNode: { server: { id: 'server-1', name: '面板', baseUrl: 'https://panel.example.com' } }
  };
  const prisma = { customerNode: { findMany: async () => [node] } } as any;
  const xui = {
    customerNodeLinks: async () => ['vless://example'],
    syncCustomerNodeTraffic: async () => { throw new Error('panel unavailable'); }
  } as any;
  const service = new NodesService(prisma, encryption(), xui, testLocks());

  const result = await service.listUserNodes('customer-1');

  assert.equal(result.length, 1);
  assert.equal(result[0].usedTrafficGb, 2.25);
  assert.equal(result[0].usedTrafficBytes, 2.25 * 1024 ** 3);
  assert.equal(result[0].lastSyncedAt, storedAt);
  assert.equal(result[0].trafficStatus, 'cached');
  assert.equal(result[0].trafficError, '官方客户端流量获取失败，请联系管理员检查面板连接和客户端绑定');
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
