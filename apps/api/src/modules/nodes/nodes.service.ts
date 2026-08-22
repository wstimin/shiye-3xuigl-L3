import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { customerNodeCreateSchema, serviceNodeUpsertSchema, socksNodeUpsertSchema, xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';
import { XuiService } from '../xui/xui.service.js';

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

type XuiServerConfig = {
  shareHost?: string;
  tlsServerName?: string;
  tlsCertFile?: string;
  tlsKeyFile?: string;
  realityTarget?: string;
  realityServerName?: string;
  realityFingerprint?: string;
  realitySpiderX?: string;
  panelCompatibility?: {
    detectedVersion?: string;
    apiProfile?: 'legacy' | 'v3.6';
    detectedAt?: string;
    source?: string;
    openApiVersion?: string;
  };
};

const SHARE_LINK_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'hysteria2']);

type SyncTaskAction = 'service-inbound' | 'service-clients' | 'service-config' | 'socks-references' | 'service-delete-check' | 'socks-delete-check';

@Injectable()
export class NodesService {
  constructor(private readonly prisma: PrismaService, private readonly encryption: EncryptionService, private readonly xui: XuiService) {}

  async listServers() {
    const servers = await this.prisma.xuiServer.findMany({ orderBy: { createdAt: 'desc' } });
    return servers.map(maskXuiServer);
  }

