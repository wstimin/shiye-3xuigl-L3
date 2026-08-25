import test from 'node:test';
import assert from 'node:assert/strict';
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
