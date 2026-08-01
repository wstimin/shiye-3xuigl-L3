import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { XuiService } from '../apps/api/src/modules/xui/xui.service.js';

const service = new XuiService({} as never, {} as never) as any;
const presetTargets = new Set([
  'www.amazon.com:443',
  'aws.amazon.com:443',
  'www.oracle.com:443',
  'www.nvidia.com:443',
  'www.amd.com:443',
  'www.intel.com:443',
  'www.sony.com:443'
]);

test('Reality scan aliases provide the target and SNI instead of the panel certificate domain', () => {
  const result = service.realityInfoFromScan(
    { feasible: true, dest: 'cdn.example.com:443', sni: 'cdn.example.com' },
    { baseUrl: 'https://panel-cert.example.net', tlsServerName: 'panel-cert.example.net' }
  );

  assert.equal(result.target, 'cdn.example.com:443');
  assert.equal(result.serverName, 'cdn.example.com');
  assert.equal(result.source, 'scan');
});

test('configured Reality SNI is preserved when a single-target scan omits SNI', async () => {
  const client = {
    scanRealityTarget: async () => ({ success: true, obj: { feasible: true, target: 'edge.example.com:443' } })
  };
  const result = await service.resolveRealityTarget(client, {
    realityTarget: 'edge.example.com:443',
    realityServerName: 'sni.example.com',
    tlsServerName: 'panel-cert.example.net'
  });

  assert.equal(result.target, 'edge.example.com:443');
  assert.equal(result.serverName, 'sni.example.com');
});

test('Reality fallback uses a 3x-ui preset and never derives a target from the panel domain', async () => {
  const client = {
    scanRealityTargets: async () => { throw new Error('unsupported'); }
  };
  const result = await service.resolveRealityTarget(client, {
    baseUrl: 'https://panel-cert.example.net',
    tlsServerName: 'panel-cert.example.net'
  });

  assert.equal(result.source, 'preset');
  assert.ok(presetTargets.has(result.target));
  assert.notEqual(result.target, 'panel-cert.example.net:443');
  assert.notEqual(result.serverName, 'panel-cert.example.net');
});

test('node form detects and displays Reality parameters without using TLS fields', async () => {
  const source = await readFile(new URL('../apps/admin-web/src/views/NodesView.vue', import.meta.url), 'utf8');
  assert.match(source, /\/api\/admin\/xui-servers\/\$\{serverId\}\/reality-detect/);
  assert.match(source, /Reality 目标/);
  assert.match(source, /Reality SNI/);
  assert.doesNotMatch(source, /realityServerName\s*=\s*[^\n]*tlsServerName/);
});


test('Reality updates preserve keys and short IDs while changing only target fields', () => {
  const original = {
    network: 'tcp',
    security: 'reality',
    realitySettings: {
      show: false,
      target: 'old.example.com:443',
      serverNames: ['old.example.com'],
      privateKey: 'private-key',
      publicKey: 'public-key',
      shortIds: ['a1b2c3d4'],
      settings: { publicKey: 'public-key', fingerprint: 'chrome', serverName: 'old.example.com', shortId: 'a1b2c3d4' }
    }
  };

  const patched = service.patchRealityStreamSettings(original, 'new.example.com:443', 'new.example.com');
  const reality = patched.realitySettings;
  assert.equal(reality.target, 'new.example.com:443');
  assert.deepEqual(reality.serverNames, ['new.example.com']);
  assert.equal(reality.privateKey, 'private-key');
  assert.equal(reality.publicKey, 'public-key');
  assert.deepEqual(reality.shortIds, ['a1b2c3d4']);
  assert.equal(reality.settings.publicKey, 'public-key');
  assert.equal(reality.settings.shortId, 'a1b2c3d4');
  assert.equal(reality.settings.serverName, 'new.example.com');
});


test('full Reality inbound update preserves credentials and verifies the remote result', async () => {
  const originalStream = {
    network: 'tcp',
    security: 'reality',
    tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } },
    realitySettings: {
      target: 'old.example.com:443',
      serverNames: ['old.example.com'],
      privateKey: 'private-key',
      publicKey: 'public-key',
      shortIds: ['a1b2c3d4'],
      settings: { publicKey: 'public-key', fingerprint: 'chrome', serverName: 'old.example.com', shortId: 'a1b2c3d4' }
    }
  };
  const originalInbound = {
    id: 12,
    up: 10,
    down: 20,
    total: 0,
    remark: '旧名称',
    enable: true,
    expiryTime: 0,
    listen: '',
    port: 24443,
    protocol: 'vless',
    settings: { clients: [{ id: '11111111-2222-4333-8444-555555555555', email: 'client@example.com' }], decryption: 'none', fallbacks: [] },
    streamSettings: originalStream,
    sniffing: { enabled: true },
    tag: 'inbound-24443'
  };
  let remoteInbound = structuredClone(originalInbound);
  let submitted: any = null;
  const client = {
    getInbound: async () => ({ success: true, obj: remoteInbound }),
    updateInbound: async (_id: number, body: any) => {
      submitted = structuredClone(body);
      remoteInbound = structuredClone(body);
      return { success: true, obj: remoteInbound };
    }
  };
  const prisma = {
    xuiServer: {
      findUnique: async () => ({ id: 'server-1', baseUrl: 'https://panel.example.com', enabled: true, config: {} })
    },
    syncLog: { create: async () => ({}) }
  };
  const updateService = new XuiService(prisma as never, {} as never) as any;
  updateService.createAuthenticatedClient = async () => client;

  const result = await updateService.updateServiceNodeInbound({
    serverId: 'server-1',
    inboundId: 12,
    name: '新名称',
    remark: '新名称',
    protocol: 'vless',
    encryption: 'reality',
    transport: 'tcp',
    tcpHeaderType: 'none',
    transportPath: '/',
    realityTarget: 'new.example.com:443',
    realityServerName: 'new.example.com',
    enabled: true,
    port: 24443
  });

  assert.equal(result.updated, true);
  assert.equal(submitted.streamSettings.realitySettings.target, 'new.example.com:443');
  assert.deepEqual(submitted.streamSettings.realitySettings.serverNames, ['new.example.com']);
  assert.equal(submitted.streamSettings.realitySettings.privateKey, 'private-key');
  assert.equal(submitted.streamSettings.realitySettings.publicKey, 'public-key');
  assert.deepEqual(submitted.streamSettings.realitySettings.shortIds, ['a1b2c3d4']);
  assert.equal(submitted.streamSettings.realitySettings.settings.shortId, 'a1b2c3d4');
});
