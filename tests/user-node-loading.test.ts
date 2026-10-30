import test from 'node:test';
import assert from 'node:assert/strict';
import { readUserNodes } from '../apps/user-web/src/node-loading.js';
import { cancelPendingReadRequests } from '../apps/user-web/src/api.js';

test('progressive nodes display snapshots early and never replace live results with late snapshots', async () => {
  const originalFetch = globalThis.fetch, originalWindow = globalThis.window;
  globalThis.window = Object.assign(new EventTarget(), { setTimeout, clearTimeout }) as unknown as Window & typeof globalThis;
  const pending = new Map<string, (value: Response) => void>();
  globalThis.fetch = async path => new Promise(resolve => pending.set(String(path), resolve));
  const reply = (path: string, value: string) => pending.get(path)!(new Response(JSON.stringify({ ok: true, data: [value] }), { headers: { 'content-type': 'application/json' } }));
  const seen: string[][] = [];
  try {
    const first = readUserNodes<string>(rows => seen.push(rows));
    reply('/api/user/nodes?snapshot=1', 'snapshot');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [['snapshot']]);
    reply('/api/user/nodes', 'live');
    assert.deepEqual(await first, ['live']);
    const second = readUserNodes<string>(rows => seen.push(rows));
    reply('/api/user/nodes', 'new-live');
    assert.deepEqual(await second, ['new-live']);
    reply('/api/user/nodes?snapshot=1', 'late-snapshot');
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(seen, [['snapshot']]);
  } finally {
    cancelPendingReadRequests(); globalThis.fetch = originalFetch;
    if (originalWindow) globalThis.window = originalWindow;
    else delete (globalThis as { window?: Window }).window;
  }
});
