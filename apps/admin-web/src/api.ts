import { createApiClient } from '../../web-shared/api-client';

export const { api, cancelPendingReadRequests, onSessionExpired } = createApiClient(responseErrorMessage);

function responseErrorMessage(status: number, message: unknown) {
  const text = Array.isArray(message)
    ? message.filter((item): item is string => typeof item === 'string').join('；')
    : typeof message === 'string'
      ? message
      : '';
  const normalized = text.replace(/\s+/g, ' ').trim().slice(0, 1500);
  if (normalized) return normalized;
  return `请求失败（HTTP ${status}）`;
}
