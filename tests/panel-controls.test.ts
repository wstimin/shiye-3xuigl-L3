import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';
import { SuiService } from '../apps/api/src/modules/sui/sui.service.js';
import { testLocks } from './test-locks.js';
import { networkOutboundNameSchema, xrayVersionSchema } from '../packages/shared/src/schemas/node.js';

function coreFixture() {
  let version = '26.10.21';
  const installs: string[] = [];
  const logs: any[] = [];
  const client = {
    serverStatus: async () => ({ success: true, obj: { xray: { state: 'running', version } } }),
    getXrayVersion: async () => ({ success: true, obj: ['v26.10.21', 'v26.10.16'] }),
    installXray: async (target: string) => { installs.push(target); version = target.replace(/^v/, ''); return { success: true }; }
  };
  const service = new XuiService({ serviceNode: { findMany: async () => [] }, syncLog: { create: async (data: any) => logs.push(data) } } as never, {} as never, testLocks(), {} as never) as any;
  service.nativeClient = async () => client;
  return { service, installs, client, logs };
}

test('core changes require confirmation and an exact version from the official panel list', async () => {
  assert.equal(xrayVersionSchema.safeParse({ version: 'v26.10.16', confirmed: true }).success, true);
  assert.equal(xrayVersionSchema.safeParse({ version: 'latest', confirmed: true }).success, false);
  assert.equal(xrayVersionSchema.safeParse({ version: 'v26.10.16' }).success, false);
  const f = coreFixture();
  await assert.rejects(() => f.service.changeXrayVersion('s1', 'v99.99.99'), /版本列表/);
  assert.deepEqual(f.installs, []);
  assert.equal((await f.service.changeXrayVersion('s1', 'v26.10.21')).changed, false);
  assert.deepEqual(f.installs, []);
});

test('core changes report success only after the requested version is running', async () => {
  const f = coreFixture();
  assert.deepEqual(await f.service.changeXrayVersion('s1', '26.10.16'), { changed: true, version: '26.10.16', state: 'running' });
  assert.deepEqual(f.installs, ['v26.10.16']);
  assert.equal(f.logs.at(-1).data.status, 'success');
});

test('failed core verification restores the previous running version and reports failure', async () => {
  const f = coreFixture();
  let recovered = false;
  f.client.installXray = async (target: string) => { f.installs.push(target); if (target === 'v26.10.21') recovered = true; return { success: true }; };
  f.service.waitXrayVersion = async (_client: unknown, target: string) => target === '26.10.21' && recovered ? { xray: { state: 'running', version: target } } : null;
  await assert.rejects(() => f.service.changeXrayVersion('s1', '26.10.16'), /原版本已恢复/);
  assert.deepEqual(f.installs, ['v26.10.16', 'v26.10.21']);
  assert.equal(f.logs.at(-1).data.detail.restored, true);
});

test('custom outbound names change only the display name, keeping routing keys intact', async () => {
  assert.equal(networkOutboundNameSchema.safeParse({ name: '  ' }).success, false);
  const outbound = { id: 'o1', serverId: 's1', tag: 'proxy-us', name: 'old' };
  const service = new XuiService({ networkOutbound: {
    findUnique: async () => outbound,
    update: async ({ data }: any) => Object.assign(outbound, data)
  } } as never, {} as never, testLocks(), {} as never);
  await service.renameNetworkOutbound('o1', '美国出口');
  assert.equal(outbound.name, '美国出口');
  assert.equal(outbound.tag, 'proxy-us');
});

function renameFixture() {
  let remote: any = { id: 7, name: 'old', inbounds: [11], config: { vless: { name: 'old', uuid: 'keep' } }, links: [], enable: true, expiry: 0, volume: 1024 ** 3, up: 2, down: 3 };
  const node: any = { id: 'node', inboundId: 11, protocol: 'vless', config: { suiClientId: 7, remoteClientEmail: 'old', future: 9 } };
  const binding: any = { id: 'binding', xuiEmail: 'old', config: { subId: 'old', future: 'preserve' } };
  let fail = false;
  const prisma: any = {
    serviceNode: { findMany: async () => [node], update: async ({ data }: any) => Object.assign(node, data) },
    customerNode: { findMany: async () => [binding], update: async ({ data }: any) => Object.assign(binding, data) },
    renewalLog: { findFirst: async () => null }, syncLog: { create: async () => ({}) },
    $transaction: async (fn: any) => { if (fail) throw Error('local transaction failed'); return fn(prisma); }
  };
  const service = new SuiService(prisma, {} as never, testLocks());
  service.client = async () => ({ request: async () => ({ clients: [remote] }), save: async (_object: string, _action: string, data: any) => { remote = structuredClone(data); remote.config.vless.name = remote.name; return {}; } }) as never;
  return { service, node, binding, data: () => ({ ...remote, name: 'custom', remark: '自定义用户' }), remote: () => remote, fail: () => { fail = true; } };
}

test('S-UI renames synchronize the business identity and every user subscription binding', async () => {
  const f = renameFixture();
  await f.service.save('s1', { object: 'clients', action: 'edit', data: f.data() });
  assert.equal(f.remote().name, 'custom');
  assert.equal(f.node.config.remoteClientEmail, 'custom');
  assert.equal(f.binding.xuiEmail, 'custom');
  assert.equal(f.binding.config.subId, 'custom');
  assert.equal(f.binding.config.future, 'preserve');
  assert.equal(f.remote().config.vless.uuid, 'keep');
});

test('S-UI restores the previous remote username if its local rename transaction fails', async () => {
  const f = renameFixture(); f.fail();
  await assert.rejects(() => f.service.save('s1', { object: 'clients', action: 'edit', data: f.data() }), /local transaction failed/);
  assert.equal(f.remote().name, 'old');
  assert.equal(f.remote().config.vless.name, 'old');
  assert.equal(f.binding.xuiEmail, 'old');
  assert.equal(f.node.config.remoteClientEmail, 'old');
});
