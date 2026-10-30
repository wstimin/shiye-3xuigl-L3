import type { PanelRecord } from './panel-fields';

export function inboundFieldGroups(keys: string[], record: PanelRecord, field: string) {
  const common: Record<string, string[]> = {
    '': ['remark', 'protocol', 'port', 'listen', 'enable', 'settings', 'streamSettings'],
    settings: ['clients', 'accounts', 'method', 'password', 'auth', 'secretKey', 'peers', 'server', 'rewriteAddress', 'portMap', 'address', 'fakeTlsDomain'],
    streamSettings: ['network', 'security', `${String(record.network || 'tcp')}Settings`, `${String(record.security)}Settings`],
    realitySettings: ['target', 'dest', 'serverNames', 'privateKey', 'shortIds'],
    tlsSettings: ['serverName', 'certificates', 'alpn'],
  };
  const visible = field === 'streamSettings' ? keys.filter(key => !/Settings$/.test(key) || common.streamSettings!.includes(key)) : keys;
  const primary = common[field];
  if (!primary) return [{ advanced: false, keys: visible }];
  return [{ advanced: false, keys: visible.filter(key => primary.includes(key)) }, { advanced: true, keys: visible.filter(key => !primary.includes(key)) }].filter(group => group.keys.length);
}

export function applyRealityTarget(settings: PanelRecord, target: string, serverName: string): PanelRecord {
  return { ...settings, ...('dest' in settings && !('target' in settings) ? { dest: target } : { target }), serverNames: [serverName], ...(settings.settings && typeof settings.settings === 'object' ? { settings: { ...settings.settings as PanelRecord, serverName } } : {}) };
}

// The panel's declared enum takes precedence; these match the current official inbound editor.
export const xrayInboundProtocols = ['vless', 'vmess', 'trojan', 'shadowsocks', 'http', 'mixed', 'wireguard', 'hysteria', 'tunnel', 'mtproto', 'amneziawg', 'tuic', 'masque'];
export const xrayTransportDefaults: Record<string, PanelRecord> = {
  tcp: { header: { type: 'none' }, acceptProxyProtocol: false },
  kcp: { mtu: 1350, tti: 20, uplinkCapacity: 5, downlinkCapacity: 20, cwndMultiplier: 1, maxSendingWindow: 2097152 },
  ws: { path: '/', host: '', headers: {}, heartbeatPeriod: 0, acceptProxyProtocol: false },
  grpc: { serviceName: '', authority: '', multiMode: false },
  httpupgrade: { path: '/', host: '', acceptProxyProtocol: false },
  xhttp: { path: '/', host: '', mode: 'auto' },
  hysteria: { version: 2, auth: '', udpIdleTimeout: 60 },
  xdrive: { service: 'local', remoteFolder: '', secrets: [] },
  masque: { path: '/' },
};

export function nativeInboundSettings(protocol: string): PanelRecord | undefined {
  const presets: Record<string, PanelRecord> = {
    vless: { clients: [], decryption: 'none', encryption: 'none', fallbacks: [] },
    vmess: { clients: [] }, trojan: { clients: [], fallbacks: [] },
    shadowsocks: { method: 'aes-128-gcm', password: '', network: 'tcp,udp', clients: [] },
    http: { accounts: [{ user: '', pass: '' }], allowTransparent: false },
    mixed: { auth: 'password', accounts: [{ user: '', pass: '' }], udp: false, ip: '127.0.0.1' },
    socks: { auth: 'password', accounts: [{ user: '', pass: '' }], udp: true },
    wireguard: { mtu: 1420, secretKey: '', peers: [], clients: [], noKernelTun: false, subnetIp: '10.0.0.0', subnetCidr: 24 },
    hysteria: { version: 2, clients: [] },
    tunnel: { rewriteAddress: '', portMap: {}, allowedNetwork: 'tcp,udp', followRedirect: false },
    tun: { name: 'xray0', mtu: 1500, gateway: [], dns: [], userLevel: 0, autoSystemRoutingTable: [], autoOutboundsInterface: 'auto' },
    mtproto: { fakeTlsDomain: '', clients: [] },
    amneziawg: { server: { privateKey: '', publicKey: '', subnetIp: '10.8.1.0', subnetCidr: 24, primaryDns: '', secondaryDns: '', externalInterface: '', kernelMode: false, ipv6Enabled: false }, clients: [] },
    tuic: { server: { certificate: '', private_key: '', congestion_control: 'bbr', alpn: ['h3'], udp_relay_mode: 'native', zero_rtt_handshake: false, log_level: 'info', max_idle_time: 15, authentication_timeout: 3, max_udp_relay_packet_size: 1500, sni: '' }, clients: [] },
    masque: { clients: [], address: ['10.7.0.1/24'] },
  };
  return presets[protocol];
}

export function mapEntry(record: PanelRecord, key: string, value: unknown, previous?: string): PanelRecord {
  if (!key.trim() || ['__proto__', 'prototype', 'constructor'].includes(key) || key !== previous && Object.hasOwn(record, key)) throw new Error('项目名称不能为空、重复或使用保留名称');
  return Object.fromEntries([...Object.entries(record).filter(([name]) => name !== previous && name !== key), [key, value]]);
}

export function wireguardKeys(value: PanelRecord) {
  const convert = (value: unknown) => {
    const key = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '') + '=';
    if (!/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error('面板未返回有效的 32 字节密钥，请重试');
    return key;
  };
  return { privateKey: convert(value.privateKey || value.private_key), publicKey: convert(value.publicKey || value.public_key) };
}

export function nativeInboundStream(protocol: string, previous: PanelRecord): PanelRecord {
  if (['wireguard', 'tunnel', 'tun', 'mtproto', 'amneziawg', 'tuic'].includes(protocol)) return {};
  if (['hysteria', 'masque'].includes(protocol)) return { network: protocol, security: 'tls', [`${protocol}Settings`]: { ...xrayTransportDefaults[protocol] }, tlsSettings: { serverName: '', certificates: [{ certificateFile: '', keyFile: '' }], alpn: ['h3'] } };
  if (['hysteria', 'masque'].includes(String(previous.network))) return { network: 'tcp', security: 'none', tcpSettings: { ...xrayTransportDefaults.tcp } };
  return { network: 'tcp', security: 'none', ...previous };
}
