import test from 'node:test';
import assert from 'node:assert/strict';
import { NodesService } from '../apps/api/src/modules/nodes/nodes.service.js';

const encryption = {} as any;

test('repeated sync failures upsert one task and increment the attempt count', async () => {
  const records = new Map<string, any>();
  const prisma: any = {
    syncTask: {
      upsert: async ({ where, create, update }: any) => {
        const key = [where.entityType_entityId_action.entityType, where.entityType_entityId_action.entityId, where.entityType_entityId_action.action].join(':');
        const current = records.get(key);
        if (!current) records.set(key, { ...create });
        else records.set(key, { ...current, ...update, attemptCount: current.attemptCount + update.attemptCount.increment });
        return records.get(key);
      }
    }
  };
  const service = new NodesService(prisma, encryption, {} as any) as any;
  await service.failSyncTask('service-node', 'node-1', 'service-config', new Error('remote offline'));
  await service.failSyncTask('service-node', 'node-1', 'service-config', new Error('remote offline'));
  assert.equal(records.size, 1);
  assert.equal(records.values().next().value.attemptCount, 2);
  assert.equal(records.values().next().value.status, 'failed');
});

test('failed task retry keeps the task unresolved and records another attempt', async () => {
  let attempts = 1;
  let resolved = 0;
  const prisma: any = {
    syncTask: {
      findUnique: async () => ({ id: 'task-1', entityType: 'service-node', entityId: 'node-1', action: 'service-config', status: 'failed', detail: null }),
      upsert: async () => { attempts += 1; return {}; },
      updateMany: async () => { resolved += 1; return { count: 1 }; }
    }
  };
  const service = new NodesService(prisma, encryption, { syncServiceNodeRemoteConfig: async () => { throw new Error('still offline'); } } as any);
  await assert.rejects(() => service.retrySyncTask('task-1'), /still offline/);
  assert.equal(attempts, 2);
  assert.equal(resolved, 0);
});
