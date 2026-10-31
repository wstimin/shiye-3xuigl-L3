import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceAdjustSchema, customerUpsertSchema, cardTemplateUpsertSchema, paymentChannelUpsertSchema, xuiServerUpsertSchema, serviceNodeUpsertSchema, socksNodeUpsertSchema, customerNodeCreateSchema } from '@shiye/shared';
import { ZodValidationPipe } from '../apps/api/src/shared/zod-validation.pipe.js';

test('partial edits do not inject create-time balances, authorization or protocol defaults', () => {
  for (const schema of [customerUpsertSchema, cardTemplateUpsertSchema, paymentChannelUpsertSchema, xuiServerUpsertSchema, serviceNodeUpsertSchema, socksNodeUpsertSchema, customerNodeCreateSchema]) {
    const pipe = new ZodValidationPipe(schema.partial(), true);
    assert.deepEqual(pipe.transform({}), {});
  }
  const customer = new ZodValidationPipe(customerUpsertSchema.partial(), true);
  assert.deepEqual(customer.transform({ status: 'disabled' }), { status: 'disabled' });
  assert.deepEqual(customer.transform({ name: '  Alice  ', unexpected: true }), { name: 'Alice' });
  assert.deepEqual(customer.transform({ balance: '0' }), { balance: 0 }, 'explicit balance is preserved for service-level rejection');
  const panel = new ZodValidationPipe(xuiServerUpsertSchema.partial(), true);
  assert.deepEqual(panel.transform({ enabled: false }), { enabled: false });
  assert.throws(() => panel.transform({ enabled: 'false' }));
  assert.throws(() => panel.transform([]));
});

test('create requests still receive validated defaults', () => {
  const value = new ZodValidationPipe(customerUpsertSchema).transform({ name: 'Alice', loginUsername: 'alice' }) as any;
  assert.equal(value.balance, 0);
  assert.equal(value.status, 'active');
});

test('financial inputs reject empty or nonnumeric values instead of converting them into zero', () => {
  const pipe = new ZodValidationPipe(balanceAdjustSchema);
  for (const amount of [null, true, false, '', '  ', [], {}]) assert.throws(() => pipe.transform({ mode: 'set', amount }));
  assert.deepEqual(pipe.transform({ mode: 'set', amount: '0.00' }), { mode: 'set', amount: 0 });
});