  async getServerSecrets(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id }, select: { id: true, passwordEnc: true, tokenEnc: true } });
    if (!server) throw new NotFoundException('3x-ui server not found');
    return {
      id: server.id,
      password: this.encryption.decryptNullable(server.passwordEnc) || '',
      token: this.encryption.decryptNullable(server.tokenEnc) || ''
    };
  }

  async createServer(input: z.infer<typeof xuiServerUpsertSchema>) {
    const server = await this.prisma.xuiServer.create({
      data: {
        name: input.name,
        baseUrl: input.baseUrl,
        basePath: input.basePath || null,
        username: input.username || null,
        passwordEnc: this.encryption.encryptNullable(input.password),
        tokenEnc: this.encryption.encryptNullable(input.token),
        config: this.toJsonValue(this.serverConfig(input)),
        enabled: input.enabled,
        remark: input.remark || null
      }
    });
    return maskXuiServer(server);
  }

  async updateServer(id: string, input: Partial<z.infer<typeof xuiServerUpsertSchema>>) {
    const current = await this.prisma.xuiServer.findUnique({ where: { id }, select: { config: true, baseUrl: true, basePath: true } });
    if (!current) throw new NotFoundException('3x-ui server not found');
    const config = this.serverConfig(input, serverConfigFrom(current.config));
    const nextBasePath = input.basePath === undefined ? current.basePath : input.basePath || null;
    if ((input.baseUrl !== undefined && input.baseUrl !== current.baseUrl) || nextBasePath !== current.basePath) {
      delete config.panelCompatibility;
    }
    const server = await this.prisma.xuiServer.update({
      where: { id },
      data: {
        name: input.name,
        baseUrl: input.baseUrl,
        basePath: input.basePath === undefined ? undefined : input.basePath || null,
        username: input.username === undefined ? undefined : input.username || null,
        passwordEnc: input.password === undefined ? undefined : this.encryption.encryptNullable(input.password),
        tokenEnc: input.token === undefined ? undefined : this.encryption.encryptNullable(input.token),
        config: this.toJsonValue(config),
        enabled: input.enabled,
        remark: input.remark === undefined ? undefined : input.remark || null
      }
    });
    return maskXuiServer(server);
  }

  async deleteServer(id: string) {
    await this.ensureServer(id);
    const serviceNodeCount = await this.prisma.serviceNode.count({ where: { serverId: id } });
    if (serviceNodeCount) throw new BadRequestException('请先删除关联路由节点');
    await this.prisma.xuiServer.delete({ where: { id } });
    return { deleted: true, id };
  }

  async listServiceNodes() {
    const nodes = await this.prisma.serviceNode.findMany({
      orderBy: { createdAt: 'desc' },
      include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
    });
    const tasks = await this.pendingTasks('service-node', nodes.map((node) => node.id));
    return nodes.map((node) => ({ ...node, syncTasks: tasks.get(node.id) || [] }));
  }

  async createServiceNode(input: z.infer<typeof serviceNodeUpsertSchema>) {
    if (input.protocol === 'hysteria') input = { ...input, encryption: 'tls', transport: 'tcp' };
    this.assertShareLinkProtocol(input.protocol);
    await this.ensureServer(input.serverId);
    const remoteMode = input.remoteMode || 'create';
    let inboundId = input.inboundId || null;
    let remoteCreated: { inboundId: number; port: number; tag: string; remark: string; remoteClientEmail?: string; remoteClientUuid?: string; remoteClientSubId?: string; links?: string[]; realityTarget?: string; realityServerName?: string } | null = null;
    let remoteClient: { email?: string; uuid?: string; subId?: string } | null = null;
    let remoteValidation: Awaited<ReturnType<XuiService['validateServiceNodeInbound']>> | null = null;
    let localCreated = false;

    if (remoteMode === 'bind') {
      if (!inboundId) throw new BadRequestException('绑定已有入站时必须填写入站 ID');
      await this.assertServiceNodeInboundAvailable(input.serverId, inboundId);
      remoteValidation = await this.xui.validateServiceNodeInbound(input.serverId, inboundId);
      this.assertShareLinkProtocol(remoteValidation.protocol);
      this.assertTransportCompatibility(remoteValidation.protocol, remoteValidation.encryption, remoteValidation.transportConfig.transport);
      remoteClient = remoteValidation.remoteClient;
    } else {
      this.assertTransportCompatibility(input.protocol, input.encryption, input.transport);
      remoteCreated = await this.xui.createServiceNodeInbound({
        serverId: input.serverId,
        name: input.name,
        protocol: input.protocol,
        encryption: input.encryption,
        transport: input.transport,
        tcpHeaderType: input.tcpHeaderType,
        transportHost: input.transportHost,
        transportPath: input.transportPath,
        grpcServiceName: input.grpcServiceName,
        grpcAuthority: input.grpcAuthority,
        grpcMultiMode: input.grpcMultiMode,
        xhttpMode: input.xhttpMode,
        realityTarget: input.realityTarget,
        realityServerName: input.realityServerName,
        realityMinClientVersion: input.realityMinClientVersion,
        enabled: input.enabled,
        port: input.inboundPort,
        remark: input.name,
        trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb)
      });
      inboundId = remoteCreated.inboundId;
      remoteClient = { email: remoteCreated.remoteClientEmail, uuid: remoteCreated.remoteClientUuid, subId: remoteCreated.remoteClientSubId };
    }

    try {
      await this.assertServiceNodeInboundAvailable(input.serverId, inboundId);
    } catch (error) {
      if (remoteCreated) await this.xui.deleteRemoteInbound(input.serverId, remoteCreated.inboundId).catch(() => undefined);
      throw error;
    }

    try {
      const config = await this.serviceNodeConfig(input, null, remoteCreated ? {
        remoteMode,
        remoteManaged: true,
        remoteInboundTag: remoteCreated.tag,
        remoteInboundRemark: remoteCreated.remark,
        remoteInboundPort: remoteCreated.port,
        remoteClientEmail: remoteCreated.remoteClientEmail,
        remoteClientUuid: remoteCreated.remoteClientUuid,
        remoteClientSubId: remoteCreated.remoteClientSubId,
        remoteClientLinks: remoteCreated.links,
        realityTarget: remoteCreated.realityTarget,
        realityServerName: remoteCreated.realityServerName
      } : {
        remoteMode,
        remoteManaged: false,
        remoteInboundPort: remoteValidation?.port || input.inboundPort,
        remoteClientEmail: remoteClient?.email,
        remoteClientUuid: remoteClient?.uuid,
        remoteClientSubId: remoteClient?.subId,
        encryption: remoteValidation?.encryption,
        ...remoteValidation?.transportConfig
      });
      if (remoteValidation) Object.assign(config, { encryption: remoteValidation.encryption, ...remoteValidation.transportConfig });
      const node = await this.prisma.serviceNode.create({
        data: {
          serverId: input.serverId,
          name: input.name,
          inboundId,
          protocol: remoteValidation?.protocol || input.protocol,
          config: this.toJsonValue(config),
          priceMonthly: new Prisma.Decimal(input.priceMonthly),
          trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb),
          enabled: input.enabled,
          remark: input.remark || null
        },
        include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
      });
      localCreated = true;
      const pendingActions: SyncTaskAction[] = [];
      if (config.socksRelayEnabled) {
        try {
          await this.xui.syncServiceNodeRemoteConfig(node.id);
          await this.resolveSyncTask('service-node', node.id, 'service-config');
        } catch (error) {
          pendingActions.push('service-config');
          await this.failSyncTask('service-node', node.id, 'service-config', error);
        }
      }
      return {
        ...node,
        state: pendingActions.length ? 'partial' : 'success',
        message: pendingActions.length ? '创建成功，同步失败' : '创建成功',
        pendingActions
      };
    } catch (error) {
      if (this.isUniqueConstraintError(error)) throw new BadRequestException('该 3x-ui 入站已绑定到其他路由节点');
      if (remoteCreated && !localCreated) await this.xui.deleteRemoteInbound(input.serverId, remoteCreated.inboundId).catch(() => undefined);
      throw error;
    }
  }

  async updateServiceNode(id: string, input: Partial<z.infer<typeof serviceNodeUpsertSchema>>) {
    const current = await this.ensureServiceNode(id);
    if (input.protocol) this.assertShareLinkProtocol(input.protocol);
    if (input.serverId) await this.ensureServer(input.serverId);
    const nextServerId = input.serverId || current.serverId;
    const previousConfig = jsonObject(current.config) as ServiceNodeConfig;
    const remoteMode = input.remoteMode || previousConfig.remoteMode || (current.inboundId ? 'bind' : 'create');
    let inboundId = input.inboundId === undefined ? current.inboundId : input.inboundId || null;
    let remoteCreated: { inboundId: number; port: number; tag: string; remark: string; remoteClientEmail?: string; remoteClientUuid?: string; remoteClientSubId?: string; links?: string[]; realityTarget?: string; realityServerName?: string } | null = null;
    let remoteClient: { email?: string; uuid?: string; subId?: string } | null = null;
    let remoteValidation: Awaited<ReturnType<XuiService['validateServiceNodeInbound']>> | null = null;
    let localUpdated = false;
    const nextName = input.name || current.name;
    let nextProtocol = input.protocol || current.protocol;
    let nextEncryption = input.encryption || previousConfig.encryption || 'none';
    let nextTransport = input.transport || previousConfig.transport || 'tcp';
    if ((nextProtocol === 'hysteria' || nextProtocol === 'hysteria2')) {
      nextEncryption = 'tls';
      nextTransport = 'tcp';
    } else {
      if (!['vless', 'trojan'].includes(nextProtocol) && nextEncryption === 'reality' && input.encryption === undefined) nextEncryption = 'none';
      if (nextProtocol === 'shadowsocks') nextTransport = 'tcp';
    }
    input = { ...input, encryption: nextEncryption as 'none' | 'tls' | 'reality', transport: nextTransport as 'tcp' | 'ws' | 'grpc' | 'httpupgrade' | 'xhttp' };
    this.assertTransportCompatibility(nextProtocol, nextEncryption, nextTransport);
    const nextEnabled = input.enabled ?? current.enabled;
    let nextRemotePort = input.inboundPort === undefined ? previousConfig.remoteInboundPort : input.inboundPort;
    const nextRemark = input.remark === undefined ? current.remark : input.remark || null;
    const nextRemoteRemark = nextName;
    const trafficLimitChanged = input.trafficLimitGb !== undefined && Number(input.trafficLimitGb) !== Number(current.trafficLimitGb);
    const socksConfigChanged = Boolean(
      input.socksRelayEnabled !== undefined && input.socksRelayEnabled !== Boolean(previousConfig.socksRelayEnabled) ||
      input.socksNodeId !== undefined && (input.socksNodeId || null) !== (previousConfig.socksNodeId || null)
    );

    if (remoteMode === 'bind') {
      if (!inboundId) throw new BadRequestException('绑定已有入站时必须填写入站 ID');
      await this.assertServiceNodeInboundAvailable(nextServerId, inboundId, id);
      const bindingChanged = nextServerId !== current.serverId || inboundId !== current.inboundId || previousConfig.remoteMode !== 'bind';
      if (bindingChanged) {
        remoteValidation = await this.xui.validateServiceNodeInbound(nextServerId, inboundId);
        this.assertShareLinkProtocol(remoteValidation.protocol);
        this.assertTransportCompatibility(remoteValidation.protocol, remoteValidation.encryption, remoteValidation.transportConfig.transport);
        remoteClient = remoteValidation.remoteClient;
        nextProtocol = remoteValidation.protocol;
        nextEncryption = remoteValidation.encryption;
        nextTransport = remoteValidation.transportConfig.transport;
        nextRemotePort = remoteValidation.port || nextRemotePort;
      } else {
        remoteClient = {
          email: previousConfig.remoteClientEmail,
          uuid: previousConfig.remoteClientUuid,
          subId: previousConfig.remoteClientSubId
        };
      }
    } else if (!inboundId) {
      remoteCreated = await this.xui.createServiceNodeInbound({
        serverId: nextServerId,
        name: nextName,
        protocol: nextProtocol,
        encryption: nextEncryption,
        transport: nextTransport,
        tcpHeaderType: input.tcpHeaderType || previousConfig.tcpHeaderType || 'none',
        transportHost: input.transportHost === undefined ? previousConfig.transportHost : input.transportHost,
        transportPath: input.transportPath === undefined ? previousConfig.transportPath : input.transportPath,
        grpcServiceName: input.grpcServiceName === undefined ? previousConfig.grpcServiceName : input.grpcServiceName,
        grpcAuthority: input.grpcAuthority === undefined ? previousConfig.grpcAuthority : input.grpcAuthority,
        grpcMultiMode: input.grpcMultiMode === undefined ? previousConfig.grpcMultiMode : input.grpcMultiMode,
        xhttpMode: input.xhttpMode || previousConfig.xhttpMode || 'auto',
        realityTarget: input.realityTarget === undefined ? previousConfig.realityTarget : input.realityTarget,
        realityServerName: input.realityServerName === undefined ? previousConfig.realityServerName : input.realityServerName,
        realityMinClientVersion: input.realityMinClientVersion === undefined ? previousConfig.realityMinClientVersion : input.realityMinClientVersion,
        enabled: nextEnabled,
        port: input.inboundPort,
        remark: nextRemoteRemark,
        trafficLimitGb: input.trafficLimitGb === undefined ? current.trafficLimitGb : new Prisma.Decimal(input.trafficLimitGb)
      });
      inboundId = remoteCreated.inboundId;
      remoteClient = { email: remoteCreated.remoteClientEmail, uuid: remoteCreated.remoteClientUuid, subId: remoteCreated.remoteClientSubId };
    }

    try {
      await this.assertServiceNodeInboundAvailable(nextServerId, inboundId, id);
    } catch (error) {
      if (remoteCreated) await this.xui.deleteRemoteInbound(nextServerId, remoteCreated.inboundId).catch(() => undefined);
      throw error;
    }

    try {
      const remotePatch = remoteCreated ? {
        remoteMode,
        remoteManaged: true,
        remoteInboundTag: remoteCreated.tag,
        remoteInboundRemark: remoteCreated.remark,
        remoteInboundPort: remoteCreated.port,
        remoteClientEmail: remoteCreated.remoteClientEmail,
        remoteClientUuid: remoteCreated.remoteClientUuid,
        remoteClientSubId: remoteCreated.remoteClientSubId,
        remoteClientLinks: remoteCreated.links,
        realityTarget: remoteCreated.realityTarget,
        realityServerName: remoteCreated.realityServerName
      } : {
        remoteMode,
        remoteManaged: remoteMode === 'create' ? Boolean(previousConfig.remoteManaged) : false,
        remoteInboundRemark: remoteMode === 'create' ? nextRemoteRemark : previousConfig.remoteInboundRemark,
        remoteInboundPort: remoteValidation?.port || (input.inboundPort === undefined ? previousConfig.remoteInboundPort : input.inboundPort),
        remoteClientEmail: remoteClient?.email || previousConfig.remoteClientEmail,
        remoteClientUuid: remoteClient?.uuid || previousConfig.remoteClientUuid,
        remoteClientSubId: remoteClient?.subId || previousConfig.remoteClientSubId,
        ...(remoteValidation ? { encryption: remoteValidation.encryption, ...remoteValidation.transportConfig } : {})
      };
      const config = await this.serviceNodeConfig(input, current.config, remotePatch);
      if (remoteValidation) Object.assign(config, { encryption: remoteValidation.encryption, ...remoteValidation.transportConfig });
      const remoteInboundChanged = Boolean(
        (input.serverId !== undefined && nextServerId !== current.serverId) ||
        (input.inboundId !== undefined && inboundId !== current.inboundId) ||
        nextName !== current.name ||
        nextProtocol !== current.protocol ||
        nextEncryption !== (previousConfig.encryption || 'none') ||
        nextTransport !== (previousConfig.transport || 'tcp') ||
        (input.tcpHeaderType !== undefined && input.tcpHeaderType !== (previousConfig.tcpHeaderType || 'none')) ||
        (input.transportHost !== undefined && input.transportHost !== (previousConfig.transportHost || '')) ||
        (input.transportPath !== undefined && input.transportPath !== (previousConfig.transportPath || '')) ||
        (input.grpcServiceName !== undefined && input.grpcServiceName !== (previousConfig.grpcServiceName || '')) ||
        (input.grpcAuthority !== undefined && input.grpcAuthority !== (previousConfig.grpcAuthority || '')) ||
        (input.grpcMultiMode !== undefined && input.grpcMultiMode !== Boolean(previousConfig.grpcMultiMode)) ||
        (input.xhttpMode !== undefined && input.xhttpMode !== (previousConfig.xhttpMode || 'auto')) ||
        (input.realityTarget !== undefined && input.realityTarget !== (previousConfig.realityTarget || '')) ||
        (input.realityServerName !== undefined && input.realityServerName !== (previousConfig.realityServerName || '')) ||
        (input.realityMinClientVersion !== undefined && input.realityMinClientVersion !== (previousConfig.realityMinClientVersion || '')) ||
        nextEnabled !== current.enabled ||
        (remoteMode === 'create' && previousConfig.remoteInboundRemark !== nextRemoteRemark) ||
        (input.inboundPort !== undefined && nextRemotePort !== previousConfig.remoteInboundPort)
      );
      const remoteEnableOnlyChanged = Boolean(
        input.enabled !== undefined &&
        nextEnabled !== current.enabled &&
        !remoteCreated &&
        inboundId &&
        input.serverId === undefined &&
        input.inboundId === undefined &&
        nextName === current.name &&
        nextProtocol === current.protocol &&
        nextEncryption === (previousConfig.encryption || 'none') &&
        nextTransport === (previousConfig.transport || 'tcp') &&
        (config.tcpHeaderType || 'none') === (previousConfig.tcpHeaderType || 'none') &&
        (config.transportHost || '') === (previousConfig.transportHost || '') &&
        (config.transportPath || '/') === (previousConfig.transportPath || '/') &&
        (config.grpcServiceName || '') === (previousConfig.grpcServiceName || '') &&
        (config.grpcAuthority || '') === (previousConfig.grpcAuthority || '') &&
        Boolean(config.grpcMultiMode) === Boolean(previousConfig.grpcMultiMode) &&
        (config.xhttpMode || 'auto') === (previousConfig.xhttpMode || 'auto') &&
        previousConfig.remoteInboundRemark === nextRemoteRemark &&
        nextRemark === current.remark &&
        (input.inboundPort === undefined || nextRemotePort === previousConfig.remoteInboundPort)
      );
      const remoteStructureChanged = Boolean(
        nextProtocol !== current.protocol ||
        nextEncryption !== (previousConfig.encryption || 'none') ||
        nextTransport !== (previousConfig.transport || 'tcp') ||
        (config.tcpHeaderType || 'none') !== (previousConfig.tcpHeaderType || 'none') ||
        (config.transportHost || '') !== (previousConfig.transportHost || '') ||
        (config.transportPath || '/') !== (previousConfig.transportPath || '/') ||
        (config.grpcServiceName || '') !== (previousConfig.grpcServiceName || '') ||
        (config.grpcAuthority || '') !== (previousConfig.grpcAuthority || '') ||
        Boolean(config.grpcMultiMode) !== Boolean(previousConfig.grpcMultiMode) ||
        (config.xhttpMode || 'auto') !== (previousConfig.xhttpMode || 'auto') ||
        (config.realityTarget || '') !== (previousConfig.realityTarget || '') ||
        (config.realityServerName || '') !== (previousConfig.realityServerName || '') ||
        (config.realityMinClientVersion || '') !== (previousConfig.realityMinClientVersion || '') ||
        (input.inboundPort !== undefined && nextRemotePort !== previousConfig.remoteInboundPort)
      );
      const updated = await this.prisma.serviceNode.update({
        where: { id },
        data: {
          serverId: input.serverId,
          name: input.name,
          inboundId,
          protocol: remoteValidation?.protocol || input.protocol,
          config: this.toJsonValue(config),
          priceMonthly: input.priceMonthly === undefined ? undefined : new Prisma.Decimal(input.priceMonthly),
          trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb),
          enabled: input.enabled,
          remark: input.remark === undefined ? undefined : input.remark || null
        },
        include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
      });
      localUpdated = true;
      const pendingActions: SyncTaskAction[] = [];
      if (!remoteCreated && inboundId && remoteInboundChanged) {
        try {
          const syncResult = remoteEnableOnlyChanged
            ? await this.xui.setServiceNodeRemoteEnable(id, nextEnabled)
            : await this.syncServiceNodeInboundFromLocal(id, remoteStructureChanged);
          await this.resolveSyncTask('service-node', id, 'service-inbound');
        } catch (error) {
          pendingActions.push('service-inbound');
          await this.failSyncTask('service-node', id, 'service-inbound', error, { remoteEnableOnlyChanged, runtimeReloadRequired: remoteStructureChanged });
        }
      }
      const clientIdentityChanged = nextProtocol !== current.protocol || nextEncryption !== (previousConfig.encryption || 'none');
      const remoteClientShouldSync = Boolean(updated.inboundId && (trafficLimitChanged || clientIdentityChanged));
      if (remoteClientShouldSync) {
        if (trafficLimitChanged) {
          await this.prisma.customerNode.updateMany({
            where: { serviceNodeId: id },
            data: { trafficLimitGb: updated.trafficLimitGb }
          });
        }
        try {
          const syncResult = await this.xui.syncServiceNodeTrafficLimit(id);
          if (!syncResult.synced) throw new BadGatewayException('部分客户端同步失败');
          await this.resolveSyncTask('service-node', id, 'service-clients');
        } catch (error) {
          pendingActions.push('service-clients');
          await this.failSyncTask('service-node', id, 'service-clients', error);
        }
      }
      if (updated.inboundId && socksConfigChanged) {
        try {
          await this.xui.syncServiceNodeRemoteConfig(id);
          await this.resolveSyncTask('service-node', id, 'service-config');
        } catch (error) {
          pendingActions.push('service-config');
          await this.failSyncTask('service-node', id, 'service-config', error);
        }
      }
      const finalNode = await this.prisma.serviceNode.findUnique({
        where: { id },
        include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
      });
      return {
        ...(finalNode || updated),
        state: pendingActions.length ? 'partial' : 'success',
        message: pendingActions.length ? '保存成功，同步失败' : '保存成功',
        pendingActions
      };
    } catch (error) {
      if (remoteCreated && !localUpdated) await this.xui.deleteRemoteInbound(nextServerId, remoteCreated.inboundId).catch(() => undefined);
      if (this.isUniqueConstraintError(error)) throw new BadRequestException('该 3x-ui 入站已绑定到其他路由节点');
      throw error;
    }
  }

  async deleteServiceNode(id: string, recordFailure = true) {
    const current = await this.ensureServiceNode(id);
    try {
      const remoteClientCleanup = { skipped: true, reason: 'clients belong to the service-node inbound and are removed with the inbound' };
      const remoteConfigCleanup = current.inboundId
        ? await this.xui.syncServiceNodeRemoteConfig(id, { removeOnly: true })
        : { skipped: true, reason: 'service node has no inbound ID' };
      const remoteInboundCleanup = await this.xui.deleteManagedServiceNodeInbound(id);
      const localImportedSocksCleanup = await this.cleanupLocalImportedSocksNodeForServiceNode(id, current.config);
      const customerNodes = await this.prisma.customerNode.findMany({ where: { serviceNodeId: id }, select: { id: true } });
      const customerNodeIds = customerNodes.map((node) => node.id);
      const cleanupActions: Prisma.PrismaPromise<unknown>[] = [
        this.prisma.renewalLog.updateMany({ where: { customerNodeId: { in: customerNodeIds } }, data: { customerNodeId: null } }),
        this.prisma.customerNode.deleteMany({ where: { serviceNodeId: id } }),
        this.prisma.syncTask.deleteMany({ where: { entityType: 'service-node', entityId: id } }),
        this.prisma.serviceNode.delete({ where: { id } })
      ];
      if (localImportedSocksCleanup.deleteSocksNodeId) {
        cleanupActions.push(this.prisma.syncTask.deleteMany({ where: { entityType: 'socks-node', entityId: localImportedSocksCleanup.deleteSocksNodeId } }));
        cleanupActions.push(this.prisma.socksNode.delete({ where: { id: localImportedSocksCleanup.deleteSocksNodeId } }));
      }
      await this.prisma.$transaction(cleanupActions);
      return { deleted: true, id, state: 'success', message: '删除成功', remoteClientCleanup, remoteConfigCleanup, remoteInboundCleanup, localImportedSocksCleanup };
    } catch (error) {
      if (recordFailure) await this.failSyncTask('service-node', id, 'service-delete-check', error);
      throw error;
    }
  }

  async syncServiceNodeConfig(id: string) {
    try {
      const result = await this.xui.syncServiceNodeRemoteConfig(id);
      await this.resolveSyncTask('service-node', id, 'service-config');
      return result;
    } catch (error) {
      await this.failSyncTask('service-node', id, 'service-config', error);
      throw error;
    }
  }

  async syncServiceNodeTrafficLimit(id: string, recordFailure = true) {
    const node = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true, inboundId: true, trafficLimitGb: true } });
    if (!node) throw new NotFoundException('Service node not found');
    await this.prisma.customerNode.updateMany({
      where: { serviceNodeId: id },
      data: { trafficLimitGb: node.trafficLimitGb }
    });
    try {
      const result = await this.xui.syncServiceNodeTrafficLimit(id);
      if (!result.synced) throw new BadGatewayException('部分客户端同步失败');
      await this.resolveSyncTask('service-node', id, 'service-clients');
      return result;
    } catch (error) {
      if (recordFailure) await this.failSyncTask('service-node', id, 'service-clients', error);
      throw error;
    }
  }

  async listSocksNodes() {
    const nodes = await this.prisma.socksNode.findMany({ orderBy: { createdAt: 'desc' } });
    const tasks = await this.pendingTasks('socks-node', nodes.map((node) => node.id));
    return nodes.map((node) => ({ ...maskSocksNode(node), syncTasks: tasks.get(node.id) || [] }));
  }

  async getSocksNodeSecrets(id: string) {
    const node = await this.prisma.socksNode.findUnique({ where: { id }, select: { id: true, passwordEnc: true } });
    if (!node) throw new NotFoundException('Socks node not found');
    return { id: node.id, password: this.encryption.decryptNullable(node.passwordEnc) || '' };
  }

  async createSocksNode(input: z.infer<typeof socksNodeUpsertSchema>) {
    const node = await this.prisma.socksNode.create({
      data: {
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username || null,
        passwordEnc: this.encryption.encryptNullable(input.password),
        enabled: input.enabled,
        remark: input.remark || null
      }
    });
    return maskSocksNode(node);
  }

  async updateSocksNode(id: string, input: Partial<z.infer<typeof socksNodeUpsertSchema>>) {
    await this.ensureSocksNode(id);
    const usedServiceNodes = await this.serviceNodesUsingSocksNode(id);
    if (input.enabled === false && usedServiceNodes.length) {
      throw new BadRequestException(`出站节点正在被 ${usedServiceNodes.length} 个路由节点使用，请先在路由节点中关闭或更换出站中转`);
    }
    const shouldResyncRemote = Boolean(
      input.host !== undefined ||
      input.port !== undefined ||
      input.username !== undefined ||
      input.password !== undefined ||
      input.enabled !== undefined
    );
    const node = await this.prisma.socksNode.update({
      where: { id },
      data: {
        name: input.name,
        host: input.host,
        port: input.port,
        username: input.username === undefined ? undefined : input.username || null,
        passwordEnc: input.password === undefined ? undefined : this.encryption.encryptNullable(input.password),
        enabled: input.enabled,
        remark: input.remark === undefined ? undefined : input.remark || null
      }
    });
    const syncResults = shouldResyncRemote
      ? await Promise.all(usedServiceNodes.map(async (serviceNode) => {
        try {
          const result = await this.xui.syncServiceNodeRemoteConfig(serviceNode.id);
          await this.resolveSyncTask('service-node', serviceNode.id, 'service-config');
          return { serviceNodeId: serviceNode.id, serviceNodeName: serviceNode.name, synced: true, result };
        } catch (error) {
          await this.failSyncTask('service-node', serviceNode.id, 'service-config', error, { socksNodeId: id });
          return { serviceNodeId: serviceNode.id, serviceNodeName: serviceNode.name, synced: false, message: this.shortSyncMessage(error) };
        }
      }))
      : [];
    const failed = syncResults.filter((item) => !item.synced);
    if (failed.length) await this.failSyncTask('socks-node', id, 'socks-references', new Error('部分路由节点同步失败'), { failed });
    else await this.resolveSyncTask('socks-node', id, 'socks-references');
    return {
      ...maskSocksNode(node),
      state: failed.length ? 'partial' : 'success',
      message: failed.length ? '保存成功，同步失败' : '保存成功',
      pendingActions: failed.length ? ['socks-references'] : [],
      syncResults
    };
  }

  async deleteSocksNode(id: string, recordFailure = true) {
    const node = await this.ensureSocksNode(id);
    const serviceNodes = await this.prisma.serviceNode.findMany({ select: { id: true, name: true, config: true } });
    const used = serviceNodes.find((node) => jsonObject(node.config).socksNodeId === id);
    if (used) throw new BadRequestException(`Socks 节点正在被服务节点“${used.name}”使用，请先关闭或更换该服务节点的 Socks 中转`);
    try {
      let remoteDelete: unknown = null;
      if (node.sourceServerId && node.remoteOutboundTag) {
        remoteDelete = await this.xui.deleteRemoteSocksOutbound(node.sourceServerId, node.remoteOutboundTag);
      }
      await this.prisma.$transaction([
        this.prisma.syncTask.deleteMany({ where: { entityType: 'socks-node', entityId: id } }),
        this.prisma.socksNode.delete({ where: { id } })
      ]);
      return { deleted: true, id, state: 'success', message: '删除成功', remoteDelete };
    } catch (error) {
      if (recordFailure) await this.failSyncTask('socks-node', id, 'socks-delete-check', error);
      throw error;
    }
  }

  async listUserNodes(customerId: string) {
    const nodes = await this.prisma.customerNode.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: { serviceNode: { include: { server: { select: { id: true, name: true, baseUrl: true } } } } }
    });
    return Promise.all(nodes.map(async (node) => {
      let linkError: string | null = null;
      const links = await this.xui.customerNodeLinks(customerId, node.id).catch((error) => {
        linkError = error instanceof Error ? error.message : String(error);
        return [] as string[];
      });
      return { ...node, links, linkError, subId: jsonObject(node.config).subId || node.xuiEmail };
    }));
  }

  async bindCustomerNode(customerId: string, input: z.infer<typeof customerNodeCreateSchema>) {
    const [customer, serviceNode] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: customerId } }),
      this.prisma.serviceNode.findUnique({ where: { id: input.serviceNodeId } })
    ]);
    if (!customer) throw new NotFoundException('Customer not found');
    if (!serviceNode) throw new NotFoundException('Service node not found');

    const existingBinding = await this.prisma.customerNode.findFirst({
      where: { serviceNodeId: input.serviceNodeId },
      select: { id: true, customerId: true, customer: { select: { name: true, loginUsername: true } } }
    });
    if (existingBinding) {
      const owner = existingBinding.customer?.name || existingBinding.customer?.loginUsername || existingBinding.customerId;
      throw new BadRequestException(`该路由节点已经绑定给用户 ${owner}。当前架构下远端 3x-ui 客户端属于路由节点，不能同时绑定多个面板用户。`);
    }

    const serviceConfig = jsonObject(serviceNode.config) as ServiceNodeConfig;
    const xuiEmail = input.xuiEmail || stringValue(serviceConfig.remoteClientEmail);
    const uuid = input.uuid || stringValue(serviceConfig.remoteClientUuid) || null;
    const subId = stringValue(serviceConfig.remoteClientSubId);
    const links = Array.isArray(serviceConfig.remoteClientLinks) ? serviceConfig.remoteClientLinks : [];
    if (!xuiEmail) throw new BadRequestException('Service node is missing a remote 3x-ui client. Sync/import the service node first.');
    const node = await this.prisma.customerNode.create({
      data: {
        customerId,
        serviceNodeId: input.serviceNodeId,
        xuiEmail,
        uuid,
        expireAt: input.expireAt || null,
        trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: 'active',
        config: this.toJsonValue({ uuid, subId, links })
      },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });

    let syncResult: Awaited<ReturnType<XuiService['syncCustomerNode']>>;
    try {
      syncResult = await this.xui.syncCustomerNode(customerId, node.id, {
        expireAt: input.expireAt || null,
        trafficLimitGb: node.trafficLimitGb,
        status: 'active',
        createIfMissing: false,
        requireExisting: true
      });
    } catch (error) {
      await this.prisma.customerNode.delete({ where: { id: node.id } }).catch(() => undefined);
      throw error;
    }

    const syncedNode = await this.prisma.customerNode.findUnique({
      where: { id: node.id },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });
    return { node: syncedNode, sync: syncResult };
  }

  async updateCustomerNode(customerId: string, customerNodeId: string, input: Partial<z.infer<typeof customerNodeCreateSchema>>) {
    const current = await this.prisma.customerNode.findFirst({ where: { id: customerNodeId, customerId }, include: { serviceNode: true } });
    if (!current) throw new NotFoundException('Customer node not found');

    const serviceNodeId = input.serviceNodeId || current.serviceNodeId;
    const serviceNode = serviceNodeId === current.serviceNodeId ? current.serviceNode : await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId } });
    if (!serviceNode) throw new NotFoundException('Service node not found');

    if (serviceNodeId !== current.serviceNodeId) {
      const duplicated = await this.prisma.customerNode.findFirst({
        where: { serviceNodeId, id: { not: customerNodeId } },
        select: { id: true, customerId: true, customer: { select: { name: true, loginUsername: true } } }
      });
      if (duplicated) {
        const owner = duplicated.customer?.name || duplicated.customer?.loginUsername || duplicated.customerId;
        throw new BadRequestException(`该路由节点已经绑定给用户 ${owner}。当前架构下远端 3x-ui 客户端属于路由节点，不能同时绑定多个面板用户。`);
      }
    }

    const serviceConfig = jsonObject(serviceNode.config) as ServiceNodeConfig;
    const nodeChanged = serviceNodeId !== current.serviceNodeId;
    const serviceRemoteEmail = stringValue(serviceConfig.remoteClientEmail);
    const serviceRemoteUuid = stringValue(serviceConfig.remoteClientUuid);
    const serviceRemoteSubId = stringValue(serviceConfig.remoteClientSubId);
    const serviceRemoteLinks = Array.isArray(serviceConfig.remoteClientLinks) ? serviceConfig.remoteClientLinks : [];
    const nextXuiEmail = nodeChanged
      ? input.xuiEmail || serviceRemoteEmail || current.xuiEmail
      : input.xuiEmail === undefined || input.xuiEmail === '' ? current.xuiEmail : input.xuiEmail;
    if (!nextXuiEmail) throw new BadRequestException('Service node is missing a remote 3x-ui client. Sync/import the service node first.');
    const nextUuid = nodeChanged ? input.uuid || serviceRemoteUuid || null : input.uuid === undefined ? current.uuid : input.uuid || current.uuid;
    const currentConfig = jsonObject(current.config);
    const nextConfig = nodeChanged
      ? { uuid: nextUuid, subId: serviceRemoteSubId, links: serviceRemoteLinks }
      : currentConfig;

    const node = await this.prisma.customerNode.update({
      where: { id: customerNodeId },
      data: {
        serviceNodeId: input.serviceNodeId,
        xuiEmail: nextXuiEmail,
        uuid: nextUuid,
        expireAt: input.expireAt === undefined ? undefined : input.expireAt || null,
        trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: 'active',
        config: this.toJsonValue(nextConfig)
      },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });

    let syncResult: Awaited<ReturnType<XuiService['syncCustomerNode']>>;
    try {
      syncResult = await this.xui.syncCustomerNode(customerId, customerNodeId, {
        expireAt: input.expireAt === undefined ? node.expireAt : input.expireAt || null,
        trafficLimitGb: input.trafficLimitGb === undefined ? node.trafficLimitGb : new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: 'active',
        createIfMissing: false,
        requireExisting: true
      });
    } catch (error) {
      await this.prisma.customerNode.update({
        where: { id: customerNodeId },
        data: {
          serviceNodeId: current.serviceNodeId,
          xuiEmail: current.xuiEmail,
          uuid: current.uuid,
          expireAt: current.expireAt,
          trafficLimitGb: current.trafficLimitGb,
          status: current.status,
          config: this.toJsonValue(current.config)
        }
      }).catch(() => undefined);
      throw error;
    }

    const syncedNode = await this.prisma.customerNode.findUnique({
      where: { id: node.id },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });
    return { node: syncedNode, sync: syncResult };
  }

  async unbindCustomerNode(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({ where: { id: customerNodeId, customerId }, select: { id: true } });
    if (!node) throw new NotFoundException('Customer node not found');
    const remoteCleanup: unknown = { skipped: true, reason: 'customer binding is local only; remote client belongs to the service node' };
    await this.prisma.customerNode.delete({ where: { id: customerNodeId } });
    return { deleted: true, id: customerNodeId, remoteCleanup };
  }

  async deleteServiceNodeFromCustomerNode(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      select: { id: true, serviceNodeId: true }
    });
    if (!node) throw new NotFoundException('Customer node not found');
    const result = await this.deleteServiceNode(node.serviceNodeId);
    return { ...result, customerId, customerNodeId };
  }

  async retrySyncTask(id: string) {
    const task = await this.prisma.syncTask.findUnique({ where: { id } });
    if (!task || task.status === 'resolved') throw new NotFoundException('待同步任务不存在');
    try {
      const result = await this.runSyncTask(task.entityType, task.entityId, task.action as SyncTaskAction, task.detail);
      await this.resolveSyncTask(task.entityType, task.entityId, task.action as SyncTaskAction);
      return { state: 'success', message: '同步成功', taskId: id, result };
    } catch (error) {
      await this.failSyncTask(task.entityType, task.entityId, task.action as SyncTaskAction, error, task.detail);
      throw error;
    }
  }

  private async runSyncTask(entityType: string, entityId: string, action: SyncTaskAction, detail?: unknown) {
    if (entityType === 'service-node') {
      if (action === 'service-inbound') return this.syncServiceNodeInboundFromLocal(entityId, Boolean(jsonObject(detail).runtimeReloadRequired));
      if (action === 'service-clients') return this.syncServiceNodeTrafficLimit(entityId, false);
      if (action === 'service-config') return this.xui.syncServiceNodeRemoteConfig(entityId);
      if (action === 'service-delete-check') return this.retryServiceNodeDeleteCheck(entityId);
    }
    if (entityType === 'socks-node') {
      if (action === 'socks-references') return this.syncSocksNodeReferences(entityId);
      if (action === 'socks-delete-check') return this.deleteSocksNode(entityId, false);
    }
    throw new BadRequestException('该任务不支持自动重试');
  }

  private async syncServiceNodeInboundFromLocal(id: string, forceRuntimeReload = false) {
    const node = await this.ensureServiceNode(id);
    if (!node.inboundId) throw new BadRequestException('路由节点缺少远端入站 ID');
    const config = jsonObject(node.config) as ServiceNodeConfig;
    const result = await this.xui.updateServiceNodeInbound({
      serverId: node.serverId,
      inboundId: node.inboundId,
      name: node.name,
      protocol: node.protocol,
      encryption: config.encryption || 'none',
      transport: config.transport || 'tcp',
      tcpHeaderType: config.tcpHeaderType,
      transportHost: config.transportHost,
      transportPath: config.transportPath,
      grpcServiceName: config.grpcServiceName,
      grpcAuthority: config.grpcAuthority,
      grpcMultiMode: config.grpcMultiMode,
      xhttpMode: config.xhttpMode,
      realityTarget: config.realityTarget,
      realityServerName: config.realityServerName,
      realityMinClientVersion: config.realityMinClientVersion,
      enabled: node.enabled,
      port: config.remoteInboundPort,
      remark: node.name,
      forceRuntimeReload
    });
    await this.persistProtocolClientIdentities(id, config, result.clientIdentities || []);
    return result;
  }

  private async persistProtocolClientIdentities(id: string, config: ServiceNodeConfig, identities: Array<{ email?: string; uuid?: string; subId?: string }>) {
    if (!identities.length) return;
    const serviceEmail = stringValue(config.remoteClientEmail);
    const serviceSubId = stringValue(config.remoteClientSubId);
    const serviceIdentity = identities.find((item) => serviceEmail && item.email === serviceEmail)
      || identities.find((item) => serviceSubId && item.subId === serviceSubId);
    if (serviceIdentity) {
      Object.assign(config, {
        remoteClientEmail: serviceIdentity.email || serviceEmail,
        remoteClientUuid: serviceIdentity.uuid || config.remoteClientUuid,
        remoteClientSubId: serviceIdentity.subId || serviceSubId
      });
      await this.prisma.serviceNode.update({ where: { id }, data: { config: this.toJsonValue(config) } });
    }

    const customerNodes = await this.prisma.customerNode.findMany({
      where: { serviceNodeId: id },
      select: { id: true, xuiEmail: true, config: true }
    });
    for (const node of customerNodes) {
      const saved = jsonObject(node.config);
      const subId = stringValue(saved.subId);
      const identity = identities.find((item) => item.email === node.xuiEmail)
        || identities.find((item) => subId && item.subId === subId);
      if (!identity) continue;
      await this.prisma.customerNode.update({
        where: { id: node.id },
        data: {
          xuiEmail: identity.email || node.xuiEmail,
          uuid: identity.uuid || null,
          config: this.toJsonValue({ ...saved, uuid: identity.uuid || null, subId: identity.subId || subId })
        }
      });
    }
  }

  private async syncSocksNodeReferences(id: string) {
    await this.ensureSocksNode(id);
    const serviceNodes = await this.serviceNodesUsingSocksNode(id);
    const results = await Promise.all(serviceNodes.map(async (node) => {
      try {
        const result = await this.xui.syncServiceNodeRemoteConfig(node.id);
        await this.resolveSyncTask('service-node', node.id, 'service-config');
        return { serviceNodeId: node.id, serviceNodeName: node.name, synced: true, result };
      } catch (error) {
        await this.failSyncTask('service-node', node.id, 'service-config', error, { socksNodeId: id });
        return { serviceNodeId: node.id, serviceNodeName: node.name, synced: false, message: this.errorMessage(error) };
      }
    }));
    const failed = results.filter((item) => !item.synced);
    if (failed.length) throw new BadGatewayException('部分路由节点同步失败');
    return { synced: true, results };
  }

  private async retryServiceNodeDeleteCheck(id: string) {
    const exists = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true } });
    if (!exists) return { resolved: true, reason: '路由节点已经删除' };
    return this.deleteServiceNode(id, false);
  }

  private async pendingTasks(entityType: string, entityIds: string[]) {
    const result = new Map<string, Array<{ id: string; action: string; status: string; message: string | null; attemptCount: number; updatedAt: Date }>>();
    if (!entityIds.length) return result;
    const tasks = await this.prisma.syncTask.findMany({
      where: { entityType, entityId: { in: entityIds }, status: { in: ['pending', 'failed'] } },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, entityId: true, action: true, status: true, message: true, attemptCount: true, updatedAt: true }
    });
    for (const task of tasks) result.set(task.entityId, [...(result.get(task.entityId) || []), task]);
    return result;
  }

  private async failSyncTask(entityType: string, entityId: string, action: SyncTaskAction, error: unknown, detail?: unknown) {
    const message = this.shortSyncMessage(error, action);
    return this.prisma.syncTask.upsert({
      where: { entityType_entityId_action: { entityType, entityId, action } },
      create: {
        entityType,
        entityId,
        action,
        status: 'failed',
        message,
        detail: this.toJsonValue(detail || null),
        attemptCount: 1,
        lastAttemptAt: new Date()
      },
      update: {
        status: 'failed',
        message,
        detail: this.toJsonValue(detail || null),
        attemptCount: { increment: 1 },
        lastAttemptAt: new Date(),
        resolvedAt: null
      }
    });
  }

  private async resolveSyncTask(entityType: string, entityId: string, action: SyncTaskAction) {
    return this.prisma.syncTask.updateMany({
      where: { entityType, entityId, action, status: { not: 'resolved' } },
      data: { status: 'resolved', message: null, resolvedAt: new Date() }
    });
  }

  private shortSyncMessage(error: unknown, action?: SyncTaskAction) {
    const message = this.errorMessage(error);
    const prefix = action === 'service-inbound'
      ? '入站'
      : action === 'service-clients'
        ? '用户'
        : action === 'service-config'
          ? '出站'
          : '远端';
    if (/timeout|超时/i.test(message)) return `${prefix}同步超时`;
    if (/disabled|停用/i.test(message)) return '远端面板已停用';
    if (/not found|不存在|missing/i.test(message)) return `${prefix}数据不存在`;
    if (/port.*exist|端口.*占用/i.test(message)) return '远端端口已占用';
    if (/reality/i.test(message)) return 'Reality 配置同步失败';
    if (/protocol|协议/i.test(message)) return '远端协议同步失败';
    if (/transport|传输/i.test(message)) return '远端传输同步失败';
    return `${prefix}同步失败`;
  }

  private errorMessage(error: unknown) {
    if (error && typeof error === 'object') {
      const payload = (error as { payload?: unknown }).payload;
      if (payload && typeof payload === 'object') {
        const record = payload as Record<string, unknown>;
        const remoteMessage = record.msg || record.message || record.error;
        if (remoteMessage) return String(remoteMessage);
      }
    }
    return error instanceof Error ? error.message : String(error);
  }

  private async ensureServer(id: string) {
    const exists = await this.prisma.xuiServer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('3x-ui server not found');
  }

  private async ensureServiceNode(id: string) {
    const exists = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true, serverId: true, name: true, protocol: true, inboundId: true, enabled: true, trafficLimitGb: true, remark: true, config: true } });
    if (!exists) throw new NotFoundException('Service node not found');
    return exists;
  }

  private async assertServiceNodeInboundAvailable(serverId: string, inboundId: number | null, excludeId?: string) {
    if (!inboundId) return;
    const existing = await this.prisma.serviceNode.findFirst({
      where: {
        serverId,
        inboundId,
        ...(excludeId ? { id: { not: excludeId } } : {})
      },
      select: { id: true, name: true }
    });
    if (existing) throw new BadRequestException(`该 3x-ui 入站已绑定到路由节点「${existing.name}」`);
  }

  private isUniqueConstraintError(error: unknown) {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }

  private async ensureSocksNode(id: string) {
    const exists = await this.prisma.socksNode.findUnique({ where: { id }, select: { id: true, sourceServerId: true, remoteOutboundTag: true } });
    if (!exists) throw new NotFoundException('Socks node not found');
    return exists;
  }

  private async serviceNodesUsingSocksNode(id: string) {
    const serviceNodes = await this.prisma.serviceNode.findMany({ select: { id: true, name: true, config: true } });
    return serviceNodes.filter((node) => {
      const config = jsonObject(node.config) as ServiceNodeConfig;
      return Boolean(config.socksRelayEnabled && config.socksNodeId === id);
    });
  }

  private async cleanupLocalImportedSocksNodeForServiceNode(serviceNodeId: string, serviceNodeConfig: unknown) {
    const config = jsonObject(serviceNodeConfig) as ServiceNodeConfig;
    const socksNodeId = stringValue(config.socksNodeId);
    if (!socksNodeId) return { deleted: false, skipped: true, reason: 'service node has no Socks node binding' };

    const socksNode = await this.prisma.socksNode.findUnique({
      where: { id: socksNodeId },
      select: { id: true, name: true, sourceServerId: true, remoteOutboundTag: true }
    });
    if (!socksNode) return { deleted: false, skipped: true, reason: 'Socks node already absent', socksNodeId };
    if (!socksNode.sourceServerId || !socksNode.remoteOutboundTag) {
      return { deleted: false, skipped: true, reason: 'Socks node is locally created', socksNodeId, socksNodeName: socksNode.name };
    }

    const serviceNodes = await this.prisma.serviceNode.findMany({ select: { id: true, name: true, config: true } });
    const otherUsers = serviceNodes.filter((node) => {
      if (node.id === serviceNodeId) return false;
      const otherConfig = jsonObject(node.config) as ServiceNodeConfig;
      return otherConfig.socksNodeId === socksNodeId;
    });
    if (otherUsers.length) {
      return {
        deleted: false,
        skipped: true,
        reason: 'Socks node is still referenced by other service nodes',
        socksNodeId,
        socksNodeName: socksNode.name,
        referencedBy: otherUsers.map((node) => ({ id: node.id, name: node.name }))
      };
    }

    return {
      deleted: true,
      deleteSocksNodeId: socksNode.id,
      socksNodeId: socksNode.id,
      socksNodeName: socksNode.name,
      sourceServerId: socksNode.sourceServerId,
      remoteOutboundTag: socksNode.remoteOutboundTag
    };
  }

  private assertShareLinkProtocol(protocol: string) {
    if (!SHARE_LINK_PROTOCOLS.has(protocol)) {
      throw new BadRequestException('服务节点只支持可生成用户链接的协议：VLESS、VMess、Trojan、Shadowsocks、Hysteria。Socks 请在 Socks 中转节点中配置。');
    }
  }

  private assertTransportCompatibility(protocol: string, encryption: string, transport: string) {
    if (encryption === 'reality' && !['vless', 'trojan'].includes(protocol)) {
      throw new BadRequestException('Reality 仅支持 VLESS 或 Trojan 节点');
    }
    if (encryption === 'reality' && transport !== 'tcp') {
      throw new BadRequestException('Reality 节点当前仅支持 TCP 传输');
    }
    if (['shadowsocks', 'hysteria', 'hysteria2'].includes(protocol) && transport !== 'tcp') {
      throw new BadRequestException(`${protocol} 节点当前仅支持默认传输配置`);
    }
  }

  private async serviceNodeConfig(input: Partial<z.infer<typeof serviceNodeUpsertSchema>>, current?: Prisma.JsonValue | null, remotePatch: Partial<ServiceNodeConfig> = {}): Promise<ServiceNodeConfig> {
    const previous = jsonObject(current) as ServiceNodeConfig;
    const next: ServiceNodeConfig = {
      ...previous,
      ...remotePatch,
      encryption: input.encryption === undefined ? previous.encryption || 'none' : input.encryption,
      transport: input.transport === undefined ? previous.transport || 'tcp' : input.transport,
      tcpHeaderType: input.tcpHeaderType === undefined ? previous.tcpHeaderType || 'none' : input.tcpHeaderType,
      transportHost: input.transportHost === undefined ? previous.transportHost || '' : input.transportHost || '',
      transportPath: input.transportPath === undefined ? previous.transportPath || '/' : input.transportPath || '/',
      grpcServiceName: input.grpcServiceName === undefined ? previous.grpcServiceName || '' : input.grpcServiceName || '',
      grpcAuthority: input.grpcAuthority === undefined ? previous.grpcAuthority || '' : input.grpcAuthority || '',
      grpcMultiMode: input.grpcMultiMode === undefined ? Boolean(previous.grpcMultiMode) : input.grpcMultiMode,
      xhttpMode: input.xhttpMode === undefined ? previous.xhttpMode || 'auto' : input.xhttpMode,
      realityTarget: input.realityTarget === undefined ? previous.realityTarget || '' : input.realityTarget || '',
      realityServerName: input.realityServerName === undefined ? previous.realityServerName || '' : input.realityServerName || '',
      realityMinClientVersion: input.realityMinClientVersion === undefined ? previous.realityMinClientVersion || '' : input.realityMinClientVersion || '',
      socksRelayEnabled: input.socksRelayEnabled === undefined ? Boolean(previous.socksRelayEnabled) : input.socksRelayEnabled,
      socksNodeId: input.socksNodeId === undefined ? previous.socksNodeId || null : input.socksNodeId || null
    };
    if (next.socksRelayEnabled) {
      if (!next.socksNodeId) throw new BadRequestException('A Socks node is required when Socks relay is enabled');
      const socks = await this.prisma.socksNode.findUnique({ where: { id: next.socksNodeId }, select: { id: true, enabled: true } });
      if (!socks) throw new NotFoundException('Socks node not found');
      if (!socks.enabled) throw new BadRequestException('Selected Socks node is disabled');
    }
    return next;
  }

  private toJsonValue(value: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
  }

  private serverConfig(input: Partial<z.infer<typeof xuiServerUpsertSchema>>, current: XuiServerConfig = {}): XuiServerConfig {
    return {
      ...current,
      shareHost: input.shareHost === undefined ? current.shareHost || '' : input.shareHost || '',
      tlsServerName: input.tlsServerName === undefined ? current.tlsServerName || '' : input.tlsServerName || '',
      tlsCertFile: input.tlsCertFile === undefined ? current.tlsCertFile || '' : input.tlsCertFile || '',
      tlsKeyFile: input.tlsKeyFile === undefined ? current.tlsKeyFile || '' : input.tlsKeyFile || '',
      realityTarget: input.realityTarget === undefined ? current.realityTarget || '' : input.realityTarget || '',
      realityServerName: input.realityServerName === undefined ? current.realityServerName || '' : input.realityServerName || '',
      realityFingerprint: input.realityFingerprint === undefined ? current.realityFingerprint || 'chrome' : input.realityFingerprint || 'chrome',
      realitySpiderX: input.realitySpiderX === undefined ? current.realitySpiderX || '/' : input.realitySpiderX || '/'
    };
  }
}

