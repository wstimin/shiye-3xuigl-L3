import { createPrivateKey, createPublicKey } from 'node:crypto';
import { xuiObject, stringValue, parseMaybeJson, hostFromUrl, positiveInteger, stringList, normalizeBase64 } from './xui-values.js';

export function buildLocalShareLink(
  protocol: string,
  host: string,
  port: number,
  displayName: string,
  inboundSettings: Record<string, unknown>,
  streamSettings: Record<string, unknown>,
  remoteClient: Record<string, unknown>
) {
  const name = displayName.trim() || '3x-ui';
  if (protocol === 'vless') return vlessShareLink(host, port, name, inboundSettings, streamSettings, remoteClient);
  if (protocol === 'vmess') return vmessShareLink(host, port, name, streamSettings, remoteClient);
  if (protocol === 'trojan') return trojanShareLink(host, port, name, streamSettings, remoteClient);
  if (protocol === 'shadowsocks') return shadowsocksShareLink(host, port, name, inboundSettings, remoteClient, streamSettings);
  if (protocol === 'hysteria' || protocol === 'hysteria2') return hysteriaShareLink(protocol, host, port, name, inboundSettings, streamSettings, remoteClient);
  throw new Error(`Protocol ${protocol} does not have a standard client share link`);
}

function vlessShareLink(host: string, port: number, name: string, inboundSettings: Record<string, unknown>, streamSettings: Record<string, unknown>, client: Record<string, unknown>) {
  const id = stringValue(client.id) || stringValue(client.uuid);
  if (!id) throw new Error('VLESS client UUID is missing');
  const query = shareQuery(streamSettings);
  query.set('encryption', stringValue(inboundSettings.encryption) || 'none');
  const flow = stringValue(client.flow);
  if (flow && shareTransport(streamSettings).network === 'tcp' && ['tls', 'reality'].includes(String(streamSettings.security || 'none'))) query.set('flow', flow);
  return `vless://${encodeURIComponent(id)}@${host}:${port}?${query.toString()}#${encodeURIComponent(name)}`;
}

function vmessShareLink(host: string, port: number, name: string, streamSettings: Record<string, unknown>, client: Record<string, unknown>) {
  const id = stringValue(client.id) || stringValue(client.uuid);
  if (!id) throw new Error('VMess client UUID is missing');
  const security = String(streamSettings.security || 'none').toLowerCase();
  if (security === 'reality') throw new Error('VMess over Reality has no interoperable standard share-link format');
  const transport = shareTransport(streamSettings);
  const tls = shareTls(streamSettings);
  const config: Record<string, string> = {
    v: '2',
    ps: name,
    add: unbracketHost(host),
    port: String(port),
    id,
    aid: String(client.alterId ?? client.alterID ?? 0),
    scy: stringValue(client.security) || 'auto',
    net: transport.network,
    type: transport.network === 'grpc' ? transport.mode || 'none' : transport.headerType || 'none',
    host: transport.host || '',
    path: transport.path || '',
    tls: security === 'tls' ? 'tls' : '',
    sni: tls.serverName || '',
    alpn: tls.alpn || '',
    fp: tls.fingerprint || ''
  };
  if (transport.authority) config.authority = transport.authority;
  if (transport.mode) config.mode = transport.mode;
  if (transport.seed) config.path = transport.seed;
  if (transport.mtu) config.mtu = transport.mtu;
  if (transport.tti) config.tti = transport.tti;
  applyShareExtras(config, streamSettings, true);
  return `vmess://${Buffer.from(JSON.stringify(config), 'utf8').toString('base64')}`;
}

