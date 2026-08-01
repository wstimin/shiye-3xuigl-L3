import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PaymentsService } from '../apps/api/src/modules/payments/payments.service.js';

function epaySign(params: Record<string, string>, key: string) {
  const content = Object.keys(params).filter((name) => !['sign', 'sign_type'].includes(name) && params[name]).sort().map((name) => name + '=' + params[name]).join('&');
  return createHash('md5').update(content + key, 'utf8').digest('hex');
}

test('duplicate payment notifications credit the balance only once', async () => {
  const key = 'merchant-secret';
  const channel = { id: 'channel-1', provider: 'epay', enabled: true, configEnc: { pid: '1001', key } };
  const order: any = { id: 'order-1', tradeNo: 'RC100', customerId: 'customer-1', provider: 'epay', amount: new Prisma.Decimal(50), status: 'pending', expiresAt: new Date(Date.now() + 60_000), channel };
  const customer: any = { id: 'customer-1', status: 'active', balance: new Prisma.Decimal(20) };
  let balanceLogs = 0;
  const tx: any = {
    rechargeOrder: {
      findUnique: async () => order,
      updateMany: async ({ where, data }: any) => {
        if (where.status !== order.status) return { count: 0 };
        order.status = data.status;
        order.paidAt = data.paidAt;
        order.rawPayload = data.rawPayload;
        return { count: 1 };
      },
      update: async ({ data }: any) => Object.assign(order, data)
    },
    paymentCallback: { create: async () => ({ id: 'callback' }) },
    customer: {
      findUnique: async () => customer,
      update: async ({ data }: any) => {
        customer.balance = new Prisma.Decimal(customer.balance).plus(data.balance.increment);
        return { balance: customer.balance };
      }
    },
    balanceLog: { create: async () => { balanceLogs += 1; return { id: 'balance-log' }; } }
  };
  const prisma: any = {
    rechargeOrder: { findUnique: async () => order },
    paymentChannel: { findFirst: async () => channel },
    $transaction: async (operation: any) => operation(tx)
  };
  const service = new PaymentsService(prisma, { decrypt: (value: string) => value } as any);
  const params: Record<string, string> = {
    pid: '1001',
    out_trade_no: 'RC100',
    trade_no: 'EPAY-1',
    trade_status: 'TRADE_SUCCESS',
    money: '50.00'
  };
  params.sign = epaySign(params, key);
  assert.equal(await service.notify({ provider: 'epay', query: params, body: {} }), 'success');
  assert.equal(await service.notify({ provider: 'epay', query: params, body: {} }), 'success');
  assert.equal(order.status, 'paid');
  assert.equal(customer.balance.toFixed(2), '70.00');
  assert.equal(balanceLogs, 1);
});

test('payment callback with a mismatched amount does not credit balance', async () => {
  const key = 'merchant-secret';
  const channel = { id: 'channel-1', provider: 'epay', enabled: true, configEnc: { pid: '1001', key } };
  const order: any = { id: 'order-1', tradeNo: 'RC101', customerId: 'customer-1', provider: 'epay', amount: new Prisma.Decimal(50), status: 'pending', expiresAt: new Date(Date.now() + 60_000), channel };
  let credited = 0;
  const tx: any = {
    rechargeOrder: { findUnique: async () => order },
    paymentCallback: { create: async () => ({ id: 'callback' }) },
    customer: { findUnique: async () => ({ id: 'customer-1', status: 'active', balance: new Prisma.Decimal(0) }), update: async () => { credited += 1; } },
    balanceLog: { create: async () => { credited += 1; } }
  };
  const prisma: any = {
    rechargeOrder: { findUnique: async () => order },
    paymentChannel: { findFirst: async () => channel },
    $transaction: async (operation: any) => operation(tx)
  };
  const service = new PaymentsService(prisma, { decrypt: (value: string) => value } as any);
  const params: Record<string, string> = { pid: '1001', out_trade_no: 'RC101', trade_no: 'EPAY-2', trade_status: 'TRADE_SUCCESS', money: '49.00' };
  params.sign = epaySign(params, key);
  await assert.rejects(() => service.notify({ provider: 'epay', query: params, body: {} }), /支付金额不匹配/);
  assert.equal(credited, 0);
  assert.equal(order.status, 'pending');
});
