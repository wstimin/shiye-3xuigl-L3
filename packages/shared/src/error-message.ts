const chineseTextPattern = /[\u3400-\u9fff]/;

const translatedPatterns: Array<[RegExp, string]> = [
  [/invalid credentials|incorrect (?:username|password)|wrong password|login failed/i, '账号或密码错误'],
  [/unauthorized|authentication (?:failed|required)|invalid token|token expired/i, '身份验证失败，请重新登录'],
  [/forbidden|permission denied|access denied/i, '没有操作权限'],
  [/client .*not found|remote .*client .*not found/i, '远端客户端不存在'],
  [/inbound .*not found|remote .*inbound .*not found/i, '远端入站不存在'],
  [/not found|does not exist|missing resource/i, '请求的数据不存在'],
  [/already exists|duplicate|unique constraint|conflict/i, '数据已存在或发生冲突'],
  [/certificate|cert file|key file|tls/i, '证书配置无效或无法读取'],
  [/timeout|timed out/i, '请求超时，请稍后重试'],
  [/network|fetch failed|econnrefused|connection refused|socket hang up/i, '无法连接服务，请检查网络或服务状态'],
  [/\bvalidation\b|\binvalid\b|\brequired\b|\bmust be\b|\bshould be\b|\bexpected\b|\bbad request\b/i, '提交的信息不符合要求，请检查后重试'],
  [/3x-ui|xui/i, '3x-ui 面板操作失败，请检查连接配置'],
  [/service unavailable|bad gateway|gateway timeout/i, '服务暂时不可用，请稍后重试']
];

export function userFacingErrorMessage(status: number, message: unknown, fallback = '操作失败') {
  const text = normalizeMessage(message);
  if (text && chineseTextPattern.test(text)) return text;

  if (text) {
    const translated = translatedPatterns.find(([pattern]) => pattern.test(text));
    if (translated) return preserveRemoteDetail(text, translated[1]);
  }

  if (status === 400 || status === 422) return fallback === '操作失败' ? '提交的信息不符合要求' : fallback;
  if (status === 401) return '登录已失效，请重新登录';
  if (status === 403) return '没有操作权限';
  if (status === 404) return '请求的数据不存在';
  if (status === 409) return '数据已存在或发生冲突';
  if (status === 429) return '操作太频繁，请稍后重试';
  if (status === 502 || status === 503 || status === 504) return '服务暂时不可用，请稍后重试';
  if (status >= 500) return '服务异常，请稍后重试';
  return fallback;
}

function preserveRemoteDetail(text: string, translated: string) {
  if (!/3x-ui|xui|official panel|panel\/api|request failed/i.test(text)) return translated;
  const detail = text.replace(/^3x-ui request failed:\s*\d+\s*-?\s*/i, '').trim();
  if (!detail || detail === text && /^3x-ui|^xui/i.test(text)) return translated;
  return `${translated}（官方面板返回：${detail}）`;
}

export function readableError(error: unknown, fallback = '操作失败') {
  if (error instanceof Error) return userFacingErrorMessage(0, error.message, fallback);
  return userFacingErrorMessage(0, error, fallback);
}

function normalizeMessage(message: unknown) {
  const text = Array.isArray(message)
    ? message.filter((item): item is string => typeof item === 'string').join('；')
    : typeof message === 'string'
      ? message
      : '';
  return text.replace(/\s+/g, ' ').trim().slice(0, 1000);
}
