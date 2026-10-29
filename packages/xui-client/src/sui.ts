/** S-UI v1.6 external API: https://github.com/alireza0/s-ui/wiki/API-Documentation */
export const suiObjects = ['clients', 'inbounds', 'outbounds', 'endpoints', 'services', 'tls', 'config', 'settings'] as const;
export type SuiObject = typeof suiObjects[number];
export type SuiRecord = Record<string, unknown>;

export class SuiClient {
  private readonly base: string;
  constructor(private readonly options: { baseUrl: string; token: string; fetchImpl?: typeof fetch; timeoutMs?: number }) {
    const url = new URL(options.baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('面板地址须为不含账号、查询参数的 HTTP(S) 地址');
    }
    this.base = url.href.replace(/\/+$/, '').replace(/\/apiv2$/, '');
  }

  async request<T = SuiRecord>(endpoint: string, body?: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 30_000);
    try {
      const response = await (this.options.fetchImpl || fetch)(`${this.base}/apiv2/${endpoint}`, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: controller.signal,
        headers: { Token: this.options.token, ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) },
        body: body ? new URLSearchParams(Object.entries(body).map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : String(value)])) : undefined
      });
      const payload = await response.json().catch(() => null) as { success?: boolean; msg?: string; obj?: T } | null;
      if (!response.ok || payload?.success !== true) {
        const detail = String(payload?.msg || `HTTP ${response.status}，请检查面板地址和 Token`).split(this.options.token).join('[REDACTED]');
        throw new Error(`S-UI：${detail.slice(0, 500)}`);
      }
      return payload.obj as T;
    } catch (error) {
      if (controller.signal.aborted) throw new Error('S-UI 请求超时，请检查网络连接');
      throw error;
    } finally { clearTimeout(timer); }
  }

  read(object: SuiObject) { return this.request(object); }
  status() { return this.request('status?r=cpu,mem,net,sys,sbd'); }
  save(object: SuiObject, action: 'new' | 'edit' | 'del' | 'set', data: SuiRecord) {
    return this.request('save', { object, action, data: action === 'del' ? Number(data.id) : data });
  }
}
