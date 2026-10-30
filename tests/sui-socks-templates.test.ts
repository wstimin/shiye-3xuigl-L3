import test from 'node:test';
import assert from 'node:assert/strict';
import { SuiService } from '../apps/api/src/modules/sui/sui.service.js';
import { NodesService } from '../apps/api/src/modules/nodes/nodes.service.js';
import { testLocks } from './test-locks.js';
import { parseOutboundInput } from '../apps/api/src/modules/xui/outbound-import.js';

test('structured SOCKS template import preserves special-character credentials and IPv6', () => {
  const server = { address: '2001:db8::5', port: 1080, users: [{ user: 'user+@:%中文', pass: 'p@ss:#/% 空格' }] };
  const [imported] = parseOutboundInput(JSON.stringify({ protocol: 'socks', settings: { servers: [server] } }), 'xray_json');
  assert.deepEqual(imported.outbound.settings, { servers: [server] });
});

test('S-UI copies SOCKS5 templates idempotently, seals credentials and skips unsupported outbounds', async () => {
  const saved: any[] = [];
  let used = false;
  const tx: any = { serviceNode: { findMany: async () => used ? [{ config: { socksNodeId: 'template-1' } }] : [] }, socksNode: {
    findFirst: async ({ where }: any) => saved.find(row => row.sourceServerId === where.sourceServerId && row.remoteOutboundTag === where.remoteOutboundTag),
    create: async ({ data }: any) => { const row = { ...data, id: 'template-1' }; saved.push(row); return row; },
    update: async ({ where, data }: any) => Object.assign(saved.find(row => row.id === where.id), data)
  } };
  const prisma: any = { xuiServer: { findUnique: async () => ({ id: 'sui-1', provider: 'sui', enabled: true, name: 'S-UI' }) }, $transaction: async (fn: any) => fn(tx), syncLog: { create: async () => ({}) } };
  const service = new SuiService(prisma, { encryptNullable: (value: string) => value ? 'sealed:' + value : null } as any, testLocks());
  let reads = 0;
  (service as any).client = async () => ({ read: async (resource: string) => {
    assert.equal(resource, 'outbounds'); reads++;
    return { outbounds: [
      { type: 'socks', tag: 'socks-five', server: '::1', server_port: 1080, version: '5', username: 'alice', password: 'secret' },
      { type: 'socks', tag: 'socks-four', server: 'localhost', server_port: 1080, version: '4' },
      { type: 'socks', tag: 'bad-port', server: 'localhost', server_port: -1 },
      { type: 'socks', tag: 'encrypted-socks', server: 'localhost', server_port: 1080, tls: { enabled: true } },
      { type: 'direct', tag: 'direct' }
    ] };
  } });
  assert.deepEqual(await service.copySocksTemplates('sui-1'), { imported: 1, skipped: 3 });
  assert.equal(saved[0].passwordEnc, 'sealed:secret');
  saved[0].name = 'My custom template'; saved[0].enabled = false;
  assert.deepEqual(await service.copySocksTemplates('sui-1'), { imported: 1, skipped: 3 });
  assert.equal(saved.length, 1); assert.equal(saved[0].name, 'My custom template'); assert.equal(saved[0].enabled, false); assert.equal(reads, 2);
  used = true; saved[0].host = 'preserve-active-endpoint';
  assert.deepEqual(await service.copySocksTemplates('sui-1'), { imported: 0, skipped: 4 });
  assert.equal(saved[0].host, 'preserve-active-endpoint');
});

test('deleting an independent S-UI template never deletes its source outbound', async () => {
  let remoteDeletes = 0, localDeletes = 0;
  const prisma: any = {
    socksNode: { findUnique: async () => ({ id: 'copy', sourceServerId: 'sui-1', remoteOutboundTag: 'keep-source' }), delete: async () => { localDeletes++; } },
    xuiServer: { findUnique: async () => ({ provider: 'sui' }) },
    serviceNode: { findMany: async () => [] }, syncTask: { deleteMany: async () => ({ count: 0 }) },
    $transaction: async (operations: any[]) => Promise.all(operations)
  };
  const service = new NodesService(prisma, {} as any, { deleteRemoteSocksOutbound: async () => { remoteDeletes++; } } as any, testLocks());
  const result = await service.deleteSocksNode('copy');
  assert.equal(result.remoteWrite, false); assert.equal(remoteDeletes, 0); assert.equal(localDeletes, 1);
});

test('legacy 3x-ui remote template deletion still requires explicit takeover', async () => {
  const prisma: any = { socksNode: { findUnique: async () => ({ id: 'legacy', sourceServerId: 'xui-1', remoteOutboundTag: 'remote' }) }, xuiServer: { findUnique: async () => ({ provider: 'xui' }) }, serviceNode: { findMany: async () => [] } };
  const service = new NodesService(prisma, {} as any, {} as any, testLocks());
  await assert.rejects(() => service.deleteSocksNode('legacy'), /确认接管删除/);
});
