import test from 'node:test';
import assert from 'node:assert/strict';
import { SuiClient } from '../packages/xui-client/src/sui.js';
import { suiServerSchema, suiSaveSchema, suiControlSchema } from '../packages/shared/src/sui.js';
import { SuiService } from '../apps/api/src/modules/sui/sui.service.js';
import { testLocks } from './test-locks.js';

const json = (obj: unknown, success = true) => new Response(JSON.stringify({ success, obj, msg: success ? '' : 'invalid token' }));

test('S-UI preserves panel paths, sends Token and form encoded native JSON without dropping new fields', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const client = new SuiClient({ baseUrl: 'https://panel.example.com/custom/apiv2/', token: 'test-secret', fetchImpl: async (url, init) => { calls.push({ url: String(url), init: init! }); return json({ clients: [] }); } });
  await client.read('clients');
  const data = { id: 7, name: 'alice', expiry: 1800000000, volume: 1073741824, config: { snell: { userkey: 'preserved' } }, unknownFutureField: true };
  await client.save('clients', 'edit', data);
  assert.equal(calls[0]!.url, 'https://panel.example.com/custom/apiv2/clients');
  assert.equal(new Headers(calls[1]!.init.headers).get('Token'), 'test-secret');
  assert.equal(new Headers(calls[1]!.init.headers).has('Authorization'), false);
  const form = new URLSearchParams(calls[1]!.init.body as URLSearchParams);
  assert.equal(form.get('object'), 'clients');
  assert.equal(form.get('action'), 'edit');
  assert.deepEqual(JSON.parse(form.get('data')!), data);
  assert.equal(calls[1]!.init.redirect, 'error');
});

test('S-UI resolves tagged resource deletes by current ID and sends a JSON tag string', async () => {
  for (const object of ['inbounds', 'outbounds', 'endpoints', 'services'] as const) {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = new SuiClient({ baseUrl: 'https://example.com/app', token: 'secret', fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return json(String(url).endsWith('/save') ? {} : { [object]: [{ id: 7, tag: 'actual-tag' }] });
    } });
    await client.save(object, 'del', { id: 7, tag: 'untrusted-tag' });
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.url, `https://example.com/app/apiv2/${object}`);
    const form = new URLSearchParams(calls[1]!.init.body as URLSearchParams);
    assert.equal(JSON.parse(form.get('data')!), 'actual-tag');
  }
});

test('S-UI keeps client and TLS delete IDs numeric', async () => {
  for (const object of ['clients', 'tls'] as const) {
    const calls: RequestInit[] = [];
    const client = new SuiClient({ baseUrl: 'https://example.com/app', token: 'secret', fetchImpl: async (_url, init) => { calls.push(init!); return json({}); } });
    await client.save(object, 'del', { id: 7 });
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(new URLSearchParams(calls[0]!.body as URLSearchParams).get('data')!), 7);
  }
});

test('S-UI rejects missing or invalid delete targets before writing', async () => {
  let writes = 0;
  const client = new SuiClient({ baseUrl: 'https://example.com/app', token: 'secret', fetchImpl: async (url) => { if (String(url).endsWith('/save')) writes++; return json({ inbounds: [] }); } });
  await assert.rejects(() => client.save('inbounds', 'del', { id: 7, tag: 'forged-tag' }), /已不存在/);
  await assert.rejects(() => client.save('inbounds', 'del', { id: -1 }), /有效/);
  assert.equal(writes, 0);
});

test('S-UI rejects HTTP-200 failures, invalid envelopes, HTTP errors and timeouts', async () => {
  for (const response of [json(null, false), new Response('<html>login</html>'), new Response('denied', { status: 403 })]) {
    const client = new SuiClient({ baseUrl: 'https://example.com/app', token: 'secret', fetchImpl: async () => response });
    await assert.rejects(() => client.status(), /S-UI/);
  }
  const slow = new SuiClient({ baseUrl: 'https://example.com/app', token: 'secret', timeoutMs: 5, fetchImpl: async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted')))) });
  await assert.rejects(() => slow.status(), /请求超时/);
  const secret = new SuiClient({ baseUrl: 'https://example.com', token: 'hidden-token', fetchImpl: async () => new Response(JSON.stringify({ success: false, msg: 'invalid hidden-token' })) });
  await assert.rejects(() => secret.status(), error => error instanceof Error && !error.message.includes('hidden-token'));
});

test('S-UI validates URL trust boundary, write actions, IDs and control parameters', () => {
  const base = { name: 'test', baseUrl: 'https://example.com/app' };
  assert.equal(suiServerSchema.safeParse(base).success, true);
  for (const url of ['', 'not-a-url', 'file:///etc/passwd', 'ftp://example.com', 'https://alice:password@example.com', 'https://example.com?token=x']) {
    assert.equal(suiServerSchema.safeParse({ ...base, baseUrl: url }).success, false);
  }
  assert.equal(suiSaveSchema.safeParse({ object: 'clients', action: 'del', data: {} }).success, false);
  assert.equal(suiSaveSchema.safeParse({ object: 'clients', action: 'edit', data: { id: '7' } }).success, false);
  assert.equal(suiSaveSchema.safeParse({ object: 'settings', action: 'del', data: { id: 1 } }).success, false);
  assert.equal(suiSaveSchema.safeParse({ object: 'users', action: 'new', data: {} }).success, false);
  assert.equal(suiControlSchema.safeParse({ action: 'maintenance', enable: 'false' }).success, false);
  assert.equal(suiControlSchema.safeParse({ action: 'resetTraffic' }).success, false);
  assert.equal(suiControlSchema.safeParse({ action: 'closeSessions', u: '' }).success, false);
});

test('S-UI stores encrypted tokens, preserves an omitted token and never returns secrets', async () => {
  let stored: any;
  const select = (record: any, fields: any) => Object.fromEntries(Object.keys(fields).map(key => [key, record[key]]));
  const audit: any[] = [];
  const prisma = { syncLog: { create: async (entry: any) => { audit.push(entry); return entry; } }, xuiServer: {
    create: async ({ data, select: fields }: any) => { stored = { ...data, id: 's1' }; return select(stored, fields); },
    update: async ({ data, select: fields }: any) => { stored = { ...stored, ...data }; return select(stored, fields); },
    findUnique: async () => stored,
    findMany: async ({ select: fields }: any) => [select(stored, fields)]
  } };
  const service = new SuiService(prisma as never, { encrypt: (value: string) => `encrypted:${value}`, decrypt: (value: string) => value.slice(10) } as never, testLocks());
  await assert.rejects(() => service.upsert({ name: 'bad', baseUrl: 'https://example.com', enabled: true, remark: '' }), /API Token/);
  const result = await service.upsert({ name: 'A', baseUrl: 'https://example.com/app', token: 'secret', enabled: true, remark: '' });
  assert.equal(stored.tokenEnc, 'encrypted:secret');
  assert.equal('tokenEnc' in result, false);
  await service.upsert({ name: 'B', baseUrl: 'https://example.com/app', token: '', enabled: false, remark: '' }, 's1');
  assert.equal(stored.tokenEnc, 'encrypted:secret');
  assert.equal('tokenEnc' in (await service.list())[0]!, false);
  assert.equal(audit.length, 2);
  assert.equal(JSON.stringify(audit).includes('secret'), false);
  await assert.rejects(() => service.read('s1', 'clients'), /启用/);
  await assert.rejects(() => service.read('s1', '../settings'), /不支持/);
});
