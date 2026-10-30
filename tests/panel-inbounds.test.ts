import test from 'node:test';
import assert from 'node:assert/strict';
import { panelInbounds, suiClientReason, inboundManager } from '../apps/admin-web/src/panel-inbounds.js';
import { nativeInboundSettings, nativeInboundStream, mapEntry, wireguardKeys, xrayInboundProtocols, xrayTransportDefaults } from '../apps/admin-web/src/xray-inbound-fields.js';

test('the inventory retains every remote inbound, including non-billing and disabled protocols', () => {
  const panel = { id: 'x', name: '3x-ui', provider: 'xui', enabled: true };
  const raw = [{ id: 1, protocol: 'vless', port: 443, remark: 'existing', enable: true }, { id: 2, protocol: 'mixed', port: 1080, enable: false }, { id: 3, protocol: 'future-protocol', port: 10000 }];
  const list = panelInbounds(JSON.stringify(raw), panel, [{ id: 'node', serverId: 'x', inboundId: 1 }]);
  assert.equal(list.length, 3);
  assert.equal(list[0]?.linked?.id, 'node');
  assert.equal(list[1]?.enabled, false);
  assert(list[1]?.reason);
  assert.equal(list[2]?.protocol, 'future-protocol');
  assert.throws(() => panelInbounds({ wrong: [] }, panel, []), /完整入站列表/);
});

test('S-UI selection follows the real authorization and independent billing rules', () => {
  const panel = { id: 's', name: 'S-UI', provider: 'sui', enabled: true };
  const list = panelInbounds({ inbounds: [{ id: 7, type: 'tuic', tag: 'tuic-service', listen_port: 50002 }] }, panel, []);
  assert.equal(list[0]?.reason, '');
  assert.equal(list[0]?.port, 50002);
  assert.equal(suiClientReason({ id: 1, inbounds: [7], expiry: 0 }, 7, [], 's'), '');
  assert.match(suiClientReason({ id: 1, inbounds: [7, 8] }, 7, [], 's'), /仅授权/);
  assert.match(suiClientReason({ id: 1, inbounds: [7], delayStart: true }, 7, [], 's'), /首次使用/);
  assert.match(suiClientReason({ id: 1, inbounds: [7] }, 7, [{ id: 'node', serverId: 's', config: { suiClientId: 1 } }], 's'), /已接入/);
  assert.equal(inboundManager(panel, 7).query.inboundId, '7');
  assert.equal(inboundManager(panel, undefined, true).query.create, '1');
  assert.equal(inboundManager({ ...panel, provider: 'xui' }, undefined, true).query.create, '1');
});

test('each complete editor protocol gets its own native form rather than an inherited VLESS settings blob', () => {
  for (const protocol of xrayInboundProtocols) assert(nativeInboundSettings(protocol), protocol);
  assert.deepEqual(nativeInboundSettings('http')?.accounts, [{ user: '', pass: '' }]);
  assert.equal(nativeInboundSettings('mixed')?.auth, 'password');
  assert.equal(nativeInboundSettings('wireguard')?.secretKey, '');
  assert.equal(nativeInboundSettings('wireguard')?.decryption, undefined);
  const first = nativeInboundSettings('vless')!; (first.clients as unknown[]).push({ email: 'must-not-leak' });
  assert.deepEqual(nativeInboundSettings('vless')?.clients, []);
  assert.equal(xrayTransportDefaults.kcp?.mtu, 1350);
  assert.equal(nativeInboundStream('hysteria', {}).network, 'hysteria');
  assert.equal(nativeInboundStream('hysteria', {}).security, 'tls');
  assert.deepEqual(nativeInboundStream('wireguard', { network: 'ws', security: 'tls' }), {});
  assert.equal(nativeInboundStream('vless', { network: 'ws', wsSettings: { path: '/keep' } }).network, 'ws');
});

test('visual maps preserve other entries and reject duplicate and prototype keys', () => {
  const value = { '8080': '127.0.0.1:80', '8443': '127.0.0.1:443' };
  assert.deepEqual(mapEntry(value, '8880', value['8080'], '8080'), { '8880': '127.0.0.1:80', '8443': '127.0.0.1:443' });
  assert.throws(() => mapEntry(value, '8443', 'changed'), /重复/);
  assert.throws(() => mapEntry({}, '__proto__', 'changed'), /保留/);
  assert.equal(value['8080'], '127.0.0.1:80');
});

test('panel X25519 URL keys are converted to WireGuard base64 without changing the key bytes', () => {
  const raw = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 210));
  const keys = wireguardKeys({ privateKey: raw.toString('base64url'), publicKey: raw.toString('base64url') });
  assert.equal(keys.privateKey, raw.toString('base64'));
  assert.deepEqual(Buffer.from(keys.publicKey, 'base64'), raw);
  assert.throws(() => wireguardKeys({ privateKey: 'invalid', publicKey: '' }), /有效/);
});
