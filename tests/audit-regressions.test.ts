import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { AuthGuard, credentialVersion, signSession } from '../apps/api/src/shared/auth.guard.js';
import { ExternalCardsService } from '../apps/api/src/modules/cards/external-cards.service.js';
import { ShiyeCardClient } from '../apps/api/src/modules/cards/shiye-client.js';
import { assertNativeBusinessMutation } from '../apps/api/src/modules/xui/native-business.js';
import { visibleOperation } from '../apps/admin-web/src/xui-panel.js';
import { nativeCatalog, nativeExecuteSchema } from '../apps/api/src/modules/xui/native-api.js';
import { SuiBusinessService } from '../apps/api/src/modules/sui/sui-business.service.js';
import { testLocks } from './test-locks.js';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';

test('existing administrator sessions are rejected after password changes, disable or deletion', async () => {
  let account: any = { status: 'active', passwordHash: 'old-password-hash' };
  const guard = new AuthGuard({ getAllAndOverride: () => ['admin'] } as any, { adminUser: { findUnique: async () => account } } as any);
  const token = signSession({ role: 'admin', userId: 'admin-id', username: 'admin', credentialVersion: credentialVersion(account.passwordHash) });
  const request = { path: '/admin/customers', query: {}, headers: {}, cookies: { shiye_admin_session: token } };
  const context = { switchToHttp: () => ({ getRequest: () => request }), getHandler: () => null, getClass: () => null } as any;
  assert.equal(await guard.canActivate(context), true);
  account.passwordHash = 'new-password-hash';
  await assert.rejects(() => guard.canActivate(context));
  account.passwordHash = 'old-password-hash'; account.status = 'disabled';
  await assert.rejects(() => guard.canActivate(context));
  account = null;
  await assert.rejects(() => guard.canActivate(context));
});

function cardsFixture() {
  let receipt: any = null;
  const customer: any = { id: 'customer', loginUsername: 'tester', name: 'Test', status: 'active', balance: new Prisma.Decimal(0) };
  let failCredit = false, activationCalls = 0, logs = 0;
  const records = {
    findUnique: async () => receipt,
    findUniqueOrThrow: async () => receipt,
    findMany: async () => receipt?.status === 'activated' ? [receipt] : [],
    upsert: async ({ create, update }: any) => (receipt = receipt ? { ...receipt, ...update } : { id: 'receipt', status: 'processing', ...create }),
    update: async ({ data }: any) => (receipt = { ...receipt, ...data })
  };
  const prisma: any = {
    externalCardRedemption: records,
    customer: {
      findUnique: async () => customer,
      update: async ({ data }: any) => {
        if (failCredit) { failCredit = false; throw Error('local database temporarily unavailable'); }
        customer.balance = customer.balance.add(data.balance.increment); return { ...customer };
      }
    },
    balanceLog: { create: async () => { logs++; } },
    $queryRaw: async (strings: TemplateStringsArray) => strings.join('').includes('external_card_redemptions') ? [receipt] : [customer],
    $transaction: async (fn: any) => fn(prisma)
  };
  const service = new ExternalCardsService(prisma, { encrypt: (code: string) => code, decrypt: (code: string) => code } as any, testLocks());
  const client = { activate: async () => { activationCalls++; return { code: 0, message: 'ok', data: { type: 'money', amount: 100 } }; } };
  return { service, client, customer, failNextCredit: () => { failCredit = true; }, receipt: () => receipt, activations: () => activationCalls, logs: () => logs };
}

test('a failed local credit resumes from the durable receipt without activating or crediting twice', async () => {
  const f = cardsFixture(); f.failNextCredit();
  await assert.rejects(() => f.service.redeem('customer', 'CARD', f.client), /余额正在补入/);
  assert.equal(f.receipt().status, 'activated');
  assert.equal(Number(f.customer.balance), 0);
  await f.service.redeem('customer', 'CARD', f.client);
  await f.service.redeem('customer', 'CARD', f.client);
  assert.equal(f.activations(), 1);
  assert.equal(Number(f.customer.balance), 100);
  assert.equal(f.logs(), 1);
});

test('the recovery job credits confirmed receipts after a local outage', async () => {
  const f = cardsFixture(); f.failNextCredit();
  await assert.rejects(() => f.service.redeem('customer', 'CARD', f.client));
  await f.service.recoverCredits();
  assert.equal(Number(f.customer.balance), 100);
  assert.equal(f.receipt().status, 'completed');
});

test('an unknown remote outcome is never replayed and supports an audited manual credit', async () => {
  const f = cardsFixture(); let calls = 0;
  const client = { activate: async () => { calls++; throw Error('response lost'); } };
  await assert.rejects(() => f.service.redeem('customer', 'CARD', client), /核销结果待确认/);
  await assert.rejects(() => f.service.redeem('customer', 'CARD', client), /待确认/);
  assert.equal(calls, 1);
  assert.equal(Number(f.customer.balance), 0);
  await f.service.resolve('receipt', 50, 'admin');
  await f.service.resolve('receipt', 50, 'admin');
  assert.equal(Number(f.customer.balance), 50);
  assert.equal(f.logs(), 1);
});

test('disabled accounts are checked before a remote card can be consumed', async () => {
  const f = cardsFixture(); f.customer.status = 'disabled';
  await assert.rejects(() => f.service.redeem('customer', 'CARD', f.client), /已禁用/);
  assert.equal(f.activations(), 0);
  assert.equal(f.receipt(), null);
});

