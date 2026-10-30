import test from 'node:test';
import assert from 'node:assert/strict';
import { api, cancelPendingReadRequests } from '../apps/admin-web/src/api.js';

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as typeof globalThis & { window?: Window }).window;

function installWindow() {
  const target = new EventTarget() as EventTarget & Pick<Window, 'setTimeout' | 'clearTimeout'>;
  target.setTimeout = setTimeout as unknown as Window['setTimeout'];
  target.clearTimeout = clearTimeout as unknown as Window['clearTimeout'];
  (globalThis as typeof globalThis & { window: typeof target }).window = target;
}

function jsonResponse(status: number, payload: unknown) {
  return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
}

test.beforeEach(() => {
  installWindow();
  cancelPendingReadRequests();
});

test.after(() => {
  globalThis.fetch = originalFetch;
  if (originalWindow) (globalThis as typeof globalThis & { window: Window }).window = originalWindow;
  else delete (globalThis as typeof globalThis & { window?: Window }).window;
});

test('safe GET requests recover from a transient 503 response', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return calls === 1 ? jsonResponse(503, { ok: false }) : jsonResponse(200, { ok: true, data: { ready: true } });
  };
  const result = await api<{ ready: boolean }>('/api/admin/overview');
  assert.deepEqual(result, { ready: true });
  assert.equal(calls, 2);
});

test('safe GET requests retry after a timeout', async () => {
  let calls = 0;
  globalThis.fetch = (_input, init) => {
    calls += 1;
    if (calls > 1) return Promise.resolve(jsonResponse(200, { ok: true, data: { ready: true } }));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    });
  };
  const result = await api<{ ready: boolean }>('/api/admin/overview', { timeoutMs: 5 });
  assert.deepEqual(result, { ready: true });
  assert.equal(calls, 2);
});

test('write requests are never replayed after a network failure', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    throw new TypeError('offline');
  };
  await assert.rejects(() => api('/api/admin/customers', { method: 'POST', body: { name: '测试' } }), /网络异常/);
  assert.equal(calls, 1);
});

test('API errors preserve the backend message until the notification layer', async () => {
  globalThis.fetch = async () => jsonResponse(502, {
    ok: false,
    message: '创建官方客户端失败：提交字段不符合官方接口要求（官方面板返回：body.client.email: value is not a valid email address）'
  });

  await assert.rejects(
    () => api('/api/admin/customers/customer-1/nodes', { method: 'POST', body: {} }),
    /body\.client\.email: value is not a valid email address/
  );
});

test('route changes cancel pending page reads', async () => {
  globalThis.fetch = (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
  const pending = api('/api/admin/overview');
  cancelPendingReadRequests();
  await assert.rejects(() => pending, /请求已取消/);
});

test('concurrent identical reads share one fetch without caching later reads', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse(200, { ok: true, data: { balance: calls } }); };
  const [first, second] = await Promise.all([api('/api/user/me'), api('/api/user/me')]);
  assert.deepEqual(first, second);
  assert.equal(calls, 1);
  await api('/api/user/me');
  assert.equal(calls, 2);
});

test('read cancellation discards shared promises and explicit caller signals stay independent', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse(200, { ok: true, data: calls }); };
  await Promise.all([api('/api/user/me', { signal: new AbortController().signal }), api('/api/user/me')]);
  assert.equal(calls, 2);
  cancelPendingReadRequests();
  await api('/api/user/me');
  assert.equal(calls, 3);
});

test('a write prevents reuse of an older in-flight read', async () => {
  let reads = 0, resolveOld!: (value: Response) => void;
  globalThis.fetch = async (_path, options) => {
    if (options?.method === 'POST') return jsonResponse(200, { ok: true });
    reads++;
    if (reads === 1) return new Promise(resolve => { resolveOld = resolve; });
    return jsonResponse(200, { ok: true, data: { balance: 20 } });
  };
  const old = api('/api/user/me');
  await api('/api/user/redeem-card', { method: 'POST', body: { code: 'test' } });
  assert.deepEqual(await api('/api/user/me'), { balance: 20 });
  assert.equal(reads, 2);
  resolveOld(jsonResponse(200, { ok: true, data: { balance: 10 } }));
  await old;
});
