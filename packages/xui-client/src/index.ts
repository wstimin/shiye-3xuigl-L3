export type XuiAuth =
  | { kind: 'token'; token: string }
  | { kind: 'password'; username: string; password: string };

export type XuiApiProfile = 'v3.6';

export type XuiPanelCapabilities = {
  apiProfile: XuiApiProfile;
  detectedVersion?: string;
  source: 'openapi';
  openApiVersion?: string;
};

export type XuiClientOptions = {
  baseUrl: string;
  basePath?: string;
  auth?: XuiAuth;
  apiProfile?: XuiApiProfile;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export type XuiRequestOptions = {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  headers?: Record<string, string>;
};

export type XuiFormRequestOptions = Omit<XuiRequestOptions, 'body'> & { body?: Record<string, unknown> };

export class XuiClientError extends Error {
  constructor(message: string, readonly status?: number, readonly payload?: unknown) {
    super(message);
  }
}

export class XuiClient {
  private readonly fetchImpl: typeof fetch;
  private sessionCookie = '';
  private csrfToken = '';

  constructor(private readonly options: XuiClientOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async request<T>(endpoint: string, options: XuiRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      ...this.authHeaders(),
      ...this.cookieHeaders(),
      ...this.csrfHeaders(),
      ...options.headers
    };

    const response = await this.fetchWithTimeout(endpoint, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const text = await response.text();
    this.rememberCookies(response.headers);
    const payload = text ? this.parse(text) : null;
    if (!response.ok) throw this.requestError(response.status, payload);
    return payload as T;
  }

  async formRequest<T>(endpoint: string, options: XuiFormRequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
      ...this.authHeaders(),
      ...this.cookieHeaders(),
      ...this.csrfHeaders(),
      ...options.headers
    };

    const response = await this.fetchWithTimeout(endpoint, {
      method: options.method || (options.body ? 'POST' : 'GET'),
      headers,
      body: options.body ? this.encodeForm(options.body) : undefined
    });

    const text = await response.text();
    this.rememberCookies(response.headers);
    const payload = text ? this.parse(text) : null;
    if (!response.ok) throw this.requestError(response.status, payload);
    return payload as T;
  }

  async login(body: { username: string; password: string }) {
    await this.refreshCsrfToken(false);
    const response = await this.request('/login', { method: 'POST', headers: this.csrfHeaders(), body });
    await this.refreshCsrfToken(true);
    return response;
  }

  listInbounds() {
    return this.request('/panel/api/inbounds/list');
  }

  inboundOptions() {
    return this.request('/panel/api/inbounds/options');
  }

  getInbound(id: number) {
    return this.request(`/panel/api/inbounds/get/${encodeURIComponent(String(id))}`);
  }

  getWebCertFiles() {
    return this.request('/panel/api/server/getWebCertFiles');
  }

  usesApiProfile(profile: XuiApiProfile) {
    return profile === 'v3.6';
  }

  getOpenApi() {
    return this.request('/panel/api/openapi.json');
  }

  async detectCapabilities(): Promise<XuiPanelCapabilities> {
    try {
      const payload = await this.getOpenApi();
      const document = this.openApiDocument(payload);
      const paths = this.objectValue(document.paths);
      const supportsV36 = [
        '/panel/api/clients/add',
        '/panel/api/clients/update/{email}',
        '/panel/api/clients/{email}/detach',
        '/panel/api/inbounds/{id}/resetTraffic'
      ].every((path) => path in paths);
      const info = this.objectValue(document.info);
      const rawVersion = typeof info.version === 'string' ? info.version.trim() : '';
      if (!supportsV36) {
        throw new XuiClientError('当前面板不支持 3x-ui 3.6 官方 API，请升级面板或删除后重新添加');
      }
      return {
        apiProfile: 'v3.6',
        detectedVersion: this.semanticVersion(rawVersion) || rawVersion || undefined,
        source: 'openapi',
        openApiVersion: typeof document.openapi === 'string' ? document.openapi : undefined
      };
    } catch (error) {
      if (error instanceof XuiClientError && (error.status === 404 || error.status === 405)) {
        throw new XuiClientError('当前面板不支持 3x-ui 3.6 官方 API，请升级面板或删除后重新添加', error.status, error.payload);
      }
      throw error;
    }
  }

  getNewX25519Cert() {
    return this.request('/panel/api/server/getNewX25519Cert');
  }

  scanRealityTarget(target: string) {
    return this.request('/panel/api/server/scanRealityTarget', { method: 'POST', body: { target } });
  }

  scanRealityTargets(targets?: string) {
    return this.request('/panel/api/server/scanRealityTargets', { method: 'POST', body: { targets: targets || '' } });
  }

  addInbound(body: unknown) {
    return this.request('/panel/api/inbounds/add', { method: 'POST', body: this.inboundJsonBody(body) });
  }

  updateInbound(id: number, body: unknown) {
    return this.request(`/panel/api/inbounds/update/${encodeURIComponent(String(id))}`, { method: 'POST', body: this.inboundJsonBody(body) });
  }

  deleteInbound(id: number) {
    return this.request(`/panel/api/inbounds/del/${encodeURIComponent(String(id))}`, { method: 'POST' });
  }

  setInboundEnable(id: number, enable: boolean) {
    return this.request(`/panel/api/inbounds/setEnable/${encodeURIComponent(String(id))}`, { method: 'POST', body: { enable } });
  }

  resetInboundTraffic(id: number) {
    return this.request(`/panel/api/inbounds/${encodeURIComponent(String(id))}/resetTraffic`, { method: 'POST' });
  }

  listClients() {
    return this.request('/panel/api/clients/list');
  }

  getClientDetails(email: string) {
    return this.request(`/panel/api/clients/get/${encodeURIComponent(email)}`);
  }

  async getClientRecord(email: string) {
    return this.responseClientObject(await this.getClientDetails(email));
  }

  addClient(inboundId: number, client: unknown) {
    return this.request('/panel/api/clients/add', {
      method: 'POST',
      body: { client: this.v36ClientPayload(client), inboundIds: [inboundId] }
    });
  }

  async updateClient(inboundId: number, clientId: string, client: unknown) {
    const email = this.clientEmail(client) || clientId;
    const current = await this.getClientRecord(clientId || email);
    return this.request(`/panel/api/clients/update/${encodeURIComponent(clientId || email)}`, {
      method: 'POST',
      body: this.v36ClientPayload(client, current)
    });
  }

  deleteClient(_inboundId: number, email: string, _clientId?: string, keepTraffic = false) {
    const query = keepTraffic ? '?keepTraffic=1' : '';
    return this.request(`/panel/api/clients/del/${encodeURIComponent(email)}${query}`, { method: 'POST' });
  }

  detachClient(inboundId: number, email: string) {
    return this.request(`/panel/api/clients/${encodeURIComponent(email)}/detach`, { method: 'POST', body: { inboundIds: [inboundId] } });
  }

  getClient(email: string) {
    return this.getClientTraffic(email);
  }

  resetClientTraffic(inboundId: number, email: string) {
    void inboundId;
    return this.request(`/panel/api/clients/resetTraffic/${encodeURIComponent(email)}`, { method: 'POST' });
  }

  resetTraffic(inboundId: number, email: string) {
    return this.resetClientTraffic(inboundId, email);
  }

  getClientTraffic(email: string) {
    return this.request(`/panel/api/clients/traffic/${encodeURIComponent(email)}`);
  }

  clientTraffic(email: string) {
    return this.getClientTraffic(email);
  }

  clientsLastOnline() {
    return this.request('/panel/api/clients/lastOnline', { method: 'POST' });
  }

  onlineClients() {
    return this.request('/panel/api/clients/onlines', { method: 'POST' });
  }

  clientLinks(email: string) {
    return this.request(`/panel/api/clients/links/${encodeURIComponent(email)}`);
  }

  subLinks(subId: string) {
    return this.request(`/panel/api/clients/subLinks/${encodeURIComponent(subId)}`);
  }

  getXrayConfig() {
    return this.request('/panel/api/xray/', { method: 'POST' });
  }

  listOutboundSubscriptions() {
    return this.request('/panel/api/xray/outbound-subs');
  }

  refreshOutboundSubscription(id: number | string) {
    return this.request(`/panel/api/xray/outbound-subs/${encodeURIComponent(String(id))}/refresh`, { method: 'POST' });
  }

  updateXrayConfig(body: { xraySetting: string; outboundTestUrl?: string }) {
    return this.formRequest('/panel/api/xray/update', { method: 'POST', body });
  }

  restartXrayService() {
    return this.request('/panel/api/server/restartXrayService', { method: 'POST' });
  }

  serverStatus() {
    return this.request('/panel/api/server/status');
  }

  getXrayVersion() {
    return this.request('/panel/api/server/getXrayVersion');
  }

  private url(endpoint: string) {
    const baseUrl = this.options.baseUrl.replace(/\/+$/, '');
    const basePath = this.options.basePath ? `/${this.options.basePath.replace(/^\/+|\/+$/g, '')}` : '';
    return `${baseUrl}${basePath}${endpoint.startsWith('/') ? endpoint : `/${endpoint}`}`;
  }

  private async fetchWithTimeout(endpoint: string, init: RequestInit) {
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(this.url(endpoint), { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) throw new XuiClientError(`3x-ui 请求超时（${timeoutMs}ms）：${endpoint}`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private authHeaders(): Record<string, string> {
    if (this.options.auth?.kind === 'token') return { Authorization: `Bearer ${this.options.auth.token}` };
    return {};
  }

  private async refreshCsrfToken(authenticated: boolean) {
    const endpoint = authenticated ? '/panel/csrf-token' : '/csrf-token';
    const payload = await this.request<unknown>(endpoint);
    const token = this.extractCsrfToken(payload);
    if (!token) throw new XuiClientError(`3x-ui did not return a CSRF token from ${endpoint}`, undefined, payload);
    this.csrfToken = token;
  }

  private csrfHeaders(): Record<string, string> {
    return this.csrfToken ? { 'X-CSRF-Token': this.csrfToken } : {};
  }

  private cookieHeaders(): Record<string, string> {
    return this.sessionCookie ? { Cookie: this.sessionCookie } : {};
  }

  private rememberCookies(headers: Headers) {
    const setCookies = this.readSetCookieHeaders(headers);
    if (!setCookies.length) return;

    const jar = new Map<string, string>();
    for (const part of this.sessionCookie.split(';')) {
      const [name, ...value] = part.trim().split('=');
      if (name && value.length) jar.set(name, value.join('='));
    }

    for (const cookie of setCookies) {
      const first = cookie.split(';')[0]?.trim();
      const [name, ...value] = (first || '').split('=');
      if (name && value.length) jar.set(name, value.join('='));
    }

    this.sessionCookie = Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
  }

  private encodeForm(body: Record<string, unknown>) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined) continue;
      params.append(key, value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));
    }
    return params.toString();
  }

  private formBody(body: unknown): Record<string, unknown> {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new XuiClientError('3x-ui form request body must be an object');
    }
    return body as Record<string, unknown>;
  }

  private inboundJsonBody(body: unknown): Record<string, unknown> {
    const source = this.formBody(body);
    const result: Record<string, unknown> = {};
    for (const key of [
      'id',
      'up',
      'down',
      'total',
      'allTime',
      'remark',
      'enable',
      'expiryTime',
      'trafficReset',
      'lastTrafficResetTime',
      'listen',
      'port',
      'protocol',
      'tag',
      'nodeId'
    ]) {
      if (source[key] !== undefined && source[key] !== null) result[key] = source[key];
    }
    for (const key of ['settings', 'streamSettings', 'sniffing']) {
      const value = source[key];
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') result[key] = value;
      else try {
          result[key] = JSON.parse(value) as unknown;
        } catch {
          throw new XuiClientError(`3x-ui v3.6 inbound field ${key} must contain valid JSON`);
        }
    }
    return result;
  }

  private clientEmail(client: unknown) {
    if (!client || typeof client !== 'object' || Array.isArray(client)) return '';
    const email = (client as Record<string, unknown>).email;
    return typeof email === 'string' ? email : '';
  }

  private v36ClientPayload(client: unknown, current: Record<string, unknown> = {}) {
    const requested = this.objectValue(client);
    const merged: Record<string, unknown> = { ...current, ...requested };
    const requestedId = typeof requested.id === 'string' ? requested.id.trim() : '';
    const currentId = typeof current.id === 'string' ? current.id.trim() : '';
    if (requestedId) merged.uuid = requestedId;
    else if (!merged.uuid && currentId) merged.uuid = currentId;

    const payload: Record<string, unknown> = {};
    for (const key of [
      'email',
      'uuid',
      'password',
      'auth',
      'security',
      'method',
      'flow',
      'limitIp',
      'totalGB',
      'expiryTime',
      'enable',
      'tgId',
      'subId',
      'reset',
      'reverse',
      'comment',
      'group_name'
    ]) {
      if (merged[key] !== undefined && merged[key] !== null) payload[key] = merged[key];
    }
    return payload;
  }

  private responseClientObject(payload: unknown) {
    const root = this.objectValue(payload);
    if (root.success === false) {
      throw new XuiClientError(String(root.msg || root.message || '3x-ui client lookup failed'), undefined, payload);
    }
    const candidate = root.obj ?? root.data ?? root.result ?? payload;
    const parsed = typeof candidate === 'string' ? this.objectValue(this.parse(candidate)) : this.objectValue(candidate);
    const nestedClient = this.objectValue(parsed.client);
    if (!Object.keys(nestedClient).length) return parsed;
    if (nestedClient.inboundIds !== undefined || parsed.inboundIds === undefined) return nestedClient;
    return { ...nestedClient, inboundIds: parsed.inboundIds };
  }

  private requestError(status: number, payload: unknown) {
    const object = this.objectValue(payload);
    const detail = String(object.msg || object.message || '').trim();
    const suffix = detail ? ` - ${detail}` : '';
    return new XuiClientError(`3x-ui request failed: ${status}${suffix}`, status, payload);
  }

  private openApiDocument(payload: unknown): Record<string, unknown> {
    const root = this.objectValue(payload);
    const candidate = root.obj ?? root.data ?? payload;
    if (typeof candidate === 'string') return this.objectValue(this.parse(candidate));
    return this.objectValue(candidate);
  }

  private objectValue(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private semanticVersion(value: string) {
    return value.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/)?.[0];
  }

  private extractCsrfToken(payload: unknown) {
    if (typeof payload === 'string') return payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';
    const record = payload as Record<string, unknown>;
    for (const key of ['obj', 'data', 'token', 'csrfToken']) {
      if (typeof record[key] === 'string' && record[key]) return record[key] as string;
    }
    return '';
  }

  private readSetCookieHeaders(headers: Headers): string[] {
    const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
    const cookies = withGetSetCookie.getSetCookie?.();
    if (cookies?.length) return cookies;
    const single = headers.get('set-cookie');
    return single ? [single] : [];
  }

  private parse(text: string) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
