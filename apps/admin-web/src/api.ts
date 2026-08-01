type ApiOptions = Omit<RequestInit, 'body'> & { body?: unknown; timeoutMs?: number };

const sessionExpiredEvent = 'shiye:session-expired';

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const { body, timeoutMs = requestTimeout(path), signal, ...requestOptions } = options;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timer = window.setTimeout(() => controller.abort('timeout'), timeoutMs);
  try {
    const response = await fetch(path, {
      credentials: 'include',
      ...requestOptions,
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        ...requestOptions.headers
      },
      body: typeof body === 'string' || !body ? body as BodyInit | null | undefined : JSON.stringify(body)
    });
    const payload = await response.json().catch(() => null);
    if (response.status === 401 && shouldNotifySessionExpired(path)) window.dispatchEvent(new Event(sessionExpiredEvent));
    if (!response.ok || payload?.ok === false) throw new Error(responseErrorMessage(response.status, payload?.message));
    return payload?.data ?? payload;
  } catch (error) {
    if (controller.signal.aborted) throw new Error(signal?.aborted ? '请求已取消' : '请求超时');
    if (error instanceof TypeError) throw new Error('网络异常');
    throw error;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}

export function onSessionExpired(handler: () => void) {
  window.addEventListener(sessionExpiredEvent, handler);
  return () => window.removeEventListener(sessionExpiredEvent, handler);
}

function requestTimeout(path: string) {
  return /\/(sync|test|certs|status|client-presence|diagnostics|renew)(?:[/?-]|$)/i.test(path) ? 60_000 : 15_000;
}

function shouldNotifySessionExpired(path: string) {
  return !/\/api\/(login|logout|auth\/me)(?:[/?]|$)/.test(path);
}

function responseErrorMessage(status: number, message: unknown) {
  const text = typeof message === 'string' ? message.trim() : '';
  if (text && text.length <= 24 && /[\u3400-\u9fff]/.test(text)) return text;
  if (status === 401) return '登录已失效';
  if (status === 403) return '没有操作权限';
  if (status === 404) return '数据不存在';
  if (status === 409) return '操作冲突';
  if (status === 429) return '操作太频繁';
  if (status === 502 || status === 504) return '远端连接失败';
  if (status >= 500) return '服务异常';
  return '操作失败';
}
