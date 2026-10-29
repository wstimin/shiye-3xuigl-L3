import { BadRequestException } from '@nestjs/common';
import { normalizeBase64, readableIdentifier, xuiObject, parseMaybeJson, stringValue, truncateText } from './xui-values.js';

export function parseOutboundInput(input: string, requestedFormat: string) {
  const trimmed = input.trim();
  const parseJson = () => {
    let value: unknown;
    try {
      value = JSON.parse(trimmed) as unknown;
    } catch {
      throw new BadRequestException('Xray JSON 格式不正确');
    }
    const root = xuiObject(value);
    const values = Array.isArray(value)
      ? value
      : Array.isArray(root.outbounds)
        ? root.outbounds
        : Object.keys(root).length
          ? [root]
          : [];
    return values.map((item, index) => normalizeImportedOutbound(xuiObject(item), 'xray_json', index));
  };

  if (requestedFormat === 'xray_json' || (requestedFormat === 'auto' && /^[\[{]/.test(trimmed))) return parseJson();
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  if (requestedFormat === 'subscription' || lines.length > 1) {
    return lines.flatMap((line) => parseOutboundLink(line, requestedFormat === 'subscription' ? 'auto' : requestedFormat));
  }
  return parseOutboundLink(trimmed, requestedFormat);
}

function parseOutboundLink(input: string, requestedFormat: string) {
  const scheme = input.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase() || '';
  const format = requestedFormat === 'auto' ? scheme : requestedFormat;
  if (format === 'vmess') return [parseVmessOutbound(input)];
  if (format === 'shadowsocks' || format === 'ss') return [parseShadowsocksOutbound(input)];
  if (['socks', 'socks5', 'http', 'https', 'vless', 'trojan'].includes(format)) return [parseUrlOutbound(input, format)];
  throw new BadRequestException(`暂不支持的出站导入格式：${format || 'unknown'}`);
}

function parseUrlOutbound(input: string, format: string) {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new BadRequestException(`${format} 出站链接格式不正确`);
  }
  const name = decodeURIComponent(url.hash.replace(/^#/, '')) || `${format}-${url.hostname}`;
  const tag = importedOutboundTag(name, 0);
  const port = Number(url.port || (format === 'https' ? 443 : format === 'http' ? 80 : 1080));
  if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) throw new BadRequestException(`${format} 出站地址或端口不正确`);

  if (format === 'socks' || format === 'socks5' || format === 'http' || format === 'https') {
    const protocol = format.startsWith('socks') ? 'socks' : 'http';
    const username = decodeURIComponent(url.username || '');
    const password = decodeURIComponent(url.password || '');
    return normalizeImportedOutbound({
      tag,
      protocol,
      settings: {
        servers: [{
          address: url.hostname,
          port,
          ...(username ? { users: [{ user: username, pass: password }] } : {})
        }]
      },
      streamSettings: { network: 'tcp', ...(format === 'https' ? { security: 'tls' } : {}) }
    }, protocol, 0, name);
  }

  const credential = decodeURIComponent(url.username || '');
  if (!credential) throw new BadRequestException(`${format} 出站缺少账号凭据`);
  const network = url.searchParams.get('type') || 'tcp';
  const security = url.searchParams.get('security') || 'none';
  const streamSettings: Record<string, unknown> = { network, security };
  const host = url.searchParams.get('host') || '';
  const path = url.searchParams.get('path') || '';
  if (network === 'ws') streamSettings.wsSettings = { path: path || '/', headers: host ? { Host: host } : {} };
  if (network === 'grpc') streamSettings.grpcSettings = { serviceName: url.searchParams.get('serviceName') || path };
  if (security === 'tls') streamSettings.tlsSettings = { serverName: url.searchParams.get('sni') || host || url.hostname };
  if (security === 'reality') streamSettings.realitySettings = {
    serverName: url.searchParams.get('sni') || '',
    fingerprint: url.searchParams.get('fp') || 'chrome',
    publicKey: url.searchParams.get('pbk') || '',
    shortId: url.searchParams.get('sid') || '',
    spiderX: url.searchParams.get('spx') || '/'
  };
  const protocol = format;
  const user = protocol === 'trojan'
    ? { password: credential, email: name }
    : { id: credential, encryption: url.searchParams.get('encryption') || 'none', flow: url.searchParams.get('flow') || '' };
  return normalizeImportedOutbound({
    tag,
    protocol,
    settings: { servers: [{ address: url.hostname, port, users: [user] }] },
    streamSettings
  }, protocol, 0, name);
}

function parseVmessOutbound(input: string) {
  try {
    const raw = input.replace(/^vmess:\/\//i, '');
    const value = JSON.parse(Buffer.from(normalizeBase64(raw), 'base64').toString('utf8')) as Record<string, unknown>;
    const name = stringValue(value.ps) || `vmess-${stringValue(value.add) || 'outbound'}`;
    const network = stringValue(value.net) || 'tcp';
    const host = stringValue(value.host);
    const path = stringValue(value.path);
    const streamSettings: Record<string, unknown> = { network, security: stringValue(value.tls) || 'none' };
    if (network === 'ws') streamSettings.wsSettings = { path: path || '/', headers: host ? { Host: host } : {} };
    if (network === 'grpc') streamSettings.grpcSettings = { serviceName: path };
    if (streamSettings.security === 'tls') streamSettings.tlsSettings = { serverName: stringValue(value.sni) || host || stringValue(value.add) };
    return normalizeImportedOutbound({
      tag: importedOutboundTag(name, 0),
      protocol: 'vmess',
      settings: { vnext: [{ address: stringValue(value.add), port: Number(value.port), users: [{ id: stringValue(value.id), alterId: Number(value.aid || 0), security: stringValue(value.scy) || 'auto' }] }] },
      streamSettings
    }, 'vmess', 0, name);
  } catch (error) {
    if (error instanceof BadRequestException) throw error;
    throw new BadRequestException('VMess 出站链接格式不正确');
  }
}

function parseShadowsocksOutbound(input: string) {
  try {
    const raw = input.replace(/^ss:\/\//i, '');
    const hashIndex = raw.indexOf('#');
    const name = hashIndex >= 0 ? decodeURIComponent(raw.slice(hashIndex + 1)) : 'shadowsocks-outbound';
    const withoutHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
    const atIndex = withoutHash.lastIndexOf('@');
    const decoded = atIndex >= 0
      ? `${Buffer.from(normalizeBase64(withoutHash.slice(0, atIndex)), 'base64').toString('utf8')}@${withoutHash.slice(atIndex + 1)}`
      : Buffer.from(normalizeBase64(withoutHash), 'base64').toString('utf8');
    const match = decoded.match(/^([^:]+):(.+)@([^:]+):(\d+)$/);
    if (!match) throw new Error('invalid');
    const [, method, password, address, portValue] = match;
    return normalizeImportedOutbound({
      tag: importedOutboundTag(name, 0),
      protocol: 'shadowsocks',
      settings: { servers: [{ address, port: Number(portValue), method, password }] }
    }, 'shadowsocks', 0, name);
  } catch {
    throw new BadRequestException('Shadowsocks 出站链接格式不正确');
  }
}

function normalizeImportedOutbound(outbound: Record<string, unknown>, format: string, index: number, suppliedName?: string) {
  const protocol = String(stringValue(outbound.protocol) || '').toLowerCase();
  if (!protocol) throw new BadRequestException('出站缺少 protocol');
  const name = suppliedName || stringValue(outbound.tag) || `${protocol}-${index + 1}`;
  return {
    name: truncateText(name, 120),
    format,
    outbound: { ...outbound, tag: stringValue(outbound.tag) || importedOutboundTag(name, index), protocol }
  };
}

export function applySingleOutboundName<T extends { name: string; outbound: Record<string, unknown> }>(items: T[], name?: string) {
  if (!name || items.length !== 1) return items;
  items[0] = {
    ...items[0]!,
    name,
    outbound: { ...items[0]!.outbound, tag: importedOutboundTag(name, 0) }
  };
  return items;
}

export function importedOutboundTag(name: string, index: number) {
  const readable = readableIdentifier(name, 'outbound', 120).toLowerCase();
  return truncateText(`${readable}${index ? `-${index + 1}` : ''}`, 160);
}
