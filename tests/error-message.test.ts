import test from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { customerNodeCreateSchema } from '../packages/shared/src/index.js';
import { ZodValidationPipe } from '../apps/api/src/shared/zod-validation.pipe.js';
import { readableError, userFacingErrorMessage } from '../packages/shared/src/error-message.js';

test('user-facing errors preserve useful Chinese messages', () => {
  assert.equal(userFacingErrorMessage(400, '当前密码不正确'), '当前密码不正确');
});

test('known remote errors are translated to Chinese', () => {
  assert.equal(userFacingErrorMessage(404, 'remote client not found'), '远端客户端不存在');
});

test('unknown English errors are not exposed to users', () => {
  assert.equal(readableError(new Error('unexpected parser state at offset 18'), '保存失败'), '保存失败');
});

test('common HTTP statuses use Chinese messages', () => {
  assert.equal(userFacingErrorMessage(401, ''), '登录已失效，请重新登录');
  assert.equal(userFacingErrorMessage(403, ''), '没有操作权限');
  assert.equal(userFacingErrorMessage(429, ''), '操作太频繁，请稍后重试');
  assert.equal(userFacingErrorMessage(503, ''), '服务暂时不可用，请稍后重试');
});

test('binding validation reports the exact field in Chinese', () => {
  const pipe = new ZodValidationPipe(customerNodeCreateSchema);

  assert.throws(
    () => pipe.transform({
      serviceNodeId: 'node-1',
      expireAt: '',
      remoteControl: 'fully_managed',
      remoteAction: 'create',
      takeover: true
    }),
    (error) => {
      assert.ok(error instanceof BadRequestException);
      assert.deepEqual(error.getResponse(), {
        message: ['到期时间：日期格式无效，请重新选择'],
        error: 'Bad Request',
        statusCode: 400
      });
      return true;
    }
  );
});

test('binding validation accepts normalized ISO dates and omitted traffic limits', () => {
  const pipe = new ZodValidationPipe(customerNodeCreateSchema);
  const result = pipe.transform({
    serviceNodeId: 'node-1',
    expireAt: '2026-09-26T04:00:00.000Z',
    remoteControl: 'fully_managed',
    remoteAction: 'create',
    takeover: true
  }) as { expireAt: Date; trafficLimitGb?: number };

  assert.equal(result.expireAt.toISOString(), '2026-09-26T04:00:00.000Z');
  assert.equal(result.trafficLimitGb, undefined);
});
