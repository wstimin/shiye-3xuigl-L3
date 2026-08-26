import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTraffic, trafficBytes } from '../apps/user-web/src/traffic.js';

test('user traffic display keeps small official usage visible', () => {
  assert.equal(formatTraffic(512), '512 B');
  assert.equal(formatTraffic(1536), '1.5 KB');
  assert.equal(formatTraffic(1.5 * 1024 ** 2), '1.5 MB');
  assert.equal(formatTraffic(1.5 * 1024 ** 3), '1.5 GB');
});

test('user traffic display falls back to stored GB when official bytes are unavailable', () => {
  assert.equal(trafficBytes(undefined, '0.000001'), 1073.741824);
  assert.equal(formatTraffic(undefined, '0.000001'), '1.05 KB');
});