function trojanShareLink(host: string, port: number, name: string, streamSettings: Record<string, unknown>, client: Record<string, unknown>) {
  const password = stringValue(client.password);
  if (!password) throw new Error('Trojan client password is missing');
  const query = shareQuery(streamSettings);
  const flow = stringValue(client.flow);
  if (flow && shareTransport(streamSettings).network === 'tcp' && String(streamSettings.security || '') === 'reality') query.set('flow', flow);
  return `trojan://${encodeURIComponent(password)}@${host}:${port}?${query.toString()}#${encodeURIComponent(name)}`;
}

function shadowsocksShareLink(host: string, port: number, name: string, inboundSettings: Record<string, unknown>, client: Record<string, unknown>, streamSettings?: Record<string, unknown>) {
  const method = stringValue(client.method) || stringValue(inboundSettings.method);
  const clientPassword = stringValue(client.password);
  const inboundPassword = stringValue(inboundSettings.password);
  if (!method || !clientPassword) throw new Error('Shadowsocks method or client password is missing');
  const password = method.startsWith('2022-') && inboundPassword ? `${inboundPassword}:${clientPassword}` : clientPassword;
  const credential = Buffer.from(`${method}:${password}`, 'utf8').toString('base64');
  const query = streamSettings ? shareQuery(streamSettings) : new URLSearchParams();
  return `ss://${credential}@${host}:${port}${query.size ? `?${query.toString()}` : ''}#${encodeURIComponent(name)}`;
}

function hysteriaShareLink(
  protocol: string,
  host: string,
  port: number,
  name: string,
  inboundSettings: Record<string, unknown>,
  streamSettings: Record<string, unknown>,
  client: Record<string, unknown>
) {
  const auth = stringValue(client.auth) || stringValue(client.password);
  if (!auth) throw new Error('Hysteria client authentication value is missing');
  const version = String(inboundSettings.version || '').toLowerCase();
  const isV2 = protocol === 'hysteria2' || !['1', 'v1', 'hysteria'].includes(version);
  const tls = shareTls(streamSettings);
  const query = new URLSearchParams();
  query.set('security', 'tls');
  if (tls.serverName) query.set('sni', tls.serverName);
  if (tls.fingerprint) query.set('fp', tls.fingerprint);
  if (tls.alpn) query.set('alpn', tls.alpn);
  if (tls.insecure) query.set('insecure', '1');
  const salamander = salamanderPassword(streamSettings);
  if (salamander) {
    query.set('obfs', 'salamander');
    query.set('obfs-password', salamander);
  }
  applyShareExtras(query, streamSettings, false);
  return `${isV2 ? 'hysteria2' : 'hysteria'}://${encodeURIComponent(auth)}@${host}:${port}?${query.toString()}#${encodeURIComponent(name)}`;
}

function shareQuery(streamSettings: Record<string, unknown>) {
  const transport = shareTransport(streamSettings);
  const tls = shareTls(streamSettings);
  const query = new URLSearchParams();
  query.set('type', transport.network);
  if (transport.headerType && transport.headerType !== 'none') query.set('headerType', transport.headerType);
  if (transport.host) query.set('host', transport.host);
  if (transport.path) query.set('path', transport.path);
  if (transport.serviceName) query.set('serviceName', transport.serviceName);
  if (transport.authority) query.set('authority', transport.authority);
  if (transport.mode) query.set('mode', transport.mode);
  if (transport.seed) query.set('seed', transport.seed);
  if (transport.quicSecurity) query.set('quicSecurity', transport.quicSecurity);
  if (transport.key) query.set('key', transport.key);
  if (transport.mtu) query.set('mtu', transport.mtu);
  if (transport.tti) query.set('tti', transport.tti);
  query.set('security', tls.security);
  if (tls.serverName) query.set('sni', tls.serverName);
  if (tls.fingerprint) query.set('fp', tls.fingerprint);
  if (tls.alpn) query.set('alpn', tls.alpn);
  if (tls.publicKey) query.set('pbk', tls.publicKey);
  if (tls.shortId) query.set('sid', tls.shortId);
  if (tls.mldsa65Verify) query.set('pqv', tls.mldsa65Verify);
  if (tls.spiderX) query.set('spx', tls.spiderX);
  if (tls.insecure) query.set('allowInsecure', '1');
  applyShareExtras(query, streamSettings, false);
  return query;
}

