import test from 'node:test';
import assert from 'node:assert/strict';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';

const protocols = ['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria'] as const;
const uuid = '11111111-2222-4333-8444-555555555555';

function sourceClient(protocol: string) {
  const common = {
    email: 'user@example.com',
    subId: 'existing-sub',
    enable: true,
    expiryTime: 123456,
    totalGB: 987654,
    limitIp: 2,
    comment: 'keep-me'
  };
  if (protocol === 'trojan') return { ...common, password: 'trojan-secret' };
  if (protocol === 'shadowsocks') return { ...common, method: 'chacha20-ietf-poly1305', password: 'ss-secret' };
  if (protocol === 'hysteria') return { ...common, auth: 'hysteria-secret' };
  if (protocol === 'vmess') return { ...common, id: uuid, security: 'auto' };
  return { ...common, id: uuid, flow: '' };
}

function sourceSettings(protocol: string) {
  const clients = [sourceClient(protocol)];
  if (protocol === 'vless') return { clients, decryption: 'none', encryption: 'none' };
  if (protocol === 'trojan') return { clients, fallbacks: [] };
  if (protocol === 'shadowsocks') return { clients, method: 'chacha20-ietf-poly1305', password: 'server-secret', network: 'tcp,udp', ivCheck: false };
  if (protocol === 'hysteria') return { clients, version: 2 };
  return { clients };
}

function sourceStream(protocol: string) {
  if (protocol === 'hysteria') {
    return {
      network: 'hysteria',
      security: 'tls',
      hysteriaSettings: { protocol: 'udp', version: 2, auth: '', udpIdleTimeout: 60 },
      tlsSettings: { serverName: 'node.example.com', alpn: ['h3'], certificates: [] }
    };
  }
  return { network: 'tcp', security: 'none', tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } } };
}

function assertTargetClient(protocol: string, client: Record<string, unknown>) {
  assert.equal(client.email, 'user@example.com');
  assert.equal(client.subId, 'existing-sub');
  assert.equal(client.enable, true);
  assert.equal(client.expiryTime, 123456);
  assert.equal(client.totalGB, 987654);
  assert.equal(client.limitIp, 2);
  assert.equal(client.comment, 'keep-me');

  if (protocol === 'vless' || protocol === 'vmess') {
    assert.match(String(client.id || ''), /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(client.password, undefined);
    assert.equal(client.auth, undefined);
    if (protocol === 'vmess') assert.equal(client.security, 'auto');
    return;
  }
  assert.equal(client.id, undefined);
  if (protocol === 'trojan') assert.ok(String(client.password || '').length > 0);
  if (protocol === 'shadowsocks') {
    assert.equal(client.method, 'chacha20-ietf-poly1305');
    assert.ok(String(client.password || '').length > 0);
  }
  if (protocol === 'hysteria') assert.ok(String(client.auth || '').length > 0);
}

for (const source of protocols) {
  for (const target of protocols) {
    test(`${source} inbound migrates to ${target} in place`, async () => {
      let submitted: Record<string, any> | undefined;
      let addCalls = 0;
      let deleteCalls = 0;
      let restartCalls = 0;
      const originalInbound = {
        id: 12,
        up: 10,
        down: 20,
        total: 30,
        remark: 'old-node',
        enable: true,
        expiryTime: 0,
        trafficReset: 'never',
        lastTrafficResetTime: 0,
        listen: '',
        port: 24443,
        protocol: source,
        settings: JSON.stringify(sourceSettings(source)),
        streamSettings: JSON.stringify(sourceStream(source)),
        sniffing: JSON.stringify({ enabled: true }),
        tag: 'inbound-12',
        clientStats: null
      };
      const client = {
        getInbound: async () => ({
          success: true,
          obj: submitted
            ? { ...submitted, settings: JSON.stringify(submitted.settings), streamSettings: JSON.stringify(submitted.streamSettings), sniffing: JSON.stringify(submitted.sniffing) }
            : originalInbound
        }),
        updateInbound: async (_id: number, body: Record<string, any>) => {
          submitted = structuredClone(body);
          return { success: true };
        },
        addInbound: async () => { addCalls += 1; return { success: true }; },
        deleteInbound: async () => { deleteCalls += 1; return { success: true }; },
        restartXrayService: async () => { restartCalls += 1; return { success: true }; },
        serverStatus: async () => ({ success: true, obj: { xray: { state: 'running', errorMsg: '' } } }),
        getPanelSettings: async () => ({ success: true, obj: { webCertFile: '/cert/fullchain.pem', webKeyFile: '/cert/private.key' } })
      };
      const service = new XuiService({
        xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true, baseUrl: 'https://node.example.com', config: { tlsServerName: 'node.example.com' } }) },
        syncLog: { create: async () => ({}) }
      } as never, {} as never) as any;
      service.createAuthenticatedClient = async () => client;

      const result = await service.updateServiceNodeInbound({
        serverId: 'server-1',
        inboundId: 12,
        name: 'new-node',
        remark: 'new-node',
        protocol: target,
        encryption: target === 'hysteria' ? 'tls' : 'none',
        transport: 'tcp',
        enabled: true,
        port: 24443
      });

      assert.equal(result.updated, true);
      assert.equal(addCalls, 0);
      assert.equal(deleteCalls, 0);
      assert.equal(restartCalls, source === target ? 0 : 1);
      assert.equal(submitted?.id, 12);
      assert.equal(submitted?.protocol, target);
      assertTargetClient(target, submitted?.settings.clients[0]);
      if (target === 'hysteria') {
        assert.equal(submitted?.settings.version, 2);
        assert.equal(submitted?.streamSettings.network, 'hysteria');
        assert.equal(submitted?.streamSettings.security, 'tls');
        assert.deepEqual(submitted?.streamSettings.tlsSettings.alpn, ['h3']);
      }
    });
  }
}

