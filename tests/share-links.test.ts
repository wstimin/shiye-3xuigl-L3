import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';
import { createNodeQrImage } from '../apps/user-web/src/node-qr.js';
import { testLocks } from './test-locks.js';

const service = new XuiService({} as never, {} as never, testLocks()) as any;
const uuid = '11111111-2222-4333-8444-555555555555';
const host = 'node.example.com';
const name = '东京 A 线';

function build(protocol: string, streamSettings: Record<string, unknown>, inbound: Record<string, unknown>, client: Record<string, unknown>) {
  return service.buildLocalShareLink(protocol, host, 443, name, inbound, streamSettings, client) as string;
}

test('VLESS Reality link contains usable identity and transport fields', () => {
  const link = build('vless', {
    network: 'tcp',
    security: 'reality',
    realitySettings: { publicKey: 'public-key', serverNames: ['cdn.example.com'], fingerprint: 'chrome', shortIds: ['a1b2c3d4'], spiderX: '/' }
  }, { encryption: 'none' }, { id: uuid, flow: 'xtls-rprx-vision' });
  const url = new URL(link);
  assert.equal(url.protocol, 'vless:');
  assert.equal(url.username, uuid);
  assert.equal(url.hostname, host);
  assert.equal(url.searchParams.get('security'), 'reality');
  assert.equal(url.searchParams.get('sni'), 'cdn.example.com');
  assert.equal(url.searchParams.get('pbk'), 'public-key');
  assert.equal(url.searchParams.get('sid'), 'a1b2c3d4');
  assert.equal(url.searchParams.get('flow'), 'xtls-rprx-vision');
});

test('VMess WebSocket TLS link decodes to standard JSON fields', () => {
  const link = build('vmess', {
    network: 'ws',
    security: 'tls',
    wsSettings: { path: '/socket', headers: { Host: 'edge.example.com' } },
    tlsSettings: { serverName: 'edge.example.com', alpn: ['h2', 'http/1.1'] }
  }, {}, { id: uuid, alterId: 0, security: 'auto' });
  const config = JSON.parse(Buffer.from(link.slice('vmess://'.length), 'base64').toString('utf8'));
  assert.equal(config.add, host);
  assert.equal(config.port, '443');
  assert.equal(config.id, uuid);
  assert.equal(config.net, 'ws');
  assert.equal(config.host, 'edge.example.com');
  assert.equal(config.path, '/socket');
  assert.equal(config.tls, 'tls');
  assert.equal(config.sni, 'edge.example.com');
});

test('Trojan gRPC TLS link contains service name and SNI', () => {
  const link = build('trojan', {
    network: 'grpc',
    security: 'tls',
    grpcSettings: { serviceName: 'shiye-grpc', authority: 'grpc.example.com', multiMode: true },
    tlsSettings: { serverName: 'grpc.example.com' }
  }, {}, { password: 'trojan-pass' });
  const url = new URL(link);
  assert.equal(decodeURIComponent(url.username), 'trojan-pass');
  assert.equal(url.searchParams.get('type'), 'grpc');
  assert.equal(url.searchParams.get('serviceName'), 'shiye-grpc');
  assert.equal(url.searchParams.get('authority'), 'grpc.example.com');
  assert.equal(url.searchParams.get('sni'), 'grpc.example.com');
});

test('Shadowsocks link carries method and password', () => {
  const link = build('shadowsocks', { network: 'tcp', security: 'none' }, { method: 'aes-256-gcm' }, { method: 'aes-256-gcm', password: 'ss-pass' });
  assert.ok(link.startsWith('ss://'));
  const credential = link.slice('ss://'.length).split('@')[0]!;
  assert.equal(Buffer.from(credential, 'base64').toString('utf8'), 'aes-256-gcm:ss-pass');
});

test('Hysteria2 link carries auth, SNI and obfuscation', () => {
  const link = build('hysteria2', {
    network: 'tcp',
    security: 'tls',
    tlsSettings: { serverName: 'hy.example.com' },
    hy2Settings: { obfs: { type: 'salamander', password: 'obfs-pass' } }
  }, { version: '2' }, { auth: 'hy-auth' });
  const url = new URL(link);
  assert.equal(url.protocol, 'hysteria2:');
  assert.equal(decodeURIComponent(url.username), 'hy-auth');
  assert.equal(url.searchParams.get('sni'), 'hy.example.com');
});

test('node QR helper sends the exact share link to the encoder', async () => {
  const link = build('vless', { network: 'tcp', security: 'none' }, { encryption: 'none' }, { id: uuid });
  let encoded = '';
  const image = await createNodeQrImage(link, async (text, options) => {
    encoded = text;
    assert.deepEqual(options, { width: 260, margin: 1 });
    return 'data:image/png;base64,test';
  });
  assert.equal(encoded, link);
  assert.equal(image, 'data:image/png;base64,test');
});
