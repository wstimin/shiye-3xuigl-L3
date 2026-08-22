import { createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type AccountStatus } from '@prisma/client';
import { xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { XuiClient, type XuiApiProfile } from '@shiye/xui-client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';

type XuiServerConfig = {
  baseUrl: string;
  basePath?: string | null;
  tokenEnc?: string | null;
  token?: string | null;
  username?: string | null;
  passwordEnc?: string | null;
  password?: string | null;
  config?: unknown;
};

type PanelCompatibility = {
  detectedVersion?: string;
  apiProfile: XuiApiProfile;
  detectedAt: string;
  source: 'openapi' | 'fallback';
  openApiVersion?: string;
};

type SyncOptions = {
  expireAt?: Date | null;
  status?: AccountStatus;
  trafficLimitGb?: Prisma.Decimal | number | string | null;
  createIfMissing?: boolean;
  requireExisting?: boolean;
  syncServiceConfig?: boolean;
  persistLocal?: boolean;
  preferredClientEmail?: string;
};

type SyncLogQuery = {
  serverId?: string;
  action?: string;
  status?: string;
  limit?: unknown;
};

type ServiceNodeConfig = {
  encryption?: string;
  transport?: string;
  tcpHeaderType?: string;
  transportHost?: string;
  transportPath?: string;
  grpcServiceName?: string;
  grpcAuthority?: string;
  grpcMultiMode?: boolean;
  xhttpMode?: string;
  realityTarget?: string;
  realityServerName?: string;
  realityMinClientVersion?: string;
  socksRelayEnabled?: boolean;
  socksNodeId?: string | null;
  remoteSocksOutboundTag?: string;
  remoteSocksImported?: boolean;
  remoteMode?: 'create' | 'bind';
  remoteManaged?: boolean;
  remoteInboundTag?: string;
  remoteInboundRemark?: string;
  remoteInboundPort?: number;
  remoteClientEmail?: string;
  remoteClientUuid?: string;
  remoteClientSubId?: string;
  remoteClientLinks?: string[];
};

type CreateServiceInboundInput = {
  serverId: string;
  name: string;
  protocol: string;
  encryption?: string;
  transport?: string;
  tcpHeaderType?: string;
  transportHost?: string;
  transportPath?: string;
  grpcServiceName?: string;
  grpcAuthority?: string;
  grpcMultiMode?: boolean;
  xhttpMode?: string;
  realityTarget?: string;
  realityServerName?: string;
  realityMinClientVersion?: string;
  enabled: boolean;
  port?: number;
  remark?: string | null;
  trafficLimitGb?: Prisma.Decimal | number | string | null;
};

type UpdateServiceInboundInput = CreateServiceInboundInput & {
  inboundId: number;
  forceRuntimeReload?: boolean;
};

type ClientLookup = {
  email?: string;
  uuid?: string;
  subId?: string;
  inboundId?: number;
};

type ClientMatch = {
  exists: boolean;
  raw: unknown;
  inboundId?: number;
  clientId?: string;
  email?: string;
  uuid?: string;
  subId?: string;
};

type ServiceInboundClientIdentity = {
  email?: string;
  uuid?: string;
  subId?: string;
};

type RealityTargetInfo = {
  target: string;
  serverName: string;
  source: 'scan' | 'configured' | 'preset';
  scan?: Record<string, unknown> | null;
};

type ShareLinkContext = {
  serverId: string;
  inboundId: number;
  serviceNodeName: string;
  protocol: string;
  encryption: string;
  server: XuiServerConfig;
  uuid?: string;
};

type RemoteSocksOutbound = {
  tag: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
};

type RemoteSocksRouteState = {
  socksOutbounds: Map<string, RemoteSocksOutbound>;
  routesByInboundTag: Map<string, { outboundTag: string; rule: Record<string, unknown> }>;
};

const SHIYE_ROUTE_MARK = 'shiye-service-node';
const SHARE_LINK_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'hysteria2']);
const MANAGED_SHADOWSOCKS_METHOD = 'chacha20-ietf-poly1305';
const REALITY_TARGET_CANDIDATES = [
  { target: 'www.amazon.com:443', serverName: 'www.amazon.com' },
  { target: 'aws.amazon.com:443', serverName: 'aws.amazon.com' },
  { target: 'www.oracle.com:443', serverName: 'www.oracle.com' },
  { target: 'www.nvidia.com:443', serverName: 'www.nvidia.com' },
  { target: 'www.amd.com:443', serverName: 'www.amd.com' },
  { target: 'www.intel.com:443', serverName: 'www.intel.com' },
  { target: 'www.sony.com:443', serverName: 'www.sony.com' }
] as const;

