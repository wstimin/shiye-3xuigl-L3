import test from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
import { CustomersService } from '../apps/api/src/modules/customers/customers.service.js';
import { CardsService } from '../apps/api/src/modules/cards/cards.service.js';

test('setting a balance records the actual signed change, including decreases and no change', async () => {
  let balance = new Prisma.Decimal(100);
  const logs: any[] = [];
  const tx: any = {
    $queryRaw: async () => [{ id: 'customer', balance }],
    customer: { update: async ({ data }: any) => ({ balance: balance = data.balance }) },
    balanceLog: { create: async ({ data }: any) => logs.push(data) },
  };
  const service = new CustomersService({ $transaction: (fn: any) => fn(tx) } as any, {} as any);
  for (const [target, change] of [[50, -50], [70, 20], [70, 0]]) {
    await service.adjustBalance('customer', { mode: 'set', amount: target! }, 'admin');
    const log = logs.at(-1);
    assert.equal(Number(log.amount), change);
    assert.equal(Number(log.afterBalance.minus(log.beforeBalance)), change);
  }
});

test('a card redeemed after the deletion preview is not deleted', async () => {
  const card = { id: 'card', status: 'unused' };
  let deleted = false;
  const service = new CardsService({ card: {
    findUnique: async () => { const preview = { ...card }; card.status = 'used'; return preview; },
    delete: async () => { deleted = true; },
    deleteMany: async ({ where }: any) => { if (card.status === where.status?.not) return { count: 0 }; deleted = true; return { count: 1 }; },
  } } as any, {} as any, {} as any);
  await assert.rejects(() => service.deleteCard('card'), /使用/);
  assert.equal(deleted, false);
});

test('batch deletion checks the locked current card state instead of a stale unused preview', async () => {
  let deleted = false;
  const tx: any = {
    $queryRaw: async (sql: TemplateStringsArray) => sql.join('').includes('card_batches') ? [{ id: 'batch' }] : [{ id: 'card', status: 'used' }],
    cardBatch: { findUnique: async () => ({ id: 'batch', cards: [{ status: 'unused' }] }), delete: async () => ({}) },
    card: { deleteMany: async () => { deleted = true; return { count: 1 }; } },
  };
  const service = new CardsService({ ...tx, $transaction: async (fn: any) => typeof fn === 'function' ? fn(tx) : Promise.all(fn) } as any, {} as any, {} as any);
  await assert.rejects(() => service.deleteBatch('batch'), /已使用/);
  assert.equal(deleted, false);
});

test('customer deletion locks the customer before checking financial history', async () => {
  const calls: string[] = [];
  const tx: any = {
    $queryRaw: async () => { calls.push('lock'); return [{ id: 'customer' }]; },
    customer: { findUnique: async () => { calls.push('read'); return { id: 'customer', nodes: [] }; }, delete: async () => { throw Error('must not delete'); } },
    renewalLog: { findFirst: async () => null, count: async () => 0 },
    rechargeOrder: { count: async () => 0 }, balanceLog: { count: async () => 1 }, card: { count: async () => 0 },
  };
  const service = new CustomersService({ ...tx, $transaction: async (fn: any) => typeof fn === 'function' ? fn(tx) : Promise.all(fn) } as any, {} as any);
  await assert.rejects(() => service.remove('customer'), /财务历史/);
  assert.equal(calls[0], 'lock');
});
