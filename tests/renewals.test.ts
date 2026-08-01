import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { FinanceService } from '../apps/api/src/modules/finance/finance.service.js';

function renewalFixture(options: { remoteFails?: boolean; finalLocalFails?: boolean } = {}) {
  const customer: any = { id: 'customer-1', balance: new Prisma.Decimal(100), status: 'active' };
  const node: any = {
    id: 'customer-node-1',
    customerId: 'customer-1',
    serviceNodeId: 'service-node-1',
    expireAt: new Date('2030-01-01T00:00:00Z'),
    status: 'active',
    customer,
    serviceNode: { id: 'service-node-1', name: '东京路由', priceMonthly: new Prisma.Decimal(10) }
  };
  const renewalLog: any = { id: 'renewal-1', status: 'pending' };
  const balanceLog: any = { id: 'balance-1' };
  const refunds: any[] = [];
  let transactionCalls = 0;
  const tx: any = {
    customerNode: {
      findFirst: async () => node,
      update: async ({ data }: any) => {
        if (options.finalLocalFails) throw new Error('local commit failed');
        Object.assign(node, data);
        return { ...node, serviceNode: { ...node.serviceNode, server: {} } };
      }
    },
    customer: {
      updateMany: async ({ data }: any) => { customer.balance = new Prisma.Decimal(customer.balance).minus(data.balance.decrement); return { count: 1 }; },
      findUnique: async () => ({ balance: customer.balance }),
      update: async ({ data }: any) => { customer.balance = data.balance; return customer; }
    },
    renewalLog: {
      create: async () => renewalLog,
      update: async ({ data }: any) => Object.assign(renewalLog, data)
    },
    balanceLog: {
      create: async ({ data }: any) => { if (data.type === 'refund') refunds.push(data); return balanceLog; },
      update: async () => balanceLog
    }
  };
  const prisma: any = {
    $transaction: async (operation: any) => {
      transactionCalls += 1;
      if (Array.isArray(operation)) return Promise.all(operation);
      return operation(tx);
    },
    customer: tx.customer,
    renewalLog: tx.renewalLog,
    balanceLog: tx.balanceLog
  };
  const syncCalls: any[] = [];
  const xui: any = {
    syncCustomerNode: async (_customerId: string, _nodeId: string, syncOptions: any) => {
      syncCalls.push(syncOptions);
      if (options.remoteFails && syncCalls.length === 1) throw new Error('remote offline');
      return { route: 'clients/update', detail: { ok: true }, localPatch: {} };
    }
  };
  const service = new FinanceService(prisma, xui) as any;
  service.withRenewalLock = async (_id: string, operation: () => Promise<unknown>) => operation();
  return { service: service as FinanceService, customer, node, renewalLog, refunds, syncCalls, get transactionCalls() { return transactionCalls; } };
}

test('renewal sync never creates a missing remote client', async () => {
  const fixture = renewalFixture();
  await fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 2, 'admin');
  assert.equal(fixture.syncCalls.length, 1);
  assert.equal(fixture.syncCalls[0].createIfMissing, false);
  assert.equal(fixture.syncCalls[0].requireExisting, true);
  assert.equal(fixture.syncCalls[0].persistLocal, false);
  assert.equal(fixture.customer.balance.toFixed(2), '80.00');
  assert.equal(fixture.renewalLog.status, 'success');
});

test('remote renewal failure refunds the deducted balance', async () => {
  const fixture = renewalFixture({ remoteFails: true });
  await assert.rejects(() => fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 1, 'admin'), /remote offline/);
  assert.equal(fixture.customer.balance.toFixed(2), '100.00');
  assert.equal(fixture.renewalLog.status, 'failed');
  assert.equal(fixture.refunds.length, 1);
});

test('local renewal commit failure rolls the remote expiry back without creating clients', async () => {
  const fixture = renewalFixture({ finalLocalFails: true });
  await assert.rejects(() => fixture.service.renewCustomerNode('customer-1', 'customer-node-1', 1, 'admin'), /local commit failed/);
  assert.equal(fixture.syncCalls.length, 2);
  assert.equal(fixture.syncCalls[1].createIfMissing, false);
  assert.equal(fixture.syncCalls[1].requireExisting, true);
  assert.equal(fixture.syncCalls[1].expireAt.toISOString(), '2030-01-01T00:00:00.000Z');
  assert.equal(fixture.customer.balance.toFixed(2), '100.00');
});