test('card activation is not automatically replayed when the response is lost', async () => {
  const originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; throw Error('response lost'); };
  try {
    const client = new ShiyeCardClient({ baseUrl: 'https://fixture.invalid', appKey: 'test', appSecret: 'test' });
    assert.equal((await client.activate('CARD')).code, -1);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

const linked = [{ id: 'service', inboundId: 11, protocol: 'vless', config: { remoteClientEmail: 'linked' } }];
function mutation(path: string, body: unknown = {}, parameters: Record<string, string> = {}) {
  const operation = nativeCatalog({ paths: { [path]: { post: {} } } })[0]!;
  return () => assertNativeBusinessMutation(operation, nativeExecuteSchema.parse({ operation: operation.id, body, parameters, confirmed: true }), linked);
}
test('linked native client updates are identified for business reconciliation', () => {
  assert.deepEqual(mutation('/panel/api/clients/update/{email}', { email: 'linked', totalGB: 50 * 1024 ** 3 }, { email: 'linked' })(), linked);
  assert.deepEqual(mutation('/panel/api/clients/update/{email}', { email: 'other' }, { email: 'other' })(), []);
});
test('native operations protect deletion and retain renamed clients for reconciliation', () => {
  for (const path of ['/panel/api/clients/del/{email}', '/panel/api/clients/{email}/detach', '/panel/api/clients/bulkDel']) {
    assert.throws(mutation(path, { emails: ['linked'] }, { email: 'linked' }), /业务/);
  }
  assert.throws(mutation('/panel/api/inbounds/bulkDel', { ids: [11] }), /业务/);
  assert.deepEqual(mutation('/panel/api/clients/update/{email}', { email: 'renamed' }, { email: 'linked' })(), linked);
});
test('the hosts bulk delete action remains visible', () => {
  assert.equal(visibleOperation({ method: 'POST', path: '/panel/api/hosts/bulk/del' } as any), true);
});
test('native quota changes are read back into the service and every user binding', async () => {
  const path = '/panel/api/clients/update/{email}';
  let remote: any = { email: 'linked', uuid: 'uuid', totalGB: 10 * 1024 ** 3, expiryTime: 0, enable: true, comment: 'Linked' };
  const node: any = { ...linked[0], serverId: 'server', name: 'Service', server: { baseUrl: 'https://panel.example' } };
  const binding: any = { id: 'binding', config: {}, trafficLimitGb: 10 };
  let failLocalWrite = false;
  const prisma: any = {
    serviceNode: { findMany: async () => [node], update: async ({ data }: any) => Object.assign(node, data) },
    customerNode: { findMany: async () => [binding], update: async ({ data }: any) => Object.assign(binding, data) },
    renewalLog: { findFirst: async () => null }, syncLog: { create: async () => ({}) },
    $transaction: async (fn: any) => { if (failLocalWrite) { failLocalWrite = false; throw Error('simulated local write failure'); } return fn(prisma); }
  };
  const client: any = {
    request: async () => ({ paths: { [path]: { post: { parameters: [{ name: 'email', in: 'path' }], requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } } } } }),
    nativeRequest: async (_path: string, options: any) => { remote = { ...remote, ...options.body }; return { success: true }; },
    getClientRecord: async () => remote,
    updateClient: async (_inbound: number, _email: string, previous: any) => { remote = { ...previous }; return { success: true }; },
    clientLinks: async () => ({ success: true, obj: ['vless://uuid@example.test:443'] })
  };
  const service = new XuiService(prisma, {} as any, testLocks(), {} as any) as any;
  service.nativeClient = async () => client;
  await service.nativeExecute('server', nativeExecuteSchema.parse({ operation: `POST ${path}`, parameters: { email: 'linked' }, confirmed: true, body: { totalGB: 50 * 1024 ** 3 } }));
  assert.equal(binding.trafficLimitGb, 50);
  assert.equal(node.trafficLimitGb, 50);
  assert.equal(node.config.remoteClientTrafficLimitGb, 50);
  assert.equal(binding.status, 'active');
  failLocalWrite = true;
  await assert.rejects(() => service.nativeExecute('server', nativeExecuteSchema.parse({ operation: `POST ${path}`, parameters: { email: 'linked' }, confirmed: true, body: { totalGB: 60 * 1024 ** 3 } })), /simulated local write failure/);
  assert.equal(remote.totalGB, 50 * 1024 ** 3, 'failed local write must restore the previous remote quota');
  assert.equal(binding.trafficLimitGb, 50);
  await service.nativeExecute('server', nativeExecuteSchema.parse({ operation: `POST ${path}`, parameters: { email: 'linked' }, confirmed: true, body: { email: 'renamed' } }));
  assert.equal(node.config.remoteClientEmail, 'renamed');
  assert.equal(binding.xuiEmail, 'renamed');
  assert.equal(remote.email, 'renamed');
});
test('twenty S-UI bindings share a single subscription metadata read', async () => {
  const service = new SuiBusinessService({} as any, {} as any, testLocks()) as any;
  let reads = 0;
  service.remote = async () => ({ client: { name: 'client', links: [] }, api: { request: async () => { reads++; return { subURI: 'https://sub.example/sub' }; } } });
  const node = { serverId: 'panel', server: { baseUrl: 'https://panel.example' } };
  const links = await Promise.all(Array.from({ length: 20 }, () => service.links(node)));
  assert.equal(reads, 1); assert.equal(links.length, 20);
  assert.equal(links[0][0], 'https://sub.example/sub/client');
});
