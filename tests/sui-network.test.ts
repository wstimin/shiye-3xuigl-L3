import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSuiNetwork, assertSuiResourceUnused } from '../apps/api/src/modules/sui/sui-network.js';
import { SuiService } from '../apps/api/src/modules/sui/sui.service.js';
import { testLocks } from './test-locks.js';
import { suiTagChoices, suiRouteRule, suiRouteSchema } from '../apps/admin-web/src/sui-panel.js';

const inbounds = [{ id: 1, tag: 'entry', type: 'vless' }];
const outbounds = [{ id: 2, tag: 'direct', type: 'direct' }];
const endpoints = [{ id: 3, tag: 'wg', type: 'wireguard' }];
const config = { dns: { final: 'dns-server' }, route: { rules: [{ action: 'sniff' }, { type: 'logical', mode: 'and', rules: [{ inbound: ['entry'] }], outbound: 'wg' }], final: 'direct' } };

test('S-UI route forms select current native tags and preserve endpoints as targets', () => {
  assert.deepEqual(suiTagChoices([...outbounds, ...endpoints, { id: 4 }]), [
    { value: 'direct', label: 'direct · direct' }, { value: 'wg', label: 'wg · wireguard' }
  ]);
  assert.equal(suiRouteRule.action, 'route');
  assert.equal(suiRouteSchema.properties?.rules?.items?.properties?.inbound?.type, 'array');
  assert.equal(suiRouteSchema.properties?.rules?.items?.properties?.outbound?.type, 'string');
});

test('S-UI validates nested route, default exit and detour references within the current panel', () => {
  assert.doesNotThrow(() => assertSuiNetwork(config, inbounds, outbounds, endpoints));
  for (const patch of [
    { route: { rules: [{ inbound: ['other-panel'], outbound: 'direct' }] } },
    { route: { final: 'missing' } },
    { route: { rules: [{ type: 'logical', rules: [{ outbound: 'missing' }] }] } },
    { dns: { servers: [{ detour: 'missing' }] } },
    { route: { rules: [{ action: 'route' }] } }
  ]) assert.throws(() => assertSuiNetwork(patch, inbounds, outbounds, endpoints));
  assert.throws(() => assertSuiNetwork({}, inbounds, [{ tag: 'group', outbounds: ['missing'] }], endpoints));
});

test('S-UI protects referenced inbound, endpoint, default exit, DNS detour and selector members', () => {
  for (const [kind, tag] of [['inbounds', 'entry'], ['endpoints', 'wg'], ['outbounds', 'direct']])
    assert.throws(() => assertSuiResourceUnused(kind!, tag!, config, outbounds, endpoints), /解除关联/);
  assert.throws(() => assertSuiResourceUnused('outbounds', 'direct', { dns: { servers: [{ detour: 'direct' }] } }, outbounds, []));
  assert.throws(() => assertSuiResourceUnused('outbounds', 'direct', {}, [{ tag: 'group', outbounds: ['direct'], default: 'direct' }], []));
  assert.doesNotThrow(() => assertSuiResourceUnused('outbounds', 'free', config, outbounds, endpoints));
});

function fixture() {
  let saved = structuredClone(config) as Record<string, unknown>;
  let writes = 0;
  let staleReadback = false;
  const service = new SuiService({ serviceNode: { findMany: async () => [] }, syncLog: { create: async () => ({}) } } as never, {} as never, testLocks());
  const client = {
    read: async (key: string) => ({ config: { config: saved }, inbounds: { inbounds }, outbounds: { outbounds }, endpoints: { endpoints } })[key],
    save: async (_object: string, _action: string, data: Record<string, unknown>) => { writes++; if (!staleReadback) saved = structuredClone(data); return {}; }
  };
  service.client = async () => client as never;
  return { service, writes: () => writes, stale: () => { staleReadback = true; } };
}

test('S-UI rejects invalid and referenced network writes before sending any mutation', async () => {
  const f = fixture();
  await assert.rejects(() => f.service.save('s1', { object: 'config', action: 'edit', data: { route: { final: 'missing' } } }));
  await assert.rejects(() => f.service.save('s1', { object: 'outbounds', action: 'del', data: { id: 2 } }), /解除关联/);
  await assert.rejects(() => f.service.save('s1', { object: 'endpoints', action: 'edit', data: { id: 3, tag: 'renamed' } }), /解除关联/);
  assert.equal(f.writes(), 0);
});

test('S-UI verifies the route saved by the native panel instead of trusting success alone', async () => {
  const next = { ...config, route: { final: 'wg', rules: [] } };
  const f = fixture();
  await f.service.save('s1', { object: 'config', action: 'edit', data: next });
  assert.equal(f.writes(), 1);
  const stale = fixture(); stale.stale();
  await assert.rejects(() => stale.service.save('s1', { object: 'config', action: 'edit', data: next }), /回读不一致/);
});
