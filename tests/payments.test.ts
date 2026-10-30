import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PaymentsService } from '../apps/api/src/modules/payments/payments.service.js';

function epaySign(params: Record<string, string>, key: string) {
  const content = Object.keys(params).filter((name) => !['sign', 'sign_type'].includes(name) && params[name]).sort().map((name) => name + '=' + params[name]).join('&');
  return createHash('md5').update(content + key, 'utf8').digest('hex');
}

test('concurrent payment notifications lock the order before reading and credit once', async () => {
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
  let lockTail = Promise.resolve();
  const prisma: any = {
    rechargeOrder: { findUnique: async () => order },
    paymentChannel: { findFirst: async () => channel },
    $transaction: async (operation: any) => {
      let unlock: (() => void) | undefined;
      let locked = false;
      try {
        return await operation({
          ...tx,
          $queryRaw: async (sql: TemplateStringsArray, tradeNo: string) => {
            assert.match(sql.join('?'), /SELECT id FROM recharge_orders WHERE tradeNo = \? FOR UPDATE/);
            assert.equal(tradeNo, order.tradeNo);
            const previous = lockTail;
            lockTail = new Promise<void>(resolve => { unlock = resolve; });
            await previous;
            locked = true;
            return [{ id: order.id }];
          },
          rechargeOrder: {
            ...tx.rechargeOrder,
            findUnique: async () => {
              assert(locked, 'order state must be read under its database row lock');
              return order;
            }
          }
        });
      } finally { unlock?.(); }
    }
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
  assert.deepEqual(await Promise.all(Array.from({ length: 5 }, () => service.notify({ provider: 'epay', query: params, body: {} }))), Array(5).fill('success'));
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
    $queryRaw: async () => [{ id: order.id }],
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

test('WeChat parses wrapped XML gateway responses and signed XML notifications', async (t) => {
  const key = 'wechat-merchant-secret';
  const channel = { id: 'wx-channel', provider: 'wechat', enabled: true, configEnc: {
    url: 'https://payment-fixture.invalid', appId: 'wx-app', mchId: 'wx-merchant', apiKey: key,
    notifyUrl: 'https://site-fixture.invalid/api/payments/wechat/notify'
  } };
  const customer = { id: 'wx-customer', status: 'active', balance: new Prisma.Decimal(0) };
  let order: any;
  let credits = 0;
  const tx: any = {
    $queryRaw: async () => [{ id: order.id }],
    rechargeOrder: {
      findUnique: async () => order,
      updateMany: async ({ data }: any) => { Object.assign(order, data); return { count: 1 }; }
    },
    paymentCallback: { create: async () => ({ id: 'wx-callback' }) },
    customer: {
      findUnique: async () => customer,
      update: async ({ data }: any) => {
        credits++;
        customer.balance = customer.balance.plus(data.balance.increment);
        return { balance: customer.balance };
      }
    },
    balanceLog: { create: async () => ({ id: 'wx-balance-log' }) }
  };
  const prisma: any = {
    customer: tx.customer,
    paymentChannel: { findFirst: async () => channel },
    rechargeOrder: {
      create: async ({ data }: any) => (order = { ...data, id: 'wx-order', channel }),
      findUnique: async () => order
    },
    $transaction: async (operation: any) => operation(tx)
  };
  const xml = (data: Record<string, string>, cdata: boolean) => '<xml>' + Object.entries(data).map(([name, value]) =>
    `<${name}>${cdata ? `<![CDATA[${value}]]>` : value}</${name}>`).join('') + '</xml>';
  const service = new PaymentsService(prisma, { decrypt: (value: string) => value } as any);
  for (const cdata of [false, true]) {
    const fetchMock = t.mock.method(globalThis, 'fetch', async () => new Response(xml({
      return_code: 'SUCCESS', result_code: 'SUCCESS', code_url: 'weixin://fixture-payment'
    }, cdata), { headers: { 'content-type': 'text/xml' } }));
    try {
      const result = await service.createOrder(customer.id, { provider: 'wechat', channelId: channel.id, amount: '4.56' });
      assert.equal(result.qrCode, 'weixin://fixture-payment');
      const params = { return_code: 'SUCCESS', result_code: 'SUCCESS', out_trade_no: order.tradeNo, transaction_id: `wx-${cdata}`, total_fee: '456' };
      const sign = createHash('md5').update(Object.keys(params).sort().map(name => `${name}=${params[name as keyof typeof params]}`).join('&') + '&key=' + key).digest('hex').toUpperCase();
      const notify = { provider: 'wechat', query: {}, body: xml({ ...params, sign }, cdata) };
      assert.match(await service.notify(notify), /<!\[CDATA\[SUCCESS\]\]>/);
      assert.match(await service.notify(notify), /<!\[CDATA\[SUCCESS\]\]>/);
      assert.equal(order.status, 'paid');
    } finally { fetchMock.mock.restore(); }
  }
  assert.equal(credits, 2);
  assert.equal(customer.balance.toFixed(2), '9.12');
});