export function shareTransport(streamSettings: Record<string, unknown>) {
  const rawNetwork = String(streamSettings.network || 'tcp').trim().toLowerCase();
  const network = rawNetwork === 'raw' ? 'tcp' : rawNetwork === 'splithttp' ? 'xhttp' : rawNetwork;
  const result: { network: string; headerType?: string; host?: string; path?: string; serviceName?: string; authority?: string; mode?: string; seed?: string; quicSecurity?: string; key?: string; mtu?: string; tti?: string } = { network };
  if (network === 'tcp') {
    const settings = xuiObject(streamSettings.tcpSettings || streamSettings.rawSettings);
    const header = xuiObject(settings.header);
    result.headerType = stringValue(header.type) || 'none';
    const request = xuiObject(header.request);
    result.host = firstHeaderValue(xuiObject(request.headers).Host);
    result.path = stringList(request.path)[0];
  } else if (network === 'ws') {
    const settings = xuiObject(streamSettings.wsSettings);
    result.path = stringValue(settings.path) || '/';
    result.host = stringValue(settings.host) || firstHeaderValue(xuiObject(settings.headers).Host);
  } else if (network === 'grpc') {
    const settings = xuiObject(streamSettings.grpcSettings);
    result.serviceName = stringValue(settings.serviceName);
    result.path = result.serviceName;
    result.authority = stringValue(settings.authority);
    result.mode = settings.multiMode === true ? 'multi' : undefined;
  } else if (network === 'httpupgrade') {
    const settings = xuiObject(streamSettings.httpupgradeSettings);
    result.path = stringValue(settings.path) || '/';
    result.host = stringValue(settings.host) || firstHeaderValue(xuiObject(settings.headers).Host);
  } else if (network === 'xhttp') {
    const settings = xuiObject(streamSettings.xhttpSettings || streamSettings.splithttpSettings);
    result.path = stringValue(settings.path) || '/';
    result.host = stringValue(settings.host) || firstHeaderValue(xuiObject(settings.headers).Host);
    result.mode = stringValue(settings.mode);
  } else if (network === 'http' || network === 'h2') {
    const settings = xuiObject(streamSettings.httpSettings);
    result.network = 'http';
    result.path = stringValue(settings.path) || '/';
    result.host = stringList(settings.host)[0];
  } else if (network === 'kcp') {
    const settings = xuiObject(streamSettings.kcpSettings);
    result.headerType = stringValue(xuiObject(settings.header).type) || 'none';
    result.seed = stringValue(settings.seed);
    result.mtu = numberString(settings.mtu);
    result.tti = numberString(settings.tti);
    const finalmask = xuiObject(streamSettings.finalmask);
    const masks = Array.isArray(finalmask.udp) ? finalmask.udp : [];
    const headerTypes: Record<string, string> = {
      'header-dns': 'dns',
      'header-dtls': 'dtls',
      'header-srtp': 'srtp',
      'header-utp': 'utp',
      'header-wechat': 'wechat-video',
      'header-wireguard': 'wireguard'
    };
    for (const item of masks) {
      const mask = xuiObject(item);
      const maskType = String(mask.type || '').toLowerCase();
      if (headerTypes[maskType]) result.headerType = headerTypes[maskType];
      if (maskType === 'mkcp-original') result.seed = undefined;
      if (maskType === 'mkcp-aes128gcm') result.seed = stringValue(xuiObject(mask.settings).password);
    }
  } else if (network === 'quic') {
    const settings = xuiObject(streamSettings.quicSettings);
    result.headerType = stringValue(xuiObject(settings.header).type) || 'none';
    result.quicSecurity = stringValue(settings.security) || 'none';
    result.key = stringValue(settings.key);
  }
  return result;
}

