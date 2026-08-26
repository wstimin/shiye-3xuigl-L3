import test from 'node:test';
import assert from 'node:assert/strict';
import { JobsService } from '../apps/api/src/modules/jobs/jobs.service.js';
import { testLocks } from './test-locks.js';

function expiredFixture() {
  return {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'shared@example.com',
    expireAt: new Date('2020-01-01T00:00:00Z'),
    serviceNodeId: 'service-node-1',
    status: 'active'
  };
}

test('expired-node job disables the remote shared client before updating local state', async () => {
  const node = expiredFixture();
  const operations: string[] = [];
  const prisma = {
    customerNode: {
      findMany: async () => [node],
      findUnique: async () => node,
      update: async () => {
        operations.push('local-disabled');
        return { ...node, status: 'disabled' };
      }
    },
    renewalLog: { findFirst: async () => null },
    syncLog: { create: async () => ({}) }
  } as any;
  const xui = {
    setCustomerNodeRemoteEnabled: async () => {
      operations.push('remote-disabled');
      return { synced: true };
    }
  } as any;
  const service = new JobsService(prisma, xui, testLocks());

  const result = await service.disableExpiredNodes('manual');

  assert.deepEqual(operations, ['remote-disabled', 'local-disabled']);
  assert.equal(result.success, 1);
  assert.equal(result.failed, 0);
});

test('expired-node job keeps the local binding active when remote disable fails', async () => {
  const node = expiredFixture();
  let localUpdates = 0;
  const prisma = {
    customerNode: {
      findMany: async () => [node],
      findUnique: async () => node,
      update: async () => { localUpdates += 1; }
    },
    renewalLog: { findFirst: async () => null },
    syncLog: { create: async () => ({}) }
  } as any;
  const xui = {
    setCustomerNodeRemoteEnabled: async () => {
      throw new Error('panel unavailable');
    }
  } as any;
  const service = new JobsService(prisma, xui, testLocks());

  const result = await service.disableExpiredNodes('manual');

  assert.equal(localUpdates, 0);
  assert.equal(result.success, 0);
  assert.equal(result.failed, 1);
  assert.match(result.results[0].message || '', /panel unavailable/);
});

function trafficFixture() {
  return {
    id: 'customer-node-1',
    customerId: 'customer-1',
    xuiEmail: 'shared@example.com',
    trafficLimitGb: 10,
    serviceNodeId: 'service-node-1',
    status: 'active'
  };
}

test('traffic job reads official usage and keeps a below-limit node active', async () => {
  const node = trafficFixture();
  let remoteDisableCalls = 0;
  let localUpdates = 0;
  const prisma = {
    customerNode: {
      findMany: async () => [node],
      findUnique: async () => node,
      update: async () => { localUpdates += 1; }
    },
    renewalLog: { findFirst: async () => null },
    syncLog: { create: async () => ({}) }
  } as any;
  const xui = {
    syncCustomerNodeTraffic: async () => ({ usedBytes: 5 * 1024 ** 3, usedTrafficGb: 5 }),
    setCustomerNodeRemoteEnabled: async () => { remoteDisableCalls += 1; }
  } as any;
  const service = new JobsService(prisma, xui, testLocks());

  const result = await service.disableTrafficExceededNodes('manual');

  assert.equal(remoteDisableCalls, 0);
  assert.equal(localUpdates, 0);
  assert.equal(result.checked, 1);
  assert.equal(result.disabled, 0);
  assert.equal(result.failed, 0);
});

test('traffic job disables the official client before marking an exceeded node disabled', async () => {
  const node = trafficFixture();
  const operations: string[] = [];
  let localUpdate: any;
  const prisma = {
    customerNode: {
      findMany: async () => [node],
      findUnique: async () => node,
      update: async (args: any) => {
        localUpdate = args;
        operations.push('local-disabled');
      }
    },
    renewalLog: { findFirst: async () => null },
    syncLog: { create: async () => ({}) }
  } as any;
  const xui = {
    syncCustomerNodeTraffic: async () => ({ usedBytes: 10 * 1024 ** 3, usedTrafficGb: 10 }),
    setCustomerNodeRemoteEnabled: async () => { operations.push('remote-disabled'); }
  } as any;
  const service = new JobsService(prisma, xui, testLocks());

  const result = await service.disableTrafficExceededNodes('manual');

  assert.deepEqual(operations, ['remote-disabled', 'local-disabled']);
  assert.equal(localUpdate.data.status, 'disabled');
  assert.equal(localUpdate.data.disabledReason, 'traffic_exceeded');
  assert.equal(result.disabled, 1);
  assert.equal(result.failed, 0);
});

test('traffic job leaves local state active when official traffic cannot be read', async () => {
  const node = trafficFixture();
  let localUpdates = 0;
  const prisma = {
    customerNode: {
      findMany: async () => [node],
      findUnique: async () => node,
      update: async () => { localUpdates += 1; }
    },
    renewalLog: { findFirst: async () => null },
    syncLog: { create: async () => ({}) }
  } as any;
  const xui = {
    syncCustomerNodeTraffic: async () => { throw new Error('panel unavailable'); },
    setCustomerNodeRemoteEnabled: async () => { throw new Error('must not disable'); }
  } as any;
  const service = new JobsService(prisma, xui, testLocks());

  const result = await service.disableTrafficExceededNodes('manual');

  assert.equal(localUpdates, 0);
  assert.equal(result.disabled, 0);
  assert.equal(result.failed, 1);
  assert.match(result.results[0].message || '', /panel unavailable/);
});
