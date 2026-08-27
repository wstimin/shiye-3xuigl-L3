import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { formatTraffic, trafficBytes } from '../apps/user-web/src/traffic.js';

const adminNodesView = readFileSync('apps/admin-web/src/views/NodesView.vue', 'utf8');
const adminCustomersView = readFileSync('apps/admin-web/src/views/CustomersView.vue', 'utf8');
const userHomeView = readFileSync('apps/user-web/src/views/HomeView.vue', 'utf8');
const userNodesView = readFileSync('apps/user-web/src/views/NodesView.vue', 'utf8');

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

test('management and user pages display official total and remaining traffic', () => {
  for (const source of [adminNodesView, adminCustomersView, userHomeView, userNodesView]) {
    assert.match(source, /总流量/);
    assert.match(source, /剩余流量/);
  }
  assert.match(userHomeView, /officialTrafficTotalBytes/);
  assert.match(userHomeView, /officialTrafficRemainingBytes/);
  assert.match(userNodesView, /officialTrafficTotalBytes/);
  assert.match(userNodesView, /officialTrafficRemainingBytes/);
});

test('user traffic display treats only the official zero quota as unlimited', () => {
  for (const source of [userHomeView, userNodesView]) {
    assert.match(source, /officialTrafficUnlimited === true/);
    assert.doesNotMatch(source, /trafficLimitGb[^\n]*(?:无限流量|officialTrafficUnlimited)/);
  }
});
