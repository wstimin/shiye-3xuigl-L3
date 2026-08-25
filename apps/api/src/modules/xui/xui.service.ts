import { createHash, createPrivateKey, createPublicKey, randomBytes, randomUUID } from 'node:crypto';
import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { networkRouteUpsertSchema, outboundImportPreviewSchema, outboundImportSchema, remoteClientCreateSchema, remoteClientPatchSchema, xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { XuiClient, type XuiApiProfile } from '@shiye/xui-client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';
import { DatabaseLockService } from '../../shared/database-lock.service.js';

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
  source: 'openapi';
  openApiVersion?: string;
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
  remoteInboundFingerprint?: string;
  remoteInboundObservedFingerprint?: string;
  remoteInboundDrift?: boolean;
  remoteInboundLastCheckedAt?: string;
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
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly locks: DatabaseLockService
  ) {}

  async testConnection(input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient({
      baseUrl: input.baseUrl,
      basePath: input.basePath,
      token: input.token,
      username: input.username,
      password: input.password
    }, true, true);

    const inbounds = await client.listInbounds();
    this.assertXuiSuccess(inbounds);
    return { connected: true, inbounds };
  }

  async testStoredServerDraft(id: string, input: z.infer<typeof xuiServerUpsertSchema>) {
    const client = await this.createAuthenticatedClient(await this.storedServerDraftConfig(id, input), true, true);
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
      label: compatibility.detectedVersion || '3.6 官方 API'
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
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');

    const client = await this.createAuthenticatedClient(server);
    return this.readWebCertFiles(client);
  }

  async storedServerStatus(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');

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
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');

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
    const node = await this.assertManagedServiceNode(serviceNodeId);
    return this.locks.withLock(this.locks.panelOperationKey(node.serverId), () =>
      this.locks.withLock(this.locks.serviceNodeKey(serviceNodeId), async () => {
        const lockedNode = await this.assertManagedServiceNode(serviceNodeId);
        if (lockedNode.serverId !== node.serverId) throw new BadRequestException('服务节点绑定面板已被其他操作修改，请刷新后重试');
        return this.locks.withLock(this.locks.xrayConfigKey(node.serverId), () => this.syncServiceNodeRemoteConfigUnlocked(serviceNodeId, options));
      })
    );
  }

  private async syncServiceNodeRemoteConfigUnlocked(serviceNodeId: string, options: { removeOnly?: boolean } = {}) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');
    if (!serviceNode.inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');

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
    if (!Object.keys(xraySetting).length) throw new BadGatewayException('3x-ui 返回了空 Xray 配置');

    const nextConfig = this.removeManagedSocksRoute(xraySetting, serviceNode.id, inboundTag, config.remoteSocksOutboundTag);
    let action: 'removed' | 'updated' = 'removed';
    let socksDetail: Record<string, unknown> | null = null;

    if (!options.removeOnly && config.socksRelayEnabled) {
      if (!config.socksNodeId) throw new BadRequestException('启用 Socks 中转时必须选择 Socks 节点');
      const socksNode = await this.prisma.socksNode.findUnique({ where: { id: config.socksNodeId } });
      if (!socksNode) throw new NotFoundException('Socks 节点不存在');
      if (!socksNode.enabled) throw new BadRequestException('所选 Socks 节点已停用');

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
      data: {
        config: this.toJsonValue({ ...nextServiceConfig, remoteManaged: true })
      }
    });
    await this.prisma.syncTask.updateMany({
      where: { entityType: 'service-node', entityId: serviceNodeId, action: 'service-config', status: { not: 'resolved' } },
      data: { status: 'resolved', message: null, resolvedAt: new Date() }
    });
    await this.writeSyncLog(serviceNode.serverId, 'service-node-config-sync', 'success', `服务节点 ${serviceNode.name} 的远端配置已${action === 'removed' ? '移除' : '同步'}`, {
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
    return this.locks.withLock(this.locks.panelOperationKey(input.serverId), () => this.createServiceNodeInboundUnlocked(input));
  }

  private async createServiceNodeInboundUnlocked(input: CreateServiceInboundInput) {
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
      const verifiedPayload = await client.getInbound(inboundId);
      this.assertXuiSuccess(verifiedPayload);
      const verifiedInbound = this.remoteInboundFromPayload(verifiedPayload);
      const verifiedStreamSettings = this.xuiObject(this.parseMaybeJson(verifiedInbound.streamSettings));
      const verifiedTag = String(verifiedInbound.tag || tag);
      const verifiedRemark = String(verifiedInbound.remark || payload.remark);
      const verifiedPort = this.positiveInteger(verifiedInbound.port) || port;
      const verifiedProtocol = String(verifiedInbound.protocol || input.protocol);
      const verifiedEnabled = this.booleanValue(verifiedInbound.enable, input.enabled);
      await this.writeSyncLog(server.id, 'service-node-inbound-create', 'success', `已为 ${input.name} 创建入站 ${inboundId}`, {
        inboundId,
        port: verifiedPort,
        protocol: verifiedProtocol,
        tag: verifiedTag,
        reality: this.realityLogDetail(verifiedStreamSettings),
        remoteClientEmail,
        remoteClientUuid,
        remoteClientSubId,
        links,
        response: this.toJsonValue(response),
        clientResponse: this.toJsonValue(clientResponse)
      }, true);
      const reality = this.realityLogDetail(verifiedStreamSettings);
      const remoteInboundLastCheckedAt = new Date().toISOString();
      const remoteInboundFingerprint = this.inboundFingerprint({
        name: this.remoteInboundName(verifiedInbound, inboundId),
        protocol: verifiedProtocol,
        enabled: verifiedEnabled,
        tag: verifiedTag,
        remark: verifiedRemark,
        port: verifiedPort,
        streamSettings: verifiedStreamSettings
      });
      return {
        inboundId,
        port: verifiedPort,
        tag: verifiedTag,
        remark: verifiedRemark,
        remoteInboundFingerprint,
        remoteInboundLastCheckedAt,
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
    if (!remoteClient.email && !remoteClient.uuid && !remoteClient.subId) {
      throw new BadRequestException('该 3x-ui 入站没有可绑定的客户端，请先在官方面板创建客户端，或改用自动创建入站');
    }
    const streamSettings = this.xuiObject(this.parseMaybeJson(inbound.streamSettings));
    const reality = this.realityLogDetail(streamSettings);
    const name = this.remoteInboundName(inbound, inboundId);
    const protocol = String(inbound.protocol || 'vless').trim() || 'vless';
    const enabled = this.booleanValue(inbound.enable, true);
    const port = this.positiveInteger(inbound.port);
    const tag = String(inbound.tag || `inbound-${inboundId}`);
    const remark = String(inbound.remark || '');
    const remoteInboundLastCheckedAt = new Date().toISOString();
    return {
      inboundId,
      valid: true,
      remoteClient,
      name,
      protocol,
      encryption: String(streamSettings.security || 'none').trim() || 'none',
      enabled,
      port,
      tag,
      remark,
      realityTarget: reality?.target,
      realityServerName: reality?.serverName,
      realityMinClientVersion: reality?.minClientVersion,
      transportConfig: this.transportConfigFromStream(streamSettings),
      remoteInboundFingerprint: this.inboundFingerprint({
        name,
        protocol,
        enabled,
        tag,
        remark,
        port: port || null,
        streamSettings
      }),
      remoteInboundLastCheckedAt
    };
  }

  async updateServiceNodeInbound(input: UpdateServiceInboundInput) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');

    const client = await this.createAuthenticatedClient(server);
    const currentPayload = await client.getInbound(input.inboundId);
    this.assertXuiSuccess(currentPayload);
    const currentInbound = this.remoteInboundFromPayload(currentPayload);
    if (!this.inboundIdOf(currentInbound)) throw new BadRequestException(`3x-ui 入站 ${input.inboundId} 不存在`);

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
      throw new BadRequestException(`传输方式 ${requestedTransport} 只能保留现有 3x-ui 入站配置，不能在本面板中重新创建`);
    }
    if (!selectableTransport && currentSecurity !== nextSecurity) {
      throw new BadRequestException(`传输方式 ${requestedTransport} 不支持在本面板中修改安全配置`);
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
    if (!port) throw new BadRequestException('3x-ui 入站缺少有效端口');
    if (port !== this.positiveInteger(currentInbound.port)) {
      const rawInbounds = await client.listInbounds();
      this.assertXuiSuccess(rawInbounds);
      const occupied = this.xuiArray(rawInbounds).some((item) => this.inboundIdOf(item) !== input.inboundId && this.positiveInteger(this.xuiObject(item).port) === port);
      if (occupied) throw new BadRequestException(`3x-ui 入站端口 ${port} 已被占用`);
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
    await this.writeSyncLog(server.id, 'service-node-inbound-update', 'success', `已更新 ${input.name} 的入站 ${input.inboundId}`, {
      inboundId: input.inboundId,
      port,
      protocol: input.protocol,
      runtimeReloadRequired,
      reality: this.realityLogDetail(streamSettings),
      response: this.toJsonValue(response),
      reloadResponse: reloadResponse === undefined ? undefined : this.toJsonValue(reloadResponse),
      runtimeStatus: runtimeStatus === undefined ? undefined : this.toJsonValue(runtimeStatus)
    });
    const remoteInboundTag = String(verifiedInbound.tag || payload.tag || '');
    const remoteInboundRemark = String(verifiedInbound.remark || input.remark || input.name);
    const remoteInboundLastCheckedAt = new Date().toISOString();
    const remoteInboundFingerprint = this.inboundFingerprint({
      name: this.remoteInboundName(verifiedInbound, input.inboundId),
      protocol: String(verifiedInbound.protocol || input.protocol),
      enabled: this.booleanValue(verifiedInbound.enable, input.enabled),
      tag: remoteInboundTag,
      remark: remoteInboundRemark,
      port: this.positiveInteger(verifiedInbound.port) || port,
      streamSettings: this.xuiObject(this.parseMaybeJson(verifiedInbound.streamSettings))
    });
    return {
      updated: true,
      inboundId: input.inboundId,
      port,
      response,
      clientIdentities,
      runtimeReloadRequired,
      remoteInboundTag,
      remoteInboundRemark,
      remoteInboundFingerprint,
      remoteInboundLastCheckedAt
    };
  }

  async setServiceNodeRemoteEnable(serviceNodeId: string, enable: boolean) {
    return this.locks.withLock(this.locks.serviceNodeKey(serviceNodeId), () => this.setServiceNodeRemoteEnableUnlocked(serviceNodeId, enable));
  }

  private async setServiceNodeRemoteEnableUnlocked(serviceNodeId: string, enable: boolean) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');
    if (serviceNode.ownership !== 'managed') throw new BadRequestException('引用入站不能修改远端启用状态，请先明确接管');
    if (!serviceNode.inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');
    await this.assertNoPendingRenewalsForServiceNode(serviceNodeId, '修改远端入站启用状态');
    const client = await this.createAuthenticatedClient(serviceNode.server);
    const response = await client.setInboundEnable(serviceNode.inboundId, enable);
    this.assertXuiSuccess(response);
    const verifiedPayload = await client.getInbound(serviceNode.inboundId);
    this.assertXuiSuccess(verifiedPayload);
    const verifiedInbound = this.remoteInboundFromPayload(verifiedPayload);
    if (this.booleanValue(verifiedInbound.enable, true) !== enable) throw new BadGatewayException('远端入站启用状态回读校验失败');
    const previousConfig = this.xuiObject(serviceNode.config) as ServiceNodeConfig;
    const verifiedStreamSettings = this.xuiObject(this.parseMaybeJson(verifiedInbound.streamSettings));
    const remoteInboundTag = String(verifiedInbound.tag || previousConfig.remoteInboundTag || `inbound-${serviceNode.inboundId}`);
    const remoteInboundRemark = String(verifiedInbound.remark || previousConfig.remoteInboundRemark || serviceNode.name);
    const remoteInboundPort = this.positiveInteger(verifiedInbound.port) || previousConfig.remoteInboundPort || null;
    const remoteInboundFingerprint = this.inboundFingerprint({
      name: this.remoteInboundName(verifiedInbound, serviceNode.inboundId),
      protocol: String(verifiedInbound.protocol || serviceNode.protocol),
      enabled: enable,
      tag: remoteInboundTag,
      remark: remoteInboundRemark,
      port: remoteInboundPort,
      streamSettings: verifiedStreamSettings
    });
    await this.prisma.serviceNode.update({
      where: { id: serviceNodeId },
      data: {
        config: this.toJsonValue({
          ...previousConfig,
          remoteManaged: true,
          remoteInboundTag,
          remoteInboundRemark,
          remoteInboundPort: remoteInboundPort || undefined,
          remoteInboundFingerprint,
          remoteInboundObservedFingerprint: remoteInboundFingerprint,
          remoteInboundDrift: false,
          remoteInboundLastCheckedAt: new Date().toISOString()
        })
      }
    });
    await this.writeSyncLog(serviceNode.serverId, 'service-node-enable-sync', 'success', `已${enable ? '启用' : '停用'}入站 ${serviceNode.inboundId}`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      enable,
      response: this.toJsonValue(response)
    });
    return { synced: true, serviceNodeId, inboundId: serviceNode.inboundId, enable, response };
  }

  async syncServiceNodeTrafficLimit(serviceNodeId: string) {
    return this.locks.withLock(this.locks.serviceNodeKey(serviceNodeId), () => this.syncServiceNodeTrafficLimitUnlocked(serviceNodeId));
  }

  private async syncServiceNodeTrafficLimitUnlocked(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({
      where: { id: serviceNodeId },
      include: {
        server: true,
        customerNodes: { select: { id: true, customerId: true, status: true, remoteControl: true } }
      }
    });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');
    if (serviceNode.ownership !== 'managed') throw new BadRequestException('引用入站不能同步远端客户端额度，请先明确接管');
    if (!serviceNode.inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');
    await this.assertNoPendingRenewalsForServiceNode(serviceNodeId, '同步客户端额度');
    const config = this.xuiObject(serviceNode.config) as ServiceNodeConfig;
    const results: Array<{ target: string; updated: boolean; skipped?: boolean; message?: string }> = [];

    for (const node of serviceNode.customerNodes) {
      if (node.remoteControl === 'reference') {
        results.push({ target: `customer:${node.id}`, updated: false, skipped: true, message: '只读引用绑定不修改远端额度' });
        continue;
      }
      if (!serviceNode.enabled && node.status === 'active') {
        results.push({ target: `customer:${node.id}`, updated: false, skipped: true, message: '服务节点已停用，用户节点无需继续同步为启用' });
        continue;
      }
      try {
        await this.updateCustomerNodeRemoteQuota(node.customerId, node.id, serviceNode.trafficLimitGb);
        results.push({ target: `customer:${node.id}`, updated: true });
      } catch (error) {
        results.push({ target: `customer:${node.id}`, updated: false, message: this.errorMessage(error) });
      }
    }

    const updated = results.filter((item) => item.updated).length;
    const skipped = results.filter((item) => item.skipped).length;
    const failed = results.length - updated - skipped;
    if (failed === 0) await this.prisma.serviceNode.update({ where: { id: serviceNodeId }, data: { config: this.toJsonValue({ ...config, remoteManaged: true }) } });
    await this.writeSyncLog(serviceNode.serverId, 'service-node-traffic-limit-sync', failed ? 'partial' : 'success', `已同步 ${serviceNode.name} 的流量额度`, {
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
    return this.locks.withLock(this.locks.serviceNodeKey(serviceNodeId), () => this.resetServiceNodeTrafficUnlocked(serviceNodeId));
  }

  private async resetServiceNodeTrafficUnlocked(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({
      where: { id: serviceNodeId },
      include: { server: true, customerNodes: { select: { remoteControl: true } } }
    });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');
    if (serviceNode.ownership !== 'managed') throw new BadRequestException('引用入站不能重置远端流量，请先明确接管');
    if (!serviceNode.inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');
    await this.assertNoPendingRenewalsForServiceNode(serviceNodeId, '重置远端入站流量');
    const protectedBindings = serviceNode.customerNodes.filter((node) => node.remoteControl !== 'fully_managed').length;
    if (protectedBindings > 0) {
      throw new BadRequestException(`该入站仍绑定 ${protectedBindings} 个非完全托管账号，整入站重置会影响这些官方账号，请改为逐个重置完全托管账号`);
    }
    const client = await this.createAuthenticatedClient(serviceNode.server);
    const response = await client.resetInboundTraffic(serviceNode.inboundId);
    this.assertXuiSuccess(response);
    await this.prisma.serviceNode.update({
      where: { id: serviceNodeId },
      data: { config: this.toJsonValue({ ...this.xuiObject(serviceNode.config), remoteManaged: true }) }
    });
    await this.prisma.customerNode.updateMany({
      where: { serviceNodeId },
      data: { usedTrafficGb: new Prisma.Decimal(0), lastSyncedAt: new Date() }
    });
    await this.writeSyncLog(serviceNode.serverId, 'service-node-reset-traffic', 'success', `已重置入站 ${serviceNode.inboundId} 的流量`, {
      serviceNodeId,
      inboundId: serviceNode.inboundId,
      response: this.toJsonValue(response)
    });
    return { reset: true, serviceNodeId, inboundId: serviceNode.inboundId, response };
  }

  async resetCustomerNodeTraffic(customerId: string, customerNodeId: string) {
    return this.withCustomerNodeLock(customerId, customerNodeId, () => this.resetCustomerNodeTrafficUnlocked(customerId, customerNodeId));
  }

  private async resetCustomerNodeTrafficUnlocked(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');
    if (customerNode.remoteControl !== 'fully_managed') throw new BadRequestException('只有完全托管账号允许重置远端流量');
    await this.assertNoPendingRenewal(customerNodeId, '重置远端流量');

    const client = await this.createAuthenticatedClient(customerNode.serviceNode.server);
    const inboundId = customerNode.serviceNode.inboundId;
    if (!inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');
    const response = await client.resetClientTraffic(inboundId, customerNode.xuiEmail);
    this.assertXuiSuccess(response);
    await this.prisma.customerNode.update({
      where: { id: customerNodeId },
      data: { usedTrafficGb: new Prisma.Decimal(0), lastSyncedAt: new Date() }
    });
    await this.writeSyncLog(customerNode.serviceNode.serverId, 'customer-node-reset-traffic', 'success', `已重置客户端 ${customerNode.xuiEmail} 的流量`, {
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
    if (!customerNode) throw new NotFoundException('用户节点不存在');

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
    return this.locks.withLock(this.locks.serviceNodeKey(serviceNodeId), () => this.deleteManagedServiceNodeInboundUnlocked(serviceNodeId));
  }

  private async deleteManagedServiceNodeInboundUnlocked(serviceNodeId: string) {
    const serviceNode = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, include: { server: true } });
    if (!serviceNode?.inboundId) return { deleted: false, skipped: true };
    if (serviceNode.ownership !== 'managed') return { deleted: false, skipped: true, reason: '引用入站保留在官方面板' };
    const protectedClients = await this.prisma.customerNode.count({
      where: { serviceNodeId, remoteControl: { not: 'fully_managed' } }
    });
    if (protectedClients > 0) {
      throw new BadRequestException(`该托管入站仍绑定 ${protectedClients} 个非完全托管账号，拒绝删除远端入站`);
    }

    try {
      const client = await this.createAuthenticatedClient(serviceNode.server);
      const remoteClientCleanup = { skipped: true, reason: '客户端将随入站一并删除' };
      const beforeDelete = await this.remoteInboundExists(client, serviceNode.inboundId);
      if (!beforeDelete.exists) {
        await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'success', `入站 ${serviceNode.inboundId} 已不存在`, {
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
      await this.writeSyncLog(serviceNode.serverId, 'service-node-inbound-delete', 'success', `已删除入站 ${serviceNode.inboundId}`, {
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
    return this.locks.withLock(this.locks.panelOperationKey(serverId), async () => {
      const serviceNodeIds = (await this.prisma.serviceNode.findMany({
        where: { serverId },
        select: { id: true },
        orderBy: { id: 'asc' }
      })).map((node) => node.id);
      return this.locks.withLocks(serviceNodeIds.map((id) => this.locks.serviceNodeKey(id)), () =>
        this.locks.withLock(this.locks.xrayConfigKey(serverId), () => this.syncServerUnlocked(serverId))
      );
    });
  }

  private async syncServerUnlocked(serverId: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');

    const client = await this.createAuthenticatedClient(server);
    const payload = await client.listInbounds();
    this.assertXuiSuccess(payload);
    const inbounds = this.xuiArray(payload);
    const remoteInboundIds = new Set(inbounds.map((inbound) => this.inboundIdOf(inbound)).filter((id) => id > 0));
    const xrayPayload = await client.getXrayConfig();
    this.assertXuiSuccess(xrayPayload);
    const xrayObj = this.xuiObject(this.xuiObject(xrayPayload).obj || this.xuiObject(xrayPayload).data || xrayPayload);
    const xraySetting = this.xuiObject(xrayObj.xraySetting ?? xrayObj);
    if (!Object.keys(xraySetting).length) throw new BadGatewayException('3x-ui 返回了空 Xray 配置');
    const remoteSocksState = this.remoteSocksRouteState(xraySetting);
    await this.mergeOutboundSubscriptions(client, remoteSocksState);
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
        const remoteInboundFingerprint = this.inboundFingerprint({
          name,
          protocol,
          enabled,
          tag: inboundTag,
          remark: String(inbound.remark || ''),
          port: port || null,
          streamSettings
        });
        const previousInboundFingerprint = this.stringValue(previousConfig.remoteInboundFingerprint);
        const managedInboundDrifted = Boolean(
          existing && existing.ownership !== 'referenced' && previousInboundFingerprint && previousInboundFingerprint !== remoteInboundFingerprint
        );
        const preserveManagedClientIdentity = Boolean(existing && existing.ownership !== 'referenced');
        const config = {
          ...previousConfig,
          ...remoteSocksConfig,
          remoteMode: existing ? existingRemoteMode : 'bind',
          remoteManaged: existing ? existingRemoteManaged : false,
          remoteInboundTag: inboundTag,
          remoteInboundRemark: String(inbound.remark || previousConfig.remoteInboundRemark || ''),
          remoteInboundPort: port || previousConfig.remoteInboundPort || undefined,
          remoteClientEmail: remoteClient.email || (preserveManagedClientIdentity ? previousConfig.remoteClientEmail : undefined),
          remoteClientUuid: remoteClient.uuid || (preserveManagedClientIdentity ? previousConfig.remoteClientUuid : undefined),
          remoteClientSubId: remoteClient.subId || (preserveManagedClientIdentity ? previousConfig.remoteClientSubId : undefined),
          remoteClientLinks,
          encryption: String(streamSettings.security || previousConfig.encryption || 'none'),
          ...this.transportConfigFromStream(streamSettings),
          importedFromRemote: existing ? Boolean(previousConfig.importedFromRemote) : true,
          remoteInboundFingerprint,
          remoteInboundObservedFingerprint: remoteInboundFingerprint,
          remoteInboundDrift: false,
          remoteInboundLastCheckedAt: new Date().toISOString()
        };

        if (existing) {
          if (managedInboundDrifted) {
            await this.prisma.serviceNode.update({
              where: { id: existing.id },
              data: {
                config: this.toJsonValue({
                  ...previousConfig,
                  remoteInboundObservedFingerprint: remoteInboundFingerprint,
                  remoteInboundDrift: true,
                  remoteInboundLastCheckedAt: new Date().toISOString()
                })
              }
            });
            results.push({
              inboundId,
              name: existing.name,
              action: 'skipped',
              serviceNodeId: existing.id,
              message: '托管入站与官方面板状态不一致，已保留本地配置，请核对后明确同步或接管'
            });
            continue;
          }
          const updated = await this.prisma.serviceNode.update({
            where: { id: existing.id },
            data: existing.ownership === 'referenced' ? {
              name,
              protocol,
              enabled,
              ownership: existing.ownership,
              config: this.toJsonValue(config)
            } : {
              config: this.toJsonValue({
                ...previousConfig,
                remoteInboundFingerprint,
                remoteInboundObservedFingerprint: remoteInboundFingerprint,
                remoteInboundDrift: false,
                remoteInboundLastCheckedAt: new Date().toISOString()
              })
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
              ownership: 'referenced',
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
          if (winner.ownership !== 'referenced') {
            results.push({ inboundId, name: winner.name, action: 'skipped', serviceNodeId: winner.id, message: '并发同步时发现托管入站，已保留本地配置' });
          } else {
            const updated = await this.prisma.serviceNode.update({
              where: { id: winner.id },
              data: { name, protocol, enabled, config: this.toJsonValue(config) }
            });
            results.push({ inboundId, name, action: 'updated', serviceNodeId: updated.id, message: '并发导入已复用现有本地路由节点' });
          }
        }
      } catch (error) {
        results.push({ inboundId, name: inboundId ? `Inbound ${inboundId}` : 'unknown', action: 'skipped', message: this.errorMessage(error) });
      }
    }

    const missingLocalInbounds = await this.prisma.serviceNode.findMany({
      where: { serverId, inboundId: { not: null, notIn: [...remoteInboundIds] } },
      select: { id: true, inboundId: true, name: true, config: true }
    });
    for (const missing of missingLocalInbounds) {
      const previousConfig = this.xuiObject(missing.config);
      await this.prisma.serviceNode.update({
        where: { id: missing.id },
        data: {
          config: this.toJsonValue({
            ...previousConfig,
            remoteInboundDrift: true,
            remoteInboundLastCheckedAt: new Date().toISOString()
          })
        }
      });
      results.push({
        inboundId: missing.inboundId || 0,
        name: missing.name,
        action: 'skipped',
        serviceNodeId: missing.id,
        message: '官方面板中已找不到该入站，已保留本地记录并标记异常，请核对后删除或重新绑定'
      });
    }

    const created = results.filter((item) => item.action === 'created').length;
    const updated = results.filter((item) => item.action === 'updated').length;
    const skipped = results.filter((item) => item.action === 'skipped').length;
    const networkResources = await this.syncNetworkResourcesFromRemote(server.id, xraySetting);
    await this.writeSyncLog(serverId, 'server-inbounds-import', skipped ? 'partial' : 'success', `已从 ${server.name} 导入远端入站`, {
      created,
      updated,
      skipped,
      remoteSocksFound: remoteSocksState.socksOutbounds.size,
      remoteSocksImported: importedSocks.length,
      networkResources,
      results
    });
    return {
      serverId,
      serverName: server.name,
      total: results.length,
      created,
      updated,
      skipped,
      remoteSocksFound: remoteSocksState.socksOutbounds.size,
      remoteSocksImported: importedSocks.length,
      networkResources,
      results
    };
  }

  private async syncNetworkResourcesFromRemote(serverId: string, setting: Record<string, unknown>) {
    const syncedAt = new Date();
    const remoteOutbounds = (Array.isArray(setting.outbounds) ? setting.outbounds : [])
      .map((item) => this.xuiObject(item))
      .filter((item) => this.stringValue(item.tag));
    const existingOutbounds = await this.prisma.networkOutbound.findMany({ where: { serverId } });
    const existingOutboundByTag = new Map(existingOutbounds.map((item) => [item.tag, item]));
    const remoteOutboundTags = new Set<string>();
    const outboundIdsByTag = new Map<string, string>();
    let outboundsCreated = 0;
    let outboundsUpdated = 0;
    let managedOutboundDrift = 0;

    for (const outbound of remoteOutbounds) {
      const tag = this.stringValue(outbound.tag)!;
      remoteOutboundTags.add(tag);
      const protocol = this.stringValue(outbound.protocol) || 'unknown';
      const fingerprint = this.configFingerprint(outbound);
      const existing = existingOutboundByTag.get(tag);
      const managedResourceDrifted = Boolean(existing && existing.ownership !== 'referenced' && existing.remoteFingerprint !== fingerprint);
      if (managedResourceDrifted) managedOutboundDrift += 1;
      const saved = existing
        ? await this.prisma.networkOutbound.update({
          where: { id: existing.id },
          data: managedResourceDrifted ? {
            lastSyncedAt: null
          } : {
            name: existing.name || tag,
            protocol,
            normalizedConfig: this.toJsonValue(outbound),
            remoteFingerprint: fingerprint,
            lastSyncedAt: syncedAt
          }
        })
        : await this.prisma.networkOutbound.create({
          data: {
            serverId,
            name: tag,
            tag,
            protocol,
            ownership: 'referenced',
            sourceFormat: 'xray_json',
            sourceServerId: serverId,
            normalizedConfig: this.toJsonValue(outbound),
            remoteFingerprint: fingerprint,
            lastSyncedAt: syncedAt
          }
        });
      outboundIdsByTag.set(tag, saved.id);
      if (!existing) outboundsCreated += 1;
      else if (!managedResourceDrifted) outboundsUpdated += 1;
    }

    const serviceNodes = await this.prisma.serviceNode.findMany({ where: { serverId }, select: { id: true, config: true } });
    const serviceNodeByInboundTag = new Map<string, string>();
    for (const node of serviceNodes) {
      const tag = this.stringValue(this.xuiObject(node.config).remoteInboundTag);
      if (tag) serviceNodeByInboundTag.set(tag, node.id);
    }

    const routing = this.xuiObject(setting.routing);
    const remoteRules = (Array.isArray(routing.rules) ? routing.rules : []).map((item) => this.xuiObject(item));
    const existingRoutes = await this.prisma.networkRoute.findMany({ where: { serverId } });
    const unusedRoutes = new Set(existingRoutes.map((item) => item.id));
    const fingerprintOccurrences = new Map<string, number>();
    const remoteRouteFingerprints = new Set(remoteRules.map((rule) => this.configFingerprint(rule)));
    let routesCreated = 0;
    let routesUpdated = 0;
    let managedRouteDrift = 0;

    for (let index = 0; index < remoteRules.length; index += 1) {
      const rule = remoteRules[index]!;
      const fingerprint = this.configFingerprint(rule);
      const occurrence = (fingerprintOccurrences.get(fingerprint) || 0) + 1;
      fingerprintOccurrences.set(fingerprint, occurrence);
      let existing = existingRoutes
        .filter((item) => unusedRoutes.has(item.id) && item.remoteFingerprint === fingerprint)
        .sort((left, right) => Math.abs((left.remoteOrder ?? index) - index) - Math.abs((right.remoteOrder ?? index) - index))[0];
      let managedRemoteDrifted = false;
      if (!existing) {
        const orderedManaged = existingRoutes.find((item) =>
          unusedRoutes.has(item.id) &&
          item.ownership !== 'referenced' &&
          item.remoteOrder === index &&
          (!item.remoteFingerprint || !remoteRouteFingerprints.has(item.remoteFingerprint))
        );
        if (orderedManaged) {
          existing = orderedManaged;
          managedRemoteDrifted = true;
        }
      }
      if (existing) unusedRoutes.delete(existing.id);
      const outboundTag = this.stringList(rule.outboundTag)[0];
      const inboundTag = this.stringList(rule.inboundTag)[0];
      const remoteKey = existing?.remoteKey || `route-${fingerprint.slice(0, 20)}-${occurrence}`;
      const data = {
        serviceNodeId: inboundTag ? serviceNodeByInboundTag.get(inboundTag) || null : null,
        outboundId: outboundTag ? outboundIdsByTag.get(outboundTag) || null : null,
        name: existing?.name || `Route ${index + 1}`,
        remoteOrder: index,
        matchConfig: this.toJsonValue(rule),
        normalizedConfig: this.toJsonValue(rule),
        remoteFingerprint: fingerprint,
        lastSyncedAt: syncedAt
      };
      if (existing) {
        const localConfigChanged = existing.ownership !== 'referenced' && this.configFingerprint(existing.normalizedConfig) !== fingerprint;
        const managedResourceDrifted = managedRemoteDrifted || localConfigChanged;
        await this.prisma.networkRoute.update({
          where: { id: existing.id },
          data: managedResourceDrifted ? { remoteOrder: index, lastSyncedAt: null } : data
        });
        if (managedResourceDrifted) managedRouteDrift += 1;
        else routesUpdated += 1;
      } else {
        await this.prisma.networkRoute.upsert({
          where: { serverId_remoteKey: { serverId, remoteKey } },
          create: { serverId, remoteKey, ownership: 'referenced', ...data },
          update: data
        });
        routesCreated += 1;
      }
    }

    const referencedRouteIdsToDelete = existingRoutes
      .filter((item) => unusedRoutes.has(item.id) && item.ownership === 'referenced')
      .map((item) => item.id);
    if (referencedRouteIdsToDelete.length) {
      await this.prisma.networkRoute.deleteMany({ where: { id: { in: referencedRouteIdsToDelete } } });
    }
    const missingManagedRouteIds = existingRoutes
      .filter((item) => unusedRoutes.has(item.id) && item.ownership !== 'referenced')
      .map((item) => item.id);
    if (missingManagedRouteIds.length) {
      await this.prisma.networkRoute.updateMany({ where: { id: { in: missingManagedRouteIds } }, data: { lastSyncedAt: null } });
    }
    managedRouteDrift += missingManagedRouteIds.length;

    const referencedOutboundIdsToDelete = existingOutbounds
      .filter((item) => !remoteOutboundTags.has(item.tag) && item.ownership === 'referenced')
      .map((item) => item.id);
    if (referencedOutboundIdsToDelete.length) {
      await this.prisma.networkOutbound.deleteMany({ where: { id: { in: referencedOutboundIdsToDelete } } });
    }
    const missingManagedOutboundIds = existingOutbounds
      .filter((item) => !remoteOutboundTags.has(item.tag) && item.ownership !== 'referenced')
      .map((item) => item.id);
    if (missingManagedOutboundIds.length) {
      await this.prisma.networkOutbound.updateMany({ where: { id: { in: missingManagedOutboundIds } }, data: { lastSyncedAt: null } });
    }
    managedOutboundDrift += missingManagedOutboundIds.length;

    return {
      outbounds: {
        total: remoteOutbounds.length,
        created: outboundsCreated,
        updated: outboundsUpdated,
        removedReferences: referencedOutboundIdsToDelete.length,
        managedDrift: managedOutboundDrift
      },
      routes: {
        total: remoteRules.length,
        created: routesCreated,
        updated: routesUpdated,
        removedReferences: referencedRouteIdsToDelete.length,
        managedDrift: managedRouteDrift
      }
    };
  }

  async syncServerSocksOutbounds(serverId: string) {
    return this.withPanelXrayLock(serverId, () => this.syncServerSocksOutboundsUnlocked(serverId));
  }

  private async syncServerSocksOutboundsUnlocked(serverId: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');

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
      await this.writeSyncLog(serverId, 'server-socks-outbounds-import', 'success', `已从 ${server.name} 同步远端 SOCKS 出站`, result);
      return result;
    } catch (error) {
      await this.writeSyncLog(serverId, 'server-socks-outbounds-import', 'failed', this.errorMessage(error), { message: this.errorMessage(error) });
      throw new BadGatewayException(`同步远端 Socks 出站失败：${this.errorMessage(error)}`);
    }
  }

  async listNetworkOutbounds(serverId?: string) {
    return this.prisma.networkOutbound.findMany({
      where: { serverId: serverId || undefined },
      orderBy: { createdAt: 'desc' },
      include: { server: { select: { id: true, name: true, enabled: true } }, _count: { select: { routes: true } } }
    });
  }

  previewOutboundImport(input: z.infer<typeof outboundImportPreviewSchema>) {
    const items = this.parseOutboundInput(input.input, input.format);
    return {
      format: input.format,
      count: items.length,
      items: items.map((item) => ({
        name: item.name,
        tag: item.outbound.tag,
        protocol: item.outbound.protocol,
        outbound: item.outbound,
        fingerprint: this.configFingerprint(item.outbound)
      }))
    };
  }

  async importNetworkOutbounds(input: z.infer<typeof outboundImportSchema>) {
    return this.withPanelXrayLock(input.serverId, () => this.importNetworkOutboundsUnlocked(input));
  }

  private async importNetworkOutboundsUnlocked(input: z.infer<typeof outboundImportSchema>) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (input.strategy === 'local_only' && input.conflict === 'takeover') {
      throw new BadRequestException('接管远端出站必须选择写入目标官方面板');
    }
    const parsed = this.parseOutboundInput(input.input, input.format);
    if (!parsed.length) throw new BadRequestException('没有识别到可导入的出站');

    let remoteState: { client: XuiClient; xrayObj: Record<string, unknown>; setting: Record<string, unknown> } | null = null;
    if (input.strategy === 'target_panel') remoteState = await this.loadXrayState(server);
    const existingOutbounds = await this.prisma.networkOutbound.findMany({ where: { serverId: server.id } });
    const existingByTag = new Map(existingOutbounds.map((item) => [item.tag, item]));
    const occupiedTags = new Set([
      ...existingOutbounds.map((item) => item.tag),
      ...(remoteState && Array.isArray(remoteState.setting.outbounds)
        ? remoteState.setting.outbounds.map((item) => this.stringValue(this.xuiObject(item).tag)).filter((item): item is string => Boolean(item))
        : [])
    ]);
    const pending: Array<{
      name: string;
      tag: string;
      protocol: string;
      format: string;
      outbound: Record<string, unknown>;
      fingerprint: string;
      action: 'created' | 'updated';
      existing: (typeof existingOutbounds)[number] | undefined;
    }> = [];

    for (let index = 0; index < parsed.length; index += 1) {
      const parsedItem = parsed[index]!;
      const outbound = { ...parsedItem.outbound };
      if (input.name && parsed.length === 1) parsedItem.name = input.name;
      let tag = this.stringValue(outbound.tag) || this.importedOutboundTag(parsedItem.name, index);
      let existingLocal = existingByTag.get(tag);
      const remoteOutbounds = remoteState && Array.isArray(remoteState.setting.outbounds) ? remoteState.setting.outbounds : [];
      const remoteIndex = remoteOutbounds.findIndex((item) => this.stringValue(this.xuiObject(item).tag) === tag);
      const pendingConflict = pending.some((item) => item.tag === tag);
      const conflict = Boolean(existingLocal || remoteIndex >= 0 || pendingConflict);

      if (pendingConflict && input.conflict !== 'rename') {
        throw new BadRequestException(`导入内容中出站标签 ${tag} 重复；请修正输入或使用自动重命名`);
      }
      if (conflict && input.conflict === 'reject') throw new BadRequestException(`出站标签 ${tag} 已存在`);
      if (conflict && input.conflict === 'rename') {
        tag = this.availableOutboundTag(tag, occupiedTags);
        existingLocal = undefined;
      }
      if (conflict && input.conflict === 'replace_managed' && (!existingLocal || existingLocal.ownership !== 'managed')) {
        throw new BadRequestException(`出站 ${tag} 不是本系统管理资源，不能替换`);
      }
      if (remoteIndex >= 0 && input.conflict === 'replace_managed') {
        const currentRemoteFingerprint = this.configFingerprint(this.xuiObject(remoteOutbounds[remoteIndex]));
        if (!existingLocal?.remoteFingerprint || currentRemoteFingerprint !== existingLocal.remoteFingerprint) {
          throw new BadRequestException(`远端出站 ${tag} 已变化或未经本系统确认；请同步核对后使用明确接管`);
        }
      }
      outbound.tag = tag;
      occupiedTags.add(tag);

      if (remoteState) {
        const currentOutbounds = Array.isArray(remoteState.setting.outbounds) ? remoteState.setting.outbounds : [];
        const currentIndex = currentOutbounds.findIndex((item) => this.stringValue(this.xuiObject(item).tag) === tag);
        if (currentIndex >= 0) currentOutbounds.splice(currentIndex, 1, outbound);
        else currentOutbounds.push(outbound);
        remoteState.setting.outbounds = currentOutbounds;
      }

      const fingerprint = this.configFingerprint(outbound);
      pending.push({
        name: parsedItem.name,
        tag,
        protocol: String(outbound.protocol),
        format: parsedItem.format,
        outbound,
        fingerprint,
        action: existingLocal ? 'updated' : 'created',
        existing: existingLocal
      });
    }

    let remoteWritten = false;
    if (remoteState) {
      await this.writeAndVerifyXrayState(server.id, remoteState, pending.map((item) => item.tag));
      remoteWritten = true;
    }

    const syncedAt = remoteState ? new Date() : null;
    const savedOwnership = remoteState ? 'managed' : input.ownership;
    let savedOutbounds: Array<(typeof existingOutbounds)[number]>;
    try {
      savedOutbounds = await this.prisma.$transaction(pending.map((item) => this.prisma.networkOutbound.upsert({
        where: { serverId_tag: { serverId: server.id, tag: item.tag } },
        create: {
          serverId: server.id,
          name: item.name,
          tag: item.tag,
          protocol: item.protocol,
          ownership: savedOwnership,
          sourceFormat: item.format,
          rawInput: this.toJsonValue(input.input),
          normalizedConfig: this.toJsonValue(item.outbound),
          remoteFingerprint: remoteState ? item.fingerprint : null,
          lastSyncedAt: syncedAt
        },
        update: {
          name: item.name,
          protocol: item.protocol,
          ownership: savedOwnership,
          sourceFormat: item.format,
          rawInput: this.toJsonValue(input.input),
          normalizedConfig: this.toJsonValue(item.outbound),
          remoteFingerprint: remoteState ? item.fingerprint : item.existing?.remoteFingerprint,
          lastSyncedAt: remoteState
            ? syncedAt
            : item.existing && this.configFingerprint(item.existing.normalizedConfig) === item.fingerprint
              ? item.existing.lastSyncedAt
              : null
        }
      })));
    } catch (error) {
      if (remoteWritten) {
        await this.writeSyncLog(server.id, 'network-outbound-import-local-save', 'failed', '官方出站已写入，但本地记录保存失败，请立即执行面板同步并核对', {
          tags: pending.map((item) => item.tag),
          message: this.errorMessage(error)
        });
        throw new BadGatewayException('官方出站已写入，但本地记录保存失败。请立即执行面板同步并核对，避免重复导入');
      }
      throw error;
    }
    const results = savedOutbounds.map((saved, index) => ({
      id: saved.id,
      tag: saved.tag,
      protocol: saved.protocol,
      action: pending[index]!.action
    }));

    const routeResults: Array<{ outboundId: string; outboundTag: string; created: boolean; routeId?: string; message?: string }> = [];
    if (input.createRoute && input.inboundTags.length) {
      for (const result of results) {
        const outbound = await this.prisma.networkOutbound.findUnique({ where: { id: result.id } });
        if (!outbound) continue;
        try {
          const route = await this.upsertNetworkRouteUnlocked({
            serverId: server.id,
            name: `${outbound.name} route`,
            outboundId: outbound.id,
            ownership: remoteState ? 'managed' : input.ownership,
            rule: { type: 'field', inboundTag: input.inboundTags, outboundTag: outbound.tag },
            pushRemote: input.strategy === 'target_panel',
            conflict: input.conflict === 'takeover' ? 'takeover' : input.conflict === 'replace_managed' ? 'replace_managed' : 'reject'
          });
          routeResults.push({ outboundId: outbound.id, outboundTag: outbound.tag, created: true, routeId: route.id });
        } catch (error) {
          routeResults.push({ outboundId: outbound.id, outboundTag: outbound.tag, created: false, message: this.errorMessage(error) });
        }
      }
    }

    const failedRoutes = routeResults.filter((item) => !item.created);
    const state = failedRoutes.length ? 'partial' : 'success';
    const message = failedRoutes.length
      ? `已导入 ${results.length} 个出站，但有 ${failedRoutes.length} 条自动路由创建失败`
      : `已导入 ${results.length} 个出站`;
    await this.writeSyncLog(server.id, 'network-outbound-import', state, message, {
      strategy: input.strategy,
      results,
      routeResults
    });
    return { imported: results.length, strategy: input.strategy, state, message, results, routeResults };
  }

  async deleteNetworkOutbound(id: string, deleteRemote = false, takeover = false) {
    const outbound = await this.prisma.networkOutbound.findUnique({ where: { id }, include: { server: true, routes: true } });
    if (!outbound) throw new NotFoundException('出站不存在');
    return this.withPanelXrayLock(outbound.serverId, () => this.deleteNetworkOutboundUnlocked(id, deleteRemote, takeover));
  }

  private async deleteNetworkOutboundUnlocked(id: string, deleteRemote = false, takeover = false) {
    const outbound = await this.prisma.networkOutbound.findUnique({ where: { id }, include: { server: true, routes: true } });
    if (!outbound) throw new NotFoundException('出站不存在');
    const routes = await this.prisma.networkRoute.findMany({
      where: { serverId: outbound.serverId },
      select: { id: true, outboundId: true, normalizedConfig: true }
    });
    const referencedRoutes = routes.filter((route) =>
      route.outboundId === outbound.id || this.stringList(this.xuiObject(route.normalizedConfig).outboundTag).includes(outbound.tag)
    );
    if (referencedRoutes.length) {
      throw new BadRequestException(`该出站仍被 ${referencedRoutes.length} 条路由规则引用，请先删除关联路由`);
    }
    if (deleteRemote && outbound.ownership !== 'managed' && !takeover) {
      throw new BadRequestException('该出站来自官方面板或由其他来源共享，删除远端配置前必须明确确认接管删除');
    }
    if (deleteRemote && !outbound.remoteFingerprint) throw new BadRequestException('该出站尚未由本系统写入或确认远端状态，不能删除官方面板配置');
    let remote = { deleted: false, skipped: true } as Record<string, unknown>;
    if (deleteRemote) {
      const state = await this.loadXrayState(outbound.server);
      const outbounds = Array.isArray(state.setting.outbounds) ? state.setting.outbounds : [];
      const index = outbounds.findIndex((item) => this.stringValue(this.xuiObject(item).tag) === outbound.tag);
      if (index >= 0) {
        const current = this.xuiObject(outbounds[index]);
        const expectedFingerprint = outbound.remoteFingerprint || this.configFingerprint(outbound.normalizedConfig);
        if (this.configFingerprint(current) !== expectedFingerprint) {
          throw new BadRequestException('远端出站已被其他来源修改，拒绝覆盖删除');
        }
        outbounds.splice(index, 1);
        state.setting.outbounds = outbounds;
        await this.writeAndVerifyXrayState(outbound.serverId, state, [], [outbound.tag]);
        remote = { deleted: true, tag: outbound.tag };
      }
    }
    try {
      await this.prisma.networkOutbound.delete({ where: { id } });
    } catch (error) {
      if (Boolean(remote.deleted)) {
        await this.writeSyncLog(outbound.serverId, 'network-outbound-delete-local-save', 'failed', '官方出站已删除，但本地记录删除失败，请执行面板同步并核对', {
          outboundId: id,
          tag: outbound.tag,
          message: this.errorMessage(error)
        });
        throw new BadGatewayException('官方出站已删除，但本地记录删除失败。请执行面板同步并核对后再操作');
      }
      throw error;
    }
    return { deleted: true, id, remote };
  }

  async listNetworkRoutes(serverId?: string) {
    return this.prisma.networkRoute.findMany({
      where: { serverId: serverId || undefined },
      orderBy: [{ serverId: 'asc' }, { remoteOrder: 'asc' }, { createdAt: 'asc' }],
      include: { server: { select: { id: true, name: true } }, outbound: true, serviceNode: { select: { id: true, name: true, inboundId: true } } }
    });
  }

  async upsertNetworkRoute(input: z.infer<typeof networkRouteUpsertSchema>, id?: string) {
    const current = id ? await this.prisma.networkRoute.findUnique({ where: { id }, select: { serverId: true } }) : null;
    if (id && !current) throw new NotFoundException('路由规则不存在');
    const serverIds = [...new Set([input.serverId, current?.serverId].filter((value): value is string => Boolean(value)))];
    return this.locks.withLocks(serverIds.map((serverId) => this.locks.panelOperationKey(serverId)), () =>
      this.locks.withLock(this.locks.xrayConfigKey(input.serverId), () => this.upsertNetworkRouteUnlocked(input, id))
    );
  }

  private async upsertNetworkRouteUnlocked(input: z.infer<typeof networkRouteUpsertSchema>, id?: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: input.serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    const current = id ? await this.prisma.networkRoute.findUnique({ where: { id } }) : null;
    if (id && !current) throw new NotFoundException('路由规则不存在');
    if (current && current.serverId !== input.serverId) throw new BadRequestException('路由规则不能跨 3x-ui 面板迁移，请在目标面板重新创建');
    if (current && current.ownership !== 'managed' && input.pushRemote && input.conflict !== 'takeover') {
      throw new BadRequestException('同步导入的路由需要使用接管模式后才能写回远端');
    }
    if (current && current.ownership !== 'managed' && !input.pushRemote && input.ownership === 'managed') {
      throw new BadRequestException('引用或共享路由不能仅通过本地修改变为托管；请写回官方面板并明确选择接管');
    }
    const outbound = input.outboundId ? await this.prisma.networkOutbound.findUnique({ where: { id: input.outboundId } }) : null;
    if (input.outboundId && (!outbound || outbound.serverId !== server.id)) throw new BadRequestException('出站不存在或不属于目标面板');
    const serviceNode = input.serviceNodeId ? await this.prisma.serviceNode.findUnique({ where: { id: input.serviceNodeId }, select: { id: true, serverId: true } }) : null;
    if (input.serviceNodeId && (!serviceNode || serviceNode.serverId !== server.id)) throw new BadRequestException('服务节点不存在或不属于目标面板');
    const rule = { ...input.rule } as Record<string, unknown>;
    if (outbound && !rule.outboundTag) rule.outboundTag = outbound.tag;
    if (!this.stringValue(rule.outboundTag)) throw new BadRequestException('路由规则缺少 outboundTag');
    const fingerprint = this.configFingerprint(rule);
    const localConfigChanged = current ? this.configFingerprint(current.normalizedConfig) !== fingerprint : false;
    const remoteKey = current?.remoteKey || `route-${fingerprint.slice(0, 20)}`;
    let remoteOrder = current?.remoteOrder ?? null;

    if (input.pushRemote) {
      const state = await this.loadXrayState(server);
      const routing = this.ensureRouting(state.setting);
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      let index = current?.remoteFingerprint
        ? this.findRemoteRouteIndex(rules, current.remoteFingerprint, current.remoteOrder)
        : -1;
      if (current?.remoteFingerprint && index < 0) {
        if (input.conflict !== 'takeover') throw new BadRequestException('远端路由已变化，拒绝覆盖');
        const takeoverIndex = this.findRemoteRouteIndex(rules, fingerprint, current.remoteOrder);
        if (takeoverIndex < 0) {
          throw new BadRequestException('当前绑定的远端路由已变化且无法精确定位，请先同步官方面板后再接管，系统不会追加重复规则');
        }
        index = takeoverIndex;
      }
      if (index < 0) {
        const duplicate = this.findRemoteRouteIndex(rules, fingerprint, current?.remoteOrder);
        if (duplicate >= 0 && input.conflict === 'reject') throw new BadRequestException('相同远端路由规则已存在');
        if (duplicate >= 0 && input.conflict === 'replace_managed' && (!current || current.ownership !== 'managed')) {
          throw new BadRequestException('相同远端路由不是已确认的本系统托管规则，不能直接替换；请使用明确接管');
        }
        index = duplicate;
      }
      if (index >= 0) rules.splice(index, 1, rule);
      else rules.push(rule);
      routing.rules = rules;
      state.setting.routing = routing;
      remoteOrder = index >= 0 ? index : rules.length - 1;
      await this.writeAndVerifyXrayState(server.id, state, [], [], fingerprint, undefined, {
        expectedRoute: { fingerprint, index: remoteOrder }
      });
    }

    try {
      return current
        ? await this.prisma.networkRoute.update({ where: { id: current.id }, data: {
          name: input.name,
          serviceNodeId: input.serviceNodeId,
          outboundId: input.outboundId,
          ownership: input.pushRemote ? 'managed' : input.ownership,
          matchConfig: this.toJsonValue(rule),
          normalizedConfig: this.toJsonValue(rule),
          remoteFingerprint: input.pushRemote ? fingerprint : current.remoteFingerprint,
          remoteOrder,
          lastSyncedAt: input.pushRemote ? new Date() : localConfigChanged ? null : current.lastSyncedAt
        } })
        : await this.prisma.networkRoute.create({ data: {
          serverId: server.id,
          name: input.name,
          serviceNodeId: input.serviceNodeId,
          outboundId: input.outboundId,
          ownership: input.pushRemote ? 'managed' : input.ownership,
          remoteKey,
          remoteOrder,
          matchConfig: this.toJsonValue(rule),
          normalizedConfig: this.toJsonValue(rule),
          remoteFingerprint: input.pushRemote ? fingerprint : null,
          lastSyncedAt: input.pushRemote ? new Date() : null
        } });
    } catch (error) {
      if (input.pushRemote) {
        await this.writeSyncLog(server.id, 'network-route-local-save', 'failed', '官方路由已写入，但本地记录保存失败，请立即执行面板同步并核对', {
          routeId: current?.id,
          remoteOrder,
          fingerprint,
          message: this.errorMessage(error)
        });
        throw new BadGatewayException('官方路由已写入，但本地记录保存失败。请立即执行面板同步并核对，避免重复添加');
      }
      throw error;
    }
  }

  async deleteNetworkRoute(id: string, deleteRemote = false, takeover = false) {
    const route = await this.prisma.networkRoute.findUnique({ where: { id }, include: { server: true } });
    if (!route) throw new NotFoundException('路由规则不存在');
    return this.withPanelXrayLock(route.serverId, () => this.deleteNetworkRouteUnlocked(id, deleteRemote, takeover));
  }

  private async deleteNetworkRouteUnlocked(id: string, deleteRemote = false, takeover = false) {
    const route = await this.prisma.networkRoute.findUnique({ where: { id }, include: { server: true } });
    if (!route) throw new NotFoundException('路由规则不存在');
    if (deleteRemote && route.ownership !== 'managed' && !takeover) {
      throw new BadRequestException('该路由来自官方面板或由其他来源共享，删除远端配置前必须明确确认接管删除');
    }
    if (deleteRemote && !route.remoteFingerprint) throw new BadRequestException('该路由尚未由本系统写入或确认远端状态，不能删除官方面板配置');
    if (deleteRemote) {
      const state = await this.loadXrayState(route.server);
      const routing = this.ensureRouting(state.setting);
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      const expectedFingerprint = route.remoteFingerprint || this.configFingerprint(route.normalizedConfig);
      const index = this.findRemoteRouteIndex(rules, expectedFingerprint, route.remoteOrder);
      if (index < 0) throw new BadRequestException('远端路由已变化或不存在，拒绝误删');
      const remainingFingerprintCount = rules.filter((item) => this.configFingerprint(this.xuiObject(item)) === expectedFingerprint).length - 1;
      rules.splice(index, 1);
      routing.rules = rules;
      state.setting.routing = routing;
      await this.writeAndVerifyXrayState(route.serverId, state, [], [], undefined, undefined, {
        expectedRouteFingerprintCount: { fingerprint: expectedFingerprint, count: remainingFingerprintCount }
      });
    }
    try {
      await this.prisma.networkRoute.delete({ where: { id } });
    } catch (error) {
      if (deleteRemote) {
        await this.writeSyncLog(route.serverId, 'network-route-delete-local-save', 'failed', '官方路由已删除，但本地记录删除失败，请执行面板同步并核对', {
          routeId: id,
          remoteOrder: route.remoteOrder,
          message: this.errorMessage(error)
        });
        throw new BadGatewayException('官方路由已删除，但本地记录删除失败。请执行面板同步并核对后再操作');
      }
      throw error;
    }
    return { deleted: true, id, remoteDeleted: deleteRemote };
  }

  async deleteRemoteSocksOutbound(serverId: string, outboundTag: string) {
    return this.withPanelXrayLock(serverId, () => this.deleteRemoteSocksOutboundUnlocked(serverId, outboundTag));
  }

  private async deleteRemoteSocksOutboundUnlocked(serverId: string, outboundTag: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id: serverId } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
    if (!server.enabled) throw new BadRequestException('3x-ui 服务器已停用');
    if (!outboundTag) throw new BadRequestException('远端出站标签不能为空');

    try {
      const state = await this.loadXrayState(server);
      const outbounds = Array.isArray(state.setting.outbounds) ? state.setting.outbounds : [];
      const beforeOutbounds = outbounds.length;
      state.setting.outbounds = outbounds.filter((item) => this.stringValue(this.xuiObject(item).tag) !== outboundTag);

      const routing = this.xuiObject(state.setting.routing);
      const rules = Array.isArray(routing.rules) ? routing.rules : [];
      const beforeRules = rules.length;
      const nextRules = rules.filter((item) => !this.stringList(this.xuiObject(item).outboundTag).includes(outboundTag));
      routing.rules = nextRules;
      state.setting.routing = routing;

      const removedOutbounds = beforeOutbounds - (state.setting.outbounds as unknown[]).length;
      const removedRules = beforeRules - nextRules.length;
      if (removedOutbounds || removedRules) {
        const verified = await this.writeAndVerifyXrayState(serverId, state, [], [outboundTag], undefined, undefined, {
          absentRouteOutboundTags: [outboundTag]
        });
        await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'success', `已从 ${server.name} 删除远端 SOCKS 出站 ${outboundTag} 及其引用路由`, {
          outboundTag,
          removedOutbounds,
          removedRules,
          response: this.toJsonValue(verified.response),
          reloadResponse: this.toJsonValue(verified.reloadResponse)
        });
      } else {
        await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'success', `${server.name} 中的远端 SOCKS 出站 ${outboundTag} 及其引用路由已不存在`, {
          outboundTag,
          removedOutbounds,
          removedRules
        });
      }

      return { deleted: true, serverId, serverName: server.name, outboundTag, removedOutbounds, removedRules };
    } catch (error) {
      await this.writeSyncLog(serverId, 'server-socks-outbound-delete', 'failed', this.errorMessage(error), { outboundTag, message: this.errorMessage(error) });
      throw new BadGatewayException(`删除远端 Socks 出站失败：${this.errorMessage(error)}`);
    }
  }

  async deleteCustomerNode(customerId: string, customerNodeId: string, keepTraffic = false) {
    return this.withCustomerNodeLock(customerId, customerNodeId, () => this.deleteCustomerNodeUnlocked(customerId, customerNodeId, keepTraffic));
  }

  private async deleteCustomerNodeUnlocked(customerId: string, customerNodeId: string, keepTraffic = false) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');
    const pendingRenewal = await this.prisma.renewalLog.findFirst({
      where: { customerNodeId, status: 'pending' },
      select: { id: true }
    });
    if (pendingRenewal) throw new BadRequestException('该用户节点存在待处理续费，完成自动恢复或人工对账后才能删除远端账号');
    if (customerNode.remoteControl !== 'fully_managed') throw new BadRequestException('只有完全托管账号允许从远端删除');
    if (!customerNode.serviceNode.inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');
    const result = await this.deleteRemoteClient(customerNode.serviceNode.server, customerNode.serviceNode.inboundId, customerNode.xuiEmail, keepTraffic, {
      customerId,
      customerNodeId,
      serviceNodeId: customerNode.serviceNodeId
    });
    await this.prisma.customerNode.update({
      where: { id: customerNode.id },
      data: { status: 'disabled', disabledReason: 'admin', lastSyncedAt: null }
    });
    return { ...result, bindingRetained: true };
  }

  async deleteServiceNodeClients(serviceNodeId: string, keepTraffic = false) {
    return this.locks.withLock(this.locks.serviceNodeKey(serviceNodeId), () => this.deleteServiceNodeClientsUnlocked(serviceNodeId, keepTraffic));
  }

  private async deleteServiceNodeClientsUnlocked(serviceNodeId: string, keepTraffic = false) {
    const serviceNode = await this.prisma.serviceNode.findUnique({
      where: { id: serviceNodeId },
      include: { server: true, customerNodes: { select: { id: true, customerId: true, xuiEmail: true, remoteControl: true } } }
    });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');
    await this.assertNoPendingRenewalsForServiceNode(serviceNodeId, '批量删除远端账号');

    const results: Array<{ customerNodeId: string; customerId: string; xuiEmail: string; deleted: boolean; skipped?: boolean; message?: string }> = [];
    for (const node of serviceNode.customerNodes) {
      try {
        if (node.remoteControl !== 'fully_managed') {
          results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: false, skipped: true, message: '非完全托管账号不会从官方面板删除' });
          continue;
        }
        const customerNode = await this.prisma.customerNode.findUnique({ where: { id: node.id }, select: { lastSyncedAt: true, config: true } });
        if (!this.shouldDeleteRemoteClient(customerNode)) {
          results.push({ customerNodeId: node.id, customerId: node.customerId, xuiEmail: node.xuiEmail, deleted: false, skipped: true, message: '该账号没有远端同步记录' });
          continue;
        }
        if (!serviceNode.inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');
        await this.deleteRemoteClient(serviceNode.server, serviceNode.inboundId, node.xuiEmail, keepTraffic, {
          customerId: node.customerId,
          customerNodeId: node.id,
          serviceNodeId
        });
        await this.prisma.customerNode.update({
          where: { id: node.id },
          data: { status: 'disabled', disabledReason: 'admin', lastSyncedAt: null }
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

  async refreshCustomerNodeBinding(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      select: { serviceNodeId: true }
    });
    if (!node) throw new NotFoundException('用户节点不存在');
    return this.locks.withLock(this.locks.serviceNodeKey(node.serviceNodeId), () =>
      this.locks.withLock(this.locks.customerNodeKey(customerNodeId), () =>
        this.refreshCustomerNodeBindingUnlocked(customerId, customerNodeId, node.serviceNodeId)
      )
    );
  }

  private async refreshCustomerNodeBindingUnlocked(customerId: string, customerNodeId: string, lockedServiceNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: {
        serviceNode: { include: { server: true } }
      }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');
    if (customerNode.serviceNodeId !== lockedServiceNodeId) throw new BadRequestException('绑定关系已被其他操作修改，请刷新后重试');
    await this.assertNoPendingRenewal(customerNodeId, '刷新绑定');

    const server = customerNode.serviceNode.server;
    const serverId = server.id;

    try {
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
      const savedUuid = typeof savedConfig.uuid === 'string' ? savedConfig.uuid : undefined;
      const savedSubId = typeof savedConfig.subId === 'string' ? savedConfig.subId : undefined;
      const existing = await this.findClient(client, {
        email: customerNode.xuiEmail,
        uuid: customerNode.uuid || savedUuid,
        subId: savedSubId,
        inboundId
      }, inbounds);
      if (!existing.exists) throw new BadRequestException('远端 3x-ui 客户端不存在；绑定刷新不会创建或修改远端账号');

      const uuid = existing.uuid || customerNode.uuid || savedUuid;
      const subId = existing.subId || savedSubId;
      const xuiEmail = existing.email || customerNode.xuiEmail;
      await this.assertRemoteClientBindingAvailable(customerNode.serviceNodeId, xuiEmail, customerNode.id);
      const serviceConfig = this.xuiObject(customerNode.serviceNode.config) as ServiceNodeConfig;
      const links = await this.linksForClient(client, xuiEmail, subId, {
          serverId,
          inboundId,
          serviceNodeName: customerNode.serviceNode.name,
          protocol: customerNode.serviceNode.protocol,
          encryption: String(serviceConfig.encryption || 'none'),
          server,
          uuid
        }).catch(() => Array.isArray(savedConfig.links) ? savedConfig.links.filter((item): item is string => typeof item === 'string') : []);
      const syncedAt = new Date();
      const updatedNode = await this.prisma.customerNode.update({
        where: { id: customerNode.id },
        data: {
        xuiEmail,
          uuid: uuid || null,
        lastSyncedAt: syncedAt,
        config: this.toJsonValue({ ...savedConfig, uuid, subId, links })
        },
        include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
      });

      const detail = {
        customerId,
        customerNodeId,
        inboundId,
        xuiEmail,
        route: 'clients/get',
        action: 'refresh',
        subId,
        links
      };
      await this.writeSyncLog(serverId, 'customer-node-refresh', 'success', `已刷新客户端 ${xuiEmail} 的绑定`, detail);
      return { synced: true, action: 'refresh', route: 'clients/get', remoteWrite: false, node: updatedNode, detail };
    } catch (error) {
      await this.writeSyncLog(serverId, 'customer-node-refresh', 'failed', this.errorMessage(error), {
        customerId,
        customerNodeId,
        xuiEmail: customerNode.xuiEmail
      });
      if (error instanceof BadRequestException || error instanceof NotFoundException) throw error;
      throw new BadGatewayException(`刷新 3x-ui 绑定失败：${this.errorMessage(error)}`);
    }
  }

  async syncCustomerNode(customerId: string, customerNodeId: string) {
    return this.refreshCustomerNodeBinding(customerId, customerNodeId);
  }

  async createCustomerNodeRemoteClient(customerId: string, customerNodeId: string, input: z.infer<typeof remoteClientCreateSchema>) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      select: { serviceNodeId: true }
    });
    if (!node) throw new NotFoundException('用户节点不存在');
    return this.locks.withLock(this.locks.serviceNodeKey(node.serviceNodeId), () =>
      this.locks.withLock(this.locks.customerNodeKey(customerNodeId), () =>
        this.createCustomerNodeRemoteClientUnlocked(customerId, customerNodeId, input, node.serviceNodeId)
      )
    );
  }

  private async createCustomerNodeRemoteClientUnlocked(customerId: string, customerNodeId: string, input: z.infer<typeof remoteClientCreateSchema>, lockedServiceNodeId: string) {
    const node = await this.customerNodeForRemoteOperation(customerId, customerNodeId);
    if (node.serviceNodeId !== lockedServiceNodeId) throw new BadRequestException('绑定关系已被其他操作修改，请刷新后重试');
    if (node.remoteControl !== 'fully_managed') throw new BadRequestException('只有完全托管绑定允许创建远端账号');
    await this.assertNoPendingRenewal(customerNodeId, '创建远端账号');
    if (input.email !== node.xuiEmail) throw new BadRequestException('创建远端客户端必须使用当前绑定的官方标识；如需更换标识，请先修改本地绑定并明确确认接管');
    await this.assertRemoteClientBindingAvailable(node.serviceNodeId, input.email, node.id);
    const inboundId = node.serviceNode.inboundId;
    if (!inboundId) throw new BadRequestException('服务节点缺少 3x-ui 入站 ID');
    const client = await this.createAuthenticatedClient(node.serviceNode.server);
    const occupied = await this.optionalV36ClientRecord(client, input.email);
    if (occupied) throw new BadRequestException(`远端客户端 ${input.email} 已存在`);

    const uuid = input.uuid || randomUUID();
    const subId = input.subId || this.randomSecret(12);
    const payload = this.buildXuiClient({
      protocol: node.serviceNode.protocol,
      uuid,
      subId,
      email: input.email,
      enabled: input.enabled,
      expireAt: input.expireAt,
      trafficLimitGb: input.trafficLimitGb,
      flow: this.clientFlowForServiceNode(node.serviceNode)
    });
    let response: unknown;
    try {
      response = await client.addClient(inboundId, payload);
      this.assertXuiSuccess(response);
    } catch (error) {
      await this.writeSyncLog(node.serviceNode.serverId, 'customer-node-create', 'failed', this.errorMessage(error), {
        customerId,
        customerNodeId,
        serviceNodeId: node.serviceNodeId,
        inboundId,
        xuiEmail: input.email,
        phase: 'remote-create'
      });
      throw error;
    }
    try {
      const verified = await this.findClient(client, { email: input.email, uuid, subId, inboundId }, []);
      if (!verified.exists) throw new BadGatewayException('远端客户端创建后回读失败');
      const savedConfig = this.xuiObject(node.config);
      const binding = await this.prisma.customerNode.update({
        where: { id: node.id },
        data: {
          xuiEmail: input.email,
          uuid: verified.uuid || uuid,
          expireAt: input.expireAt || null,
          trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb),
          status: input.enabled ? 'active' : 'disabled',
          disabledReason: input.enabled ? null : 'admin',
          lastSyncedAt: new Date(),
          config: this.toJsonValue({ ...savedConfig, uuid: verified.uuid || uuid, subId: verified.subId || subId })
        },
        include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
      });
      await this.writeSyncLog(node.serviceNode.serverId, 'customer-node-create', 'success', `已创建客户端 ${input.email}`, {
        customerId,
        customerNodeId,
        serviceNodeId: node.serviceNodeId,
        inboundId,
        xuiEmail: input.email,
        uuid: verified.uuid || uuid,
        subId: verified.subId || subId,
        response: this.toJsonValue(response)
      });
      return { created: true, remoteWrite: true, route: 'clients/add', response, binding };
    } catch (error) {
      await this.writeSyncLog(node.serviceNode.serverId, 'customer-node-create', 'failed', this.errorMessage(error), {
        customerId,
        customerNodeId,
        serviceNodeId: node.serviceNodeId,
        inboundId,
        xuiEmail: input.email,
        phase: 'verify-or-save',
        rollbackAttempted: true
      });
      try {
        await this.deleteRemoteClientWithClient(client, node.serviceNode.serverId, inboundId, input.email, false, {
          customerId,
          customerNodeId,
          serviceNodeId: node.serviceNodeId,
          rollbackOf: 'clients/add'
        });
      } catch (cleanupError) {
        throw new BadGatewayException(`远端客户端已创建，但本地保存失败且自动回滚失败，请立即人工核对 ${input.email}：${this.errorMessage(cleanupError)}`);
      }
      throw error;
    }
  }

  async patchCustomerNodeRemoteClient(customerId: string, customerNodeId: string, input: z.infer<typeof remoteClientPatchSchema>) {
    return this.withCustomerNodeLock(customerId, customerNodeId, () => this.patchCustomerNodeRemoteClientUnlocked(customerId, customerNodeId, input));
  }

  private async patchCustomerNodeRemoteClientUnlocked(customerId: string, customerNodeId: string, input: z.infer<typeof remoteClientPatchSchema>) {
    const node = await this.customerNodeForRemoteOperation(customerId, customerNodeId);
    if (node.remoteControl === 'reference') throw new BadRequestException('只读引用绑定不能修改远端账号');
    await this.assertNoPendingRenewal(customerNodeId, '修改远端账号');
    const patch = {
      ...(input.expireAt === undefined ? {} : { expiryTime: input.expireAt ? input.expireAt.getTime() : 0 }),
      ...(input.trafficLimitGb === undefined ? {} : { totalGB: this.gbToBytes(input.trafficLimitGb) }),
      ...(input.enabled === undefined ? {} : { enable: input.enabled })
    };
    const result = await this.patchCustomerNodeRemote(customerId, customerNodeId, patch, 'account');
    const before = 'before' in result ? result.before : undefined;
    if (!before) throw new BadGatewayException('远端客户端修改前状态缺失，无法保证本地保存一致性');
    try {
      await this.prisma.customerNode.update({
        where: { id: customerNodeId },
        data: {
          expireAt: input.expireAt === undefined ? undefined : input.expireAt,
          trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb),
          status: input.enabled === undefined ? undefined : input.enabled ? 'active' : 'disabled',
          disabledReason: input.enabled === undefined ? undefined : input.enabled ? null : 'admin'
        }
      });
      return result;
    } catch (error) {
      try {
        await this.patchCustomerNodeRemote(customerId, customerNodeId, before, 'account', true);
        await this.writeSyncLog(node.serviceNode.serverId, 'customer-node-account-save', 'failed', this.errorMessage(error), {
          customerId,
          customerNodeId,
          xuiEmail: node.xuiEmail,
          remoteRolledBack: true
        });
      } catch (rollbackError) {
        await this.writeSyncLog(node.serviceNode.serverId, 'customer-node-account-save', 'failed', this.errorMessage(error), {
          customerId,
          customerNodeId,
          xuiEmail: node.xuiEmail,
          remoteRolledBack: false,
          rollbackError: this.errorMessage(rollbackError)
        });
        throw new BadGatewayException(`官方客户端已修改，但本地保存及自动回滚失败，请立即人工核对 ${node.xuiEmail}：${this.errorMessage(rollbackError)}`);
      }
      throw new BadGatewayException(`本地保存失败，官方客户端修改已自动回滚：${this.errorMessage(error)}`);
    }
  }

  async deleteCustomerNodeRemoteClient(customerId: string, customerNodeId: string, keepTraffic = false) {
    return this.deleteCustomerNode(customerId, customerNodeId, keepTraffic);
  }

  async updateCustomerNodeExpiry(customerId: string, customerNodeId: string, expireAt: Date | null, enable?: boolean, allowPendingRenewal = false) {
    return this.withCustomerNodeLock(customerId, customerNodeId, () => this.patchCustomerNodeRemote(customerId, customerNodeId, {
      expiryTime: expireAt ? expireAt.getTime() : 0,
      ...(enable === undefined ? {} : { enable })
    }, 'expiry', allowPendingRenewal));
  }

  async customerNodeRemoteState(customerId: string, customerNodeId: string) {
    const node = await this.customerNodeForRemoteOperation(customerId, customerNodeId);
    const inboundId = node.serviceNode.inboundId;
    if (!inboundId) throw new BadRequestException('服务节点缺少 3x-ui 入站 ID');
    const client = await this.createAuthenticatedClient(node.serviceNode.server);
    const rawInbounds = await client.listInbounds();
    this.assertXuiSuccess(rawInbounds);
    const config = this.xuiObject(node.config);
    const existing = await this.findClient(client, {
      email: node.xuiEmail,
      uuid: node.uuid || this.stringValue(config.uuid),
      subId: this.stringValue(config.subId),
      inboundId
    }, this.xuiArray(rawInbounds));
    if (!existing.exists) throw new BadRequestException('远端 3x-ui 客户端不存在');
    const raw = this.xuiObject(existing.raw);
    const expiryTime = Number(raw.expiryTime);
    return {
      customerId,
      customerNodeId,
      inboundId: existing.inboundId || inboundId,
      xuiEmail: existing.email || node.xuiEmail,
      expiryTime: Number.isFinite(expiryTime) && expiryTime > 0 ? expiryTime : 0,
      enable: this.booleanValue(raw.enable, false)
    };
  }

  async setCustomerNodeRemoteEnabled(customerId: string, customerNodeId: string, enable: boolean) {
    return this.withCustomerNodeLock(customerId, customerNodeId, () => this.patchCustomerNodeRemote(customerId, customerNodeId, { enable }, 'enable'));
  }

  async updateCustomerNodeRemoteQuota(customerId: string, customerNodeId: string, trafficLimitGb: Prisma.Decimal | number | string | null) {
    return this.withCustomerNodeLock(customerId, customerNodeId, () => this.patchCustomerNodeRemote(customerId, customerNodeId, { totalGB: this.gbToBytes(trafficLimitGb) }, 'quota'));
  }

  private async patchCustomerNodeRemote(
    customerId: string,
    customerNodeId: string,
    patch: Record<string, unknown>,
    operation: 'expiry' | 'enable' | 'quota' | 'account',
    allowPendingRenewal = false
  ) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!node) throw new NotFoundException('用户节点不存在');
    if (node.remoteControl === 'reference') {
      return { synced: false, skipped: true, remoteWrite: false, reason: '该绑定为只读引用，不修改远端账号', operation };
    }
    if (!allowPendingRenewal) await this.assertNoPendingRenewal(customerNodeId, '修改远端账号');
    const inboundId = node.serviceNode.inboundId;
    if (!inboundId) throw new BadRequestException('服务节点缺少 3x-ui 入站 ID');
    const client = await this.createAuthenticatedClient(node.serviceNode.server);
    const rawInbounds = await client.listInbounds();
    this.assertXuiSuccess(rawInbounds);
    const existing = await this.findClient(client, {
      email: node.xuiEmail,
      uuid: node.uuid || this.stringValue(this.xuiObject(node.config).uuid),
      subId: this.stringValue(this.xuiObject(node.config).subId),
      inboundId
    }, this.xuiArray(rawInbounds));
    if (!existing.exists) throw new BadRequestException('远端 3x-ui 客户端不存在，精确更新不会创建新账号');

    const current = this.xuiObject(existing.raw);
    const next = { ...current, ...patch };
    const before = Object.fromEntries(Object.keys(patch).map((key) => [key, current[key]]));
    const identifier = existing.email || node.xuiEmail;
    const response = await client.updateClient(existing.inboundId || inboundId, identifier, next);
    this.assertXuiSuccess(response);

    const verifyPayload = await client.listInbounds();
    this.assertXuiSuccess(verifyPayload);
    const refreshed = await this.findClient(client, {
      email: existing.email || node.xuiEmail,
      uuid: existing.uuid || node.uuid || undefined,
      subId: existing.subId,
      inboundId
    }, this.xuiArray(verifyPayload));
    if (!refreshed.exists) throw new BadGatewayException('远端客户端更新后回读失败');
    const verified = this.xuiObject(refreshed.raw);
    for (const [key, value] of Object.entries(patch)) {
      if (!this.remoteClientFieldMatches(key, verified[key], value)) throw new BadGatewayException(`远端客户端字段 ${key} 未按预期更新`);
    }
    const syncedAt = new Date();
    await this.prisma.customerNode.update({ where: { id: node.id }, data: { lastSyncedAt: syncedAt } });
    const detail = { customerId, customerNodeId, inboundId, xuiEmail: existing.email || node.xuiEmail, operation, fields: Object.keys(patch) };
    const operationName = operation === 'expiry' ? '到期时间' : operation === 'enable' ? '启用状态' : operation === 'quota' ? '流量额度' : '账号配置';
    await this.writeSyncLog(node.serviceNode.serverId, `customer-node-${operation}-update`, 'success', `已更新客户端 ${node.xuiEmail} 的${operationName}`, detail);
    return {
      synced: true,
      remoteWrite: true,
      route: 'clients/update',
      operation,
      fields: Object.keys(patch),
      before,
      detail,
      response,
      verified: {
        expiryTime: Number(verified.expiryTime) > 0 ? Number(verified.expiryTime) : 0,
        enable: this.booleanValue(verified.enable, false)
      }
    };
  }

  private async customerNodeForRemoteOperation(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!node) throw new NotFoundException('用户节点不存在');
    return node;
  }

  private async withCustomerNodeLock<T>(customerId: string, customerNodeId: string, operation: () => Promise<T>) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      select: { serviceNodeId: true }
    });
    if (!node) throw new NotFoundException('用户节点不存在');
    return this.locks.withLock(this.locks.serviceNodeKey(node.serviceNodeId), () =>
      this.locks.withLock(this.locks.customerNodeKey(customerNodeId), operation)
    );
  }

  private async assertRemoteClientBindingAvailable(serviceNodeId: string, xuiEmail: string, excludeCustomerNodeId?: string) {
    const occupied = await this.prisma.customerNode.findFirst({
      where: {
        serviceNodeId,
        xuiEmail,
        ...(excludeCustomerNodeId ? { id: { not: excludeCustomerNodeId } } : {})
      },
      select: { id: true }
    });
    if (occupied) {
      throw new BadRequestException('该官方 3x-ui 客户端已绑定其他本地用户；请先解绑原关系，系统不会自动修改或删除远端账号');
    }
  }

  private async assertNoPendingRenewal(customerNodeId: string, action: string) {
    const pending = await this.prisma.renewalLog.findFirst({
      where: { customerNodeId, status: 'pending' },
      select: { id: true }
    });
    if (pending) throw new BadRequestException(`该用户节点存在待处理续费，完成自动恢复或人工对账后才能${action}`);
  }

  private async assertNoPendingRenewalsForServiceNode(serviceNodeId: string, action: string) {
    const pending = await this.prisma.renewalLog.findFirst({
      where: { status: 'pending', customerNode: { serviceNodeId } },
      select: { id: true }
    });
    if (pending) throw new BadRequestException(`该路由节点存在待处理续费，完成自动恢复或人工对账后才能${action}`);
  }

  private async assertManagedServiceNode(serviceNodeId: string) {
    const node = await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId }, select: { id: true, serverId: true, ownership: true } });
    if (!node) throw new NotFoundException('服务节点不存在');
    if (node.ownership !== 'managed') throw new BadRequestException('该入站为官方面板引用资源，请明确接管后再执行远端写操作');
    return node;
  }

  private remoteClientFieldMatches(key: string, actual: unknown, expected: unknown) {
    if (key === 'expiryTime' || key === 'totalGB') return Number(actual) === Number(expected);
    if (key === 'enable') return this.booleanValue(actual, false) === this.booleanValue(expected, false);
    return actual === expected;
  }

  async customerNodeLinks(customerId: string, customerNodeId: string) {
    const customerNode = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      include: { serviceNode: { include: { server: true } } }
    });
    if (!customerNode) throw new NotFoundException('用户节点不存在');
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

  private parseOutboundInput(input: string, requestedFormat: string) {
    const trimmed = input.trim();
    const parseJson = () => {
      let value: unknown;
      try {
        value = JSON.parse(trimmed) as unknown;
      } catch {
        throw new BadRequestException('Xray JSON 格式不正确');
      }
      const root = this.xuiObject(value);
      const values = Array.isArray(value)
        ? value
        : Array.isArray(root.outbounds)
          ? root.outbounds
          : Object.keys(root).length
            ? [root]
            : [];
      return values.map((item, index) => this.normalizeImportedOutbound(this.xuiObject(item), 'xray_json', index));
    };

    if (requestedFormat === 'xray_json' || (requestedFormat === 'auto' && /^[\[{]/.test(trimmed))) return parseJson();
    const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
    if (requestedFormat === 'subscription' || lines.length > 1) {
      return lines.flatMap((line) => this.parseOutboundLink(line, requestedFormat === 'subscription' ? 'auto' : requestedFormat));
    }
    return this.parseOutboundLink(trimmed, requestedFormat);
  }

  private parseOutboundLink(input: string, requestedFormat: string) {
    const scheme = input.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase() || '';
    const format = requestedFormat === 'auto' ? scheme : requestedFormat;
    if (format === 'vmess') return [this.parseVmessOutbound(input)];
    if (format === 'shadowsocks' || format === 'ss') return [this.parseShadowsocksOutbound(input)];
    if (['socks', 'socks5', 'http', 'https', 'vless', 'trojan'].includes(format)) return [this.parseUrlOutbound(input, format)];
    throw new BadRequestException(`暂不支持的出站导入格式：${format || 'unknown'}`);
  }

  private parseUrlOutbound(input: string, format: string) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new BadRequestException(`${format} 出站链接格式不正确`);
    }
    const name = decodeURIComponent(url.hash.replace(/^#/, '')) || `${format}-${url.hostname}`;
    const tag = this.importedOutboundTag(name, 0);
    const port = Number(url.port || (format === 'https' ? 443 : format === 'http' ? 80 : 1080));
    if (!url.hostname || !Number.isInteger(port) || port <= 0 || port > 65535) throw new BadRequestException(`${format} 出站地址或端口不正确`);

    if (format === 'socks' || format === 'socks5' || format === 'http' || format === 'https') {
      const protocol = format.startsWith('socks') ? 'socks' : 'http';
      const username = decodeURIComponent(url.username || '');
      const password = decodeURIComponent(url.password || '');
      return this.normalizeImportedOutbound({
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
    return this.normalizeImportedOutbound({
      tag,
      protocol,
      settings: { servers: [{ address: url.hostname, port, users: [user] }] },
      streamSettings
    }, protocol, 0, name);
  }

  private parseVmessOutbound(input: string) {
    try {
      const raw = input.replace(/^vmess:\/\//i, '');
      const value = JSON.parse(Buffer.from(this.normalizeBase64(raw), 'base64').toString('utf8')) as Record<string, unknown>;
      const name = this.stringValue(value.ps) || `vmess-${this.stringValue(value.add) || 'outbound'}`;
      const network = this.stringValue(value.net) || 'tcp';
      const host = this.stringValue(value.host);
      const path = this.stringValue(value.path);
      const streamSettings: Record<string, unknown> = { network, security: this.stringValue(value.tls) || 'none' };
      if (network === 'ws') streamSettings.wsSettings = { path: path || '/', headers: host ? { Host: host } : {} };
      if (network === 'grpc') streamSettings.grpcSettings = { serviceName: path };
      if (streamSettings.security === 'tls') streamSettings.tlsSettings = { serverName: this.stringValue(value.sni) || host || this.stringValue(value.add) };
      return this.normalizeImportedOutbound({
        tag: this.importedOutboundTag(name, 0),
        protocol: 'vmess',
        settings: { vnext: [{ address: this.stringValue(value.add), port: Number(value.port), users: [{ id: this.stringValue(value.id), alterId: Number(value.aid || 0), security: this.stringValue(value.scy) || 'auto' }] }] },
        streamSettings
      }, 'vmess', 0, name);
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException('VMess 出站链接格式不正确');
    }
  }

  private parseShadowsocksOutbound(input: string) {
    try {
      const raw = input.replace(/^ss:\/\//i, '');
      const hashIndex = raw.indexOf('#');
      const name = hashIndex >= 0 ? decodeURIComponent(raw.slice(hashIndex + 1)) : 'shadowsocks-outbound';
      const withoutHash = hashIndex >= 0 ? raw.slice(0, hashIndex) : raw;
      const atIndex = withoutHash.lastIndexOf('@');
      const decoded = atIndex >= 0
        ? `${Buffer.from(this.normalizeBase64(withoutHash.slice(0, atIndex)), 'base64').toString('utf8')}@${withoutHash.slice(atIndex + 1)}`
        : Buffer.from(this.normalizeBase64(withoutHash), 'base64').toString('utf8');
      const match = decoded.match(/^([^:]+):(.+)@([^:]+):(\d+)$/);
      if (!match) throw new Error('invalid');
      const [, method, password, address, portValue] = match;
      return this.normalizeImportedOutbound({
        tag: this.importedOutboundTag(name, 0),
        protocol: 'shadowsocks',
        settings: { servers: [{ address, port: Number(portValue), method, password }] }
      }, 'shadowsocks', 0, name);
    } catch {
      throw new BadRequestException('Shadowsocks 出站链接格式不正确');
    }
  }

  private normalizeImportedOutbound(outbound: Record<string, unknown>, format: string, index: number, suppliedName?: string) {
    const protocol = String(this.stringValue(outbound.protocol) || '').toLowerCase();
    if (!protocol) throw new BadRequestException('出站缺少 protocol');
    const name = suppliedName || this.stringValue(outbound.tag) || `${protocol}-${index + 1}`;
    return {
      name: this.truncateText(name, 120),
      format,
      outbound: { ...outbound, tag: this.stringValue(outbound.tag) || this.importedOutboundTag(name, index), protocol }
    };
  }

  private importedOutboundTag(name: string, index: number) {
    const readable = this.readableIdentifier(name, 'outbound', 120).toLowerCase();
    return this.truncateText(`${readable}${index ? `-${index + 1}` : ''}`, 160);
  }

  private availableOutboundTag(base: string, occupied: Set<string>) {
    if (!occupied.has(base)) return base;
    for (let suffix = 2; suffix < 10000; suffix += 1) {
      const candidate = this.truncateText(`${base}-${suffix}`, 160);
      if (!occupied.has(candidate)) return candidate;
    }
    throw new BadRequestException(`无法为出站 ${base} 生成可用标签`);
  }

  private configFingerprint(value: unknown) {
    return createHash('sha256').update(this.stableJson(value)).digest('hex');
  }

  private findRemoteRouteIndex(rules: unknown[], fingerprint: string, remoteOrder: number | null | undefined) {
    if (remoteOrder !== null && remoteOrder !== undefined && remoteOrder >= 0 && remoteOrder < rules.length) {
      if (this.configFingerprint(this.xuiObject(rules[remoteOrder])) === fingerprint) return remoteOrder;
    }
    const matches = rules
      .map((item, index) => ({ index, fingerprint: this.configFingerprint(this.xuiObject(item)) }))
      .filter((item) => item.fingerprint === fingerprint);
    if (!matches.length) return -1;
    if (matches.length === 1) return matches[0]!.index;
    if (remoteOrder === null || remoteOrder === undefined) {
      throw new BadRequestException('官方面板存在多条完全相同的路由，缺少顺序信息，拒绝误改或误删');
    }
    const sorted = matches.sort((left, right) => Math.abs(left.index - remoteOrder) - Math.abs(right.index - remoteOrder));
    const nearestDistance = Math.abs(sorted[0]!.index - remoteOrder);
    if (sorted[1] && Math.abs(sorted[1].index - remoteOrder) === nearestDistance) {
      throw new BadRequestException('官方面板存在多条无法唯一定位的相同路由，请先同步核对后再操作');
    }
    return sorted[0]!.index;
  }

  private stableJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => this.stableJson(item)).join(',')}]`;
    if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${this.stableJson(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value ?? null);
  }

  private async loadXrayState(server: XuiServerConfig & { id?: string | null }) {
    if (!server.id) throw new BadRequestException('3x-ui 服务器 ID 缺失');
    const client = await this.createAuthenticatedClient(server);
    const payload = await client.getXrayConfig();
    this.assertXuiSuccess(payload);
    const xrayObj = this.xuiObject(this.xuiObject(payload).obj || this.xuiObject(payload).data || payload);
    const setting = this.xuiObject(xrayObj.xraySetting ?? xrayObj);
    if (!Object.keys(setting).length) throw new BadGatewayException('3x-ui 返回了空 Xray 配置');
    return { client, xrayObj, setting };
  }

  private async writeAndVerifyXrayState(
    serverId: string,
    state: { client: XuiClient; xrayObj: Record<string, unknown>; setting: Record<string, unknown> },
    expectedTags: string[] = [],
    absentTags: string[] = [],
    expectedRouteFingerprint?: string,
    absentRouteFingerprint?: string,
    routeVerification: {
      expectedRoute?: { fingerprint: string; index: number | null };
      expectedRouteFingerprintCount?: { fingerprint: string; count: number };
      absentRouteOutboundTags?: string[];
    } = {}
  ) {
    const outboundTestUrl = typeof state.xrayObj.outboundTestUrl === 'string' ? state.xrayObj.outboundTestUrl : undefined;
    const response = await state.client.updateXrayConfig({ xraySetting: JSON.stringify(state.setting, null, 2), outboundTestUrl });
    this.assertXuiSuccess(response);
    const reloadResponse = await state.client.restartXrayService();
    this.assertXuiSuccess(reloadResponse);
    const verifiedPayload = await state.client.getXrayConfig();
    this.assertXuiSuccess(verifiedPayload);
    const verifiedRoot = this.xuiObject(this.xuiObject(verifiedPayload).obj || this.xuiObject(verifiedPayload).data || verifiedPayload);
    const verified = this.xuiObject(verifiedRoot.xraySetting ?? verifiedRoot);
    const tags = new Set((Array.isArray(verified.outbounds) ? verified.outbounds : []).map((item) => this.stringValue(this.xuiObject(item).tag)).filter(Boolean));
    for (const tag of expectedTags) if (!tags.has(tag)) throw new BadGatewayException(`远端出站 ${tag} 写后回读失败`);
    for (const tag of absentTags) if (tags.has(tag)) throw new BadGatewayException(`远端出站 ${tag} 删除后仍然存在`);
    const rules = Array.isArray(this.xuiObject(verified.routing).rules) ? this.xuiObject(verified.routing).rules as unknown[] : [];
    const fingerprints = rules.map((item) => this.configFingerprint(this.xuiObject(item)));
    const routeFingerprints = new Set(fingerprints);
    if (expectedRouteFingerprint && !routeFingerprints.has(expectedRouteFingerprint)) throw new BadGatewayException('远端路由写后回读失败');
    if (absentRouteFingerprint && routeFingerprints.has(absentRouteFingerprint)) throw new BadGatewayException('远端路由删除后仍然存在');
    if (routeVerification.expectedRoute) {
      const expectedIndex = routeVerification.expectedRoute.index;
      if (expectedIndex === null || expectedIndex < 0 || fingerprints[expectedIndex] !== routeVerification.expectedRoute.fingerprint) {
        throw new BadGatewayException('远端路由顺序或内容写后回读不一致');
      }
    }
    if (routeVerification.expectedRouteFingerprintCount) {
      const expected = routeVerification.expectedRouteFingerprintCount;
      const actualCount = fingerprints.filter((fingerprint) => fingerprint === expected.fingerprint).length;
      if (actualCount !== expected.count) throw new BadGatewayException('远端重复路由删除后回读数量不一致');
    }
    for (const outboundTag of routeVerification.absentRouteOutboundTags || []) {
      if (rules.some((item) => this.stringList(this.xuiObject(item).outboundTag).includes(outboundTag))) {
        throw new BadGatewayException(`远端出站 ${outboundTag} 删除后仍被路由引用`);
      }
    }
    return { response, reloadResponse };
  }

  private async withPanelXrayLock<T>(serverId: string, operation: () => Promise<T>) {
    return this.locks.withLock(this.locks.panelOperationKey(serverId), () =>
      this.locks.withLock(this.locks.xrayConfigKey(serverId), operation)
    );
  }

  private async createAuthenticatedClient(config: XuiServerConfig, autoDetect = true, detectDraft = false) {
    const password = config.password || (config.passwordEnc ? this.encryption.decrypt(config.passwordEnc) : '');
    const token = config.token || (config.tokenEnc ? this.encryption.decrypt(config.tokenEnc) : '');
    const client = new XuiClient({
      baseUrl: config.baseUrl,
      basePath: config.basePath || undefined,
      apiProfile: 'v3.6',
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
      await this.detectAndPersistPanelCompatibility(config, client);
      const detectedClient = new XuiClient({
        baseUrl: config.baseUrl,
        basePath: config.basePath || undefined,
        apiProfile: 'v3.6',
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
    if (apiProfile !== 'v3.6') return undefined;
    return {
      apiProfile,
      detectedVersion: this.stringValue(compatibility.detectedVersion),
      detectedAt: String(compatibility.detectedAt || ''),
      source: 'openapi',
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
        await this.writeSyncLog(server.id || null, 'customer-node-delete', 'success', `远端客户端 ${xuiEmail} 已不存在`, { ...detail, xuiEmail, keepTraffic });
        return { deleted: true, xuiEmail, alreadyAbsent: true };
      }
      await this.writeSyncLog(server.id || null, 'customer-node-delete', 'failed', this.errorMessage(error), { ...detail, xuiEmail, keepTraffic });
      throw new BadGatewayException(`删除 3x-ui 客户端失败：${this.errorMessage(error)}`);
    }
  }

  private async deleteRemoteClientWithClient(client: XuiClient, serverId: string | null | undefined, inboundId: number, xuiEmail: string, keepTraffic: boolean, detail: Record<string, unknown>) {
    const beforeDelete = await this.remoteClientExists(client, inboundId, xuiEmail);
    if (!beforeDelete.exists) {
      await this.writeSyncLog(serverId || null, 'customer-node-delete', 'success', `远端客户端 ${xuiEmail} 已不存在`, { ...detail, inboundId, xuiEmail, keepTraffic, beforeDelete });
      return { deleted: true, inboundId, xuiEmail, alreadyAbsent: true, verified: { absent: true, checked: true, retried: false } };
    }
    const deleteOperation = () => client.deleteClient(inboundId, xuiEmail, undefined, keepTraffic);
    const payload = await deleteOperation();
    this.assertXuiSuccess(payload);
    const verified = await this.verifyRemoteClientDeleted(client, inboundId, xuiEmail, deleteOperation);
    await this.writeSyncLog(serverId || null, 'customer-node-delete', 'success', `已删除远端客户端 ${xuiEmail}`, {
      ...detail,
      inboundId,
      xuiEmail,
      keepTraffic,
      verified,
      response: this.toJsonValue(payload)
    });
    return {
      deleted: true,
      inboundId,
      xuiEmail,
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

  private inboundFingerprint(input: {
    name: string;
    protocol: string;
    enabled: boolean;
    tag: string;
    remark: string;
    port: number | null;
    streamSettings?: Record<string, unknown>;
    encryption?: string;
    transport?: ReturnType<XuiService['normalizeTransportConfig']>;
  }) {
    const streamSettings = input.streamSettings || {};
    return this.configFingerprint({
      name: input.name,
      protocol: input.protocol,
      enabled: input.enabled,
      tag: input.tag,
      remark: input.remark,
      port: input.port,
      encryption: input.encryption || String(streamSettings.security || 'none'),
      transport: input.transport || this.transportConfigFromStream(streamSettings)
    });
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
    const payload = await client.getWebCertFiles();
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
      minClientVersion: this.stringValue(settings.minClient) || '',
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
      if (!publicKey || !serverName) throw new Error('Reality 配置缺少公钥或 SNI');
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
    void inbounds;
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
    return { exists: false, raw: null };
  }

  private async optionalV36ClientRecord(client: XuiClient, email: string) {
    try {
      const record = await client.getClientRecord(email);
      return Object.keys(record).length ? record : undefined;
    } catch (error) {
      if (this.isRemoteNotFound(error)) return undefined;
      throw error;
    }
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