function shareTls(streamSettings: Record<string, unknown>) {
  const security = String(streamSettings.security || 'none').trim().toLowerCase() || 'none';
  if (security === 'reality') {
    const reality = xuiObject(streamSettings.realitySettings);
    const nested = xuiObject(reality.settings);
    const privateKey = stringValue(reality.privateKey) || stringValue(nested.privateKey);
    const publicKey = stringValue(reality.publicKey) || stringValue(nested.publicKey) || (privateKey ? x25519PublicKey(privateKey) : undefined);
    const serverName = stringValue(reality.serverName) || stringValue(nested.serverName) || stringList(reality.serverNames)[0] || stringList(nested.serverNames)[0];
    if (!publicKey || !serverName) throw new Error('Reality 配置缺少公钥或 SNI');
    return {
      security,
      serverName,
      fingerprint: stringValue(reality.fingerprint) || stringValue(nested.fingerprint) || 'chrome',
      alpn: stringList(reality.alpn).join(','),
      publicKey,
      shortId: stringValue(nested.shortId) || stringList(reality.shortIds)[0] || stringList(nested.shortIds)[0],
      mldsa65Verify: stringValue(nested.mldsa65Verify) || stringValue(reality.mldsa65Verify),
      spiderX: stringValue(reality.spiderX) || stringValue(nested.spiderX) || '/',
      insecure: false
    };
  }
  const tls = xuiObject(streamSettings.tlsSettings);
  const nested = xuiObject(tls.settings);
  if (security !== 'tls') {
    return {
      security: 'none',
      serverName: undefined,
      fingerprint: undefined,
      alpn: undefined,
      publicKey: undefined,
      shortId: undefined,
      mldsa65Verify: undefined,
      spiderX: undefined,
      insecure: false
    };
  }
  return {
    security: 'tls',
    serverName: stringValue(tls.serverName) || stringValue(nested.serverName),
    fingerprint: stringValue(nested.fingerprint) || stringValue(tls.fingerprint),
    alpn: stringList(tls.alpn).join(','),
    publicKey: undefined,
    shortId: undefined,
    mldsa65Verify: undefined,
    spiderX: undefined,
    insecure: nested.allowInsecure === true || tls.allowInsecure === true || tls.insecure === true
  };
}

function x25519PublicKey(privateKey: string) {
  try {
    const raw = Buffer.from(normalizeBase64(privateKey), 'base64');
    if (raw.length !== 32) return undefined;
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
    const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' });
    return Buffer.from(publicDer).subarray(-32).toString('base64url');
  } catch {
    return undefined;
  }
}

export function shareLinkEndpoints(protocol: string, host: string, port: number, name: string, streamSettings: Record<string, unknown>): Array<{ host: string; port: number; name: string; streamSettings: Record<string, unknown> }> {
  const externalProxies = Array.isArray(streamSettings.externalProxy) ? streamSettings.externalProxy : [];
  const endpoints = externalProxies.flatMap((item) => {
    const proxy = xuiObject(item);
    const rawHost = stringValue(proxy.dest);
    const proxyPort = positiveInteger(proxy.port);
    if (!rawHost || !proxyPort) return [];
    const parsedHost = hostFromShareAddress(rawHost);
    if (!parsedHost) return [];
    const unbracketed = unbracketHost(parsedHost);
    const endpointHost = unbracketed.includes(':') ? `[${unbracketed}]` : unbracketed;
    const forceTls = String(proxy.forceTls || 'same').trim().toLowerCase();
    const endpointStream = !['hysteria', 'hysteria2'].includes(protocol) && forceTls && forceTls !== 'same'
      ? { ...streamSettings, security: forceTls }
      : streamSettings;
    const extraRemark = stringValue(proxy.remark);
    return [{
      host: endpointHost,
      port: proxyPort,
      name: extraRemark ? `${name} - ${extraRemark}` : name,
      streamSettings: endpointStream
    }];
  });
  return endpoints.length ? endpoints : [{ host, port, name, streamSettings }];
}

