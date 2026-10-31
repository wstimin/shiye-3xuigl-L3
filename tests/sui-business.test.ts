import test from 'node:test';
import assert from 'node:assert/strict';
import { SuiBusinessService } from '../apps/api/src/modules/sui/sui-business.service.js';
import { SuiClient } from '../packages/xui-client/src/sui.js';
import { XuiClient } from '../packages/xui-client/src/index.js';
import {
  nativeCatalog,
  executeNative,
  nativeExecuteSchema
} from '../apps/api/src/modules/xui/native-api.js';
import { testLocks } from './test-locks.js';
import { suiAuthorization } from '../apps/api/src/modules/sui/sui-state.js';

function fixture() {
  let client: any = {
    id: 7,
    name: 'alice',
    enable: true,
    expiry: 0,
    volume: 100 * 1024 ** 3,
    up: 3,
    down: 5,
    inbounds: [11],
    config: { tuic: { uuid: 'keep', password: 'keep-secret' } },
    autoReset: true,
    links: [{ type: 'local', uri: 'tuic://keep@example.test:443' }],
    futureOption: { keep: true }
  };
  const calls: string[] = [],
    writes: any[] = [];
  let ignoreWrite = false;
  const api = new SuiClient({
    baseUrl: 'https://sui.example/app/',
    token: 'token',
    fetchImpl: async (url, init) => {
      const endpoint = new URL(String(url));
      calls.push(endpoint.pathname + endpoint.search);
      let obj: any;
      if (endpoint.pathname.endsWith('/clients'))
        obj = {
          clients: [
            endpoint.searchParams.has('id')
              ? structuredClone(client)
              : { ...client, config: undefined, links: undefined }
          ]
        };
      if (endpoint.pathname.endsWith('/inbounds'))
        obj = { inbounds: [{ id: 11, type: 'tuic', tag: 'tuic-in' }] };
      if (endpoint.pathname.endsWith('/load'))
        obj = { subURI: 'https://sub.example/sub/' };
      if (endpoint.pathname.endsWith('/save')) {
        const data = JSON.parse(
          new URLSearchParams(init!.body as string).get('data')!
        );
        writes.push(structuredClone(data));
        if (!ignoreWrite) client = data;
        obj = {
          clients: [
            client,
            {
              id: 999,
              name: 'another-customer',
              config: { password: 'another-secret' }
            }
          ]
        };
      }
      return new Response(JSON.stringify({ success: true, obj }));
    }
  });
  const node: any = {
    id: 'n1',
    serverId: 's1',
    inboundId: 11,
    protocol: 'tuic',
    name: 'TUIC',
    config: { suiClientId: 7, remoteClientEmail: 'alice' },
    server: { id: 's1', provider: 'sui', enabled: true }
  };
  const prisma: any = {
    serviceNode: {
      findMany: async () => [],
      create: async ({ data }: any) => ({ ...data, id: 'n1' }),
      update: async ({ data }: any) => {
        Object.assign(node, data);
        return node;
      }
    },
    customerNode: { updateMany: async () => ({ count: 1 }) },
    renewalLog: { findFirst: async () => null },
    syncLog: { create: async () => ({}) }
  };
  const service = new SuiBusinessService(
    prisma,
    { client: async () => api } as never,
    testLocks()
  );
  return {
    service,
    node,
    prisma,
    writes,
    calls,
    client: () => client,
    setClient: (patch: any) => Object.assign(client, patch),
    ignore: () => {
      ignoreWrite = true;
    }
  };
}

