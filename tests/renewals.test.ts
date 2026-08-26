import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { FinanceService } from '../apps/api/src/modules/finance/finance.service.js';
import { testLocks } from './test-locks.js';

type RemoteMode = 'success' | 'throw-applied' | 'throw-unchanged' | 'throw-unknown';

function renewalFixture(options: {
  remoteMode?: RemoteMode;
  finalLocalFails?: boolean;
  existingPending?: boolean;
  node?: Record<string, unknown>;
} = {}) {
  const customer: any = { id: 'customer-1', balance: new Prisma.Decimal(100), status: 'active' };
  const node: any = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    serviceNodeId: 'service-node-1',
    expireAt: new Date('2030-01-01T00:00:00Z'),
    status: 'active',
    disabledReason: null,
    remoteControl: 'fully_managed',
    customer,
    serviceNode: {
      id: 'service-node-1',
      name: '东京路由',
      enabled: true,
      priceMonthly: new Prisma.Decimal(10),
      server: {}
    },
    ...options.node
  };
  const renewalLogs: any[] = options.existingPending ? [{
    id: 'renewal-existing',
    idempotencyKey: 'renewal:customer-1:customer-node-1:another-request',
    customerId: 'customer-1',
    customerNodeId: 'customer-node-1',
    months: 1,
    amount: new Prisma.Decimal(10),
    status: 'pending',
    beforeExpireAt: node.expireAt,
    afterExpireAt: new Date('2030-02-01T00:00:00Z'),
    balanceLogId: 'balance-existing',
    detail: {}
  }] : [];
  const balanceLogs: any[] = options.existingPending ? [{
    id: 'balance-existing',
    customerId: 'customer-1',
    type: 'renewal',
    afterBalance: new Prisma.Decimal(90)
  }] : [];
  const remoteWrites: Array<{ expireAt: Date | null; enable?: boolean }> = [];
  const initialRemote = { expiryTime: new Date('2030-01-01T00:00:00Z').getTime(), enable: true };
  let remoteState = { ...initialRemote };
  let remoteResultUnknown = false;
  let debitCount = 0;
  let sequence = 0;

  const renewalLogRepository: any = {
    findUnique: async ({ where }: any) => {
      if (where.idempotencyKey) return renewalLogs.find((item) => item.idempotencyKey === where.idempotencyKey) || null;
      return renewalLogs.find((item) => item.id === where.id) || null;
    },
    findFirst: async ({ where }: any) => renewalLogs.find((item) =>
      item.customerNodeId === where.customerNodeId && item.status === where.status
    ) || null,
    findMany: async () => renewalLogs.filter((item) => item.status === 'pending'),
    count: async ({ where }: any) => renewalLogs.filter((item) => item.status === where.status).length,
    create: async ({ data }: any) => {
      const record = { id: `renewal-${++sequence}`, ...data, createdAt: new Date(), updatedAt: new Date() };
      renewalLogs.push(record);
      return record;
    },
    update: async ({ where, data }: any) => {
      const record = renewalLogs.find((item) => item.id === where.id);
      if (!record) throw new Error('renewal missing');
      Object.assign(record, data, { updatedAt: new Date() });
      return record;
    },
    updateMany: async ({ where, data }: any) => {
      const record = renewalLogs.find((item) => item.id === where.id && item.status === where.status);
      if (!record) return { count: 0 };
      Object.assign(record, data, { updatedAt: new Date() });
      return { count: 1 };
    }
  };

  const balanceLogRepository: any = {
    findUnique: async ({ where }: any) => balanceLogs.find((item) => item.id === where.id) || null,
    create: async ({ data }: any) => {
      const record = { id: `balance-${balanceLogs.length + 1}`, ...data };
      balanceLogs.push(record);
      return record;
    },
    update: async ({ where, data }: any) => {
      const record = balanceLogs.find((item) => item.id === where.id);
      if (!record) throw new Error('balance log missing');
      Object.assign(record, data);
      return record;
    }
  };

  const customerRepository: any = {
    updateMany: async ({ data }: any) => {
      debitCount += 1;
      const amount = new Prisma.Decimal(data.balance.decrement);
      if (customer.status !== 'active' || customer.balance.lessThan(amount)) return { count: 0 };
      customer.balance = customer.balance.minus(amount);
      return { count: 1 };
    },
    findUnique: async () => ({ balance: customer.balance }),
    update: async ({ data }: any) => {
      customer.balance = data.balance?.increment === undefined
        ? new Prisma.Decimal(data.balance)
        : customer.balance.plus(data.balance.increment);
      return customer;
    }
  };

  const customerNodeRepository: any = {
    findFirst: async ({ where }: any) => where.id === node.id && where.customerId === node.customerId ? node : null,
    findUnique: async ({ where }: any) => where.id === node.id ? node : null,
    update: async ({ data }: any) => {
      if (options.finalLocalFails) throw new Error('local commit failed');
      Object.assign(node, data);
      return node;
    }
  };

  const tx: any = {
    customer: customerRepository,
    customerNode: customerNodeRepository,
    renewalLog: renewalLogRepository,
    balanceLog: balanceLogRepository,
    $queryRaw: async () => [{ balance: customer.balance }]
  };
  const prisma: any = {
    $transaction: async (operation: any) => Array.isArray(operation) ? Promise.all(operation) : operation(tx),
    customer: customerRepository,
    customerNode: customerNodeRepository,
    renewalLog: renewalLogRepository,
    balanceLog: balanceLogRepository
  };
  const xui: any = {
    customerNodeRemoteState: async () => {
      if (remoteResultUnknown) throw new Error('remote state unavailable');
      return { ...remoteState };
    },
    updateCustomerNodeExpiry: async (_customerId: string, _nodeId: string, expireAt: Date | null, enable?: boolean) => {
      remoteWrites.push({ expireAt, enable });
      const isRollback = remoteWrites.length > 1 && expireAt?.getTime() === initialRemote.expiryTime;
      if (isRollback) {
        remoteState = { expiryTime: expireAt?.getTime() || 0, enable: Boolean(enable) };
        return { skipped: false, verified: { ...remoteState } };
      }

      const nextState = { expiryTime: expireAt?.getTime() || 0, enable: Boolean(enable) };
      if (options.remoteMode === 'throw-applied') {
        remoteState = nextState;
        throw new Error('remote response lost');
      }
      if (options.remoteMode === 'throw-unchanged') throw new Error('remote rejected update');
      if (options.remoteMode === 'throw-unknown') {
        remoteState = nextState;
        remoteResultUnknown = true;
        throw new Error('remote result unknown');
      }
      remoteState = nextState;
      return { skipped: false, verified: { ...remoteState } };
    }
  };

  const service = new FinanceService(prisma, xui, testLocks()) as any;
  service.withRenewalLock = async (_id: string, operation: () => Promise<unknown>) => operation();
  return {
    service: service as FinanceService,
    customer,
    node,
    renewalLogs,
    balanceLogs,
    remoteWrites,
    get debitCount() { return debitCount; },
    get refunds() { return balanceLogs.filter((item) => item.type === 'refund'); }
  };
}

