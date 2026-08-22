type ApiOptions = Omit<RequestInit, 'body'> & { body?: unknown; timeoutMs?: number };

const sessionExpiredEvent = 'shiye:session-expired';
const transientStatuses = new Set([502, 503, 504]);
const activeReadRequests = new Set<AbortController>();
let readGeneration = 0;

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, timeoutMs = requestTimeout(path), signal, ...requestOptions } = options;
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const safeRead = method === 'GET' || method === 'HEAD';
  const maxRetries = safeRead ? 2 : 0;
  const generation = readGeneration;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (safeRead && generation !== readGeneration) throw new Error('请求已取消');
    const controller = new AbortController();
    const abortFromCaller = () => controller.abort(signal?.reason || 'caller');
    if (signal?.aborted) abortFromCaller();
    else signal?.addEventListener('abort', abortFromCaller, { once: true });
    if (safeRead) activeReadRequests.add(controller);
    const timer = window.setTimeout(() => controller.abort('timeout'), timeoutMs);

    try {
      const response = await fetch(path, {
        credentials: 'include',
        ...requestOptions,
        method,
        cache: safeRead ? 'no-store' : requestOptions.cache,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...requestOptions.headers
        },
        body: typeof body === 'string' || !body ? body as BodyInit | null | undefined : JSON.stringify(body)
      });
      const payload = await response.json().catch(() => null);
      if (response.status === 401 && shouldNotifySessionExpired(path)) window.dispatchEvent(new Event(sessionExpiredEvent));
      if (transientStatuses.has(response.status) && attempt < maxRetries) {
        await retryDelay(attempt, signal, generation, controller.signal);
        continue;
      }
      if (!response.ok || payload?.ok === false) throw new Error(responseErrorMessage(response.status, payload?.message));
      return payload?.data ?? payload;
    } catch (error) {
      const abortReason = controller.signal.aborted ? String(controller.signal.reason || '') : '';
      if (signal?.aborted || abortReason !== 'timeout' && controller.signal.aborted) throw new Error('请求已取消');
      const retryableFailure = safeRead && (abortReason === 'timeout' || error instanceof TypeError);
      if (retryableFailure && attempt < maxRetries) {
        await retryDelay(attempt, signal, generation, controller.signal);
        continue;
      }
      if (abortReason === 'timeout') throw new Error('请求超时');
      if (error instanceof TypeError) throw new Error('网络异常');
      throw error;
    } finally {
      window.clearTimeout(timer);
      activeReadRequests.delete(controller);
      signal?.removeEventListener('abort', abortFromCaller);
    }
  }

  throw new Error('网络异常');
}

export function cancelPendingReadRequests() {
  readGeneration += 1;
  for (const controller of activeReadRequests) controller.abort('navigation');
  activeReadRequests.clear();
}

export function onSessionExpired(handler: () => void) {
  window.addEventListener(sessionExpiredEvent, handler);
  return () => window.removeEventListener(sessionExpiredEvent, handler);
}

function retryDelay(attempt: number, callerSignal: AbortSignal | null | undefined, generation: number, requestSignal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const requestCancelled = requestSignal.aborted && requestSignal.reason !== 'timeout';
    if (callerSignal?.aborted || requestCancelled || generation !== readGeneration) return reject(new Error('请求已取消'));
    const timer = window.setTimeout(() => {
      cleanup();
      if (generation !== readGeneration) reject(new Error('请求已取消'));
      else resolve();
    }, attempt === 0 ? 220 : 650);
    const cancel = () => {
      window.clearTimeout(timer);
      cleanup();
      reject(new Error('请求已取消'));
    };
    const cleanup = () => {
      callerSignal?.removeEventListener('abort', cancel);
      requestSignal.removeEventListener('abort', cancel);
    };
    callerSignal?.addEventListener('abort', cancel, { once: true });
    if (!requestSignal.aborted) requestSignal.addEventListener('abort', cancel, { once: true });
  });
}

function requestTimeout(path: string) {
  return /\/(sync|test|certs|status|client-presence|diagnostics|renew)(?:[/?-]|$)/i.test(path) ? 60_000 : 15_000;
}

function shouldNotifySessionExpired(path: string) {
  return !/\/api\/(login|logout|auth\/me)(?:[/?]|$)/.test(path);
}

function responseErrorMessage(status: number, message: unknown) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (text && text.length <= 240 && /[\u3400-\u9fff]/.test(text)) return text;
  if (status === 401) return '登录已失效';
  if (status === 403) return '没有操作权限';
  if (status === 404) return '数据不存在';
  if (status === 409) return '操作冲突';
  if (status === 429) return '操作太频繁';
  if (status === 502 || status === 503 || status === 504) return '服务暂时不可用';
  if (status >= 500) return '服务异常';
  return '操作失败';
}