@Injectable()
export class XuiService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService) {}

  async testConnection(input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient({
      baseUrl: input.baseUrl,
      basePath: input.basePath,
      token: input.token,
      username: input.username,
      password: input.password
    });

    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, inbounds };
  }

  async testStoredServerDraft(id: string, input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient(await this.storedServerDraftConfig(id, input));
    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, serverId: id, inboundCount: this.xuiArray(inbounds).length, inbounds };
  }

  async testStoredServer(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');

    const client = await this.createAuthenticatedClient(server);
    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, serverId: id, enabled: server.enabled, inboundCount: this.xuiArray(inbounds).length, inbounds };
  }

  async detectStoredServerVersion(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');

    const client = await this.createAuthenticatedClient({ ...server, config: this.withPanelCompatibility(server.config) }, false);
    const compatibility = await this.detectAndPersistPanelCompatibility(server, client);
    return {
      serverId: id,
      ...compatibility,
      label: compatibility.detectedVersion || (compatibility.apiProfile === 'v3.6' ? '3.6 API 兼容' : 'Legacy/旧版 API')
    };
  }

  async testConnectionCertFiles(input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient({
      baseUrl: input.baseUrl,
      basePath: input.basePath,
      token: input.token,
      username: input.username,
      password: input.password
    }, true, true);
    return this.readWebCertFiles(client);
  }

  async testStoredServerDraftCertFiles(id: string, input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient(await this.storedServerDraftConfig(id, input), true, true);
    return this.readWebCertFiles(client);
  }

  async storedServerCertFiles(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui server not found');

    const client = await this.createAuthenticatedClient(server);
    return this.readWebCertFiles(client);
  }

  async storedServerStatus(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui server not found');

    const client = await this.createAuthenticatedClient(server);
    const [statusPayload, versionPayload] = await Promise.all([client.serverStatus(), client.getXrayVersion()]);
    this.assertXuiSuccess(statusPayload);
    this.assertXuiSuccess(versionPayload);
    return {
      serverId: id,
      status: this.xuiObject(this.xuiObject(statusPayload).obj || this.xuiObject(statusPayload).data || statusPayload),
      versions: this.xuiArray(versionPayload),
      raw: { status: statusPayload, versions: versionPayload }
    };
  }

  async storedServerClientPresence(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui server not found');

    const client = await this.createAuthenticatedClient(server);
    const [onlinePayload, lastOnlinePayload] = await Promise.all([client.onlineClients(), client.clientsLastOnline()]);
    this.assertXuiSuccess(onlinePayload);
    this.assertXuiSuccess(lastOnlinePayload);
    return {
      serverId: id,
      online: this.xuiArray(onlinePayload),
      lastOnline: this.xuiObject(this.xuiObject(lastOnlinePayload).obj || this.xuiObject(lastOnlinePayload).data || lastOnlinePayload),
      raw: { online: onlinePayload, lastOnline: lastOnlinePayload }
    };
  }

  async syncLogs(query: SyncLogQuery = {}) {
    const limit = Math.min(Math.max(Number(query.limit || 100), 1), 300);
    const where: Prisma.SyncLogWhereInput = {
      serverId: query.serverId || undefined,
      action: query.action || undefined,
      status: query.status || undefined
    };
    const [items, actions, statuses, servers] = await Promise.all([
      this.prisma.syncLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
        include: { server: { select: { id: true, name: true, baseUrl: true } } }
      }),
      this.prisma.syncLog.findMany({ distinct: ['action'], select: { action: true }, orderBy: { action: 'asc' } }),
      this.prisma.syncLog.findMany({ distinct: ['status'], select: { status: true }, orderBy: { status: 'asc' } }),
      this.prisma.xuiServer.findMany({ orderBy: { createdAt: 'desc' }, select: { id: true, name: true, baseUrl: true } })
    ]);

    return {
      items,
      filters: {
        actions: actions.map((item) => item.action),
        statuses: statuses.map((item) => item.status),
        servers
      }
    };
  }

  async syncServiceNode(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, select: { id: true } });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');
    throw new BadRequestException('服务节点不再批量创建 3x-ui 客户端，请在用户绑定列表中逐个点击同步');
  }

  async syncServiceNodeRemoteConfig(serviceNodeId: string, options: { removeOnly?: boolean } = {}) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;
    const client = await this.createAuthenticatedClient(serviceNode.server);
    let inboundTag = String(config.remoteInboundTag || `inbound-${serviceNode.inboundId}`);
    if (!options.removeOnly) {
      const inboundPayload = await client.getInbound(serviceNode.inboundId);
      this.assertXuiSuccess(inboundPayload);
      const inbound = this.xuiObject(this.xuiObject(inboundPayload).obj || this.xuiObject(inboundPayload).data || inboundPayload);
      inboundTag = String(inbound.tag || inboundTag);
    }
    let outboundTag = config.remoteSocksOutboundTag || this.legacySocksOutboundTag(serviceNode.id);

    const xrayPayload = await client.getXrayConfig();
    this.assertXuiSuccess(xrayPayload);
    const xrayObj = this.xuiObject(this.xuiObject(xrayPayload).obj || this.xuiObject(xrayPayload).data || xrayPayload);
    const rawSetting = xrayObj.xraySetting ?? xrayObj;
    const xraySetting = this.xuiObject(rawSetting);
    if (!Object.keys(xraySetting).length) throw new BadGatewayException('3x-ui returned an empty Xray config');

    const nextConfig = this.removeManagedSocksRoute(xraySetting, serviceNode.id, inboundTag, config.remoteSocksOutboundTag);
    let action: 'removed' | 'updated' = 'removed';
    let socksDetail: Record<string, unknown> | null = null;

    if (!options.removeOnly && config.socksRelayEnabled) {
      if (!config.socksNodeId) throw new BadRequestException('Socks relay enabled but no Socks node selected');
      const socksNode = await this.prisma.socksNode.findUnique({ where: { id: config.socksNodeId } });
      if (!socksNode) throw new NotFoundException('Socks node not found');
      if (!socksNode.enabled) throw new BadRequestException('Selected Socks node is disabled');

      outboundTag = this.socksOutboundTag(serviceNode.id, socksNode.name);
      const outbound = this.buildSocksOutbound(outboundTag, socksNode, serviceNode.id);
      const outbounds = Array.isArray(nextConfig.outbounds) ? nextConfig.outbounds : [];
      outbounds.push(outbound);
      nextConfig.outbounds = outbounds;

      const routing = this.ensureRouting(nextConfig);
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      rules.push({
        type: 'field',
        inboundTag: [inboundTag],
        outboundTag,
        _shiyeManaged: true,
        _shiyeServiceNodeId: serviceNode.id,
        _shiyeMark: SHIYE_ROUTE_MARK
      });
      routing.rules = rules;
      nextConfig.routing = routing;
      action = 'updated';
      socksDetail = { socksNodeId: socksNode.id, name: socksNode.name, outboundTag, host: socksNode.host, port: socksNode.port, username: socksNode.username || '' };
    }

    const outboundTestUrl = typeof xrayObj.outboundTestUrl === 'string' ? xrayObj.outboundTestUrl : undefined;
    const response = await client.updateXrayConfig({ xraySetting: JSON.stringify(nextConfig, null, 2), outboundTestUrl });
    this.assertXuiSuccess(response);
    const reloadResponse = await client.restartXrayService();
    this.assertXuiSuccess(reloadResponse);
    const nextServiceConfig: ServiceNodeConfig = { ...config };
    if (action === 'updated') nextServiceConfig.remoteSocksOutboundTag = outboundTag;
    else delete nextServiceConfig.remoteSocksOutboundTag;
    await this.prisma.serviceNode.update({
      where: { id: serviceNodeId },
      data: { config: this.toJsonValue(nextServiceConfig) }
    });
    await this.prisma.syncTask.updateMany({
      where: { entityType: 'service-node', entityId: serviceNodeId, action: 'service-config', status: { not: 'resolved' } },
      data: { status: 'resolved', message: null, resolvedAt: new Date() }
    });
    await this.writeSyncLog(serviceNode.serverId, 'service-node-config-sync', 'success', `Service node ${serviceNode.name} remote config ${action}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      inboundTag,
      outboundTag,
      action,
      socks: socksDetail,
      response: this.toJsonValue(response),
      reloadResponse: this.toJsonValue(reloadResponse)
    });
    return { synced: true, action, serviceNodeId, inboundId: serviceNode.inboundId, inboundTag, outboundTag, socks: socksDetail };
  }

  async createServiceNodeInbound(input: CreateServiceInboundInput) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');

    const client = await this.createAuthenticatedClient(server);
    const rawInbounds = await client.listInbounds();
    this.assertXuiSuccess(rawInbounds);
    const inbounds = this.xuiArray(rawInbounds);
    const usedPorts = new Set(inbounds.map((item) => Number(this.xuiObject(item).port)).filter((port) => Number.isInteger(port) && port > 0));
    const port = input.port || this.pickInboundPort(usedPorts);
    if (usedPorts.has(port)) throw new BadRequestException(`3x-ui 入站端口 ${port} 已被占用`);

    const tag = this.serviceInboundTag();
    const serverConfig: Record<string, unknown> = { ...this.xuiObject(server.config), baseUrl: server.baseUrl };
    if ((input.encryption || 'none') === 'reality') {
      delete serverConfig.realityTarget;
      delete serverConfig.realityServerName;
      if (input.realityTarget) serverConfig.realityTarget = input.realityTarget;
      if (input.realityServerName) serverConfig.realityServerName = input.realityServerName;
    }
    const effectiveSecurity = this.securityForProtocol(input.protocol, input.encryption || 'none');
    const streamSettings = await this.defaultStreamSettings(client, effectiveSecurity, serverConfig, input);
    const payload = this.buildInboundPayload({ ...input, encryption: effectiveSecurity, port, tag, streamSettings });
    const response = await client.addInbound(payload);
    this.assertXuiSuccess(response);

    let inboundId = this.extractCreatedInboundId(response);
    try {
      if (!inboundId) {
        const afterPayload = await client.listInbounds();
        this.assertXuiSuccess(afterPayload);
        inboundId = this.findCreatedInboundId(afterPayload, tag, payload.remark, port);
      }

      if (!inboundId) throw new BadGatewayException('3x-ui 已返回成功，但没有返回新入站 ID');
      const remoteClientUuid = randomUUID();
      const remoteClientSubId = this.subscriptionId(remoteClientUuid);
      const remoteClientEmail = this.serviceClientEmail(input.name, inboundId);
      const remoteClient = this.buildXuiClient({
        protocol: input.protocol,
        uuid: remoteClientUuid,
        subId: remoteClientSubId,
        email: remoteClientEmail,
        enabled: input.enabled,
        expireAt: null,
        trafficLimitGb: input.trafficLimitGb ?? 0,
        flow: this.clientFlowForProtocol(input.protocol, effectiveSecurity),
        method: this.inboundClientMethod(payload.settings)
      });
      let clientResponse: unknown;
      clientResponse = await client.addClient(inboundId, remoteClient);
      this.assertXuiSuccess(clientResponse);
      const links = input.enabled
        ? await this.requireLinksForServiceNode(client, remoteClientEmail, remoteClientSubId, {
          serverId: server.id,
          inboundId,
          serviceNodeName: input.name,
          protocol: input.protocol,
          encryption: effectiveSecurity,
          server,
          uuid: remoteClientUuid
        }, true)
        : await this.linksForClient(client, remoteClientEmail, remoteClientSubId, {
          serverId: server.id,
          inboundId,
          serviceNodeName: input.name,
          protocol: input.protocol,
          encryption: effectiveSecurity,
          server,
          uuid: remoteClientUuid
        }).catch(() => [] as string[]);
      await this.writeSyncLog(server.id, 'service-node-inbound-create', 'success', `Created inbound ${inboundId} for ${input.name}`, {
        inboundId,
        port,
        protocol: input.protocol,
        tag,
        reality: this.realityLogDetail(streamSettings),
        remoteClientEmail,
        remoteClientUuid,
        remoteClientSubId,
        links,
        response: this.toJsonValue(response),
        clientResponse: this.toJsonValue(clientResponse)
      }, true);
      const reality = this.realityLogDetail(streamSettings);
      return {
        inboundId,
        port,
        tag,
        remark: String(payload.remark),
        remoteClientEmail,
        remoteClientUuid,
        remoteClientSubId,
        links,
        realityTarget: reality?.target,
        realityServerName: reality?.serverName,
        response
      };
    } catch (error) {
      if (!inboundId) {
        const cleanupPayload = await client.listInbounds().catch(() => undefined);
        if (cleanupPayload) inboundId = this.findCreatedInboundId(cleanupPayload, tag, payload.remark, port);
      }
      if (inboundId) await this.deleteRemoteInbound(server.id, inboundId).catch(async (cleanupError) => {
        await this.writeSyncLog(server.id, 'service-node-inbound-create-cleanup', 'failed', this.errorMessage(cleanupError), {
          inboundId,
          serviceNodeName: input.name,
          originalError: this.errorMessage(error),
          cleanupError: this.errorMessage(cleanupError)
        });
      });
      throw error;
    }
  }

  async detectRealityTarget(serverId: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');
    const client = await this.createAuthenticatedClient(server);
    const serverConfig = { ...this.xuiObject(server.config) };
    delete serverConfig.realityTarget;
    delete serverConfig.realityServerName;
    delete serverConfig.tlsServerName;
    const detected = await this.resolveRealityTarget(client, serverConfig);
    return { target: detected.target, serverName: detected.serverName, source: detected.source };
  }

  async validateServiceNodeInbound(serverId: string, inboundId: number) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    const client = await this.createAuthenticatedClient(server);
    const payload = await client.getInbound(inboundId);
    this.assertXuiSuccess(payload);
    const inbound = this.remoteInboundFromPayload(payload);
    const remoteClient = await this.firstClientIdentityForInbound(client, inbound, inboundId);
    if (!remoteClient.email && !remoteClient.uuid && !remoteClient.subId) throw new BadRequestException('This 3x-ui inbound has no client. Create a client in 3x-ui first, or use automatic service-node creation.');
    const streamSettings = this.xuiObject(this.parseMaybeJson(inbound.streamSettings));
    return {
      inboundId,
      valid: true,
      remoteClient,
      protocol: String(inbound.protocol || 'vless').trim() || 'vless',
      encryption: String(streamSettings.security || 'none').trim() || 'none',
      enabled: this.booleanValue(inbound.enable, true),
      port: this.positiveInteger(inbound.port),
      transportConfig: this.transportConfigFromStream(streamSettings)
    };
  }

  async updateServiceNodeInbound(input: UpdateServiceInboundInput) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException('3x-ui server not found');
    if (!server.enabled) throw new BadRequestException('3x-ui server is disabled');

    const client = await this.createAuthenticatedClient(server);
    const currentPayload = await client.getInbound(input.inboundId);
    this.assertXuiSuccess(currentPayload);
    const currentInbound = this.remoteInboundFromPayload(currentPayload);
    if (!this.inboundIdOf(currentInbound)) throw new BadRequestException(`3x-ui inbound ${input.inboundId} does not exist`);

    const serverConfig: Record<string, unknown> = { ...this.xuiObject(server.config), baseUrl: server.baseUrl };
    if ((input.encryption || 'none') === 'reality') {
      delete serverConfig.realityTarget;
      delete serverConfig.realityServerName;
      if (input.realityTarget) serverConfig.realityTarget = input.realityTarget;
      if (input.realityServerName) serverConfig.realityServerName = input.realityServerName;
    }
    const currentStreamSettings = this.xuiObject(this.parseMaybeJson(currentInbound.streamSettings));
    const currentProtocol = String(currentInbound.protocol || '').trim().toLowerCase();
    const currentSecurity = String(currentStreamSettings.security || 'none').trim() || 'none';
    const nextSecurity = this.securityForProtocol(input.protocol, input.encryption || 'none');
    const currentTransport = this.transportConfigFromStream(currentStreamSettings);
    const requestedTransport = String(input.transport || 'tcp').trim().toLowerCase() || 'tcp';
    const selectableTransport = ['tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp'].includes(requestedTransport);
    if (!selectableTransport && requestedTransport !== currentTransport.transport) {
      throw new BadRequestException(`Transport ${requestedTransport} can only be preserved from an existing 3x-ui inbound`);
    }
    if (!selectableTransport && currentSecurity !== nextSecurity) {
      throw new BadRequestException(`Transport ${requestedTransport} does not support changing security from this panel`);
    }
    const nextTransport = this.normalizeTransportConfig(input);
    const crossesHysteriaBoundary = this.isHysteriaProtocol(currentProtocol) !== this.isHysteriaProtocol(input.protocol);
    const transportUnchanged = requestedTransport === currentTransport.transport && (
      !selectableTransport || this.sameTransportConfig(currentTransport, nextTransport)
    );
    const currentReality = this.realityLogDetail(currentStreamSettings);
    const nextRealityTarget = input.realityTarget || currentReality?.target;
    const nextRealityServerName = input.realityServerName || currentReality?.serverName;
    let streamSettings: Record<string, unknown>;
    if (currentSecurity === 'reality' && nextSecurity === 'reality' && nextRealityTarget && nextRealityServerName) {
      const realityBase = transportUnchanged
        ? currentStreamSettings
        : { ...currentStreamSettings, ...this.transportStreamSettings(nextTransport) };
      streamSettings = this.patchRealityStreamSettings(realityBase, nextRealityTarget, nextRealityServerName);
      const realitySettings = this.xuiObject(streamSettings.realitySettings);
      streamSettings = {
        ...streamSettings,
        realitySettings: {
          ...realitySettings,
          minClient: String(input.realityMinClientVersion ?? realitySettings.minClient ?? '').trim()
        }
      };
    } else if (!crossesHysteriaBoundary && currentSecurity === nextSecurity && transportUnchanged) {
      streamSettings = currentStreamSettings;
    } else {
      streamSettings = await this.defaultStreamSettings(client, nextSecurity, serverConfig, { ...input, ...nextTransport });
    }
    const currentSettings = this.xuiObject(this.parseMaybeJson(currentInbound.settings));
    const port = input.port || this.positiveInteger(currentInbound.port);
    if (!port) throw new BadRequestException('3x-ui inbound is missing a valid port');
    if (port !== this.positiveInteger(currentInbound.port)) {
      const rawInbounds = await client.listInbounds();
      this.assertXuiSuccess(rawInbounds);
      const occupied = this.xuiArray(rawInbounds).some((item) => this.inboundIdOf(item) !== input.inboundId && this.positiveInteger(this.xuiObject(item).port) === port);
      if (occupied) throw new BadRequestException(`3x-ui inbound port ${port} is already in use`);
    }

    const payload = {
      ...currentInbound,
      ...this.buildInboundPayload({
        ...input,
        port,
        tag: String(currentInbound.tag || this.serviceInboundTag()),
        streamSettings
      }),
      id: input.inboundId,
      settings: this.mergeInboundSettings(input.protocol, String(currentInbound.protocol || ''), currentSettings, nextSecurity),
      up: Number(currentInbound.up || 0),
      down: Number(currentInbound.down || 0),
      total: Number(currentInbound.total || 0)
    };
    const runtimeReloadRequired = Boolean(
      input.forceRuntimeReload ||
      currentProtocol !== String(input.protocol || '').trim().toLowerCase() ||
      this.positiveInteger(currentInbound.port) !== port ||
      JSON.stringify(currentStreamSettings) !== JSON.stringify(streamSettings)
    );

    const response = await client.updateInbound(input.inboundId, payload);
    const responseError = this.xuiFailureMessage(response);
    let verifiedPayload = await client.getInbound(input.inboundId);
    this.assertXuiSuccess(verifiedPayload);
    let verifiedInbound = this.remoteInboundFromPayload(verifiedPayload);
    this.assertServiceInboundUpdateApplied(verifiedInbound, input, port, streamSettings);
    let reloadResponse: unknown;
    let runtimeStatus: unknown;
    if (runtimeReloadRequired) {
      reloadResponse = await client.restartXrayService();
      this.assertXuiSuccess(reloadResponse);
      runtimeStatus = await this.waitForXrayRunning(client);
      verifiedPayload = await client.getInbound(input.inboundId);
      this.assertXuiSuccess(verifiedPayload);
      verifiedInbound = this.remoteInboundFromPayload(verifiedPayload);
      this.assertServiceInboundUpdateApplied(verifiedInbound, input, port, streamSettings);
    }
    const clientIdentities = this.inboundClientIdentities(verifiedInbound);
    if (responseError) {
      await this.writeSyncLog(server.id, 'service-node-inbound-update', 'partial', responseError, {
        inboundId: input.inboundId,
        verifiedApplied: true
      });
    }
    await this.writeSyncLog(server.id, 'service-node-inbound-update', 'success', `Updated inbound ${input.inboundId} for ${input.name}`, {
      inboundId: input.inboundId,
      port,
      protocol: input.protocol,
      runtimeReloadRequired,
      reality: this.realityLogDetail(streamSettings),
      response: this.toJsonValue(response),
      reloadResponse: reloadResponse === undefined ? undefined : this.toJsonValue(reloadResponse),
      runtimeStatus: runtimeStatus === undefined ? undefined : this.toJsonValue(runtimeStatus)
    });
    return { updated: true, inboundId: input.inboundId, port, response, clientIdentities, runtimeReloadRequired };
  }

  async setServiceNodeRemoteEnable(serviceNodeId: string, enable: boolean) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const client = await this.createAuthenticatedClient(serviceNode.server);
    const response = await client.setInboundEnable(serviceNode.inboundId, enable);
    this.assertXuiSuccess(response);
    await this.writeSyncLog(serviceNode.serverId, 'service-node-enable-sync', 'success', `${enable ? 'Enabled' : 'Disabled'} inbound ${serviceNode.inboundId}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      enable,
      response: this.toJsonValue(response)
    });
    return { synced: true, serviceNodeId, inboundId: serviceNode.inboundId, enable, response };
  }

  async syncServiceNodeTrafficLimit(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({
      where: { id: serviceNodeId },
      include: {
        server: true,
        customerNodes: { select: { id: true, customerId: true, status: true } }
      }
    });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const client = await this.createAuthenticatedClient(serviceNode.server);
    const rawInbounds = await client.listInbounds();
    this.assertXuiSuccess(rawInbounds);
    const inbounds = this.xuiArray(rawInbounds);
    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;
    const remoteClientEmail = this.stringValue(config.remoteClientEmail);
    const remoteClientUuid = this.stringValue(config.remoteClientUuid);
    const remoteClientSubId = this.stringValue(config.remoteClientSubId);
    const results: Array<{ target: string; updated: boolean; skipped?: boolean; message?: string }> = [];
    let serviceLinks: string[] | undefined;

    if (remoteClientEmail || remoteClientUuid || remoteClientSubId) {
      try {
        const existing = await this.findClient(client, { email: remoteClientEmail, uuid: remoteClientUuid, subId: remoteClientSubId, inboundId: serviceNode.inboundId }, inbounds);
        if (existing.exists) {
          const uuid = existing.uuid || remoteClientUuid || randomUUID();
          const subId = existing.subId || remoteClientSubId || this.subscriptionId(uuid);
          const email = existing.email || remoteClientEmail || this.serviceClientEmail(serviceNode.name, serviceNode.inboundId);
          const updateIdentifier = client.usesApiProfile('v3.6') ? existing.email || email : existing.clientId || existing.uuid || uuid;
          const payload = await client.updateClient(existing.inboundId || serviceNode.inboundId, updateIdentifier, this.buildXuiClient({
              protocol: serviceNode.protocol,
              uuid,
              subId,
              email,
              enabled: serviceNode.enabled,
              expireAt: null,
              trafficLimitGb: serviceNode.trafficLimitGb,
              flow: this.clientFlowForServiceNode(serviceNode)
            }));
          this.assertXuiSuccess(payload);
          if (serviceNode.enabled) {
            serviceLinks = await this.requireLinksForServiceNode(client, email, subId, {
              serverId: serviceNode.serverId,
              inboundId: serviceNode.inboundId,
              serviceNodeName: serviceNode.name,
              protocol: serviceNode.protocol,
              encryption: String(config.encryption || 'none'),
              server: serviceNode.server,
              uuid
            });
          }
          results.push({ target: `service:${email}`, updated: true });
        } else {
          results.push({ target: 'service-client', updated: false, message: 'remote service client not found' });
        }
      } catch (error) {
        results.push({ target: 'service-client', updated: false, message: this.errorMessage(error) });
      }
    } else {
      results.push({ target: 'service-client', updated: false, skipped: true, message: 'service node has no remote client identity' });
    }

    if (serviceLinks) {
      await this.prisma.serviceNode.update({
        where: { id: serviceNode.id },
        data: { config: this.toJsonValue({ ...config, remoteClientLinks: serviceLinks }) }
      });
    }

    for (const node of serviceNode.customerNodes) {
      if (!serviceNode.enabled && node.status === 'active') {
        results.push({ target: `customer:${node.id}`, updated: false, skipped: true, message: '服务节点已停用，用户节点无需继续同步为启用' });
        continue;
      }
      try {
        await this.syncCustomerNode(node.customerId, node.id, {
          status: node.status,
          trafficLimitGb: serviceNode.trafficLimitGb,
          createIfMissing: false,
          requireExisting: true
        });
        results.push({ target: `customer:${node.id}`, updated: true });
      } catch (error) {
        results.push({ target: `customer:${node.id}`, updated: false, message: this.errorMessage(error) });
      }
    }

    const updated = results.filter((item) => item.updated).length;
    const skipped = results.filter((item) => item.skipped).length;
    const failed = results.length - updated - skipped;
    await this.writeSyncLog(serviceNode.serverId, 'service-node-traffic-limit-sync', failed ? 'partial' : 'success', `Synced traffic limit for ${serviceNode.name}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      trafficLimitGb: String(serviceNode.trafficLimitGb),
      updated,
      skipped,
      failed,
      results
    });
    return { synced: failed === 0, serviceNodeId, inboundId: serviceNode.inboundId, trafficLimitGb: serviceNode.trafficLimitGb, updated, skipped, failed, results };
  }

  async resetServiceNodeTraffic(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('Service node not found');
    if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');

    const client = await this.createAuthenticatedClient(serviceNode.server);
    const response = await client.resetInboundTraffic(serviceNode.inboundId);
    this.assertXuiSuccess(response);
    await this.writeSyncLog(serviceNode.serverId, 'service-node-reset-traffic', 'success', `Reset inbound traffic ${serviceNode.inboundId}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      response: this.toJsonValue(response)
    });
    return { reset: true, serviceNodeId, inboundId: serviceNode.inboundId, response };
  }

  async resetCustomerNodeTraffic(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('Customer node not found');

    const client = await this.createAuthenticatedClient(customerNode.serviceNode.server);
    const inboundId = customerNode.serviceNode.inboundId;
    if (!inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');
    const response = await client.resetClientTraffic(inboundId, customerNode.xuiEmail);
    this.assertXuiSuccess(response);
    await this.writeSyncLog(customerNode.serviceNode.serverId, 'customer-node-reset-traffic', 'success', `Reset client traffic ${customerNode.xuiEmail}`, {
      customerId,
      customerNodeId,
      serviceNodeId: customerNode.serviceNodeId,
      xuiEmail: customerNode.xuiEmail,
      response: this.toJsonValue(response)
    });
    return { reset: true, customerId, customerNodeId, xuiEmail: customerNode.xuiEmail, response };
  }

  async customerNodeTraffic(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('Customer node not found');

    const client = await this.createAuthenticatedClient(customerNode.serviceNode.server);
    const payload = await client.clientTraffic(customerNode.xuiEmail);
    this.assertXuiSuccess(payload);
    return {
      customerId,
      customerNodeId,
      xuiEmail: customerNode.xuiEmail,
      traffic: this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload),
      raw: payload
    };
  }

  async deleteManagedServiceNodeInbound(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode?.inboundId) return { deleted: false, skipped: true };
    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;

    try {
      const client = await this.createAuthenticatedClient(serviceNode.server);
      const remoteClientEmail = this.stringValue(config.remoteClientEmail);
      const remoteClientCleanup = remoteClientEmail
        ? await this.deleteRemoteClientWithClient(client, serviceNode.server.id, serviceNode.inboundId, remoteClientEmail, false, { serviceNodeId, inboundId: serviceNode.inboundId, action: 'service-node-delete' }).catch((error) => ({ deleted: false, xuiEmail: remoteClientEmail, message: this.errorMessage(error) }))
        : { skipped: true, reason: 'service node has no remote client email' };
      const beforeDelete = await this.remoteInboundExists(client, serviceNode.inboundId);
      if (!beforeDelete.exists) {
        await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'success', `Inbound ${serviceNode.inboundId} already absent`, {
          serviceNodeId,
          inboundId: serviceNode.inboundId,
          alreadyAbsent: true,
          remoteClientCleanup
        });
        return { deleted: true, inboundId: serviceNode.inboundId, alreadyAbsent: true, remoteClientCleanup };
      }
      const response = await client.deleteInbound(serviceNode.inboundId);
      this.assertXuiSuccess(response);
      const verified = await this.verifyRemoteInboundDeleted(client, serviceNode.inboundId);
      await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'success', `Deleted inbound ${serviceNode.inboundId}`, {
        serviceNodeId,
        inboundId: serviceNode.inboundId,
        remoteClientCleanup,
        verified,
        response: this.toJsonValue(response)
      });
      return { deleted: true, inboundId: serviceNode.inboundId, remoteClientCleanup, verified, response };
    } catch (error) {
      if (this.isRemoteNotFound(error)) return { deleted: true, inboundId: serviceNode.inboundId, alreadyAbsent: true };
      await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'failed', this.errorMessage(error), { serviceNodeId, inboundId: serviceNode.inboundId });
      throw new BadGatewayException(`删除远端 3x-ui 入站失败：${this.errorMessage(error)}`);
    }
  }

  async deleteRemoteInbound(serverId: string, inboundId: number) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) return { deleted: false, skipped: true };
    const client = await this.createAuthenticatedClient(server);
    const beforeDelete = await this.remoteInboundExists(client, inboundId);
    if (!beforeDelete.exists) return { deleted: true, inboundId, alreadyAbsent: true };
    const response = await client.deleteInbound(inboundId);
    this.assertXuiSuccess(response);
    const verified = await this.verifyRemoteInboundDeleted(client, inboundId);
    return { deleted: true, inboundId, verified, response };
  }

  async syncServer(serverId: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');

    const client = await this.createAuthenticatedClient(server);
    const payload = await client.listInbounds();
    this.assertXuiSuccess(payload);
    const inbounds = this.xuiArray(payload);
    const remoteSocksState = await this.loadRemoteSocksRouteState(client);
    const importedSocks = await this.importRemoteSocksOutbounds(server.id, server.name, remoteSocksState);

    const results: Array<{ inboundId: number; name: string; action: 'created' | 'updated' | 'skipped'; serviceNodeId?: string; message?: string }> = [];
    for (const rawInbound of inbounds) {
      const inboundId = this.inboundIdOf(rawInbound);
      try {
        if (!inboundId) {
          results.push({ inboundId: 0, name: 'unknown', action: 'skipped', message: '远端入站缺少有效 ID' });
          continue;
        }

        const inbound = this.xuiObject(rawInbound);
        const streamSettings = this.xuiObject(this.parseMaybeJson(inbound.streamSettings));
        const remoteClient = this.firstInboundClientIdentity(inbound);
        const name = this.remoteInboundName(inbound, inboundId);
        const protocol = String(inbound.protocol || 'vless').trim() || 'vless';
        if (!SHARE_LINK_PROTOCOLS.has(protocol)) {
          results.push({ inboundId, name: this.remoteInboundName(inbound, inboundId), action: 'skipped', message: `${protocol} 不会生成用户端节点链接` });
          continue;
        }
        const port = this.positiveInteger(inbound.port);
        const enabled = this.booleanValue(inbound.enable, true);
        const existing = await this.prisma.serviceNode.findFirst({ where: { serverId, inboundId } });
        const previousConfig = this.xuiObject(existing?.config);
        const existingRemoteManaged = Boolean(previousConfig.remoteManaged);
        const existingRemoteMode = previousConfig.remoteMode === 'create' || previousConfig.remoteMode === 'bind'
          ? previousConfig.remoteMode
          : existingRemoteManaged ? 'create' : 'bind';
        const inboundTag = String(inbound.tag || previousConfig.remoteInboundTag || `inbound-${inboundId}`);
        const directOutboundTags = this.stringList(inbound.outboundTag);
        const remoteSocks = await this.importRemoteSocksForInbound(server.id, server.name, inboundTag, remoteSocksState, directOutboundTags);
        const remoteSocksConfig = remoteSocks
          ? {
            socksRelayEnabled: true,
            socksNodeId: remoteSocks.socksNodeId,
            remoteSocksOutboundTag: remoteSocks.outboundTag,
            remoteSocksImported: true
          }
          : {};
        const remoteClientLinks = remoteClient.email || remoteClient.uuid || remoteClient.subId
          ? await this.linksForClient(client, remoteClient.email || '', remoteClient.subId, {
            serverId,
            inboundId,
            serviceNodeName: name,
            protocol,
            encryption: String(streamSettings.security || previousConfig.encryption || 'none'),
            server,
            uuid: remoteClient.uuid
          }).catch(() => Array.isArray(previousConfig.remoteClientLinks) ? previousConfig.remoteClientLinks.filter((item): item is string => typeof item === 'string') : [])
          : [];
        const config = {
          ...previousConfig,
          ...remoteSocksConfig,
          remoteMode: existing ? existingRemoteMode : 'bind',
          remoteManaged: existing ? existingRemoteManaged : false,
          remoteInboundTag: inboundTag,
          remoteInboundRemark: String(inbound.remark || previousConfig.remoteInboundRemark || ''),
          remoteInboundPort: port || previousConfig.remoteInboundPort || undefined,
          remoteClientEmail: remoteClient.email || previousConfig.remoteClientEmail || undefined,
          remoteClientUuid: remoteClient.uuid || previousConfig.remoteClientUuid || undefined,
          remoteClientSubId: remoteClient.subId || previousConfig.remoteClientSubId || undefined,
          remoteClientLinks,
          encryption: String(streamSettings.security || previousConfig.encryption || 'none'),
          ...this.transportConfigFromStream(streamSettings),
          importedFromRemote: existing ? Boolean(previousConfig.importedFromRemote) : true
        };

        if (existing) {
          const updated = await this.prisma.serviceNode.update({
            where: { id: existing.id },
            data: {
              name,
              protocol,
              enabled,
              config: this.toJsonValue(config)
            }
          });
          results.push({ inboundId, name, action: 'updated', serviceNodeId: updated.id });
          continue;
        }

        try {
          const created = await this.prisma.serviceNode.create({
            data: {
              serverId,
              name,
              inboundId,
              protocol,
              priceMonthly: new Prisma.Decimal(0),
              trafficLimitGb: new Prisma.Decimal(0),
              enabled,
              config: this.toJsonValue(config),
              remark: String(inbound.remark || '').trim() || null
            }
          });
          results.push({ inboundId, name, action: 'created', serviceNodeId: created.id });
        } catch (error) {
          if (!this.isUniqueConstraintError(error)) throw error;
          const winner = await this.prisma.serviceNode.findFirst({ where: { serverId, inboundId } });
          if (!winner) throw error;
          const updated = await this.prisma.serviceNode.update({
            where: { id: winner.id },
            data: { name, protocol, enabled, config: this.toJsonValue(config) }
          });
          results.push({ inboundId, name, action: 'updated', serviceNodeId: updated.id, message: 'Concurrent import reused the existing local service node' });
        }
      } catch (error) {
        results.push({ inboundId, name: inboundId ? `Inbound ${inboundId}` : 'unknown', action: 'skipped', message: this.errorMessage(error) });
      }
    }

    const created = results.filter((item) => item.action === 'created').length;
    const updated = results.filter((item) => item.action === 'updated').length;
    const skipped = results.filter((item) => item.action === 'skipped').length;
    await this.writeSyncLog(serverId, 'server-inbounds-import', skipped ? 'partial' : 'success', `Imported remote inbounds from ${server.name}`, {
      created,
      updated,
      skipped,
      remoteSocksFound: remoteSocksState.socksOutbounds.size,
      remoteSocksImported: importedSocks.length,
      results
    });
    return { serverId, serverName: server.name, total: results.length, created, updated, skipped, remoteSocksFound: remoteSocksState.socksOutbounds.size, remoteSocksImported: importedSocks.length, results };
  }

  async syncServerSocksOutbounds(serverId: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui server not found');
    if (!server.enabled) throw new BadRequestException('3x-ui server is disabled');

    try {
      const client = await this.createAuthenticatedClient(server);
      const remoteSocksState = await this.loadRemoteSocksRouteState(client);
      const importedSocks = await this.importRemoteSocksOutbounds(server.id, server.name, remoteSocksState);
      const result = {
        serverId,
        serverName: server.name,
        remoteSocksFound: remoteSocksState.socksOutbounds.size,
        remoteSocksImported: importedSocks.length,
        importedSocks
      };
      await this.writeSyncLog(serverId, 'server-socks-outbounds-import', 'success', `Imported remote SOCKS outbounds from ${server.name}`, result);
      return result;
    } catch (error) {
      await this.writeSyncLog(serverId, 'server-socks-outbounds-import', 'failed', this.errorMessage(error), { message: this.errorMessage(error) });
      throw new BadGatewayException(`Sync remote SOCKS outbounds failed: ${this.errorMessage(error)}`);
    }
  }

  async deleteRemoteSocksOutbound(serverId: string, outboundTag: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui server not found');
    if (!server.enabled) throw new BadRequestException('3x-ui server is disabled');
    if (!outboundTag) throw new BadRequestException('Remote outbound tag is required');

    try {
      const client = await this.createAuthenticatedClient(server);
      const xrayPayload = await client.getXrayConfig();
      this.assertXuiSuccess(xrayPayload);
      const xrayObj = this.xuiObject(this.xuiObject(xrayPayload).obj || this.xuiObject(xrayPayload).data || xrayPayload);
      const rawSetting = xrayObj.xraySetting ?? xrayObj;
      const xraySetting = this.xuiObject(rawSetting);
      if (!Object.keys(xraySetting).length) throw new BadGatewayException('3x-ui returned an empty Xray config');

      const outbounds = Array.isArray(xraySetting.outbounds) ? xraySetting.outbounds : [];
      const beforeOutbounds = outbounds.length;
      xraySetting.outbounds = outbounds.filter((item) => this.stringValue(this.xuiObject(item).tag) !== outboundTag);

      const routing = this.xuiObject(xraySetting.routing);
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      const beforeRules = rules.length;
      const nextRules = rules.filter((item) => !this.stringList(this.xuiObject(item).outboundTag).includes(outboundTag));
      routing.rules = nextRules;
      xraySetting.routing = routing;

      const removedOutbounds = beforeOutbounds - (xraySetting.outbounds as unknown[]).length;
      const removedRules = beforeRules - nextRules.length;
      if (removedOutbounds || removedRules) {
        const outboundTestUrl = typeof xrayObj.outboundTestUrl === 'string' ? xrayObj.outboundTestUrl : undefined;
        const response = await client.updateXrayConfig({ xraySetting: JSON.stringify(xraySetting, null, 2), outboundTestUrl });
        this.assertXuiSuccess(response);
        const reloadResponse = await client.restartXrayService();
        this.assertXuiSuccess(reloadResponse);
        await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'success', `Deleted remote SOCKS outbound ${outboundTag} from ${server.name}`, {
          outboundTag,
          removedOutbounds,
          removedRules,
          response: this.toJsonValue(response),
          reloadResponse: this.toJsonValue(reloadResponse)
        });
      } else {
        await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'success', `Remote SOCKS outbound ${outboundTag} already absent from ${server.name}`, {
          outboundTag,
          removedOutbounds,
          removedRules
        });
      }

      return { deleted: true, serverId, serverName: server.name, outboundTag, removedOutbounds, removedRules };
    } catch (error) {
      await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'failed', this.errorMessage(error), { outboundTag, message: this.errorMessage(error) });
      throw new BadGatewayException(`Delete remote SOCKS outbound failed: ${this.errorMessage(error)}`);
    }
  }

  async deleteCustomerNode(customerId: string, customerNodeId: string, keepTraffic = false) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');
    if (!customerNode.serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');
    return this.deleteRemoteClient(customerNode.serviceNode.server, customerNode.serviceNode.inboundId, customerNode.xuiEmail, keepTraffic, {
      customerId,
      customerNodeId,
      serviceNodeId: customerNode.serviceNodeId
    });
  }

  async deleteServiceNodeClients(serviceNodeId: string, keepTraffic = false) {
    const serviceNode = await this.prisma.serviceNode.findUnique({
      where: { id: serviceNodeId },
      include: { server: true, customerNodes: { select: { id: true, customerId: true, xuiEmail: true } } }
    });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');

    const results: Array<{ customerNodeId: string; customerId: string; xuiEmail: string; deleted: boolean; skipped?: boolean; message?: string }> = [];
    for (const node of serviceNode.customerNodes) {
      try {
        const customerNode = await this.prisma.customerNode.findUnique({ where: { id: node.id }, select: { lastSyncedAt: true, config: true } });
        if (!this.shouldDeleteRemoteClient(customerNode)) {
          results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: false, skipped: true, message: 'not synced to remote' });
          continue;
        }
        if (!serviceNode.inboundId) throw new BadRequestException('Service node missing 3x-ui inbound ID');
        await this.deleteRemoteClient(serviceNode.server, serviceNode.inboundId, node.xuiEmail, keepTraffic, {
          customerId: node.customerId,
          customerNodeId: node.id,
          serviceNodeId
        });
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: true });
      } catch (error) {
        results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: false, message: this.errorMessage(error) });
      }
    }

    const success = results.filter((item) => item.deleted).length;
    const skipped = results.filter((item) => item.skipped).length;
    const failed = results.filter((item) => !item.deleted && !item.skipped).length;
    return { serviceNodeId, total: results.length, success, skipped, failed, results };
  }

  async syncCustomerNode(customerId: string, customerNodeId: string, options: SyncOptions = {}) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: {
        customer: true,
        serviceNode: { include: { server: true } }
      }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');

    const server = customerNode.serviceNode.server;
    const serverId = server.id;

    try {
      const targetStatus = options.status || customerNode.status;
      if (!server.enabled && targetStatus === 'active') throw new BadRequestException('3x-ui 服务器已停用');
      if (!customerNode.serviceNode.enabled && targetStatus === 'active') throw new BadRequestException('服务节点已停用');
      if (!customerNode.serviceNode.inboundId) throw new BadRequestException('服务节点缺少 3x-ui 入站 ID');

      const client = await this.createAuthenticatedClient(server);
      const rawInbounds = await client.listInbounds();
      this.assertXuiSuccess(rawInbounds);
      const inbounds = this.xuiArray(rawInbounds);
      const inboundId = customerNode.serviceNode.inboundId;
      const inbound = inbounds.find((item) => this.inboundIdOf(item) === inboundId);
      if (!inbound) {
        const knownIds = inbounds.map((item) => this.inboundIdOf(item)).filter(Boolean).join(', ') || '-';
        throw new BadRequestException(`3x-ui 入站 ${inboundId} 不存在，可用 ID: ${knownIds}`);
      }

      const savedConfig = this.xuiObject(customerNode.config);
      const serviceConfig = this.xuiObject(customerNode.serviceNode.config) as ServiceNodeConfig;
      const remoteClientEmail = this.stringValue(serviceConfig.remoteClientEmail);
      const remoteClientUuid = this.stringValue(serviceConfig.remoteClientUuid);
      const remoteClientSubId = this.stringValue(serviceConfig.remoteClientSubId);
      const savedUuid = typeof savedConfig.uuid === 'string' ? savedConfig.uuid : undefined;
      const savedSubId = typeof savedConfig.subId === 'string' ? savedConfig.subId : undefined;
      const lookupEmail = remoteClientEmail || customerNode.xuiEmail;
      const existing = await this.findClient(client, {
        email: lookupEmail,
        uuid: remoteClientUuid || customerNode.uuid || savedUuid,
        subId: remoteClientSubId || savedSubId,
        inboundId
      }, inbounds);

      if (!existing.exists && options.createIfMissing === false) {
        if (options.requireExisting) {
          throw new BadRequestException('Remote 3x-ui client was not found. This operation only updates an existing client and will not create a duplicate client.');
        }
        const uuid = customerNode.uuid || savedUuid || randomUUID();
        const subId = savedSubId || this.subscriptionId(uuid);
        const syncedAt = new Date();
        const updatedNode = await this.prisma.customerNode.update({
          where: { id: customerNode.id },
          data: { uuid, lastSyncedAt: syncedAt, config: this.toJsonValue({ ...savedConfig, uuid, subId, links: [] }) },
          include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
        });
        const detail = {
          customerId,
          customerNodeId,
          inboundId,
          xuiEmail: lookupEmail,
          route: 'clients/get',
          action: 'already-absent',
          subId,
          links: [] as string[],
          remoteConfig: null as unknown
        };
        const remoteConfigSync = options.syncServiceConfig ? await this.syncServiceNodeRemoteConfig(customerNode.serviceNodeId) : null;
        detail.remoteConfig = remoteConfigSync ? this.toJsonValue(remoteConfigSync) : null;
        await this.writeSyncLog(serverId, 'customer-node-sync', 'success', `Remote client already absent: ${lookupEmail}`, detail);
        return { synced: true, action: 'already-absent', route: 'clients/get', node: updatedNode, detail, remoteConfig: remoteConfigSync };
      }

      if (!existing.exists) throw new BadRequestException('Remote 3x-ui client was not found for this service node. Customer binding sync will not create a new client. Sync/import the service node first or fill the existing remote client email/UUID.');

      const allowCreate = false;
      if (!existing.exists && !allowCreate) {
        throw new BadRequestException('绑定已有 3x-ui 入站时未找到对应远端客户端，为避免重复创建，请填写已有客户端的远端标识/email 或 UUID 后再同步');
      }

      const uuid = existing.uuid || remoteClientUuid || customerNode.uuid || savedUuid || randomUUID();
      const subId = existing.subId || remoteClientSubId || savedSubId || this.subscriptionId(uuid);
      const xuiEmail = this.stringValue(options.preferredClientEmail) || existing.email || remoteClientEmail || customerNode.xuiEmail;
      const xuiClient = this.buildXuiClient({
        protocol: customerNode.serviceNode.protocol,
        uuid,
        subId,
        email: xuiEmail,
        enabled: targetStatus === 'active',
        expireAt: options.expireAt === undefined ? customerNode.expireAt : options.expireAt,
        trafficLimitGb: options.trafficLimitGb ?? customerNode.trafficLimitGb,
        flow: this.clientFlowForServiceNode(customerNode.serviceNode)
      });
      const route = 'clients/update';
      const updateIdentifier = client.usesApiProfile('v3.6') ? existing.email || xuiEmail : existing.clientId || existing.uuid || uuid;
      const payload = await client.updateClient(existing.inboundId || inboundId, updateIdentifier, xuiClient);
      this.assertXuiSuccess(payload);
      const links = targetStatus === 'active'
        ? await this.requireLinksForServiceNode(client, xuiEmail, subId, {
          serverId,
          inboundId,
          serviceNodeName: customerNode.serviceNode.name,
          protocol: customerNode.serviceNode.protocol,
          encryption: String(serviceConfig.encryption || 'none'),
          server,
          uuid
        })
        : await this.linksForClient(client, xuiEmail, subId, {
          serverId,
          inboundId,
          serviceNodeName: customerNode.serviceNode.name,
          protocol: customerNode.serviceNode.protocol,
          encryption: String(serviceConfig.encryption || 'none'),
          server,
          uuid
        }).catch(() => [] as string[]);
      const syncedAt = new Date();
      const localPatch = {
        xuiEmail,
        uuid,
        lastSyncedAt: syncedAt,
        config: this.toJsonValue({ ...savedConfig, uuid, subId, links })
      };
      const remoteIdentityChanged = xuiEmail !== remoteClientEmail
        || uuid !== remoteClientUuid
        || subId !== remoteClientSubId;
      const updatedNode = options.persistLocal === false
        ? customerNode
        : remoteIdentityChanged
          ? await this.prisma.$transaction(async (tx) => {
            const node = await tx.customerNode.update({
              where: { id: customerNode.id },
              data: localPatch,
              include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
            });
            await tx.serviceNode.update({
              where: { id: customerNode.serviceNodeId },
              data: {
                config: this.toJsonValue({
                  ...serviceConfig,
                  remoteClientEmail: xuiEmail,
                  remoteClientUuid: uuid,
                  remoteClientSubId: subId,
                  remoteClientLinks: links
                })
              }
            });
            return node;
          })
          : await this.prisma.customerNode.update({
            where: { id: customerNode.id },
            data: localPatch,
            include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
          });

      const detail = {
        customerId,
        customerNodeId,
        inboundId,
        xuiEmail,
        route,
        action: 'update',
        subId,
        links,
        remoteConfig: null as unknown,
        response: this.toJsonValue(payload)
      };
      const remoteConfigSync = options.syncServiceConfig ? await this.syncServiceNodeRemoteConfig(customerNode.serviceNodeId) : null;
      detail.remoteConfig = remoteConfigSync ? this.toJsonValue(remoteConfigSync) : null;
      await this.writeSyncLog(serverId, 'customer-node-sync', 'success', `Synced ${xuiEmail}`, detail);
      return { synced: true, action: 'update', route, node: updatedNode, detail, localPatch, remoteConfig: remoteConfigSync };
    } catch (error) {
      await this.writeSyncLog(serverId, 'customer-node-sync', 'failed', this.errorMessage(error), {
        customerId,
        customerNodeId,
        xuiEmail: customerNode.xuiEmail
      });
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new BadGatewayException(`同步 3x-ui 失败：${this.errorMessage(error)}`);
    }
  }

  async customerNodeLinks(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('Customer node not found');
    const config = this.xuiObject(customerNode.config);
    const savedLinks = Array.isArray(config.links) ? config.links.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
    const client = await this.createAuthenticatedClient(customerNode.serviceNode.server);
    const subId = typeof config.subId === 'string' ? config.subId : undefined;
    try {
      const links = await this.linksForClient(client, customerNode.xuiEmail, subId, {
        serverId: customerNode.serviceNode.serverId,
        inboundId: customerNode.serviceNode.inboundId || 0,
        serviceNodeName: customerNode.serviceNode.name,
        protocol: customerNode.serviceNode.protocol,
        encryption: String(this.xuiObject(customerNode.serviceNode.config).encryption || 'none'),
        server: customerNode.serviceNode.server,
        uuid: customerNode.uuid || this.stringValue(config.uuid)
      });
      const renamed = this.renameShareLinks(links, customerNode.serviceNode.name);
      if (renamed.length) {
        await this.prisma.customerNode.update({
          where: { id: customerNode.id },
          data: { config: this.toJsonValue({ ...config, links: renamed }) }
        });
      }
      return renamed;
    } catch (error) {
      if (savedLinks.length) {
        await this.writeSyncLog(customerNode.serviceNode.serverId, 'customer-node-links', 'partial', this.errorMessage(error), {
          customerId,
          customerNodeId,
          xuiEmail: customerNode.xuiEmail,
          subId,
          fallback: 'saved-links'
        });
        return this.renameShareLinks(savedLinks, customerNode.serviceNode.name);
      }
      await this.writeSyncLog(customerNode.serviceNode.serverId, 'customer-node-links', 'failed', this.errorMessage(error), {
        customerId,
        customerNodeId,
        xuiEmail: customerNode.xuiEmail,
        subId
      });
      throw error;
    }
  }

  private async createAuthenticatedClient(config: XuiServerConfig, autoDetect = true, detectDraft = false) {
    const password = config.password || (config.passwordEnc ? this.encryption.decrypt(config.passwordEnc) : '');
    const token = config.token || (config.tokenEnc ? this.encryption.decrypt(config.tokenEnc) : '');
    const client = new XuiClient({
      baseUrl: config.baseUrl,
      basePath: config.basePath || undefined,
      apiProfile: this.panelCompatibility(config.config)?.apiProfile,
      auth: token
        ? { kind: 'token', token }
        : config.username && password
          ? { kind: 'password', username: config.username, password }
          : undefined
    });

    if (config.username && password) {
      await client.login({ username: config.username, password });
    }

    const serverId = this.stringValue(this.xuiObject(config).id);
    if (autoDetect && (serverId || detectDraft) && !this.panelCompatibility(config.config)) {
      let compatibility: PanelCompatibility;
      try {
        compatibility = await this.detectAndPersistPanelCompatibility(config, client);
      } catch {
        return client;
      }
      const detectedClient = new XuiClient({
        baseUrl: config.baseUrl,
        basePath: config.basePath || undefined,
        apiProfile: compatibility.apiProfile,
        auth: token
          ? { kind: 'token', token }
          : config.username && password
            ? { kind: 'password', username: config.username, password }
            : undefined
      });
      if (config.username && password) await detectedClient.login({ username: config.username, password });
      return detectedClient;
    }

    return client;
  }

  private async detectAndPersistPanelCompatibility(config: XuiServerConfig, client: XuiClient) {
    const detected = await client.detectCapabilities();
    const compatibility: PanelCompatibility = { ...detected, detectedAt: new Date().toISOString() };
    const serverId = this.stringValue(this.xuiObject(config).id);
    if (serverId) {
      await this.prisma.xuiServer.update({
        where: { id: serverId },
        data: { config: this.toJsonValue(this.withPanelCompatibility(config.config, compatibility)) }
      });
    }
    return compatibility;
  }

  private panelCompatibility(value: unknown): PanelCompatibility | undefined {
    const compatibility = this.xuiObject(this.xuiObject(value).panelCompatibility);
    const apiProfile = compatibility.apiProfile;
    if (apiProfile !== 'legacy' && apiProfile !== 'v3.6') return undefined;
    return {
      apiProfile,
      detectedVersion: this.stringValue(compatibility.detectedVersion),
      detectedAt: String(compatibility.detectedAt || ''),
      source: compatibility.source === 'openapi' ? 'openapi' : 'fallback',
      openApiVersion: this.stringValue(compatibility.openApiVersion)
    };
  }

  private withPanelCompatibility(value: unknown, compatibility?: PanelCompatibility) {
    const config = { ...this.xuiObject(value) };
    if (compatibility) config.panelCompatibility = compatibility;
    else delete config.panelCompatibility;
    return config;
  }

  private async storedServerDraftConfig(id: string, input: z.infer<typeof xuiServerUpsertSchema>): Promise<XuiServerConfig> {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    return {
      baseUrl: input.baseUrl,
      basePath: input.basePath === undefined ? server.basePath : input.basePath || null,
      username: input.username === undefined ? server.username : input.username || null,
      password: input.password,
      passwordEnc: input.password === undefined ? server.passwordEnc : null,
      token: input.token,
      tokenEnc: input.token === undefined ? server.tokenEnc : null
    };
  }

  private async deleteRemoteClient(server: XuiServerConfig & { id?: string | null }, inboundId: number, xuiEmail: string, keepTraffic: boolean, detail: Record<string, unknown>) {
    try {
      const client = await this.createAuthenticatedClient(server);
      return await this.deleteRemoteClientWithClient(client, server.id || null, inboundId, xuiEmail, keepTraffic, detail);
    } catch (error) {
      if (this.isRemoteNotFound(error)) {
        await this.writeSyncLog(server.id || null, 'customer-node-delete', 'success', `Remote client already absent: ${xuiEmail}`, { ...detail, xuiEmail, keepTraffic });
        return { deleted: true, xuiEmail, alreadyAbsent: true };
      }
      await this.writeSyncLog(server.id || null, 'customer-node-delete', 'failed', this.errorMessage(error), { ...detail, xuiEmail, keepTraffic });
      throw new BadGatewayException(`删除 3x-ui 客户端失败：${this.errorMessage(error)}`);
    }
  }

  private async deleteRemoteClientWithClient(client: XuiClient, serverId: string | null | undefined, inboundId: number, xuiEmail: string, keepTraffic: boolean, detail: Record<string, unknown>) {
    const beforeDelete = await this.remoteClientExists(client, inboundId, xuiEmail);
    if (!beforeDelete.exists) {
      await this.writeSyncLog(serverId || null, 'customer-node-delete', 'success', `Remote client already absent: ${xuiEmail}`, { ...detail, inboundId, xuiEmail, keepTraffic, beforeDelete });
      return { deleted: true, inboundId, xuiEmail, alreadyAbsent: true, verified: { absent: true, checked: true, retried: false } };
    }
    const lastClientFallback = beforeDelete.clientCount === 1 && !client.usesApiProfile('v3.6')
      ? 'update-inbound-empty-clients'
      : undefined;
    const deleteOperation = lastClientFallback
      ? () => client.updateInbound(inboundId, this.inboundPayloadWithClients(beforeDelete.inbound!, beforeDelete.settings!, []))
      : () => client.deleteClient(inboundId, xuiEmail, undefined, keepTraffic);
    const payload = await deleteOperation();
    this.assertXuiSuccess(payload);
    const verified = await this.verifyRemoteClientDeleted(client, inboundId, xuiEmail, deleteOperation);
    await this.writeSyncLog(serverId || null, 'customer-node-delete', 'success', `Deleted ${xuiEmail}`, {
      ...detail,
      inboundId,
      xuiEmail,
      keepTraffic,
      keepTrafficUnsupported: keepTraffic,
      lastClientFallback,
      trafficRecordCleanupNotGuaranteed: Boolean(lastClientFallback),
      verified,
      response: this.toJsonValue(payload)
    });
    return {
      deleted: true,
      inboundId,
      xuiEmail,
      keepTrafficUnsupported: keepTraffic,
      lastClientFallback,
      trafficRecordCleanupNotGuaranteed: Boolean(lastClientFallback),
      verified,
      response: payload
    };
  }

  private async verifyRemoteClientDeleted(client: XuiClient, inboundId: number, xuiEmail: string, retryDelete: () => Promise<unknown>) {
    const firstCheck = await this.remoteClientExists(client, inboundId, xuiEmail);
    if (!firstCheck.exists) return { absent: true, checked: true, retried: false };

    const retryResponse = await retryDelete();
    this.assertXuiSuccess(retryResponse);
    const secondCheck = await this.remoteClientExists(client, inboundId, xuiEmail);
    if (secondCheck.exists) throw new Error(`3x-ui client ${xuiEmail} still exists after retry delete`);

    return { absent: true, checked: true, retried: true, retryResponse: this.toJsonValue(retryResponse) };
  }

  private async remoteClientExists(client: XuiClient, inboundId: number, xuiEmail: string) {
    try {
      const payload = await client.getInbound(inboundId);
      this.assertXuiSuccess(payload);
      const object = this.xuiObject(payload);
      const inbound = this.xuiObject(object.obj ?? object.data ?? payload);
      const settings = this.xuiObject(this.parseMaybeJson(inbound.settings));
      const clients = Array.isArray(settings.clients) ? settings.clients : [];
      for (const item of clients) {
        const identity = this.clientIdentity(item);
        if (identity.email === xuiEmail) {
          return {
            exists: true,
            ...identity,
            clientId: this.clientIdForProtocol(item, String(inbound.protocol || '')),
            clientCount: clients.length,
            inbound,
            settings
          };
        }
      }
      return { exists: false, clientCount: clients.length, inbound, settings };
    } catch (error) {
      if (this.isRemoteNotFound(error)) return { exists: false };
      throw error;
    }
  }

  private inboundPayloadWithClients(inbound: Record<string, unknown>, settings: Record<string, unknown>, clients: unknown[]) {
    return {
      up: inbound.up ?? 0,
      down: inbound.down ?? 0,
      total: inbound.total ?? 0,
      remark: inbound.remark ?? '',
      enable: inbound.enable ?? true,
      expiryTime: inbound.expiryTime ?? 0,
      trafficReset: inbound.trafficReset ?? 'never',
      lastTrafficResetTime: inbound.lastTrafficResetTime ?? 0,
      listen: inbound.listen ?? '',
      port: inbound.port,
      protocol: inbound.protocol,
      settings: { ...settings, clients },
      streamSettings: this.parseMaybeJson(inbound.streamSettings),
      tag: inbound.tag ?? '',
      sniffing: this.parseMaybeJson(inbound.sniffing)
    };
  }

  private shouldDeleteRemoteClient(customerNode?: { lastSyncedAt: Date | null; config: Prisma.JsonValue | null } | null) {
    if (!customerNode) return false;
    if (customerNode.lastSyncedAt) return true;
    const config = this.xuiObject(customerNode.config);
    return Boolean(config.subId || (Array.isArray(config.links) && config.links.length));
  }

  private buildXuiClient(input: { protocol: string; uuid: string; subId: string; email: string; enabled: boolean; expireAt?: Date | null; trafficLimitGb: Prisma.Decimal | number | string | null; flow?: string; method?: string }) {
    const client: Record<string, unknown> = {
      email: input.email,
      enable: input.enabled,
      expiryTime: input.expireAt ? input.expireAt.getTime() : 0,
      totalGB: this.gbToBytes(input.trafficLimitGb),
      limitIp: 0,
      flow: input.flow || '',
      tgId: 0,
      subId: input.subId,
      reset: 0
    };
    if (input.protocol === 'trojan') client.password = input.uuid;
    else if (input.protocol === 'shadowsocks') {
      client.method = input.method || MANAGED_SHADOWSOCKS_METHOD;
      client.password = input.uuid;
    }
    else if (input.protocol === 'hysteria' || input.protocol === 'hysteria2') client.auth = input.uuid;
    else {
      client.id = input.uuid;
      if (input.protocol === 'vmess') client.security = 'auto';
    }
    return client;
  }

  private clientFlowForServiceNode(serviceNode: { protocol: string; config?: Prisma.JsonValue | null }) {
    const config = this.xuiObject(serviceNode.config);
    return this.clientFlowForProtocol(serviceNode.protocol, String(config.encryption || 'none'));
  }

  private clientFlowForProtocol(protocol: string, encryption: string) {
    return protocol === 'vless' && encryption === 'reality' ? 'xtls-rprx-vision' : '';
  }

  private buildInboundPayload(input: CreateServiceInboundInput & { port: number; tag: string; streamSettings: Record<string, unknown> }) {
    const protocol = input.protocol;
    const remark = input.remark || input.name;
    return {
      up: 0,
      down: 0,
      total: 0,
      remark,
      enable: input.enabled,
      expiryTime: 0,
      listen: '',
      port: input.port,
      protocol,
      settings: this.defaultInboundSettings(protocol),
      streamSettings: input.streamSettings,
      sniffing: {
        enabled: true,
        destOverride: ['http', 'tls', 'quic', 'fakedns'],
        metadataOnly: false,
        routeOnly: false
      },
      tag: input.tag,
      _shiyeManaged: true
    };
  }

  private defaultInboundSettings(protocol: string) {
    if (protocol === 'vless') return { clients: [], decryption: 'none', encryption: 'none', fallbacks: [] };
    if (protocol === 'vmess') return { clients: [] };
    if (protocol === 'trojan') return { clients: [], fallbacks: [] };
    if (protocol === 'shadowsocks') {
      return {
        method: MANAGED_SHADOWSOCKS_METHOD,
        password: this.randomSecret(32),
        network: 'tcp,udp',
        clients: [],
        ivCheck: false
      };
    }
    if (protocol === 'hysteria' || protocol === 'hysteria2') return { version: 2, clients: [] };
    if (protocol === 'socks') return { auth: 'noauth', accounts: [], udp: true, ip: '127.0.0.1' };
    if (protocol === 'http') return { accounts: [] };
    if (protocol === 'mixed') return { auth: 'noauth', accounts: [], udp: true, ip: '127.0.0.1' };
    return { clients: [] };
  }

  private mergeInboundSettings(protocol: string, currentProtocol: string, currentSettings: Record<string, unknown>, encryption = 'none') {
    const next = this.xuiObject(this.defaultInboundSettings(protocol));
    const protocolChanged = currentProtocol.trim().toLowerCase() !== protocol.trim().toLowerCase();
    const clients = Array.isArray(currentSettings.clients) ? currentSettings.clients : [];
    if (clients.length) {
      next.clients = protocolChanged
        ? clients.map((item) => this.convertInboundClient(item, protocol, encryption))
        : clients.map((item) => this.normalizeInboundClientForProtocol(item, protocol, encryption));
    }
    if (!protocolChanged && Array.isArray(currentSettings.accounts)) next.accounts = currentSettings.accounts;
    if (!protocolChanged) {
      for (const key of ['method', 'password', 'network', 'auth', 'ip', 'udp']) {
        if (currentSettings[key] !== undefined) next[key] = currentSettings[key];
      }
    }
    return next;
  }

  private convertInboundClient(item: unknown, protocol: string, encryption: string) {
    const current = this.xuiObject(item);
    const currentCredential = this.clientUuidOf(current);
    const credential = this.credentialForProtocol(protocol, currentCredential);
    const email = this.clientEmailOf(current) || 'client-' + credential.slice(0, 8) + '@shiye.local';
    const subId = this.clientSubIdOf(current) || this.subscriptionId(credential);
    const next: Record<string, unknown> = { ...current, email, subId };
    for (const key of ['id', 'uuid', 'password', 'auth', 'security', 'flow', 'method']) delete next[key];
    if (protocol === 'trojan') next.password = credential;
    else if (protocol === 'shadowsocks') {
      next.method = MANAGED_SHADOWSOCKS_METHOD;
      next.password = credential;
    }
    else if (protocol === 'hysteria' || protocol === 'hysteria2') next.auth = credential;
    else {
      next.id = credential;
      if (protocol === 'vmess') next.security = 'auto';
      if (protocol === 'vless') next.flow = this.clientFlowForProtocol(protocol, encryption);
    }
    return next;
  }

  private normalizeInboundClientForProtocol(item: unknown, protocol: string, encryption: string) {
    const current = this.xuiObject(item);
    if (protocol === 'vless') {
      const flow = encryption === 'reality'
        ? this.stringValue(current.flow) || this.clientFlowForProtocol(protocol, encryption)
        : '';
      return { ...current, flow };
    }
    if (protocol === 'vmess') return { ...current, security: this.stringValue(current.security) || 'auto' };
    if (protocol === 'shadowsocks') return { ...current, method: this.stringValue(current.method) || MANAGED_SHADOWSOCKS_METHOD };
    return current;
  }

  private credentialForProtocol(protocol: string, current?: string) {
    if (protocol === 'vless' || protocol === 'vmess') return this.isUuid(current) ? current! : randomUUID();
    return current || this.randomSecret(24);
  }

  private isUuid(value?: string) {
    return Boolean(value && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value));
  }

  private securityForProtocol(protocol: string, security: string) {
    return protocol === 'hysteria' || protocol === 'hysteria2' ? 'tls' : security;
  }

  private isHysteriaProtocol(protocol: string) {
    return protocol === 'hysteria' || protocol === 'hysteria2';
  }

  private inboundClientMethod(settings: unknown) {
    return this.stringValue(this.xuiObject(settings).method);
  }

  private async defaultStreamSettings(
    client: XuiClient,
    security: string,
    serverConfig: Record<string, unknown> = {},
    transportInput: Partial<CreateServiceInboundInput> = {}
  ) {
    const transport = this.normalizeTransportConfig(transportInput);
    const protocol = String(transportInput.protocol || '').trim().toLowerCase();
    const base = protocol === 'hysteria' || protocol === 'hysteria2'
      ? {
        network: 'hysteria',
        hysteriaSettings: {
          protocol: 'udp',
          version: 2,
          auth: '',
          udpIdleTimeout: 60
        }
      }
      : this.transportStreamSettings(transport);
    if (security === 'tls') {
      const certFiles = await this.resolveTlsCertFiles(client, serverConfig);
      const serverName = String(serverConfig.tlsServerName || this.hostFromUrl(String(serverConfig.baseUrl || ''))).trim();
      return {
        ...base,
        security: 'tls',
        tlsSettings: {
          serverName,
          minVersion: '1.2',
          maxVersion: '1.3',
          cipherSuites: '',
          rejectUnknownSni: false,
          disableSystemRoot: false,
          enableSessionResumption: false,
          certificates: [{
            certificateFile: certFiles.certFile,
            keyFile: certFiles.keyFile,
            oneTimeLoading: false,
            usage: 'encipherment',
            buildChain: false
          }],
          alpn: protocol === 'hysteria' || protocol === 'hysteria2' ? ['h3'] : ['h2', 'http/1.1'],
          echServerKeys: '',
          settings: { fingerprint: 'chrome', echConfigList: '' }
        }
      };
    }
    if (security === 'reality') {
      const keys = await this.resolveRealityKeys(client);
      const realityTarget = await this.resolveRealityTarget(client, serverConfig);
      const target = realityTarget.target;
      const serverName = realityTarget.serverName;
      const fingerprint = String(serverConfig.realityFingerprint || 'chrome').trim() || 'chrome';
      const spiderX = String(serverConfig.realitySpiderX || '/').trim() || '/';
      const shortId = this.randomShortId();
      return {
        ...base,
        security: 'reality',
        realitySettings: {
          show: false,
          xver: 0,
          dest: target,
          target,
          serverNames: [serverName],
          privateKey: keys.privateKey,
          publicKey: keys.publicKey,
          minClient: String(transportInput.realityMinClientVersion || '').trim(),
          maxClient: '',
          maxTimediff: 0,
          alpn: ['h3', 'h2', 'http/1.1'],
          shortIds: [shortId],
          fingerprint,
          serverName,
          spiderX,
          settings: { publicKey: keys.publicKey, fingerprint, serverName, spiderX, shortId }
        }
      };
    }
    return { ...base, security: 'none' };
  }

  private normalizeTransportConfig(input: Partial<CreateServiceInboundInput> | ServiceNodeConfig) {
    const transport = ['tcp', 'ws', 'grpc', 'httpupgrade', 'xhttp'].includes(String(input.transport || '').toLowerCase())
      ? String(input.transport).toLowerCase()
      : 'tcp';
    return {
      transport,
      tcpHeaderType: input.tcpHeaderType === 'http' ? 'http' : 'none',
      transportHost: String(input.transportHost || '').trim(),
      transportPath: this.normalizeTransportPath(input.transportPath),
      grpcServiceName: String(input.grpcServiceName || '').trim(),
      grpcAuthority: String(input.grpcAuthority || '').trim(),
      grpcMultiMode: Boolean(input.grpcMultiMode),
      xhttpMode: ['auto', 'packet-up', 'stream-up', 'stream-one'].includes(String(input.xhttpMode || '')) ? String(input.xhttpMode) : 'auto'
    };
  }

  private transportStreamSettings(input: ReturnType<XuiService['normalizeTransportConfig']>): Record<string, unknown> {
    if (input.transport === 'ws') {
      return {
        network: 'ws',
        wsSettings: {
          acceptProxyProtocol: false,
          path: input.transportPath,
          host: input.transportHost,
          headers: {},
          heartbeatPeriod: 0
        }
      };
    }
    if (input.transport === 'grpc') {
      return {
        network: 'grpc',
        grpcSettings: {
          serviceName: input.grpcServiceName,
          authority: input.grpcAuthority,
          multiMode: input.grpcMultiMode
        }
      };
    }
    if (input.transport === 'httpupgrade') {
      return {
        network: 'httpupgrade',
        httpupgradeSettings: {
          acceptProxyProtocol: false,
          path: input.transportPath,
          host: input.transportHost,
          headers: {}
        }
      };
    }
    if (input.transport === 'xhttp') {
      return {
        network: 'xhttp',
        xhttpSettings: {
          path: input.transportPath,
          host: input.transportHost,
          mode: input.xhttpMode,
          xPaddingBytes: '100-1000',
          xPaddingObfsMode: false,
          xPaddingKey: '',
          xPaddingHeader: '',
          xPaddingPlacement: '',
          xPaddingMethod: '',
          sessionPlacement: '',
          sessionKey: '',
          seqPlacement: '',
          seqKey: '',
          uplinkDataPlacement: '',
          uplinkDataKey: '',
          scMaxEachPostBytes: '1000000',
          noSSEHeader: false,
          scMaxBufferedPosts: 30,
          scStreamUpServerSecs: '20-80',
          serverMaxHeaderBytes: 0,
          headers: {}
        }
      };
    }
    const header = input.tcpHeaderType === 'http'
      ? {
        type: 'http',
        request: {
          version: '1.1',
          method: 'GET',
          path: [input.transportPath],
          headers: input.transportHost ? { Host: [input.transportHost] } : {}
        },
        response: { version: '1.1', status: '200', reason: 'OK', headers: {} }
      }
      : { type: 'none' };
    return { network: 'tcp', tcpSettings: { acceptProxyProtocol: false, header } };
  }

  private transportConfigFromStream(streamSettings: Record<string, unknown>) {
    const transport = this.shareTransport(streamSettings);
    return {
      transport: transport.network === 'hysteria' ? 'tcp' : transport.network,
      tcpHeaderType: transport.network === 'tcp' && transport.headerType === 'http' ? 'http' : 'none',
      transportHost: transport.host || '',
      transportPath: transport.path || '/',
      grpcServiceName: transport.serviceName || '',
      grpcAuthority: transport.authority || '',
      grpcMultiMode: transport.mode === 'multi',
      xhttpMode: transport.network === 'xhttp' && transport.mode && ['auto', 'packet-up', 'stream-up', 'stream-one'].includes(transport.mode) ? transport.mode : 'auto'
    };
  }

  private sameTransportConfig(left: ReturnType<XuiService['normalizeTransportConfig']>, right: ReturnType<XuiService['normalizeTransportConfig']>) {
    if (left.transport !== right.transport) return false;
    if (left.transport === 'tcp') {
      if (left.tcpHeaderType !== right.tcpHeaderType) return false;
      return left.tcpHeaderType !== 'http' || (
        left.transportHost === right.transportHost &&
        left.transportPath === right.transportPath
      );
    }
    if (left.transport === 'grpc') {
      return left.grpcServiceName === right.grpcServiceName &&
        left.grpcAuthority === right.grpcAuthority &&
        left.grpcMultiMode === right.grpcMultiMode;
    }
    if (left.transport === 'xhttp') {
      return left.transportHost === right.transportHost &&
        left.transportPath === right.transportPath &&
        left.xhttpMode === right.xhttpMode;
    }
    return left.transportHost === right.transportHost && left.transportPath === right.transportPath;
  }

  private normalizeTransportPath(value: unknown) {
    const path = String(value || '').trim();
    if (!path) return '/';
    return path.startsWith('/') ? path : `/${path}`;
  }

  private async resolveWebCertFiles(client: XuiClient) {
    const result = await this.readWebCertFiles(client);
    const certFile = result.certFile;
    const keyFile = result.keyFile;
    if (!certFile || !keyFile) throw new BadGatewayException('3x-ui 没有返回可用的 TLS 证书路径，请先在 3x-ui 面板配置 Web 证书，或选择 Reality/none');
    return { certFile, keyFile };
  }

  private async readWebCertFiles(client: XuiClient) {
    const payload = typeof client.usesApiProfile === 'function' && client.usesApiProfile('v3.6')
      ? await client.getWebCertFiles()
      : await client.getPanelSettings();
    this.assertXuiSuccess(payload);
    const object = this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload);
    const certFile = String(object.webCertFile || object.certFile || object.certificateFile || object.cert || object.certPath || object.publicKeyPath || '').trim();
    const keyFile = String(object.webKeyFile || object.keyFile || object.privateKeyFile || object.key || object.keyPath || object.privateKeyPath || '').trim();
    return {
      found: Boolean(certFile && keyFile),
      certFile,
      keyFile,
      message: certFile && keyFile ? '已读取到 3x-ui 面板 Web 证书路径' : '3x-ui 没有返回完整的 Web 证书路径',
      raw: payload
    };
  }

  private async resolveTlsCertFiles(client: XuiClient, serverConfig: Record<string, unknown>) {
    const certFile = String(serverConfig.tlsCertFile || '').trim();
    const keyFile = String(serverConfig.tlsKeyFile || '').trim();
    if (certFile && keyFile) return { certFile, keyFile };
    return this.resolveWebCertFiles(client);
  }

  private async resolveRealityKeys(client: XuiClient) {
    const payload = await client.getNewX25519Cert();
    this.assertXuiSuccess(payload);
    const object = this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload);
    const privateKey = String(object.privateKey || object.private_key || '').trim();
    const publicKey = String(object.publicKey || object.public_key || '').trim();
    if (!privateKey || !publicKey) throw new BadGatewayException('3x-ui 没有返回 Reality X25519 密钥');
    return { privateKey, publicKey };
  }

  private async resolveRealityTarget(client: XuiClient, serverConfig: Record<string, unknown>): Promise<RealityTargetInfo> {
    const configuredTarget = String(serverConfig.realityTarget || '').trim();

    if (configuredTarget) {
      const targetSeed = this.normalizeRealityTarget(configuredTarget);
      const single = await this.scanRealityTarget(client, targetSeed).catch(() => null);
      const info = this.realityInfoFromScan(single, serverConfig, targetSeed);
      if (info) return info;
      return { target: targetSeed, serverName: this.realityServerName(serverConfig, targetSeed), source: 'configured', scan: null };
    }

    const scanned = await this.scanRealityTargets(client).catch(() => null);
    const discovered = this.bestRealityScanResult(scanned);
    if (discovered) {
      const info = this.realityInfoFromScan(discovered, serverConfig);
      if (info) return info;
    }

    const start = randomBytes(1).readUInt8(0) % REALITY_TARGET_CANDIDATES.length;
    for (let offset = 0; offset < REALITY_TARGET_CANDIDATES.length; offset += 1) {
      const candidate = REALITY_TARGET_CANDIDATES[(start + offset) % REALITY_TARGET_CANDIDATES.length]!;
      const single = await this.scanRealityTarget(client, candidate.target).catch(() => null);
      if (!single || (single.feasible !== true && !this.realityTargetFromScan(single))) continue;
      const info = this.realityInfoFromScan(single, { ...serverConfig, realityServerName: candidate.serverName }, candidate.target);
      if (info) return info;
    }

    return this.defaultRealityTarget();
  }

  private async scanRealityTarget(client: XuiClient, target: string) {
    const payload = await client.scanRealityTarget(target);
    this.assertXuiSuccess(payload);
    return this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload);
  }

  private async scanRealityTargets(client: XuiClient, targets?: string) {
    const payload = await client.scanRealityTargets(targets);
    this.assertXuiSuccess(payload);
    const root = this.xuiObject(payload);
    const nested = root.obj ?? root.data ?? root.result ?? payload;
    return this.xuiArray(nested).map((item) => this.xuiObject(item));
  }

  private bestRealityScanResult(results: unknown) {
    const candidates = Array.isArray(results) ? results.map((item) => this.xuiObject(item)) : [];
    const hasTarget = (item: Record<string, unknown>) => this.realityTargetFromScan(item);
    return candidates.find((item) => item.feasible === true && hasTarget(item))
      || candidates.find((item) => item.feasible !== false && hasTarget(item));
  }

  private realityInfoFromScan(scan: Record<string, unknown> | null | undefined, serverConfig: Record<string, unknown>, fallbackTarget?: string): RealityTargetInfo | null {
    if (!scan) return null;
    if (scan.feasible === false) return null;
    const targetValue = this.realityTargetFromScan(scan) || fallbackTarget;
    if (!targetValue) return null;
    const target = this.normalizeRealityTarget(targetValue);
    const serverName = this.realityServerNameFromScan(serverConfig, target, scan);
    return { target, serverName, source: 'scan', scan };
  }

  private realityServerNameFromScan(serverConfig: Record<string, unknown>, target: string, scan?: Record<string, unknown>) {
    const rawServerNames = Array.isArray(scan?.serverNames)
      ? scan.serverNames
      : String(scan?.serverNames || '').split(',');
    const serverNames = rawServerNames.map((item) => String(item).trim()).filter(Boolean);
    const scannedName = serverNames.find((item) => !item.startsWith('*.') && !this.isIpAddress(item))
      || this.stringValue(scan?.serverName)
      || this.stringValue(scan?.sni)
      || this.stringValue(scan?.host);
    if (scannedName && !this.isIpAddress(scannedName)) return scannedName;
    const configured = String(serverConfig.realityServerName || '').trim();
    if (configured && !this.isIpAddress(configured)) return configured;
    const host = this.hostFromTarget(target);
    if (host && !this.isIpAddress(host)) return host;
    throw new BadRequestException('Reality 检测结果缺少可用 SNI');
  }

  private defaultRealityTarget(): RealityTargetInfo {
    const index = randomBytes(1).readUInt8(0) % REALITY_TARGET_CANDIDATES.length;
    const selected = REALITY_TARGET_CANDIDATES[index]!;
    return { ...selected, source: 'preset', scan: null };
  }

  private realityTargetFromScan(scan: Record<string, unknown>) {
    return this.stringValue(scan.target)
      || this.stringValue(scan.dest)
      || this.stringValue(scan.address)
      || this.stringValue(scan.destination);
  }

  private realityServerName(serverConfig: Record<string, unknown>, target: string) {
    const configured = String(serverConfig.realityServerName || '').trim();
    if (configured && !this.isIpAddress(configured)) return configured;
    const host = this.hostFromTarget(target);
    if (host && !this.isIpAddress(host)) return host;
    throw new BadRequestException('Reality 目标缺少可用域名 SNI，请重新自动检测');
  }

  private patchRealityStreamSettings(streamSettings: Record<string, unknown>, targetValue: string, serverNameValue: string) {
    const target = this.normalizeRealityTarget(targetValue);
    const serverName = serverNameValue.trim();
    if (!serverName || this.isIpAddress(serverName)) throw new BadRequestException('Reality SNI 必须是有效域名');
    const currentReality = this.xuiObject(streamSettings.realitySettings);
    const nested = this.xuiObject(currentReality.settings);
    const realitySettings: Record<string, unknown> = { ...currentReality, serverNames: [serverName] };
    if ('dest' in currentReality) realitySettings.dest = target;
    if ('target' in currentReality || !('dest' in currentReality)) realitySettings.target = target;
    if ('serverName' in currentReality) realitySettings.serverName = serverName;
    if (Object.keys(nested).length) realitySettings.settings = { ...nested, serverName };
    return { ...streamSettings, security: 'reality', realitySettings };
  }

  private assertServiceInboundUpdateApplied(
    inbound: Record<string, unknown>,
    input: UpdateServiceInboundInput,
    port: number,
    expectedStreamSettings: Record<string, unknown>
  ) {
    if (this.inboundIdOf(inbound) !== input.inboundId) throw new BadGatewayException('远端入站回读失败');
    if (String(inbound.protocol || '').trim() !== input.protocol) throw new BadGatewayException('远端协议未更新');
    if (this.positiveInteger(inbound.port) !== port) throw new BadGatewayException('远端端口未更新');
    if (this.booleanValue(inbound.enable, true) !== input.enabled) throw new BadGatewayException('远端启用状态未更新');
    if (String(inbound.remark || '').trim() !== String(input.remark || input.name).trim()) throw new BadGatewayException('远端节点名称未更新');

    const actualStreamSettings = this.xuiObject(this.parseMaybeJson(inbound.streamSettings));
    const expectedSecurity = String(expectedStreamSettings.security || 'none');
    if (String(actualStreamSettings.security || 'none') !== expectedSecurity) throw new BadGatewayException('远端安全配置未更新');
    if (!this.sameTransportConfig(this.transportConfigFromStream(actualStreamSettings), this.transportConfigFromStream(expectedStreamSettings))) {
      throw new BadGatewayException('远端传输配置未更新');
    }
    if (expectedSecurity === 'reality') {
      const expectedReality = this.realityLogDetail(expectedStreamSettings);
      const actualReality = this.realityLogDetail(actualStreamSettings);
      if (!expectedReality || !actualReality || expectedReality.target !== actualReality.target || expectedReality.serverName !== actualReality.serverName) {
        throw new BadGatewayException('远端 Reality 配置未更新');
      }
    }
  }

  private async waitForXrayRunning(client: XuiClient) {
    let lastState = '';
    let lastError = '';
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 400));
      const payload = await client.serverStatus();
      this.assertXuiSuccess(payload);
      const status = this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload);
      const xray = this.xuiObject(status.xray);
      lastState = String(xray.state || '').trim().toLowerCase();
      lastError = String(xray.errorMsg || '').trim();
      if (lastState === 'running' && !lastError) return status;
    }
    throw new BadGatewayException(lastError ? `Xray 启动失败：${lastError}` : `Xray 状态异常：${lastState || 'unknown'}`);
  }

  private realityLogDetail(streamSettings: Record<string, unknown>) {
    if (String(streamSettings.security || '') !== 'reality') return undefined;
    const settings = this.xuiObject(streamSettings.realitySettings);
    const nested = this.xuiObject(settings.settings);
    return {
      target: this.stringValue(settings.dest) || this.stringValue(settings.target),
      serverName: this.stringValue(settings.serverName) || this.xuiArray(settings.serverNames).map((item) => String(item)).find(Boolean) || this.stringValue(nested.serverName) || '',
      alpn: this.xuiArray(settings.alpn).map((item) => String(item)).filter(Boolean)
    };
  }

  private normalizeRealityTarget(target: string) {
    const trimmed = target.trim();
    const host = this.hostFromTarget(trimmed);
    if (!host) throw new BadRequestException('Reality 目标格式不正确，请填写 example.com:443');
    if (/\]:\d+$/.test(trimmed) || /:\d+$/.test(trimmed)) return trimmed;
    return `${trimmed}:443`;
  }

  private hostFromTarget(target: string) {
    const trimmed = target.trim();
    if (!trimmed) return '';
    if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
    return trimmed.split(':')[0];
  }

  private hostFromUrl(value: string) {
    try {
      return new URL(value).hostname;
    } catch {
      return '';
    }
  }

  private isIpAddress(value: string) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(value) || value.includes(':');
  }

  private async linksForClient(client: XuiClient, email: string, subId?: string, context?: ShareLinkContext) {
    const errors: unknown[] = [];
    if (email) {
      try {
        const payload = await client.clientLinks(email);
        this.assertXuiSuccess(payload);
        const links = this.extractLinks(payload);
        if (links.length) return links;
      } catch (error) {
        errors.push(error);
      }
    }
    if (subId) {
      try {
        const payload = await client.subLinks(subId);
        this.assertXuiSuccess(payload);
        const links = this.extractLinks(payload);
        if (links.length) return links;
      } catch (error) {
        errors.push(error);
      }
    }
    if (context) return this.localShareLinks(client, email, subId, context);
    if (errors.length) throw errors[0];
    return [];
  }

  private async requireLinksForServiceNode(
    client: XuiClient,
    email: string,
    subId: string | undefined,
    context: ShareLinkContext,
    throwOnFailure = false
  ) {
    try {
      const links = await this.linksForClient(client, email, subId, context);
      if (links.length) return links;
      throw new Error('3x-ui returned an empty link list');
    } catch (error) {
      await this.writeSyncLog(context.serverId, 'service-node-link-verify', 'partial', this.errorMessage(error), {
        inboundId: context.inboundId,
        serviceNodeName: context.serviceNodeName,
        protocol: context.protocol,
        encryption: context.encryption,
        remoteClientEmail: email,
        remoteClientSubId: subId,
        note: 'Legacy share endpoints and local share-link generation both returned no usable link'
      });
      if (throwOnFailure) throw error;
      return [];
    }
  }

  private async localShareLinks(client: XuiClient, email: string, subId: string | undefined, context: ShareLinkContext) {
    if (!context.inboundId) throw new Error('Cannot generate a share link without an inbound ID');
    const payload = await client.getInbound(context.inboundId);
    this.assertXuiSuccess(payload);
    const inbound = this.remoteInboundFromPayload(payload);
    const inboundId = this.inboundIdOf(inbound);
    if (inboundId && inboundId !== context.inboundId) throw new Error(`3x-ui returned inbound ${inboundId} instead of ${context.inboundId}`);

    const protocol = String(inbound.protocol || context.protocol || '').trim().toLowerCase();
    const port = this.positiveInteger(inbound.port);
    if (!port) throw new Error(`Inbound ${context.inboundId} has no valid port`);
    const settings = this.xuiObject(this.parseMaybeJson(inbound.settings));
    const streamSettings = this.xuiObject(this.parseMaybeJson(inbound.streamSettings));
    const clients = Array.isArray(settings.clients) ? settings.clients : [];
    const lookup: ClientLookup = { email: email || undefined, subId, uuid: context.uuid };
    const remoteClient = clients.find((item) => this.clientMatches(this.clientIdentity(item), lookup));
    if (!remoteClient) throw new Error(`Client ${email || subId || context.uuid || 'unknown'} was not found in inbound ${context.inboundId}`);

    const host = this.shareLinkHost(context.server, inbound);
    if (!host) throw new Error('No node connection address is configured');
    const links = this.shareLinkEndpoints(protocol, host, port, context.serviceNodeName, streamSettings).map((endpoint) => this.buildLocalShareLink(
      protocol,
      endpoint.host,
      endpoint.port,
      endpoint.name,
      settings,
      endpoint.streamSettings,
      this.xuiObject(remoteClient)
    ));
    if (!links.length || links.some((link) => !this.isShareLink(link))) throw new Error(`Protocol ${protocol} did not produce a supported share link`);
    return [...new Set(links)];
  }

  private buildLocalShareLink(
    protocol: string,
    host: string,
    port: number,
    displayName: string,
    inboundSettings: Record<string, unknown>,
    streamSettings: Record<string, unknown>,
    remoteClient: Record<string, unknown>
  ) {
    const name = displayName.trim() || '3x-ui';
    if (protocol === 'vless') return this.vlessShareLink(host, port, name, inboundSettings, streamSettings, remoteClient);
    if (protocol === 'vmess') return this.vmessShareLink(host, port, name, streamSettings, remoteClient);
    if (protocol === 'trojan') return this.trojanShareLink(host, port, name, streamSettings, remoteClient);
    if (protocol === 'shadowsocks') return this.shadowsocksShareLink(host, port, name, inboundSettings, remoteClient, streamSettings);
    if (protocol === 'hysteria' || protocol === 'hysteria2') return this.hysteriaShareLink(protocol, host, port, name, inboundSettings, streamSettings, remoteClient);
    throw new Error(`Protocol ${protocol} does not have a standard client share link`);
  }

  private vlessShareLink(host: string, port: number, name: string, inboundSettings: Record<string, unknown>, streamSettings: Record<string, unknown>, client: Record<string, unknown>) {
    const id = this.stringValue(client.id) || this.stringValue(client.uuid);
    if (!id) throw new Error('VLESS client UUID is missing');
    const query = this.shareQuery(streamSettings);
    query.set('encryption', this.stringValue(inboundSettings.encryption) || 'none');
    const flow = this.stringValue(client.flow);
    if (flow && this.shareTransport(streamSettings).network === 'tcp' && ['tls', 'reality'].includes(String(streamSettings.security || 'none'))) query.set('flow', flow);
    return `vless://${encodeURIComponent(id)}@${host}:${port}?${query.toString()}#${encodeURIComponent(name)}`;
  }

  private vmessShareLink(host: string, port: number, name: string, streamSettings: Record<string, unknown>, client: Record<string, unknown>) {
    const id = this.stringValue(client.id) || this.stringValue(client.uuid);
    if (!id) throw new Error('VMess client UUID is missing');
    const security = String(streamSettings.security || 'none').toLowerCase();
    if (security === 'reality') throw new Error('VMess over Reality has no interoperable standard share-link format');
    const transport = this.shareTransport(streamSettings);
    const tls = this.shareTls(streamSettings);
    const config: Record<string, string> = {
      v: '2',
      ps: name,
      add: this.unbracketHost(host),
      port: String(port),
      id,
      aid: String(client.alterId ?? client.alterID ?? 0),
      scy: this.stringValue(client.security) || 'auto',
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
    this.applyShareExtras(config, streamSettings, true);
    return `vmess://${Buffer.from(JSON.stringify(config), 'utf8').toString('base64')}`;
  }

  private trojanShareLink(host: string, port: number, name: string, streamSettings: Record<string, unknown>, client: Record<string, unknown>) {
    const password = this.stringValue(client.password);
    if (!password) throw new Error('Trojan client password is missing');
    const query = this.shareQuery(streamSettings);
    const flow = this.stringValue(client.flow);
    if (flow && this.shareTransport(streamSettings).network === 'tcp' && String(streamSettings.security || '') === 'reality') query.set('flow', flow);
    return `trojan://${encodeURIComponent(password)}@${host}:${port}?${query.toString()}#${encodeURIComponent(name)}`;
  }

  private shadowsocksShareLink(host: string, port: number, name: string, inboundSettings: Record<string, unknown>, client: Record<string, unknown>, streamSettings?: Record<string, unknown>) {
    const method = this.stringValue(client.method) || this.stringValue(inboundSettings.method);
    const clientPassword = this.stringValue(client.password);
    const inboundPassword = this.stringValue(inboundSettings.password);
    if (!method || !clientPassword) throw new Error('Shadowsocks method or client password is missing');
    const password = method.startsWith('2022-') && inboundPassword ? `${inboundPassword}:${clientPassword}` : clientPassword;
    const credential = Buffer.from(`${method}:${password}`, 'utf8').toString('base64');
    const query = streamSettings ? this.shareQuery(streamSettings) : new URLSearchParams();
    return `ss://${credential}@${host}:${port}${query.size ? `?${query.toString()}` : ''}#${encodeURIComponent(name)}`;
  }

  private hysteriaShareLink(
    protocol: string,
    host: string,
    port: number,
    name: string,
    inboundSettings: Record<string, unknown>,
    streamSettings: Record<string, unknown>,
    client: Record<string, unknown>
  ) {
    const auth = this.stringValue(client.auth) || this.stringValue(client.password);
    if (!auth) throw new Error('Hysteria client authentication value is missing');
    const version = String(inboundSettings.version || '').toLowerCase();
    const isV2 = protocol === 'hysteria2' || !['1', 'v1', 'hysteria'].includes(version);
    const tls = this.shareTls(streamSettings);
    const query = new URLSearchParams();
    query.set('security', 'tls');
    if (tls.serverName) query.set('sni', tls.serverName);
    if (tls.fingerprint) query.set('fp', tls.fingerprint);
    if (tls.alpn) query.set('alpn', tls.alpn);
    if (tls.insecure) query.set('insecure', '1');
    const salamander = this.salamanderPassword(streamSettings);
    if (salamander) {
      query.set('obfs', 'salamander');
      query.set('obfs-password', salamander);
    }
    this.applyShareExtras(query, streamSettings, false);
    return `${isV2 ? 'hysteria2' : 'hysteria'}://${encodeURIComponent(auth)}@${host}:${port}?${query.toString()}#${encodeURIComponent(name)}`;
  }

  private shareQuery(streamSettings: Record<string, unknown>) {
    const transport = this.shareTransport(streamSettings);
    const tls = this.shareTls(streamSettings);
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
    this.applyShareExtras(query, streamSettings, false);
    return query;
  }

  private shareTransport(streamSettings: Record<string, unknown>) {
    const rawNetwork = String(streamSettings.network || 'tcp').trim().toLowerCase();
    const network = rawNetwork === 'raw' ? 'tcp' : rawNetwork === 'splithttp' ? 'xhttp' : rawNetwork;
    const result: { network: string; headerType?: string; host?: string; path?: string; serviceName?: string; authority?: string; mode?: string; seed?: string; quicSecurity?: string; key?: string; mtu?: string; tti?: string } = { network };
    if (network === 'tcp') {
      const settings = this.xuiObject(streamSettings.tcpSettings || streamSettings.rawSettings);
      const header = this.xuiObject(settings.header);
      result.headerType = this.stringValue(header.type) || 'none';
      const request = this.xuiObject(header.request);
      result.host = this.firstHeaderValue(this.xuiObject(request.headers).Host);
      result.path = this.stringList(request.path)[0];
    } else if (network === 'ws') {
      const settings = this.xuiObject(streamSettings.wsSettings);
      result.path = this.stringValue(settings.path) || '/';
      result.host = this.stringValue(settings.host) || this.firstHeaderValue(this.xuiObject(settings.headers).Host);
    } else if (network === 'grpc') {
      const settings = this.xuiObject(streamSettings.grpcSettings);
      result.serviceName = this.stringValue(settings.serviceName);
      result.path = result.serviceName;
      result.authority = this.stringValue(settings.authority);
      result.mode = settings.multiMode === true ? 'multi' : undefined;
    } else if (network === 'httpupgrade') {
      const settings = this.xuiObject(streamSettings.httpupgradeSettings);
      result.path = this.stringValue(settings.path) || '/';
      result.host = this.stringValue(settings.host) || this.firstHeaderValue(this.xuiObject(settings.headers).Host);
    } else if (network === 'xhttp') {
      const settings = this.xuiObject(streamSettings.xhttpSettings || streamSettings.splithttpSettings);
      result.path = this.stringValue(settings.path) || '/';
      result.host = this.stringValue(settings.host) || this.firstHeaderValue(this.xuiObject(settings.headers).Host);
      result.mode = this.stringValue(settings.mode);
    } else if (network === 'http' || network === 'h2') {
      const settings = this.xuiObject(streamSettings.httpSettings);
      result.network = 'http';
      result.path = this.stringValue(settings.path) || '/';
      result.host = this.stringList(settings.host)[0];
    } else if (network === 'kcp') {
      const settings = this.xuiObject(streamSettings.kcpSettings);
      result.headerType = this.stringValue(this.xuiObject(settings.header).type) || 'none';
      result.seed = this.stringValue(settings.seed);
      result.mtu = this.numberString(settings.mtu);
      result.tti = this.numberString(settings.tti);
      const finalmask = this.xuiObject(streamSettings.finalmask);
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
        const mask = this.xuiObject(item);
        const maskType = String(mask.type || '').toLowerCase();
        if (headerTypes[maskType]) result.headerType = headerTypes[maskType];
        if (maskType === 'mkcp-original') result.seed = undefined;
        if (maskType === 'mkcp-aes128gcm') result.seed = this.stringValue(this.xuiObject(mask.settings).password);
      }
    } else if (network === 'quic') {
      const settings = this.xuiObject(streamSettings.quicSettings);
      result.headerType = this.stringValue(this.xuiObject(settings.header).type) || 'none';
      result.quicSecurity = this.stringValue(settings.security) || 'none';
      result.key = this.stringValue(settings.key);
    }
    return result;
  }

  private shareTls(streamSettings: Record<string, unknown>) {
    const security = String(streamSettings.security || 'none').trim().toLowerCase() || 'none';
    if (security === 'reality') {
      const reality = this.xuiObject(streamSettings.realitySettings);
      const nested = this.xuiObject(reality.settings);
      const privateKey = this.stringValue(reality.privateKey) || this.stringValue(nested.privateKey);
      const publicKey = this.stringValue(reality.publicKey) || this.stringValue(nested.publicKey) || (privateKey ? this.x25519PublicKey(privateKey) : undefined);
      const serverName = this.stringValue(reality.serverName) || this.stringValue(nested.serverName) || this.stringList(reality.serverNames)[0] || this.stringList(nested.serverNames)[0];
      if (!publicKey || !serverName) throw new Error('Reality public key or SNI is missing');
      return {
        security,
        serverName,
        fingerprint: this.stringValue(reality.fingerprint) || this.stringValue(nested.fingerprint) || 'chrome',
        alpn: this.stringList(reality.alpn).join(','),
        publicKey,
        shortId: this.stringValue(nested.shortId) || this.stringList(reality.shortIds)[0] || this.stringList(nested.shortIds)[0],
        mldsa65Verify: this.stringValue(nested.mldsa65Verify) || this.stringValue(reality.mldsa65Verify),
        spiderX: this.stringValue(reality.spiderX) || this.stringValue(nested.spiderX) || '/',
        insecure: false
      };
    }
    const tls = this.xuiObject(streamSettings.tlsSettings);
    const nested = this.xuiObject(tls.settings);
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
      serverName: this.stringValue(tls.serverName) || this.stringValue(nested.serverName),
      fingerprint: this.stringValue(nested.fingerprint) || this.stringValue(tls.fingerprint),
      alpn: this.stringList(tls.alpn).join(','),
      publicKey: undefined,
      shortId: undefined,
      mldsa65Verify: undefined,
      spiderX: undefined,
      insecure: nested.allowInsecure === true || tls.allowInsecure === true || tls.insecure === true
    };
  }

  private x25519PublicKey(privateKey: string) {
    try {
      const raw = Buffer.from(this.normalizeBase64(privateKey), 'base64');
      if (raw.length !== 32) return undefined;
      const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), raw]), format: 'der', type: 'pkcs8' });
      const publicDer = createPublicKey(key).export({ format: 'der', type: 'spki' });
      return Buffer.from(publicDer).subarray(-32).toString('base64url');
    } catch {
      return undefined;
    }
  }

  private shareLinkEndpoints(protocol: string, host: string, port: number, name: string, streamSettings: Record<string, unknown>): Array<{ host: string; port: number; name: string; streamSettings: Record<string, unknown> }> {
    const externalProxies = Array.isArray(streamSettings.externalProxy) ? streamSettings.externalProxy : [];
    const endpoints = externalProxies.flatMap((item) => {
      const proxy = this.xuiObject(item);
      const rawHost = this.stringValue(proxy.dest);
      const proxyPort = this.positiveInteger(proxy.port);
      if (!rawHost || !proxyPort) return [];
      const parsedHost = this.hostFromShareAddress(rawHost);
      if (!parsedHost) return [];
      const unbracketed = this.unbracketHost(parsedHost);
      const endpointHost = unbracketed.includes(':') ? `[${unbracketed}]` : unbracketed;
      const forceTls = String(proxy.forceTls || 'same').trim().toLowerCase();
      const endpointStream = !['hysteria', 'hysteria2'].includes(protocol) && forceTls && forceTls !== 'same'
        ? { ...streamSettings, security: forceTls }
        : streamSettings;
      const extraRemark = this.stringValue(proxy.remark);
      return [{
        host: endpointHost,
        port: proxyPort,
        name: extraRemark ? `${name} - ${extraRemark}` : name,
        streamSettings: endpointStream
      }];
    });
    return endpoints.length ? endpoints : [{ host, port, name, streamSettings }];
  }

  private applyShareExtras(target: Record<string, string> | URLSearchParams, streamSettings: Record<string, unknown>, vmess: boolean) {
    const set = (key: string, value: string) => {
      if (!value) return;
      if (target instanceof URLSearchParams) target.set(key, value);
      else target[key] = value;
    };

    const finalmask = this.xuiObject(streamSettings.finalmask);
    const hasFinalmask = (Array.isArray(finalmask.tcp) && finalmask.tcp.length > 0) ||
      (Array.isArray(finalmask.udp) && finalmask.udp.length > 0) ||
      Object.keys(this.xuiObject(finalmask.quicParams)).length > 0;
    if (hasFinalmask) set('fm', JSON.stringify(finalmask));

    const transport = this.shareTransport(streamSettings);
    if (transport.network !== 'xhttp') return;
    const xhttp = this.xuiObject(streamSettings.xhttpSettings || streamSettings.splithttpSettings);
    const xPaddingBytes = this.stringValue(xhttp.xPaddingBytes);
    if (xPaddingBytes) set('x_padding_bytes', xPaddingBytes);

    const extra: Record<string, unknown> = {};
    for (const key of ['xPaddingBytes', 'sessionPlacement', 'sessionKey', 'seqPlacement', 'seqKey', 'uplinkDataPlacement', 'uplinkDataKey', 'scMaxEachPostBytes']) {
      const value = this.stringValue(xhttp[key]);
      if (value) extra[key] = value;
    }
    if (xhttp.xPaddingObfsMode === true) {
      extra.xPaddingObfsMode = true;
      for (const key of ['xPaddingKey', 'xPaddingHeader', 'xPaddingPlacement', 'xPaddingMethod']) {
        const value = this.stringValue(xhttp[key]);
        if (value) extra[key] = value;
      }
    }
    const headers = this.xuiObject(xhttp.headers);
    const clientHeaders = Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'host'));
    if (Object.keys(clientHeaders).length) extra.headers = clientHeaders;
    if (Object.keys(extra).length) {
      if (vmess && !(target instanceof URLSearchParams)) Object.assign(target, extra);
      else set('extra', JSON.stringify(extra));
    }
  }

  private salamanderPassword(streamSettings: Record<string, unknown>) {
    const finalmask = this.xuiObject(streamSettings.finalmask);
    const masks = Array.isArray(finalmask.udp) ? finalmask.udp : [];
    for (const item of masks) {
      const mask = this.xuiObject(item);
      if (String(mask.type || '').toLowerCase() !== 'salamander') continue;
      const password = this.stringValue(this.xuiObject(mask.settings).password);
      if (password) return password;
    }
    return undefined;
  }

  private numberString(value: unknown) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? String(number) : undefined;
  }

  private shareLinkHost(server: XuiServerConfig, inbound?: Record<string, unknown>) {
    const config = this.xuiObject(server.config);
    const configured = this.stringValue(config.shareHost);
    const listen = this.stringValue(inbound?.listen);
    const usableListen = listen && !['0.0.0.0', '::', '::0'].includes(listen) ? listen : undefined;
    const rawHost = configured
      ? this.hostFromShareAddress(configured)
      : usableListen
        ? this.hostFromShareAddress(usableListen)
        : this.hostFromUrl(server.baseUrl);
    if (!rawHost) return '';
    const host = this.unbracketHost(rawHost);
    return host.includes(':') ? `[${host}]` : host;
  }

  private hostFromShareAddress(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return '';
    if (/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed)) return this.hostFromUrl(trimmed);
    if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
    const withoutPath = trimmed.split('/')[0] || '';
    return /^.+:\d+$/.test(withoutPath) && withoutPath.split(':').length === 2 ? withoutPath.replace(/:\d+$/, '') : withoutPath;
  }

  private unbracketHost(host: string) {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  }

  private firstHeaderValue(value: unknown) {
    if (Array.isArray(value)) return this.stringValue(value[0]);
    return this.stringValue(value);
  }

  private extractLinks(payload: unknown) {
    const links: string[] = [];
    const seen = new Set<unknown>();
    const visit = (value: unknown) => {
      const parsed = this.parseMaybeJson(value);
      if (typeof parsed === 'string') {
        for (const item of parsed.split(/\r?\n/).map((part) => part.trim())) {
          if (this.isShareLink(item)) links.push(item);
        }
        return;
      }
      if (!parsed || typeof parsed !== 'object' || seen.has(parsed)) return;
      seen.add(parsed);
      if (Array.isArray(parsed)) {
        for (const item of parsed) visit(item);
        return;
      }
      const object = parsed as Record<string, unknown>;
      for (const key of ['links', 'link', 'urls', 'url', 'obj', 'data', 'result', 'items']) visit(object[key]);
    };
    visit(payload);
    return [...new Set(links)];
  }

  private renameShareLinks(links: string[], displayName: string) {
    const name = displayName.trim();
    if (!name) return links;
    return links.map((link) => this.renameShareLink(link, name));
  }

  private renameShareLink(link: string, displayName: string) {
    const value = link.trim();
    if (/^vmess:\/\//i.test(value)) return this.renameVmessShareLink(value, displayName);
    const hashIndex = value.indexOf('#');
    const linkWithoutName = hashIndex >= 0 ? value.slice(0, hashIndex) : value;
    return `${linkWithoutName}#${encodeURIComponent(displayName)}`;
  }

  private renameVmessShareLink(link: string, displayName: string) {
    try {
      const payload = link.slice('vmess://'.length);
      const config = JSON.parse(Buffer.from(this.normalizeBase64(payload), 'base64').toString('utf8')) as Record<string, unknown>;
      config.ps = displayName;
      return `vmess://${Buffer.from(JSON.stringify(config), 'utf8').toString('base64')}`;
    } catch {
      return this.renameFragmentShareLink(link, displayName);
    }
  }

  private renameFragmentShareLink(link: string, displayName: string) {
    const hashIndex = link.indexOf('#');
    const linkWithoutName = hashIndex >= 0 ? link.slice(0, hashIndex) : link;
    return `${linkWithoutName}#${encodeURIComponent(displayName)}`;
  }

  private normalizeBase64(value: string) {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    return normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=');
  }

  private async findClient(client: XuiClient, lookup: ClientLookup, inbounds: unknown[]): Promise<ClientMatch> {
    if (client.usesApiProfile('v3.6')) {
      const payload = await client.listClients();
      this.assertXuiSuccess(payload);
      for (const item of this.xuiArray(payload)) {
        const wrapper = this.xuiObject(item);
        const record = this.xuiObject(wrapper.client || item);
        const inboundIds = this.numberList(wrapper.inboundIds ?? record.inboundIds);
        if (lookup.inboundId && !inboundIds.includes(lookup.inboundId)) continue;
        const found = this.v36ClientIdentity(record);
        if (this.clientMatches(found, lookup)) {
          return {
            exists: true,
            raw: record,
            inboundId: lookup.inboundId || inboundIds[0],
            clientId: found.email,
            ...found
          };
        }
      }
    }

    const sorted = [...inbounds].sort((a, b) => {
      if (!lookup.inboundId) return 0;
      const aTarget = this.inboundIdOf(a) === lookup.inboundId ? 1 : 0;
      const bTarget = this.inboundIdOf(b) === lookup.inboundId ? 1 : 0;
      return bTarget - aTarget;
    });

    for (const inbound of sorted) {
      const settings = this.parseMaybeJson(this.xuiObject(inbound).settings);
      const settingsObject = this.xuiObject(settings);
      const clients = Array.isArray(settingsObject.clients) ? settingsObject.clients : [];
      for (const item of clients) {
        const found = this.clientIdentity(item);
        if (this.clientMatches(found, lookup)) {
          return {
            exists: true,
            raw: inbound,
            inboundId: this.inboundIdOf(inbound),
            clientId: this.clientIdForProtocol(item, String(this.xuiObject(inbound).protocol || '')),
            ...found
          };
        }
      }
    }
    return { exists: false, raw: null };
  }

  private async loadRemoteSocksRouteState(client: XuiClient): Promise<RemoteSocksRouteState> {
    const xrayPayload = await client.getXrayConfig();
    this.assertXuiSuccess(xrayPayload);
    const xrayObj = this.xuiObject(this.xuiObject(xrayPayload).obj || this.xuiObject(xrayPayload).data || xrayPayload);
    const rawSetting = xrayObj.xraySetting ?? xrayObj;
    const state = this.remoteSocksRouteState(this.xuiObject(rawSetting));
    await this.mergeOutboundSubscriptions(client, state);
    return state;
  }

  private remoteSocksRouteState(config: Record<string, unknown>): RemoteSocksRouteState {
    const socksOutbounds = new Map<string, RemoteSocksOutbound>();
    const outbounds = this.extractOutbounds(config);
    for (const item of outbounds) {
      this.addRemoteSocksOutbound(socksOutbounds, item);
    }

    const routesByInboundTag = new Map<string, { outboundTag: string; rule: Record<string, unknown> }>();
    const routing = this.xuiObject(config.routing);
    const rules = Array.isArray(routing.rules) ? routing.rules : [];
    for (const item of rules) {
      const rule = this.xuiObject(item);
      const outboundTag = this.stringList(rule.outboundTag).find((tag) => socksOutbounds.has(tag));
      if (!outboundTag) continue;
      for (const inboundTag of this.stringList(rule.inboundTag)) {
        if (!routesByInboundTag.has(inboundTag)) routesByInboundTag.set(inboundTag, { outboundTag, rule });
      }
    }

    return { socksOutbounds, routesByInboundTag };
  }

  private async mergeOutboundSubscriptions(client: XuiClient, state: RemoteSocksRouteState) {
    let subscriptions: unknown[] = [];
    try {
      const payload = await client.listOutboundSubscriptions();
      this.assertXuiSuccess(payload);
      subscriptions = this.xuiArray(payload);
    } catch {
      return;
    }

    for (const item of subscriptions) {
      const subscription = this.xuiObject(item);
      const id = subscription.id ?? subscription.subId ?? subscription.subscriptionId;
      if (id === undefined || id === null || id === '') continue;
      try {
        const payload = await client.refreshOutboundSubscription(String(id));
        this.assertXuiSuccess(payload);
        for (const outbound of this.extractOutbounds(payload)) this.addRemoteSocksOutbound(state.socksOutbounds, outbound);
      } catch {
        // A failed subscription refresh should not block normal inbound sync.
      }
    }
  }

  private addRemoteSocksOutbound(target: Map<string, RemoteSocksOutbound>, item: unknown) {
    const outbound = this.xuiObject(item);
    if (String(outbound.protocol || '').toLowerCase() !== 'socks') return;
    const tag = this.stringValue(outbound.tag);
    const settings = this.xuiObject(outbound.settings);
    const servers = Array.isArray(settings.servers) ? settings.servers : [];
    const server = this.xuiObject(servers[0]);
    const host = this.stringValue(server.address) || this.stringValue(server.host);
    const port = this.positiveInteger(server.port);
    if (!tag || !host || !port) return;
    const users = Array.isArray(server.users) ? server.users : [];
    const user = this.xuiObject(users[0]);
    target.set(tag, {
      tag,
      host,
      port,
      username: this.stringValue(user.user) || this.stringValue(user.username),
      password: this.stringValue(user.pass) || this.stringValue(user.password)
    });
  }

  private extractOutbounds(value: unknown, seen = new Set<unknown>()): unknown[] {
    const parsed = this.parseMaybeJson(value);
    if (!parsed || typeof parsed !== 'object') return [];
    if (seen.has(parsed)) return [];
    seen.add(parsed);

    if (Array.isArray(parsed)) return parsed.flatMap((item) => this.extractOutbounds(item, seen));

    const object = parsed as Record<string, unknown>;
    const self = this.isOutboundConfig(object) ? [object] : [];
    const direct = Array.isArray(object.outbounds) ? object.outbounds : [];
    const nestedKeys = ['obj', 'data', 'result', 'items', 'config', 'xraySetting', 'settings'];
    const nested = nestedKeys.flatMap((key) => this.extractOutbounds(object[key], seen));
    return [...self, ...direct, ...nested];
  }

  private isOutboundConfig(value: Record<string, unknown>) {
    return Boolean(this.stringValue(value.protocol) && this.stringValue(value.tag) && value.settings !== undefined);
  }

  private async importRemoteSocksForInbound(serverId: string, serverName: string, inboundTag: string, state: RemoteSocksRouteState, directOutboundTags: string[] = []) {
    const route = state.routesByInboundTag.get(inboundTag);
    const outboundTag = directOutboundTags.find((tag) => state.socksOutbounds.has(tag)) || route?.outboundTag;
    if (!outboundTag) return null;
    const outbound = state.socksOutbounds.get(outboundTag);
    if (!outbound) return null;

    const socksNode = await this.upsertRemoteSocksNode(serverId, serverName, outbound);

    return { socksNodeId: socksNode.id, outboundTag: outbound.tag };
  }

  private async importRemoteSocksOutbounds(serverId: string, serverName: string, state: RemoteSocksRouteState) {
    const imported = [] as Array<{ socksNodeId: string; outboundTag: string }>;
    for (const outbound of state.socksOutbounds.values()) {
      const socksNode = await this.upsertRemoteSocksNode(serverId, serverName, outbound);
      imported.push({ socksNodeId: socksNode.id, outboundTag: outbound.tag });
    }
    return imported;
  }

  private async upsertRemoteSocksNode(serverId: string, serverName: string, outbound: RemoteSocksOutbound) {
    const username = outbound.username || null;
    const passwordEnc = this.encryption.encryptNullable(outbound.password);
    const existing = await this.prisma.socksNode.findFirst({
      where: {
        OR: [
          { sourceServerId: serverId, remoteOutboundTag: outbound.tag },
          { sourceServerId: null, remoteOutboundTag: null, host: outbound.host, port: outbound.port, username, remark: `Imported from 3x-ui outbound ${outbound.tag}` }
        ]
      }
    });
    if (existing) {
      return this.prisma.socksNode.update({
        where: { id: existing.id },
        data: {
          name: this.truncateText(`${serverName} ${outbound.tag}`, 120),
          host: outbound.host,
          port: outbound.port,
          username,
          passwordEnc,
          enabled: true,
          remark: `Imported from 3x-ui outbound ${outbound.tag}`,
          sourceServerId: serverId,
          remoteOutboundTag: outbound.tag
        }
      });
    }

    return this.prisma.socksNode.create({
      data: {
        name: this.truncateText(`${serverName} ${outbound.tag}`, 120),
        host: outbound.host,
        port: outbound.port,
        username,
        passwordEnc,
        enabled: true,
        remark: `Imported from 3x-ui outbound ${outbound.tag}`,
        sourceServerId: serverId,
        remoteOutboundTag: outbound.tag
      }
    });
  }

  private removeManagedSocksRoute(config: Record<string, unknown>, serviceNodeId: string, inboundTag?: string, remoteOutboundTag?: string) {
    const next: Record<string, unknown> = { ...config };
    const legacyOutboundTag = this.legacySocksOutboundTag(serviceNodeId);
    const explicitOutboundTags = new Set([legacyOutboundTag, remoteOutboundTag].filter((item): item is string => Boolean(item)));
    const outbounds = Array.isArray(next.outbounds) ? next.outbounds : [];
    const socksOutboundTags = new Set(
      outbounds
        .map((item) => this.xuiObject(item))
        .filter((item) => String(item.protocol || '').toLowerCase() === 'socks')
        .map((item) => this.stringValue(item.tag))
        .filter((item): item is string => Boolean(item))
    );
    const removedOutboundTags = new Set<string>(explicitOutboundTags);

    const routing = this.xuiObject(next.routing);
    if (Object.keys(routing).length) {
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      routing.rules = rules.filter((item) => {
        const rule = this.xuiObject(item);
        const shouldRemove = this.isManagedSocksRouteRule(rule, serviceNodeId, explicitOutboundTags, socksOutboundTags, inboundTag);
        if (shouldRemove) {
          for (const tag of this.stringList(rule.outboundTag)) {
            if (explicitOutboundTags.has(tag) || socksOutboundTags.has(tag)) removedOutboundTags.add(tag);
          }
        }
        return !shouldRemove;
      });
      next.routing = routing;
    }

    const nextRouting = this.xuiObject(next.routing);
    const remainingRules = Array.isArray(nextRouting.rules) ? nextRouting.rules : [];
    const stillReferencedOutboundTags = new Set<string>();
    for (const item of remainingRules) {
      for (const tag of this.stringList(this.xuiObject(item).outboundTag)) stillReferencedOutboundTags.add(tag);
    }
    next.outbounds = outbounds.filter((item) => {
      const outbound = this.xuiObject(item);
      const tag = this.stringValue(outbound.tag);
      if (!tag) return true;
      const isServiceManaged = outbound._shiyeServiceNodeId === serviceNodeId || (outbound._shiyeManaged === true && outbound._shiyeMark === SHIYE_ROUTE_MARK && explicitOutboundTags.has(tag));
      if (tag === legacyOutboundTag || isServiceManaged) return false;
      return !(removedOutboundTags.has(tag) && !stillReferencedOutboundTags.has(tag));
    });

    return next;
  }

  private isManagedSocksRouteRule(
    rule: Record<string, unknown>,
    serviceNodeId: string,
    explicitOutboundTags: Set<string>,
    socksOutboundTags: Set<string>,
    inboundTag?: string
  ) {
    const outboundTags = this.stringList(rule.outboundTag);
    if (rule._shiyeServiceNodeId === serviceNodeId) return true;
    if (outboundTags.some((tag) => tag === this.legacySocksOutboundTag(serviceNodeId))) return true;
    if (rule._shiyeManaged === true && rule._shiyeMark === SHIYE_ROUTE_MARK && outboundTags.some((tag) => explicitOutboundTags.has(tag))) return true;
    if (!inboundTag || !this.stringList(rule.inboundTag).includes(inboundTag)) return false;
    return outboundTags.some((tag) => explicitOutboundTags.has(tag) || socksOutboundTags.has(tag));
  }

  private buildSocksOutbound(tag: string, socksNode: { host: string; port: number; username: string | null; passwordEnc: string | null }, serviceNodeId: string) {
    const user = socksNode.username
      ? [{ user: socksNode.username, pass: socksNode.passwordEnc ? this.encryption.decrypt(socksNode.passwordEnc) : '' }]
      : undefined;
    return {
      tag,
      protocol: 'socks',
      settings: {
        servers: [{ address: socksNode.host, port: socksNode.port, users: user }]
      },
      streamSettings: { network: 'tcp' },
      _shiyeManaged: true,
      _shiyeServiceNodeId: serviceNodeId,
      _shiyeMark: SHIYE_ROUTE_MARK
    };
  }

  private ensureRouting(config: Record<string, unknown>) {
    const routing = this.xuiObject(config.routing);
    if (!Array.isArray(routing.rules)) routing.rules = [];
    return routing;
  }

  private socksOutboundTag(serviceNodeId: string, name: string) {
    const readableName = this.readableIdentifier(name, 'outbound', 48);
    const suffix = this.readableIdentifier(serviceNodeId, 'node', 64).slice(-6);
    return `socks-${readableName}-${suffix}`;
  }

  private legacySocksOutboundTag(serviceNodeId: string) {
    return `shiye-socks-${serviceNodeId.slice(0, 18)}`;
  }

  customerClientEmail(name: string, loginUsername: string, inboundId: number) {
    const readableName = this.readableIdentifier(name || loginUsername, 'user', 120);
    return `${readableName}-${inboundId}`;
  }

  private readableIdentifier(value: string, fallback: string, maxLength: number) {
    const normalized = String(value || '').normalize('NFKC').trim()
      .replace(/\s+/g, '-')
      .replace(/[^\p{L}\p{N}._-]+/gu, '-')
      .replace(/^-+|-+$/g, '');
    return this.truncateText(normalized || fallback, maxLength);
  }

  private async verifyRemoteInboundDeleted(client: XuiClient, inboundId: number) {
    const firstCheck = await this.remoteInboundExists(client, inboundId);
    if (!firstCheck.exists) return { absent: true, checked: true, retried: false };

    const retryResponse = await client.deleteInbound(inboundId);
    this.assertXuiSuccess(retryResponse);
    const secondCheck = await this.remoteInboundExists(client, inboundId);
    if (secondCheck.exists) throw new Error(`3x-ui inbound ${inboundId} still exists after retry delete`);

    return { absent: true, checked: true, retried: true, retryResponse: this.toJsonValue(retryResponse) };
  }

  private async remoteInboundExists(client: XuiClient, inboundId: number) {
    try {
      const payload = await client.getInbound(inboundId);
      this.assertXuiSuccess(payload);
      const object = this.xuiObject(payload);
      if ('obj' in object || 'data' in object) {
        const value = object.obj ?? object.data;
        if (!value) return { exists: false };
        const inbound = this.xuiObject(value);
        const id = this.inboundIdOf(inbound);
        return { exists: id ? id === inboundId : Boolean(Object.keys(inbound).length) };
      }
      const inbound = this.xuiObject(payload);
      const id = this.inboundIdOf(inbound);
      return { exists: id === inboundId };
    } catch (error) {
      if (this.isRemoteNotFound(error)) return { exists: false };
      throw error;
    }
  }

  private isRemoteNotFound(error: unknown) {
    return /not found|record not found|404|不存在|未找到|没有找到|未发现|未查询到|找不到|not exist|does not exist|no .*found|empty/i.test(this.errorMessage(error));
  }

  private assertXuiSuccess(payload: unknown) {
    const message = this.xuiFailureMessage(payload);
    if (message) throw new Error(message);
  }

  private xuiFailureMessage(payload: unknown) {
    if (!payload || typeof payload !== 'object') return undefined;
    const record = payload as Record<string, unknown>;
    return record.success === false ? String(record.msg || record.message || '3x-ui returned success=false') : undefined;
  }

  private xuiArray(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    const object = this.xuiObject(data);
    for (const key of ['obj', 'data', 'result', 'items', 'inbounds', 'clients']) {
      const value = this.parseMaybeJson(object[key]);
      if (Array.isArray(value)) return value;
      if (value && typeof value === 'object') {
        for (const nestedKey of ['items', 'inbounds', 'clients']) {
          const nested = (value as Record<string, unknown>)[nestedKey];
          if (Array.isArray(nested)) return nested;
        }
      }
    }
    return [];
  }

  private xuiObject(data: unknown): Record<string, unknown> {
    const parsed = this.parseMaybeJson(data);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    return {};
  }

  private parseMaybeJson(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }

  private inboundIdOf(item: unknown) {
    const object = this.xuiObject(item);
    const value = Number(object.id ?? object.inboundId ?? object.inbound_id ?? object.value);
    return Number.isInteger(value) && value > 0 ? value : 0;
  }

  private remoteInboundName(inbound: Record<string, unknown>, inboundId: number) {
    return String(inbound.remark || inbound.tag || `Inbound ${inboundId}`).trim() || `Inbound ${inboundId}`;
  }

  private remoteInboundFromPayload(payload: unknown) {
    const object = this.xuiObject(payload);
    const value = object.obj ?? object.data ?? object.result ?? object.inbound ?? payload;
    return this.xuiObject(value);
  }

  private positiveInteger(value: unknown) {
    const number = Number(value);
    return Number.isInteger(number) && number > 0 ? number : undefined;
  }

  private booleanValue(value: unknown, fallback: boolean) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
      if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    }
    return fallback;
  }

  private clientEmailOf(item: unknown) {
    const object = this.xuiObject(item);
    return String(object.email || object.clientEmail || object.name || '').trim();
  }

  private clientUuidOf(item: unknown) {
    const object = this.xuiObject(item);
    return String(object.id || object.uuid || object.password || object.auth || object.email || '').trim();
  }

  private clientSubIdOf(item: unknown) {
    const object = this.xuiObject(item);
    return String(object.subId || object.sub_id || object.subscriptionId || '').trim();
  }

  private clientIdentity(item: unknown) {
    return {
      email: this.clientEmailOf(item) || undefined,
      uuid: this.clientUuidOf(item) || undefined,
      subId: this.clientSubIdOf(item) || undefined
    };
  }

  private v36ClientIdentity(item: unknown) {
    const object = this.xuiObject(item);
    const stringId = typeof object.id === 'string' ? object.id.trim() : '';
    return {
      email: this.clientEmailOf(object) || undefined,
      uuid: String(object.uuid || stringId || object.password || object.auth || '').trim() || undefined,
      subId: this.clientSubIdOf(object) || undefined
    };
  }

  private clientIdForProtocol(item: unknown, protocol: string) {
    const object = this.xuiObject(item);
    if (protocol === 'trojan') return this.stringValue(object.password);
    if (protocol === 'shadowsocks') return this.stringValue(object.email);
    if (protocol === 'hysteria' || protocol === 'hysteria2') return this.stringValue(object.auth);
    return this.stringValue(object.id || object.uuid);
  }

  private firstInboundClientIdentity(inbound: unknown): { email?: string; uuid?: string; subId?: string } {
    const settings = this.parseMaybeJson(this.xuiObject(inbound).settings);
    const settingsObject = this.xuiObject(settings);
    const clients = Array.isArray(settingsObject.clients) ? settingsObject.clients : [];
    for (const item of clients) {
      const identity = this.clientIdentity(item);
      if (identity.email || identity.uuid || identity.subId) return identity;
    }
    return {};
  }

  private async firstClientIdentityForInbound(client: XuiClient, inbound: unknown, inboundId: number): Promise<ServiceInboundClientIdentity> {
    if (!client.usesApiProfile('v3.6')) return this.firstInboundClientIdentity(inbound);

    const settings = this.xuiObject(this.parseMaybeJson(this.xuiObject(inbound).settings));
    const clients = Array.isArray(settings.clients) ? settings.clients : [];
    const inline = clients.length ? this.v36ClientIdentity(clients[0]) : {};

    const payload = await client.listClients();
    this.assertXuiSuccess(payload);
    let firstAttached: ServiceInboundClientIdentity | undefined;
    for (const item of this.xuiArray(payload)) {
      const wrapper = this.xuiObject(item);
      const record = this.xuiObject(wrapper.client || item);
      if (!this.numberList(wrapper.inboundIds ?? record.inboundIds).includes(inboundId)) continue;
      const identity = this.v36ClientIdentity(record);
      if (!firstAttached && (identity.email || identity.uuid || identity.subId)) firstAttached = identity;
      if (this.clientMatches(identity, inline)) return identity;
    }
    return firstAttached || inline;
  }

  private inboundClientIdentities(inbound: unknown): ServiceInboundClientIdentity[] {
    const settings = this.xuiObject(this.parseMaybeJson(this.xuiObject(inbound).settings));
    const clients = Array.isArray(settings.clients) ? settings.clients : [];
    return clients.map((item) => this.clientIdentity(item)).filter((item) => item.email || item.uuid || item.subId);
  }

  private clientMatches(identity: { email?: string; uuid?: string; subId?: string }, lookup: ClientLookup) {
    const email = this.normalizeIdentity(identity.email);
    const uuid = this.normalizeIdentity(identity.uuid);
    const subId = this.normalizeIdentity(identity.subId);
    return Boolean(
      (lookup.email && email && email === this.normalizeIdentity(lookup.email)) ||
      (lookup.uuid && uuid && uuid === this.normalizeIdentity(lookup.uuid)) ||
      (lookup.subId && subId && subId === this.normalizeIdentity(lookup.subId))
    );
  }

  private normalizeIdentity(value?: string) {
    return String(value || '').trim().toLowerCase();
  }

  private stringValue(value: unknown) {
    return typeof value === 'string' ? value.trim() || undefined : undefined;
  }

  private stringList(value: unknown) {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    const text = this.stringValue(value);
    return text ? [text] : [];
  }

  private numberList(value: unknown) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0);
  }

  private truncateText(value: string, maxLength: number) {
    return value.length > maxLength ? value.slice(0, maxLength) : value;
  }

  private isShareLink(item: unknown): item is string {
    return typeof item === 'string' && /^(vless|vmess|trojan|ss|shadowsocks|hysteria|hysteria2|hy2):\/\//i.test(item.trim());
  }

  private gbToBytes(value: Prisma.Decimal | number | string | null) {
    if (value === null) return 0;
    const gb = Number(value);
    if (!Number.isFinite(gb) || gb <= 0) return 0;
    return Math.round(gb * 1024 * 1024 * 1024);
  }

  private subscriptionId(uuid: string) {
    return uuid.replace(/-/g, '').slice(0, 16);
  }

  private serviceInboundTag() {
    return `shiye-inbound-${randomUUID().replace(/-/g, '').slice(0, 18)}`;
  }

  private serviceClientEmail(name: string, inboundId: number) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36) || 'node';
    return `shiye-${slug}-${inboundId}@shiye.local`;
  }

  private pickInboundPort(usedPorts: Set<number>) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const port = 20000 + Math.floor(Math.random() * 30000);
      if (!usedPorts.has(port)) return port;
    }
    for (let port = 20000; port <= 50000; port += 1) {
      if (!usedPorts.has(port)) return port;
    }
    throw new BadRequestException('没有可用的 3x-ui 入站端口');
  }

  private extractCreatedInboundId(payload: unknown) {
    const direct = this.inboundIdOf(payload);
    if (direct) return direct;
    const object = this.xuiObject(payload);
    for (const key of ['obj', 'data', 'result', 'inbound']) {
      const value = object[key];
      const id = this.inboundIdOf(value);
      if (id) return id;
    }
    return 0;
  }

  private findCreatedInboundId(payload: unknown, tag: string, remark: unknown, port: number) {
    const created = this.xuiArray(payload).find((item) => {
      const inbound = this.xuiObject(item);
      return inbound.tag === tag || (inbound.remark === remark && Number(inbound.port) === port);
    });
    return this.inboundIdOf(created);
  }

  private randomSecret(bytes = 24) {
    return randomBytes(bytes).toString('base64url');
  }

  private randomShortId() {
    return randomBytes(8).toString('hex');
  }

  private async writeSyncLog(serverId: string | null, action: string, status: string, message: string, detail: unknown, strict = false) {
    const write = this.prisma.syncLog.create({
      data: {
        serverId,
        action,
        status,
        message,
        detail: this.toJsonValue(detail)
      }
    });
    if (strict) {
      await write;
      return;
    }
    await write.catch(() => undefined);
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }

  private isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
