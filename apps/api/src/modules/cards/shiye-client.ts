import { createHash, createHmac, randomBytes } from 'node:crypto';

export type ShiyeCardConfig = {
  baseUrl: string;
  appKey: string;
  appSecret: string;
};

export type ShiyeCardResult = {
  code: number;
  message: string;
  data?: { [key: string]: unknown } | null;
};

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

/**
 * 十夜卡密系统客户端
 * 签名算法（对接文档第 3 章）:
 *   bodyHash = sha256( 实际发送的原始请求体 utf8 )
 *   sign     = HMAC_SHA256( app_secret, app_key + "\n" + timestamp + "\n" + nonce + "\n" + bodyHash )
 * 业务结果一律看返回中的 code === 0（业务错误也是 HTTP 200）。
 */
export class ShiyeCardClient {
  private readonly baseUrl: string;

  constructor(private readonly config: ShiyeCardConfig) {
    this.baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
  }

  /** 连通性探测，无需签名 */
  async status(): Promise<ShiyeCardResult> {
    return this.request('GET', '/api/v1/status');
  }

  /** 验卡（不改状态） */
  async verify(card: string): Promise<ShiyeCardResult> {
    return this.request('POST', '/api/v1/card/verify', { card });
  }

  /** 激活并归属本项目（一卡一次，兑换入口） */
  async activate(card: string): Promise<ShiyeCardResult> {
    return this.request('POST', '/api/v1/card/activate', { card });
  }

  private async request(method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<ShiyeCardResult> {
    // 先拼好最终要发送的 JSON 字符串，对同一字符串做 hash 再原样发送，避免重新序列化导致签名不一致
    const raw = body === undefined ? '' : JSON.stringify(body);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await sleep(300 * attempt);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (body !== undefined) {
          const timestamp = Math.floor(Date.now() / 1000).toString();
          const nonce = randomBytes(12).toString('hex');
          const bodyHash = createHash('sha256').update(raw, 'utf8').digest('hex');
          headers['X-App-Key'] = this.config.appKey;
          headers['X-Timestamp'] = timestamp;
          headers['X-Nonce'] = nonce;
          headers['X-Sign'] = createHmac('sha256', this.config.appSecret)
            .update(`${this.config.appKey}\n${timestamp}\n${nonce}\n${bodyHash}`, 'utf8')
            .digest('hex');
        }
        const response = await fetch(`${this.baseUrl}${path}`, {
          method,
          headers,
          body: body === undefined ? undefined : raw,
          signal: controller.signal
        });
        if (response.status >= 500) {
          if (attempt + 1 < MAX_ATTEMPTS) continue;
          return { code: response.status, message: `卡密服务异常（HTTP ${response.status}）` };
        }
        const payload = await response.json().catch(() => null) as ShiyeCardResult | null;
        if (!payload || typeof payload.code !== 'number') {
          if (attempt + 1 < MAX_ATTEMPTS) continue;
          return { code: -1, message: '卡密服务返回格式异常' };
        }
        return payload;
      } catch {
        const aborted = controller.signal.aborted;
        if (attempt + 1 >= MAX_ATTEMPTS) {
          return {
            code: -1,
            message: aborted ? '连接卡密服务超时' : '无法连接卡密服务，请检查服务器地址与网络'
          };
        }
      } finally {
        clearTimeout(timer);
      }
    }
    return { code: -1, message: '无法连接卡密服务' };
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}