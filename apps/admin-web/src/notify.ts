import { readableError } from '@shiye/shared';
import { ElMessage } from 'element-plus';

let lastError = '';
let lastErrorAt = 0;

export function notifyError(error: unknown, fallback = '操作失败') {
  const message = readableError(error, fallback);
  const now = Date.now();
  if (message === lastError && now - lastErrorAt < 1200) return;
  lastError = message;
  lastErrorAt = now;
  ElMessage.error({
    message,
    duration: 8000,
    showClose: true,
    grouping: true,
    customClass: 'admin-error-message'
  });
}