test('same renewal request is idempotent and debits only once', async () => {
  const fixture = renewalFixture();
  const requestId = '11111111-1111-4111-8111-111111111111';
  await fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 2, 'admin', requestId);
  const repeated = await fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 2, 'admin', requestId);
  assert.equal(fixture.debitCount, 1);
  assert.equal(fixture.remoteWrites.length, 0);
  assert.equal(fixture.customer.balance.toFixed(2), '80.00');
  assert.equal(fixture.node.expireAt.toISOString(), '2030-03-01T00:00:00.000Z');
  assert.equal(fixture.renewalLogs[0].status, 'success');
  assert.equal(fixture.renewalLogs[0].detail.sync.remoteWrite, false);
  assert.equal(fixture.balanceLogs[0].detail.syncStatus, 'local-only');
  assert.equal((repeated as any).idempotent, true);
});

test('different request is rejected while the node has a pending renewal', async () => {
  const fixture = renewalFixture({ existingPending: true });
  await assert.rejects(
    () => fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 2, 'admin', '22222222-2222-4222-8222-222222222222'),
    /存在待确认续费/
  );
  assert.equal(fixture.debitCount, 0);
  assert.equal(fixture.remoteWrites.length, 0);
});

test('reference binding renews local authorization without a remote write', async () => {
  const fixture = renewalFixture({ node: { remoteControl: 'reference' } });
  const result = await fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 1, 'admin', '33333333-3333-4333-8333-333333333333');
  assert.equal(fixture.debitCount, 1);
  assert.equal(fixture.remoteWrites.length, 0);
  assert.equal(fixture.customer.balance.toFixed(2), '90.00');
  assert.equal(fixture.node.expireAt.toISOString(), '2030-02-01T00:00:00.000Z');
  assert.deepEqual((result as any).sync, { remoteWrite: false, scope: 'local-authorization' });
});

test('renewal ignores remote update response failures because it is local authorization only', async () => {
  const fixture = renewalFixture({ remoteMode: 'throw-applied' });
  await fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 1, 'admin', '44444444-4444-4444-8444-444444444444');
  assert.equal(fixture.customer.balance.toFixed(2), '90.00');
  assert.equal(fixture.renewalLogs[0].status, 'success');
  assert.equal(fixture.balanceLogs[0].detail.syncStatus, 'local-only');
  assert.equal(fixture.remoteWrites.length, 0);
  assert.equal(fixture.refunds.length, 0);
});

test('renewal does not call a rejecting remote client', async () => {
  const fixture = renewalFixture({ remoteMode: 'throw-unchanged' });
  await fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 1, 'admin', '55555555-5555-4555-8555-555555555555');
  assert.equal(fixture.customer.balance.toFixed(2), '90.00');
  assert.equal(fixture.renewalLogs[0].status, 'success');
  assert.equal(fixture.remoteWrites.length, 0);
  assert.equal(fixture.refunds.length, 0);
});

test('renewal never becomes pending because of an unavailable shared remote client', async () => {
  const fixture = renewalFixture({ remoteMode: 'throw-unknown' });
  await fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 1, 'admin', '66666666-6666-4666-8666-666666666666');
  assert.equal(fixture.customer.balance.toFixed(2), '90.00');
  assert.equal(fixture.renewalLogs[0].status, 'success');
  assert.equal(fixture.remoteWrites.length, 0);
  assert.equal(fixture.refunds.length, 0);
});

test('admin and traffic-disabled nodes cannot be restored by renewal', async () => {
  for (const disabledReason of ['admin', 'traffic_exceeded'] as const) {
    const fixture = renewalFixture({ node: { status: 'disabled', disabledReason } });
    await assert.rejects(
      () => fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 1, 'admin', `77777777-7777-4777-8777-77777777777${disabledReason === 'admin' ? '7' : '8'}`)
    );
    assert.equal(fixture.debitCount, 0);
    assert.equal(fixture.remoteWrites.length, 0);
  }
});

test('local commit failure performs no remote write or rollback', async () => {
  const fixture = renewalFixture({ finalLocalFails: true });
  await assert.rejects(
    () => fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 1, 'admin', '88888888-8888-4888-8888-888888888888'),
    /local commit failed/
  );
  assert.equal(fixture.remoteWrites.length, 0);
  assert.equal(fixture.refunds.length, 0);
});