test('S-UI billing writes use complete detail, preserve native options and convert expiry seconds and quota bytes', async () => {
  const f = fixture(),
    expiryTime = Date.parse('2027-02-03T04:05:06.789Z');
  assert.equal((await f.service.state(f.node, { email: 'alice' })).totalGB, 100 * 1024 ** 3);
  const result = await f.service.patch(
    f.node,
    { email: 'alice' },
    { expiryTime, enable: false, totalGB: 2 * 1024 ** 3 },
    'expiry'
  );
  assert(f.calls[0]!.endsWith('clients?id=7'));
  const verified = await f.service.state(f.node, { email: 'alice' });
  assert.equal(verified.totalGB, 2 * 1024 ** 3);
  assert.equal(verified.enable, false);
  assert.deepEqual(f.writes[0].config, {
    tuic: { uuid: 'keep', password: 'keep-secret' }
  });
  assert.deepEqual(f.writes[0].futureOption, { keep: true });
  assert.equal(f.writes[0].expiry, Math.floor(expiryTime / 1000));
  assert.equal(f.writes[0].volume, 2 * 1024 ** 3);
  assert.equal(f.writes[0].up, 3);
  assert.equal(result.verified.enable, false);
  assert.deepEqual(result.response, { success: true, clientId: 7 });
  assert.equal(JSON.stringify(result).includes('another-secret'), false);
  assert.equal(JSON.stringify(result).includes('keep-secret'), false);
  const state = await f.service.state(f.node, { email: 'alice' });
  assert.equal(state.expiryTime, Math.floor(expiryTime / 1000) * 1000);
  const traffic = await f.service.traffic(f.node);
  assert.equal(traffic.usedBytes, 8);
  assert.equal(traffic.totalBytes, 2 * 1024 ** 3);
});

test('S-UI authorization mapping rejects malformed or unrepresentable remote values', () => {
  for (const fields of [
    { expiry: 'bad' },
    { volume: -1 },
    { enable: 'true' },
    { expiry: Number.MAX_SAFE_INTEGER }
  ]) {
    assert.throws(
      () => suiAuthorization({ enable: true, expiry: 0, volume: 0, ...fields }),
      /授权数据无效|超出有效范围/
    );
  }
  assert.deepEqual(
    suiAuthorization({ enable: false, expiry: 0, volume: 1024 ** 3 }),
    {
      expireAt: null,
      trafficLimitGb: 1,
      status: 'disabled',
      disabledReason: 'admin'
    }
  );
});

test('S-UI does not acknowledge an ignored write or another client identity as successful', async () => {
  const f = fixture();
  f.ignore();
  await assert.rejects(
    () =>
      f.service.patch(f.node, { email: 'alice' }, { enable: false }, 'enable'),
    /回读不一致/
  );
  await assert.rejects(
    () => f.service.state(f.node, { email: 'other' }),
    /标识已变化/
  );
});

test('S-UI subscriptions and object-shaped native links reach the user center', async () => {
  const f = fixture();
  assert.deepEqual(await f.service.links(f.node), [
    'https://sub.example/sub/alice',
    'tuic://keep@example.test:443'
  ]);
  await f.service.resetTraffic(f.node);
  assert.equal(f.client().up, 0);
  assert.equal(f.client().down, 0);
  assert.equal(f.client().config.tuic.password, 'keep-secret');
});

test('S-UI business linking rejects shared clients, first-use expiry and duplicate resource ownership', async () => {
  const f = fixture(),
    input = { clientId: 7, inboundId: 11, name: 'TUIC', priceMonthly: 12 };
  const node = await f.service.link('s1', input);
  assert.equal(node.protocol, 'tuic');
  assert.equal(node.priceMonthly, 12);
  f.setClient({ inbounds: [11, 12] });
  await assert.rejects(() => f.service.link('s1', input), /仅关联/);
  f.setClient({ inbounds: [11], delayStart: true });
  await assert.rejects(() => f.service.link('s1', input), /首次使用/);
  f.setClient({ delayStart: false });
  f.prisma.serviceNode.findMany = async () => [f.node];
  await assert.rejects(() => f.service.link('s1', input), /已接入业务/);
});

test('S-UI deletion serializes the numeric ID expected by v1.6.6 service source', async () => {
  let sent = '';
  const api = new SuiClient({
    baseUrl: 'https://example.test/app',
    token: 'token',
    fetchImpl: async (_url, init) => {
      sent = new URLSearchParams(init!.body as string).get('data')!;
      return new Response(JSON.stringify({ success: true, obj: {} }));
    }
  });
  await api.save('clients', 'del', { id: 7 });
  assert.equal(sent, '7');
});

