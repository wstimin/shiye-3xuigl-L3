import { readableError } from '@shiye/shared';

export type NotifyType = 'success' | 'error' | 'info' | 'warning';

export type NotifyPayload = {
  type: NotifyType;
  title?: string;
  message: string;
};

const notifyEventName = 'shiye:user-notify';
let lastError = '';
let lastErrorAt = 0;

export function notify(payload: NotifyPayload) {
  window.dispatchEvent(new CustomEvent<NotifyPayload>(notifyEventName, { detail: payload }));
}

export function notifySuccess(message: string, title = '操作成功') {
  notify({ type: 'success', title, message });
}

export function notifyError(error: unknown, fallback = '操作失败', title = '操作失败') {
  const message = readableError(error, fallback);
  const now = Date.now();
  if (message === lastError && now - lastErrorAt < 1200) return;
  lastError = message;
  lastErrorAt = now;
  notify({ type: 'error', title, message });
}

export function notifyInfo(message: string, title = '提示') {
  notify({ type: 'info', title, message });
}

export function notifyWarning(message: string, title = '请注意') {
  notify({ type: 'warning', title, message });
}

export function onNotify(handler: (payload: NotifyPayload) => void) {
  const listener = (event: Event) => handler((event as CustomEvent<NotifyPayload>).detail);
  window.addEventListener(notifyEventName, listener);
  return () => window.removeEventListener(notifyEventName, listener);
}