test('a failed 3x-ui update response is accepted only when remote readback proves it applied', async () => {
  let submitted: Record<string, any> | undefined;
  const originalInbound = {
    id: 12,
    remark: 'old-node',
    enable: true,
    port: 24443,
    protocol: 'vless',
    settings: JSON.stringify(sourceSettings('vless')),
    streamSettings: JSON.stringify(sourceStream('vless')),
    sniffing: JSON.stringify({ enabled: true }),
    tag: 'inbound-12'
  };
  const client = {
    getInbound: async () => ({ success: true, obj: submitted ? { ...submitted, settings: JSON.stringify(submitted.settings), streamSettings: JSON.stringify(submitted.streamSettings) } : originalInbound }),
    updateInbound: async (_id: number, body: Record<string, any>) => {
      submitted = body;
      return { success: false, msg: 'Inbound has been successfully updated. (unexpected end of JSON input)' };
    },
    restartXrayService: async () => ({ success: true }),
    serverStatus: async () => ({ success: true, obj: { xray: { state: 'running', errorMsg: '' } } })
  };
  const service = new XuiService({
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true, baseUrl: 'https://node.example.com', config: {} }) },
    syncLog: { create: async () => ({}) }
  } as never, {} as never) as any;
  service.createAuthenticatedClient = async () => client;

  const result = await service.updateServiceNodeInbound({
    serverId: 'server-1', inboundId: 12, name: 'new-node', remark: 'new-node', protocol: 'trojan', encryption: 'none', transport: 'tcp', enabled: true, port: 24443
  });
  assert.equal(result.updated, true);
  assert.equal(result.clientIdentities[0].email, 'user@example.com');
});

test('a structural migration fails when Xray does not return to running state', async () => {
  let submitted: Record<string, any> | undefined;
  const originalInbound = {
    id: 12,
    remark: 'old-node',
    enable: true,
    port: 24443,
    protocol: 'vless',
    settings: JSON.stringify(sourceSettings('vless')),
    streamSettings: JSON.stringify(sourceStream('vless')),
    sniffing: JSON.stringify({ enabled: true }),
    tag: 'inbound-12'
  };
  const client = {
    getInbound: async () => ({ success: true, obj: submitted ? { ...submitted, settings: JSON.stringify(submitted.settings), streamSettings: JSON.stringify(submitted.streamSettings) } : originalInbound }),
    updateInbound: async (_id: number, body: Record<string, any>) => { submitted = body; return { success: true }; },
    restartXrayService: async () => ({ success: true }),
    serverStatus: async () => ({ success: true, obj: { xray: { state: 'error', errorMsg: 'invalid config' } } })
  };
  const service = new XuiService({
    xuiServer: { findUnique: async () => ({ id: 'server-1', enabled: true, baseUrl: 'https://node.example.com', config: {} }) },
    syncLog: { create: async () => ({}) }
  } as never, {} as never) as any;
  service.createAuthenticatedClient = async () => client;

  await assert.rejects(() => service.updateServiceNodeInbound({
    serverId: 'server-1', inboundId: 12, name: 'new-node', remark: 'new-node', protocol: 'trojan', encryption: 'none', transport: 'tcp', enabled: true, port: 24443
  }), /invalid config/);
});