test('native API catalog resolves schemas and confines requests to declared operations and parameters', async () => {
  const document = {
    paths: {
      '/panel/api/clients/update/{email}': {
        post: {
          summary: 'Update',
          parameters: [{ name: 'email', in: 'path', required: true }],
          requestBody: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Client' }
              }
            }
          }
        }
      },
      '/panel/api/xray/update': {
        post: {
          requestBody: {
            content: {
              'application/x-www-form-urlencoded': {
                schema: { type: 'object' }
              }
            }
          }
        }
      },
      '/logout': { post: {} },
      '/panel/api/../outside': { get: {} }
    },
    components: {
      schemas: {
        Client: {
          type: 'object',
          properties: { password: { type: 'string' } }
        }
      }
    }
  };
  const catalog = nativeCatalog(document);
  assert.equal(catalog.length, 2);
  assert.equal(catalog[0]!.schema.properties.password.type, 'string');
  const calls: any[] = [];
  const client = {
    nativeRequest: async (...args: any[]) => {
      calls.push(args);
      return { success: true };
    }
  } as unknown as XuiClient;
  const input = nativeExecuteSchema.parse({
    operation: catalog[0]!.id,
    parameters: { email: 'a@example.test' },
    body: { futureOption: true },
    confirmed: true
  });
  await executeNative(client, catalog, input);
  assert.equal(calls[0][0], '/panel/api/clients/update/a%40example.test');
  assert.deepEqual(calls[0][1].body, { futureOption: true });
  await assert.rejects(
    () => executeNative(client, catalog, { ...input, confirmed: false }),
    /确认/
  );
  await assert.rejects(
    () =>
      executeNative(client, catalog, { ...input, operation: 'POST /logout' }),
    /未声明/
  );
  await assert.rejects(
    () =>
      executeNative(client, catalog, {
        ...input,
        parameters: { email: '../bad' }
      }),
    /路径参数/
  );
  await assert.rejects(
    () =>
      executeNative(client, catalog, {
        ...input,
        parameters: { email: 'a', url: 'https://bad' }
      }),
    /未声明/
  );
});

test('native transport preserves form JSON, multipart bytes and downloadable backups', async () => {
  const requests: any[] = [];
  const client = new XuiClient({
    baseUrl: 'https://example.test',
    auth: { kind: 'token', token: 'secret' },
    fetchImpl: async (_url, init) => {
      requests.push(init);
      return init?.method === 'GET'
        ? new Response(Uint8Array.of(0, 1, 255), {
            headers: {
              'content-disposition': 'attachment; filename="backup.db"',
              'content-type': 'application/octet-stream'
            }
          })
        : new Response('{"success":true}');
    }
  });
  await client.nativeRequest('/panel/api/xray/update', {
    method: 'POST',
    encoding: 'application/x-www-form-urlencoded',
    body: { xraySetting: '{"routing":{}}' }
  });
  assert.equal(
    new URLSearchParams(requests[0].body).get('xraySetting'),
    '{"routing":{}}'
  );
  await client.nativeRequest('/panel/api/server/importDB', {
    method: 'POST',
    encoding: 'multipart/form-data',
    file: {
      field: 'db',
      name: 'test.db',
      type: 'application/octet-stream',
      base64: 'AAH/'
    }
  });
  assert.deepEqual(
    new Uint8Array(await requests[1].body.get('db').arrayBuffer()),
    Uint8Array.of(0, 1, 255)
  );
  const response: any = await client.nativeRequest('/panel/api/server/getDb', {
    method: 'GET'
  });
  assert.equal(response.download.base64, 'AAH/');
  assert.equal(response.download.name, 'backup.db');
});

test('native JSON array requests are supported for the official server/clientIps endpoint', async () => {
  const catalog = nativeCatalog({
    paths: {
      '/panel/api/server/clientIps': {
        post: {
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'array', items: { type: 'string' } }
              }
            }
          }
        }
      }
    }
  });
  let body: unknown;
  const client = {
    nativeRequest: async (_path: string, options: { body: unknown }) => {
      body = options.body;
      return { success: true };
    }
  } as XuiClient;
  await executeNative(
    client,
    catalog,
    nativeExecuteSchema.parse({
      operation: catalog[0]!.id,
      body: ['alice@example.test'],
      confirmed: true
    })
  );
  assert.deepEqual(body, ['alice@example.test']);
});
