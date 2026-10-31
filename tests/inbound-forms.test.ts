import test from 'node:test';
import assert from 'node:assert/strict';
import { suiInboundTemplate, suiProtocolSchema, validateSuiInbound } from '../apps/admin-web/src/sui-inbound-fields.js';
import { inboundFieldGroups } from '../apps/admin-web/src/xray-inbound-fields.js';
import { decodePanelValue, encodePanelValue } from '../apps/admin-web/src/panel-fields.js';

test('S-UI protocol changes keep resource identity and listen settings but discard incompatible protocol options', () => {
  const next = suiInboundTemplate('tuic', { id: 8, tag: 'my-node', listen: '127.0.0.1', listen_port: 50002, type: 'hysteria2', obfs: { type: 'salamander', password: 'old' }, tls_id: 3, transport: { type: 'ws' } });
  assert.deepEqual(next, { id: 8, tag: 'my-node', listen: '127.0.0.1', listen_port: 50002, type: 'tuic', tls_id: 0, addrs: [], out_json: {}, congestion_control: 'cubic' });
  const first = suiInboundTemplate('anytls'), second = suiInboundTemplate('anytls');
  (first.padding_scheme as string[]).push('local-change');
  assert.notDeepEqual(first.padding_scheme, second.padding_scheme);
  assert.equal(suiProtocolSchema('tuic').properties?.congestion_control?.enum?.includes('cubic'), true);
});

test('S-UI inbound validation explains required TLS and rejects malformed address rows', () => {
  const draft = { ...suiInboundTemplate('anytls'), tag: 'anytls', listen_port: 50003 };
  assert.throws(() => validateSuiInbound(draft), /需要 TLS/);
  assert.doesNotThrow(() => validateSuiInbound({ ...draft, tls_id: 1 }));
  assert.throws(() => validateSuiInbound({ ...draft, tls_id: 1, listen_port: 65536 }), /监听端口/);
  assert.throws(() => validateSuiInbound({ ...draft, tls_id: 1, addrs: ['host.example'] }), /分享地址/);
  assert.doesNotThrow(() => validateSuiInbound({ ...draft, tls_id: 1, addrs: [{ server: 'host.example', server_port: 443, tls: { server_name: 'sni.example' }, newerOption: true }] }));
});

test('S-UI native non-listening protocols omit listen and subscription fields; Snell secrets are independent', () => {
  for (const protocol of ['tun', 'cloudflared']) {
    const value = suiInboundTemplate(protocol, { id: 8, tag: 'existing', listen: '::', listen_port: 50002 });
    for (const field of ['listen', 'listen_port', 'addrs', 'out_json']) assert.equal(field in value, false);
    assert.doesNotThrow(() => validateSuiInbound(value));
  }
  const first = suiInboundTemplate('snell'), second = suiInboundTemplate('snell');
  assert.match(String(first.psk), /^[a-f0-9]{32}$/);
  assert.notEqual(first.psk, second.psk);
  assert('mode' in suiProtocolSchema('snell', { version: 6 }).properties!);
  assert('obfs_mode' in suiProtocolSchema('snell', { version: 5 }).properties!);
});

test('editing S-UI labels preserves native address objects, TLS overrides and serialized extension fields', () => {
  const original = { id: 1, tag: 'before', type: 'vless', listen_port: 50001, tls_id: 1, addrs: JSON.stringify([{ server: 'edge.example', server_port: 443, tls: { enabled: true, server_name: 'sni.example' }, extension: { keep: 9 } }]), out_json: JSON.stringify({ flow: 'xtls-rprx-vision', custom: ['keep'] }), newerOption: { untouched: true } };
  const edited = decodePanelValue(original) as typeof original;
  edited.tag = 'after';
  const saved = encodePanelValue(edited, original) as typeof original;
  assert.deepEqual(saved, { ...original, tag: 'after' });
});

test('native Xray inbound fields follow a stable task order without dropping advanced or unknown settings', () => {
  const keys = ['newFeature', 'streamSettings', 'settings', 'port', 'remark', 'id', 'enable', 'protocol', 'listen'];
  const groups = inboundFieldGroups(keys, {}, '');
  assert.deepEqual(groups.map(group => group.title).filter(Boolean), ['基本设置', '协议与客户端', '传输与安全']);
  assert.deepEqual(groups[0]?.keys, ['remark', 'protocol', 'listen', 'port', 'enable']);
  assert.deepEqual(groups.flatMap(group => group.keys).sort(), [...keys].sort());
  const stream = inboundFieldGroups(['grpcSettings', 'tcpSettings', 'tlsSettings', 'security', 'network', 'sockopt'], { network: 'grpc', security: 'tls' }, 'streamSettings');
  assert.deepEqual(stream[0]?.keys, ['network', 'security', 'grpcSettings', 'tlsSettings']);
  assert.equal(stream.flatMap(group => group.keys).includes('tcpSettings'), false);
  assert.equal(stream[1]?.keys.includes('sockopt'), true);
});
