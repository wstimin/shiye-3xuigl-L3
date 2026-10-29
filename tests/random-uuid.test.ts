import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUuid } from '../packages/shared/src/random-uuid.js';

test('UUIDs use the native secure generator when present', () => {
  assert.equal(randomUuid({ randomUUID: () => 'native', getRandomValues: () => { throw Error('unexpected'); } }), 'native');
});

test('HTTP deployments generate valid v4 UUIDs from cryptographic random bytes', () => {
  let calls = 0;
  const source = { getRandomValues: (bytes: Uint8Array) => { calls++; return bytes.fill(255); } };
  assert.equal(randomUuid(source), 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(calls, 1);
  const values = new Set(Array.from({ length: 100 }, () => randomUuid({ getRandomValues: bytes => crypto.getRandomValues(bytes) })));
  assert.equal(values.size, 100);
  for (const value of values) assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