function maskXuiServer<T extends { passwordEnc: string | null; tokenEnc: string | null; config?: unknown }>(server: T) {
  const { passwordEnc, tokenEnc, config, ...safe } = server;
  return { ...safe, config: serverConfigFrom({ config }), hasPassword: Boolean(passwordEnc), hasToken: Boolean(tokenEnc) };
}

function maskSocksNode<T extends { passwordEnc: string | null }>(node: T) {
  const { passwordEnc, ...safe } = node;
  return { ...safe, hasPassword: Boolean(passwordEnc) };
}

function jsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

function serverConfigFrom(value: unknown): XuiServerConfig {
  const config = jsonObject(jsonObject(value).config || value);
  return {
    shareHost: String(config.shareHost || '').trim(),
    tlsServerName: String(config.tlsServerName || '').trim(),
    tlsCertFile: String(config.tlsCertFile || '').trim(),
    tlsKeyFile: String(config.tlsKeyFile || '').trim(),
    realityTarget: String(config.realityTarget || '').trim(),
    realityServerName: String(config.realityServerName || '').trim(),
    realityFingerprint: String(config.realityFingerprint || 'chrome').trim(),
    realitySpiderX: String(config.realitySpiderX || '/').trim(),
    panelCompatibility: jsonObject(config.panelCompatibility) as XuiServerConfig['panelCompatibility']
  };
}

function hasRemoteSyncConfig(value: unknown) {
  const config = jsonObject(value);
  return Boolean(config.subId || (Array.isArray(config.links) && config.links.length));
}
