import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';

function serviceNode(config: Record<string, unknown>) {
  return {
    id: 'service-node-abcdef123456',
    serverId: 'server-1',
    inboundId: 12,
    name: '香港路由',
    config,
    server: { id: 'server-1', enabled: true, baseUrl: 'https://panel.example.com', config: {} }
  };
}

function remoteClient(xraySetting: Record<string, unknown>, submitted: { value?: Record<string, unknown> }) {
  return {
    getInbound: async () => ({ success: true, obj: { id: 12, tag: 'inbound-12' } }),
    getXrayConfig: async () => ({ success: true, obj: { xraySetting } }),
    updateXrayConfig: async (payload: { xraySetting: string }) => {
      submitted.value = JSON.parse(payload.xraySetting);
      return { success: true };
    },
    restartXrayService: async () => ({ success: true })
  };
}

test('SOCKS synchronization replaces the legacy tag with the readable outbound name', async () => {
  const legacyTag = 'shiye-socks-service-node-abc';
  const submitted: { value?: Record<string, unknown> } = {};
  let persistedConfig: any;
  const node = serviceNode({
    socksRelayEnabled: true,
    socksNodeId: 'socks-1',
    remoteInboundTag: 'inbound-12'
  });
  const xraySetting = {
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: legacyTag, protocol: 'socks', _shiyeManaged: true, _shiyeServiceNodeId: node.id, _shiyeMark: 'shiye-managed-route-v1' }
    ],
    routing: {
      rules: [
        { type: 'field', inboundTag: ['inbound-12'], outboundTag: legacyTag, _shiyeManaged: true, _shiyeServiceNodeId: node.id, _shiyeMark: 'shiye-managed-route-v1' },
        { type: 'field', domain: ['example.com'], outboundTag: 'direct' }
      ]
    }
  };
  const prisma = {
    serviceNode: {
      findUnique: async () => node,
      update: async ({ data }: any) => {
        persistedConfig = data.config;
        return {};
      }
    },
    socksNode: {
      findUnique: async () => ({
        id: 'socks-1',
        name: '香港 主出站',
        host: '127.0.0.1',
        port: 1080,
        username: null,
        passwordEnc: null,
        enabled: true
      })
    },
    syncTask: { updateMany: async () => ({ count: 0 }) },
    syncLog: { create: async () => ({}) }
  };
  const service = new XuiService(prisma as never, { decrypt: (value: string) => value } as never) as any;
  service.createAuthenticatedClient = async () => remoteClient(xraySetting, submitted);

  const result = await service.syncServiceNodeRemoteConfig(node.id);

  const expectedTag = 'socks-香港-主出站-123456';
  const updated = submitted.value as any;
  assert.equal(result.outboundTag, expectedTag);
  assert.deepEqual(updated.outbounds.map((item: any) => item.tag), ['direct', expectedTag]);
  assert.equal(updated.routing.rules.some((rule: any) => rule.outboundTag === legacyTag), false);
  assert.equal(updated.routing.rules.some((rule: any) => rule.outboundTag === expectedTag), true);
  assert.equal(updated.routing.rules.some((rule: any) => rule.outboundTag === 'direct'), true);
  assert.equal(persistedConfig.remoteSocksOutboundTag, expectedTag);
});

test('SOCKS remove-only synchronization removes the stored readable tag and clears it locally', async () => {
  const storedTag = 'socks-日本-备用-123456';
  const submitted: { value?: Record<string, unknown> } = {};
  let persistedConfig: any;
  const node = serviceNode({
    socksRelayEnabled: false,
    socksNodeId: null,
    remoteInboundTag: 'inbound-12',
    remoteSocksOutboundTag: storedTag
  });
  const xraySetting = {
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: storedTag, protocol: 'socks', _shiyeManaged: true, _shiyeServiceNodeId: node.id, _shiyeMark: 'shiye-managed-route-v1' }
    ],
    routing: {
      rules: [
        { type: 'field', inboundTag: ['inbound-12'], outboundTag: storedTag, _shiyeManaged: true, _shiyeServiceNodeId: node.id, _shiyeMark: 'shiye-managed-route-v1' }
      ]
    }
  };
  const prisma = {
    serviceNode: {
      findUnique: async () => node,
      update: async ({ data }: any) => {
        persistedConfig = data.config;
        return {};
      }
    },
    syncTask: { updateMany: async () => ({ count: 0 }) },
    syncLog: { create: async () => ({}) }
  };
  const service = new XuiService(prisma as never, { decrypt: (value: string) => value } as never) as any;
  const client = remoteClient(xraySetting, submitted);
  client.getInbound = async () => {
    throw new Error('remove-only must not load the inbound');
  };
  service.createAuthenticatedClient = async () => client;

  const result = await service.syncServiceNodeRemoteConfig(node.id, { removeOnly: true });

  const updated = submitted.value as any;
  assert.equal(result.action, 'removed');
  assert.deepEqual(updated.outbounds.map((item: any) => item.tag), ['direct']);
  assert.equal(updated.routing.rules.length, 0);
  assert.equal('remoteSocksOutboundTag' in persistedConfig, false);
});
