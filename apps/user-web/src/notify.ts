export type NotifyType = 'success' | 'error' | 'info' | 'warning';

export type NotifyPayload = {
  type: NotifyType;
  title?: string;
  message: string;
};

const notifyEventName = 'shiye:user-notify';

export function notify(payload: NotifyPayload) {
  window.dispatchEvent(new CustomEvent<NotifyPayload>(notifyEventName, { detail: payload }));
}

export function notifySuccess(message: string, title = '操作成功') {
  notify({ type: 'success', title, message });
}

export function notifyError(message: string, title = '操作失败') {
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
