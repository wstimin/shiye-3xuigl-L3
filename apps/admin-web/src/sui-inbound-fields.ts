import { randomUuid } from '@shiye/shared';
import { clonePanelValue, type FieldSchema, type PanelRecord } from './panel-fields';

export const suiInboundProtocols = ['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'mixed', 'hysteria2', 'tuic', 'anytls', 'direct', 'naive', 'hysteria', 'shadowtls', 'snell', 'tun', 'redirect', 'tproxy', 'cloudflared'];
export const suiSubscriptionProtocols = ['mixed', 'socks', 'http', 'shadowsocks', 'vmess', 'shadowtls', 'trojan', 'hysteria', 'vless', 'anytls', 'tuic', 'hysteria2', 'naive'];
export const suiTlsProtocols = ['vless', 'vmess', 'trojan', 'http', 'hysteria', 'hysteria2', 'tuic', 'naive', 'anytls'];
export const suiTransportProtocols = ['vless', 'vmess', 'trojan'];
export const suiRequiredTls = ['hysteria', 'hysteria2', 'tuic', 'naive', 'anytls'];

export function suiInboundTemplate(protocol: string, previous: PanelRecord = {}): PanelRecord {
  const defaults: Record<string, PanelRecord> = {
    vless: { transport: {} }, vmess: { transport: {} }, trojan: { transport: {} },
    shadowsocks: { method: 'none' }, tuic: { congestion_control: 'cubic' },
    hysteria: { up_mbps: 100, down_mbps: 100 },
    shadowtls: { version: 3, handshake: { server: '', server_port: 443 }, handshake_for_server_name: {} },
    snell: { version: 6 },
    tun: { mtu: 9000, stack: 'system', udp_timeout: '5m', auto_route: false },
    cloudflared: { token: '', protocol: 'auto' },
    anytls: { padding_scheme: ['stop=8', '0=30-30', '1=100-400', '2=400-500,c,500-1000,c,500-1000,c,500-1000,c,500-1000', '3=9-9,500-1000', '4=500-1000', '5=500-1000', '6=500-1000', '7=500-1000'] },
  };
  const noListen = ['tun', 'cloudflared'].includes(protocol);
  const base = Object.fromEntries(['id', 'tag', ...(!noListen ? ['listen', 'listen_port'] : [])].filter(key => key in previous).map(key => [key, previous[key]]));
  return { tag: '', ...(!noListen ? { listen: '::', listen_port: 443 } : {}), ...base, type: protocol, ...(suiTlsProtocols.includes(protocol) ? { tls_id: 0 } : {}), ...(suiSubscriptionProtocols.includes(protocol) ? { addrs: [], out_json: {} } : {}), ...clonePanelValue(defaults[protocol] || {}) as PanelRecord, ...(protocol === 'snell' ? { psk: randomUuid().replace(/-/g, '') } : {}) };
}

const string: FieldSchema = { type: 'string' }, number: FieldSchema = { type: 'number' }, boolean: FieldSchema = { type: 'boolean' };
export function suiProtocolSchema(protocol: string, value: PanelRecord = {}): FieldSchema {
  const fields: Record<string, Record<string, FieldSchema>> = {
    shadowsocks: { method: { enum: ['none', 'aes-128-gcm', 'aes-256-gcm', 'chacha20-ietf-poly1305', '2022-blake3-aes-128-gcm', '2022-blake3-aes-256-gcm', '2022-blake3-chacha20-poly1305'] }, password: string },
    hysteria: { up_mbps: number, down_mbps: number, obfs: string },
    hysteria2: { up_mbps: number, down_mbps: number, ignore_client_bandwidth: boolean, masquerade: string },
    tuic: { congestion_control: { enum: ['cubic', 'new_reno', 'bbr'] }, zero_rtt_handshake: boolean, auth_timeout: string, heartbeat: string },
    direct: { network: { enum: ['', 'tcp', 'udp'] }, override_address: string, override_port: { type: 'integer' } },
    naive: { quic_congestion_control: { enum: ['', 'bbr', 'bbr2', 'cubic', 'reno'] } },
    shadowtls: { version: { enum: [3] }, handshake: { type: 'object', properties: { server: string, server_port: { type: 'integer' } }, required: ['server', 'server_port'] }, strict_mode: boolean },
    snell: { version: { enum: [5, 6] }, psk: string, ...(Number(value.version || 6) >= 6 ? { mode: { enum: ['default', 'unshaped', 'unsafe-raw'] } } : { obfs_mode: { enum: ['none', 'http', 'tls'] } }) },
    tun: { interface_name: string, address: { type: 'array', items: string }, mtu: { type: 'integer' }, stack: { enum: ['system', 'gvisor', 'mixed'] }, udp_timeout: string, auto_route: boolean, strict_route: boolean, auto_redirect: boolean },
    tproxy: { network: { enum: ['', 'tcp', 'udp'] } },
    cloudflared: { token: string, protocol: { enum: ['auto', 'quic', 'http2', 'h2mux'] }, ha_connections: { type: 'integer' }, post_quantum: boolean, region: string },
  };
  return { type: 'object', properties: fields[protocol] || {} };
}

export const suiTransportSchemas: Record<string, FieldSchema> = {
  http: { properties: { host: { type: 'array', items: string }, path: string, method: string } },
  ws: { properties: { path: string, headers: { type: 'object' }, max_early_data: number, early_data_header_name: string } },
  grpc: { properties: { service_name: string, idle_timeout: string, ping_timeout: string } },
  httpupgrade: { properties: { host: string, path: string } },
  quic: { properties: {} },
};

export function validateSuiInbound(value: PanelRecord) {
  if (!String(value.tag || '').trim()) throw Error('请填写入站标签（名称）。');
  if (!['tun', 'cloudflared'].includes(String(value.type)) && (!Number.isInteger(value.listen_port) || Number(value.listen_port) < 1 || Number(value.listen_port) > 65535)) throw Error('监听端口必须是 1–65535 的整数。');
  if (suiRequiredTls.includes(String(value.type)) && !(Number(value.tls_id) > 0)) throw Error(`${String(value.type)} 需要 TLS，请先读取并选择面板中的 TLS 配置。`);
  if (Array.isArray(value.addrs)) for (const address of value.addrs) {
    if (!address || typeof address !== 'object' || !String(address.server || '').trim() || !Number.isInteger(address.server_port) || address.server_port < 1 || address.server_port > 65535) throw Error('请为每条分享地址填写服务器地址和有效端口。');
  }
}