function applyShareExtras(target: Record<string, string> | URLSearchParams, streamSettings: Record<string, unknown>, vmess: boolean) {
  const set = (key: string, value: string) => {
    if (!value) return;
    if (target instanceof URLSearchParams) target.set(key, value);
    else target[key] = value;
  };

  const finalmask = xuiObject(streamSettings.finalmask);
  const hasFinalmask = (Array.isArray(finalmask.tcp) && finalmask.tcp.length > 0) ||
    (Array.isArray(finalmask.udp) && finalmask.udp.length > 0) ||
    Object.keys(xuiObject(finalmask.quicParams)).length > 0;
  if (hasFinalmask) set('fm', JSON.stringify(finalmask));

  const transport = shareTransport(streamSettings);
  if (transport.network !== 'xhttp') return;
  const xhttp = xuiObject(streamSettings.xhttpSettings || streamSettings.splithttpSettings);
  const xPaddingBytes = stringValue(xhttp.xPaddingBytes);
  if (xPaddingBytes) set('x_padding_bytes', xPaddingBytes);

  const extra: Record<string, unknown> = {};
  for (const key of ['xPaddingBytes', 'sessionPlacement', 'sessionKey', 'seqPlacement', 'seqKey', 'uplinkDataPlacement', 'uplinkDataKey', 'scMaxEachPostBytes']) {
    const value = stringValue(xhttp[key]);
    if (value) extra[key] = value;
  }
  if (xhttp.xPaddingObfsMode === true) {
    extra.xPaddingObfsMode = true;
    for (const key of ['xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod']) {
      const value = stringValue(xhttp[key]);
      if (value) extra[key] = value;
    }
  }
  const headers = xuiObject(xhttp.headers);
  const clientHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'host'));
  if (Object.keys(clientHeaders).length) extra.headers = clientHeaders;
  if (Object.keys(extra).length) {
    if (vmess && !(target instanceof URLSearchParams)) Object.assign(target, extra);
    else set('extra', JSON.stringify(extra));
  }
}

function salamanderPassword(streamSettings: Record<string, unknown>) {
  const finalmask = xuiObject(streamSettings.finalmask);
  const masks = Array.isArray(finalmask.udp) ? finalmask.udp : [];
  for (const item of masks) {
    const mask = xuiObject(item);
    if (String(mask.type || '').toLowerCase() !== 'salamander') continue;
    const password = stringValue(xuiObject(mask.settings).password);
    if (password) return password;
  }
  return undefined;
}

function numberString(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? String(number) : undefined;
}

export function shareLinkHost(server: { baseUrl: string; config?: unknown }, inbound?: Record<string, unknown>) {
  const config = xuiObject(server.config);
  const configured = stringValue(config.shareHost);
  const listen = stringValue(inbound?.listen);
  const usableListen = listen && !['0.0.0.0', '::', '::0'].includes(listen) ? listen : undefined;
  const rawHost = configured
    ? hostFromShareAddress(configured)
    : usableListen
      ? hostFromShareAddress(usableListen)
      : hostFromUrl(server.baseUrl);
  if (!rawHost) return '';
  const host = unbracketHost(rawHost);
  return host.includes(':') ? `[${host}]` : host;
}

function hostFromShareAddress(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return hostFromUrl(trimmed);
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  const withoutPath = trimmed.split('/')[0] || '';
  return /^.+:\d+$/.test(withoutPath) && withoutPath.split(':').length === 2 ? withoutPath.replace(/:\d+$/, '') : withoutPath;
}

function unbracketHost(host: string) {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function firstHeaderValue(value: unknown) {
  if (Array.isArray(value)) return stringValue(value[0]);
  return stringValue(value);
}
