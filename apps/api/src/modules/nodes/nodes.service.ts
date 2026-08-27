import { BadGatewayException, BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { customerNodeCreateSchema, serviceNodeUpsertSchema, socksNodeUpsertSchema, xuiServerUpsertSchema } from '@shiye/shared';
import type { z } from 'zod';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';
import { XuiService } from '../xui/xui.service.js';
import { DatabaseLockService } from '../../shared/database-lock.service.js';

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
    apiProfile?: 'v3.6';
    detectedAt?: string;
    source?: string;
    openApiVersion?: string;
  };
};

const SHARE_LINK_PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'hysteria2']);

type SyncTaskAction = 'service-inbound' | 'service-clients' | 'service-config' | 'socks-references' | 'service-delete-check' | 'socks-delete-check';

@Injectable()
export class NodesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly xui: XuiService,
    private readonly locks: DatabaseLockService
  ) {}

  async listServers() {
    const servers = await this.prisma.xuiServer.findMany({ orderBy: { createdAt: 'desc' } });
    return servers.map(maskXuiServer);
  }

  async getServerSecrets(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id }, select: { id: true, passwordEnc: true, tokenEnc: true } });
    if (!server) throw new NotFoundException('3x-ui 服务器不存在');
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
    if (!current) throw new NotFoundException('3x-ui 服务器不存在');
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
    const [serviceNodeCount, outboundCount, routeCount] = await Promise.all([
      this.prisma.serviceNode.count({ where: { serverId: id } }),
      this.prisma.networkOutbound.count({ where: { serverId: id } }),
      this.prisma.networkRoute.count({ where: { serverId: id } })
    ]);
    if (serviceNodeCount || outboundCount || routeCount) {
      throw new BadRequestException(`请先删除该面板关联的资源（入站 ${serviceNodeCount}、出站 ${outboundCount}、路由 ${routeCount}）`);
    }
    await this.prisma.xuiServer.delete({ where: { id } });
    return { deleted: true, id };
  }

  async listServiceNodes() {
    const nodes = await this.prisma.serviceNode.findMany({
      orderBy: { createdAt: 'desc' },
      include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
    });
    const nodeIds = nodes.map((node) => node.id);
    const [tasks, trafficSnapshots] = await Promise.all([
      this.pendingTasks('service-node', nodeIds),
      this.xui.serviceNodeTrafficSnapshots(nodeIds)
    ]);
    const trafficByNode = new Map(trafficSnapshots.map((traffic) => [traffic.serviceNodeId, traffic]));
    return nodes.map((node) => ({
      ...node,
      syncTasks: tasks.get(node.id) || [],
      traffic: trafficByNode.get(node.id) || { serviceNodeId: node.id, status: 'error', error: '未能读取官方客户端流量' }
    }));
  }

  async createServiceNode(input: z.infer<typeof serviceNodeUpsertSchema>) {
    return this.locks.withLock(this.locks.panelOperationKey(input.serverId), () => this.createServiceNodeUnlocked(input));
  }

  private async createServiceNodeUnlocked(input: z.infer<typeof serviceNodeUpsertSchema>) {
    if (input.protocol === 'hysteria') input = { ...input, encryption: 'tls', transport: 'tcp' };
    this.assertShareLinkProtocol(input.protocol);
    await this.ensureServer(input.serverId);
    const remoteMode = input.remoteMode || 'create';
    let inboundId = input.inboundId || null;
    let remoteCreated: { inboundId: number; port: number; tag: string; remark: string; remoteInboundFingerprint?: string; remoteInboundLastCheckedAt?: string; remoteClientEmail?: string; remoteClientUuid?: string; remoteClientSubId?: string; links?: string[]; realityTarget?: string; realityServerName?: string } | null = null;
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
        remoteInboundFingerprint: remoteCreated.remoteInboundFingerprint,
        remoteInboundObservedFingerprint: remoteCreated.remoteInboundFingerprint,
        remoteInboundDrift: false,
        remoteInboundLastCheckedAt: remoteCreated.remoteInboundLastCheckedAt,
        remoteClientEmail: remoteCreated.remoteClientEmail,
        remoteClientUuid: remoteCreated.remoteClientUuid,
        remoteClientSubId: remoteCreated.remoteClientSubId,
        remoteClientLinks: remoteCreated.links,
        realityTarget: remoteCreated.realityTarget,
        realityServerName: remoteCreated.realityServerName
      } : {
        remoteMode,
        remoteManaged: input.takeover,
        remoteInboundTag: remoteValidation?.tag,
        remoteInboundRemark: remoteValidation?.remark,
        remoteInboundPort: remoteValidation?.port || input.inboundPort,
        remoteInboundFingerprint: remoteValidation?.remoteInboundFingerprint,
        remoteInboundObservedFingerprint: remoteValidation?.remoteInboundFingerprint,
        remoteInboundDrift: false,
        remoteInboundLastCheckedAt: remoteValidation?.remoteInboundLastCheckedAt,
        remoteClientEmail: remoteClient?.email,
        remoteClientUuid: remoteClient?.uuid,
        remoteClientSubId: remoteClient?.subId,
        encryption: remoteValidation?.encryption,
        realityTarget: remoteValidation?.realityTarget,
        realityServerName: remoteValidation?.realityServerName,
        realityMinClientVersion: remoteValidation?.realityMinClientVersion,
        ...remoteValidation?.transportConfig
      });
      if (remoteValidation) {
        Object.assign(config, {
          encryption: remoteValidation.encryption,
          ...remoteValidation.transportConfig,
          realityTarget: remoteValidation.realityTarget,
          realityServerName: remoteValidation.realityServerName,
          realityMinClientVersion: remoteValidation.realityMinClientVersion
        });
      }
      const node = await this.prisma.serviceNode.create({
        data: {
          serverId: input.serverId,
          name: remoteValidation?.name || input.name,
          inboundId,
          protocol: remoteValidation?.protocol || input.protocol,
          config: this.toJsonValue(config),
          ownership: remoteCreated || input.takeover ? 'managed' : 'referenced',
          priceMonthly: new Prisma.Decimal(input.priceMonthly),
          trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb),
          enabled: remoteValidation?.enabled ?? input.enabled,
          remark: input.remark || null
        },
        include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
      });
      localCreated = true;
      const pendingActions: SyncTaskAction[] = [];
      if (config.socksRelayEnabled && node.ownership === 'managed') {
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
    const current = await this.prisma.serviceNode.findUnique({ where: { id }, select: { serverId: true } });
    if (!current) throw new NotFoundException('服务节点不存在');
    const lockedServerIds = [...new Set([current.serverId, input.serverId].filter((value): value is string => Boolean(value)))].sort();
    return this.locks.withLocks(lockedServerIds.map((serverId) => this.locks.panelOperationKey(serverId)), () =>
      this.locks.withLock(this.locks.serviceNodeKey(id), () => this.updateServiceNodeUnlocked(id, input, lockedServerIds))
    );
  }

  private async updateServiceNodeUnlocked(id: string, input: Partial<z.infer<typeof serviceNodeUpsertSchema>>, lockedServerIds: string[]) {
    const current = await this.ensureServiceNode(id);
    if (!lockedServerIds.includes(current.serverId)) throw new BadRequestException('服务节点绑定面板已被其他操作修改，请刷新后重试');
    const pendingRenewals = await this.prisma.renewalLog.count({
      where: { status: 'pending', customerNode: { serviceNodeId: id } }
    });
    if (pendingRenewals > 0) throw new BadRequestException('该路由节点存在待处理续费，完成自动恢复或人工对账后才能修改');
    if (input.protocol) this.assertShareLinkProtocol(input.protocol);
    if (input.serverId) await this.ensureServer(input.serverId);
    const nextServerId = input.serverId || current.serverId;
    const previousConfig = jsonObject(current.config) as ServiceNodeConfig;
    const remoteMode = input.remoteMode || previousConfig.remoteMode || (current.inboundId ? 'bind' : 'create');
    let inboundId = input.inboundId === undefined ? current.inboundId : input.inboundId || null;
    let remoteCreated: { inboundId: number; port: number; tag: string; remark: string; remoteInboundFingerprint?: string; remoteInboundLastCheckedAt?: string; remoteClientEmail?: string; remoteClientUuid?: string; remoteClientSubId?: string; links?: string[]; realityTarget?: string; realityServerName?: string } | null = null;
    let remoteClient: { email?: string; uuid?: string; subId?: string } | null = null;
    let remoteValidation: Awaited<ReturnType<XuiService['validateServiceNodeInbound']>> | null = null;
    let localUpdated = false;
    let nextName = input.name || current.name;
    let nextProtocol = input.protocol || current.protocol;
    let nextEncryption = input.encryption || previousConfig.encryption || 'none';
    let nextTransport = input.transport || previousConfig.transport || 'tcp';
    const bindingChanged = remoteMode === 'bind' && (
      nextServerId !== current.serverId ||
      inboundId !== current.inboundId ||
      previousConfig.remoteMode !== 'bind'
    );
    if ((nextProtocol === 'hysteria' || nextProtocol === 'hysteria2')) {
      nextEncryption = 'tls';
      nextTransport = 'tcp';
    } else {
      if (!['vless', 'trojan'].includes(nextProtocol) && nextEncryption === 'reality' && input.encryption === undefined) nextEncryption = 'none';
      if (nextProtocol === 'shadowsocks') nextTransport = 'tcp';
    }
    input = { ...input, encryption: nextEncryption as 'none' | 'tls' | 'reality', transport: nextTransport as 'tcp' | 'ws' | 'grpc' | 'httpupgrade' | 'xhttp' };
    if (!bindingChanged) this.assertTransportCompatibility(nextProtocol, nextEncryption, nextTransport);
    let nextEnabled = input.enabled ?? current.enabled;
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
      if (bindingChanged) {
        const boundCustomers = await this.prisma.customerNode.count({ where: { serviceNodeId: id } });
        if (boundCustomers > 0) {
          throw new BadRequestException(`该路由节点仍绑定 ${boundCustomers} 个用户账号。为避免错误关联或修改官方账号，请先解除用户绑定后再换绑入站`);
        }
        if (current.ownership === 'managed') {
          throw new BadRequestException('当前入站由本系统托管，不能直接换绑后遗留远端资源；请先删除当前路由节点，再重新添加目标入站');
        }
      }
      const takingOverCurrentBinding = !bindingChanged && current.ownership !== 'managed' && input.takeover === true;
      if (bindingChanged || takingOverCurrentBinding) {
        remoteValidation = await this.xui.validateServiceNodeInbound(nextServerId, inboundId);
        this.assertShareLinkProtocol(remoteValidation.protocol);
        this.assertTransportCompatibility(remoteValidation.protocol, remoteValidation.encryption, remoteValidation.transportConfig.transport);
        remoteClient = remoteValidation.remoteClient;
        if (bindingChanged) {
          nextName = remoteValidation.name;
          nextProtocol = remoteValidation.protocol;
          nextEncryption = remoteValidation.encryption;
          nextTransport = remoteValidation.transportConfig.transport;
          nextEnabled = remoteValidation.enabled;
          nextRemotePort = remoteValidation.port;
          input = {
            ...input,
            encryption: remoteValidation.encryption as 'none' | 'tls' | 'reality',
            ...remoteValidation.transportConfig,
            transport: remoteValidation.transportConfig.transport as 'tcp' | 'ws' | 'grpc' | 'httpupgrade' | 'xhttp',
            tcpHeaderType: remoteValidation.transportConfig.tcpHeaderType as 'none' | 'http',
            xhttpMode: remoteValidation.transportConfig.xhttpMode as 'auto' | 'packet-up' | 'stream-up' | 'stream-one',
            realityTarget: remoteValidation.realityTarget,
            realityServerName: remoteValidation.realityServerName,
            realityMinClientVersion: remoteValidation.realityMinClientVersion
          };
        }
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
        remoteInboundFingerprint: remoteCreated.remoteInboundFingerprint,
        remoteInboundObservedFingerprint: remoteCreated.remoteInboundFingerprint,
        remoteInboundDrift: false,
        remoteInboundLastCheckedAt: remoteCreated.remoteInboundLastCheckedAt,
        remoteClientEmail: remoteCreated.remoteClientEmail,
        remoteClientUuid: remoteCreated.remoteClientUuid,
        remoteClientSubId: remoteCreated.remoteClientSubId,
        remoteClientLinks: remoteCreated.links,
        realityTarget: remoteCreated.realityTarget,
        realityServerName: remoteCreated.realityServerName
      } : {
        remoteMode,
        remoteManaged: remoteMode === 'create' ? Boolean(previousConfig.remoteManaged) : input.takeover === true ? true : bindingChanged ? false : Boolean(previousConfig.remoteManaged),
        remoteInboundTag: remoteValidation?.tag ?? (bindingChanged ? undefined : previousConfig.remoteInboundTag),
        remoteInboundRemark: remoteValidation?.remark ?? (remoteMode === 'create' ? nextRemoteRemark : bindingChanged ? undefined : previousConfig.remoteInboundRemark),
        remoteInboundPort: remoteValidation
          ? remoteValidation.port
          : bindingChanged
            ? undefined
            : input.inboundPort === undefined
              ? previousConfig.remoteInboundPort
              : input.inboundPort,
        remoteInboundFingerprint: remoteValidation?.remoteInboundFingerprint ?? (bindingChanged ? undefined : previousConfig.remoteInboundFingerprint),
        remoteInboundObservedFingerprint: remoteValidation?.remoteInboundFingerprint ?? (bindingChanged ? undefined : previousConfig.remoteInboundObservedFingerprint),
        remoteInboundDrift: remoteValidation ? false : bindingChanged ? undefined : previousConfig.remoteInboundDrift,
        remoteInboundLastCheckedAt: remoteValidation?.remoteInboundLastCheckedAt ?? (bindingChanged ? undefined : previousConfig.remoteInboundLastCheckedAt),
        remoteClientEmail: remoteClient?.email ?? (bindingChanged ? undefined : previousConfig.remoteClientEmail),
        remoteClientUuid: remoteClient?.uuid ?? (bindingChanged ? undefined : previousConfig.remoteClientUuid),
        remoteClientSubId: remoteClient?.subId ?? (bindingChanged ? undefined : previousConfig.remoteClientSubId),
        remoteClientLinks: bindingChanged ? [] : previousConfig.remoteClientLinks,
        ...(remoteValidation ? { encryption: remoteValidation.encryption, ...remoteValidation.transportConfig } : {})
      };
      const config = await this.serviceNodeConfig(input, current.config, remotePatch);
      if (remoteValidation && bindingChanged) {
        Object.assign(config, {
          encryption: remoteValidation.encryption,
          ...remoteValidation.transportConfig,
          realityTarget: remoteValidation.realityTarget,
          realityServerName: remoteValidation.realityServerName,
          realityMinClientVersion: remoteValidation.realityMinClientVersion
        });
      }
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
      const takeOverBoundInbound = Boolean(
        !remoteCreated && inboundId && remoteMode === 'bind' && input.takeover === true
      );
      const takingOverCurrentBinding = Boolean(!bindingChanged && current.ownership !== 'managed' && takeOverBoundInbound);
      const remoteWriteRequested = Boolean(!remoteCreated && inboundId && !bindingChanged && (remoteInboundChanged || trafficLimitChanged || socksConfigChanged));
      if (remoteWriteRequested && current.ownership !== 'managed' && !takeOverBoundInbound) {
        throw new BadRequestException('该入站是官方面板引用资源。请明确选择“接管远端入站”后再修改远端配置');
      }
      if (takeOverBoundInbound) config.remoteManaged = true;
      const updated = await this.prisma.serviceNode.update({
        where: { id },
        data: {
          serverId: input.serverId,
          name: bindingChanged ? nextName : input.name,
          inboundId,
          protocol: bindingChanged ? nextProtocol : input.protocol,
          config: this.toJsonValue(config),
          ownership: remoteCreated || takeOverBoundInbound ? 'managed' : bindingChanged ? 'referenced' : current.ownership,
          priceMonthly: input.priceMonthly === undefined ? undefined : new Prisma.Decimal(input.priceMonthly),
          trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb),
          enabled: bindingChanged ? nextEnabled : input.enabled,
          remark: input.remark === undefined ? undefined : input.remark || null
        },
        include: { server: { select: { id: true, name: true, baseUrl: true, enabled: true } } }
      });
      localUpdated = true;
      const pendingActions: SyncTaskAction[] = [];
      if (!remoteCreated && inboundId && !bindingChanged && (remoteInboundChanged || takingOverCurrentBinding) && updated.ownership === 'managed') {
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
      if (remoteClientShouldSync && updated.ownership === 'managed') {
        if (trafficLimitChanged) {
          await this.prisma.customerNode.updateMany({
            where: { serviceNodeId: id, remoteControl: { not: 'reference' } },
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
      if (updated.inboundId && socksConfigChanged && updated.ownership === 'managed') {
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
    const current = await this.prisma.serviceNode.findUnique({ where: { id }, select: { serverId: true } });
    if (!current) throw new NotFoundException('服务节点不存在');
    return this.locks.withLock(this.locks.panelOperationKey(current.serverId), () =>
      this.locks.withLock(this.locks.serviceNodeKey(id), () => this.deleteServiceNodeUnlocked(id, recordFailure, current.serverId))
    );
  }

  private async deleteServiceNodeUnlocked(id: string, recordFailure = true, lockedServerId?: string) {
    const current = await this.ensureServiceNode(id);
    if (lockedServerId && current.serverId !== lockedServerId) throw new BadRequestException('服务节点绑定面板已被其他操作修改，请刷新后重试');
    let remoteInboundDeleted = false;
    let recoveryTaskRecorded = false;
    try {
      const pendingRenewals = await this.prisma.renewalLog.count({
        where: { status: 'pending', customerNode: { serviceNodeId: id } }
      });
      if (pendingRenewals > 0) throw new BadRequestException('该路由节点存在待处理续费，完成自动恢复或人工对账后才能删除');
      const remoteConfigCleanup = current.ownership === 'managed' && current.inboundId
        ? await this.xui.syncServiceNodeRemoteConfig(id, { removeOnly: true })
        : { skipped: true, reason: current.ownership === 'managed' ? '服务节点缺少入站 ID' : '引用入站只删除本地记录' };
      const remoteInboundCleanup = current.ownership === 'managed'
        ? await this.xui.deleteManagedServiceNodeInbound(id)
        : { deleted: false, skipped: true, reason: '引用入站只删除本地记录' };
      remoteInboundDeleted = remoteInboundCleanup.deleted === true;
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
      return {
        deleted: true,
        id,
        state: 'success',
        message: '删除成功',
        remoteClientCleanup: 'remoteClientCleanup' in remoteInboundCleanup ? remoteInboundCleanup.remoteClientCleanup : undefined,
        remoteConfigCleanup,
        remoteInboundCleanup,
        localImportedSocksCleanup
      };
    } catch (error) {
      if (recordFailure) {
        recoveryTaskRecorded = Boolean(
          await this.failSyncTask('service-node', id, 'service-delete-check', error, { remoteInboundDeleted }).catch(() => null)
        );
      }
      if (remoteInboundDeleted) {
        throw new BadGatewayException(
          recoveryTaskRecorded
            ? '官方入站已删除，但本地清理失败，系统已创建恢复任务。请勿重复操作，可稍后重试恢复任务'
            : '官方入站已删除，但本地清理失败。请勿重复操作，刷新后重试本地删除并人工核对'
        );
      }
      throw error;
    }
  }

  async syncServiceNodeConfig(id: string) {
    const node = await this.ensureManagedServiceNode(id);
    return this.locks.withLock(this.locks.panelOperationKey(node.serverId), () =>
      this.locks.withLock(this.locks.serviceNodeKey(id), async () => {
        const lockedNode = await this.ensureManagedServiceNode(id);
        if (lockedNode.serverId !== node.serverId) throw new BadRequestException('服务节点绑定面板已被其他操作修改，请刷新后重试');
        try {
          const result = await this.xui.syncServiceNodeRemoteConfig(id);
          await this.resolveSyncTask('service-node', id, 'service-config');
          return result;
        } catch (error) {
          await this.failSyncTask('service-node', id, 'service-config', error);
          throw error;
        }
      })
    );
  }

  async syncServiceNodeTrafficLimit(id: string, recordFailure = true) {
    return this.locks.withLock(this.locks.serviceNodeKey(id), async () => {
      const node = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true, inboundId: true, trafficLimitGb: true, ownership: true } });
      if (!node) throw new NotFoundException('服务节点不存在');
      if (node.ownership !== 'managed') throw new BadRequestException('引用入站不能向远端同步客户端额度，请先明确接管');
      await this.assertNoPendingRenewalsForServiceNode(id, '同步客户端额度');
      await this.prisma.customerNode.updateMany({
        where: { serviceNodeId: id, remoteControl: { not: 'reference' } },
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
    });
  }

  async listSocksNodes() {
    const nodes = await this.prisma.socksNode.findMany({ orderBy: { createdAt: 'desc' } });
    const tasks = await this.pendingTasks('socks-node', nodes.map((node) => node.id));
    return nodes.map((node) => ({ ...maskSocksNode(node), syncTasks: tasks.get(node.id) || [] }));
  }

  async getSocksNodeSecrets(id: string) {
    const node = await this.prisma.socksNode.findUnique({ where: { id }, select: { id: true, passwordEnc: true } });
    if (!node) throw new NotFoundException('Socks 节点不存在');
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
      input.name !== undefined ||
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

  async deleteSocksNode(id: string, takeover = false, recordFailure = true) {
    const initial = await this.ensureSocksNode(id);
    const operation = () => this.deleteSocksNodeUnlocked(id, takeover, recordFailure, initial.sourceServerId);
    return initial.sourceServerId
      ? this.locks.withLock(this.locks.panelOperationKey(initial.sourceServerId), operation)
      : operation();
  }

  private async deleteSocksNodeUnlocked(id: string, takeover: boolean, recordFailure: boolean, lockedServerId: string | null) {
    const node = await this.ensureSocksNode(id);
    if (node.sourceServerId !== lockedServerId) throw new BadRequestException('Socks 节点来源面板已被其他操作修改，请刷新后重试');
    const serviceNodes = await this.prisma.serviceNode.findMany({ select: { id: true, name: true, config: true } });
    const used = serviceNodes.find((node) => jsonObject(node.config).socksNodeId === id);
    if (used) throw new BadRequestException(`Socks 节点正在被服务节点“${used.name}”使用，请先关闭或更换该服务节点的 Socks 中转`);
    const importedReference = Boolean(node.sourceServerId && node.remoteOutboundTag);
    if (importedReference && !takeover) {
      throw new BadRequestException('该 Socks 节点来自官方面板。删除远端出站及其路由前必须明确确认接管删除');
    }
    let remoteDeleted = false;
    try {
      let remoteDelete: unknown = null;
      if (node.sourceServerId && node.remoteOutboundTag) {
        const outbound = await this.prisma.networkOutbound.findUnique({
          where: { serverId_tag: { serverId: node.sourceServerId, tag: node.remoteOutboundTag } },
          select: { id: true }
        });
        const referencedRoutes = await this.prisma.networkRoute.findMany({
          where: { serverId: node.sourceServerId },
          select: { id: true, outboundId: true, normalizedConfig: true }
        });
        const routeIdsToDelete = referencedRoutes
          .filter((route) =>
            (outbound && route.outboundId === outbound.id) ||
            routeReferencesOutboundTag(route.normalizedConfig, node.remoteOutboundTag!)
          )
          .map((route) => route.id);
        remoteDelete = await this.xui.deleteRemoteSocksOutbound(node.sourceServerId, node.remoteOutboundTag);
        remoteDeleted = true;
        const cleanupActions: Prisma.PrismaPromise<unknown>[] = [];
        if (routeIdsToDelete.length) {
          cleanupActions.push(this.prisma.networkRoute.deleteMany({ where: { id: { in: routeIdsToDelete } } }));
        }
        if (outbound) {
          cleanupActions.push(this.prisma.networkOutbound.delete({ where: { id: outbound.id } }));
        }
        cleanupActions.push(this.prisma.syncTask.deleteMany({ where: { entityType: 'socks-node', entityId: id } }));
        cleanupActions.push(this.prisma.socksNode.delete({ where: { id } }));
        await this.prisma.$transaction(cleanupActions);
      } else {
        await this.prisma.$transaction([
          this.prisma.syncTask.deleteMany({ where: { entityType: 'socks-node', entityId: id } }),
          this.prisma.socksNode.delete({ where: { id } })
        ]);
      }
      return {
        deleted: true,
        id,
        state: 'success',
        message: '删除成功',
        remoteDelete,
        remoteWrite: Boolean(remoteDelete),
        importedReference
      };
    } catch (error) {
      let recoveryTaskRecorded = false;
      if (recordFailure && remoteDeleted) {
        recoveryTaskRecorded = Boolean(
          await this.failSyncTask('socks-node', id, 'socks-delete-check', error, { takeover: true, remoteDeleted: true }).catch(() => null)
        );
      }
      if (remoteDeleted) {
        throw new BadGatewayException(
          recoveryTaskRecorded
            ? '官方 Socks 出站已删除，但本地清理失败，系统已创建恢复任务。请勿重复删除，可稍后重试恢复任务'
            : '官方 Socks 出站已删除，但本地清理失败。请勿重复删除，刷新后人工核对本地记录'
        );
      }
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
      let trafficError: string | null = null;
      const [links, traffic] = await Promise.all([
        this.xui.customerNodeLinks(customerId, node.id).catch((error) => {
          linkError = error instanceof Error ? error.message : String(error);
          return [] as string[];
        }),
        this.xui.syncCustomerNodeTraffic(customerId, node.id).catch((error) => {
          trafficError = this.trafficErrorMessage(error);
          return null;
        })
      ]);
      return {
        ...node,
        ...(traffic ? { usedTrafficGb: new Prisma.Decimal(traffic.usedTrafficGb), lastSyncedAt: traffic.syncedAt } : {}),
        usedTrafficBytes: traffic?.usedBytes ?? Math.max(Number(node.usedTrafficGb), 0) * 1024 ** 3,
        trafficStatus: traffic ? 'live' : node.lastSyncedAt ? 'cached' : 'error',
        trafficError,
        officialTrafficTotalBytes: traffic?.totalBytes ?? null,
        officialTrafficRemainingBytes: traffic?.remainingBytes ?? null,
        officialTrafficUnlimited: traffic?.unlimited ?? null,
        links,
        linkError,
        subId: jsonObject(node.config).subId || node.xuiEmail
      };
    }));
  }

  async bindCustomerNode(customerId: string, input: z.infer<typeof customerNodeCreateSchema>) {
    return this.locks.withLock(this.locks.serviceNodeKey(input.serviceNodeId), () => this.bindCustomerNodeUnlocked(customerId, input));
  }

  private async bindCustomerNodeUnlocked(customerId: string, input: z.infer<typeof customerNodeCreateSchema>) {
    const [customer, serviceNode] = await Promise.all([
      this.prisma.customer.findUnique({ where: { id: customerId } }),
      this.prisma.serviceNode.findUnique({ where: { id: input.serviceNodeId } })
    ]);
    if (!customer) throw new NotFoundException('用户不存在');
    if (!serviceNode) throw new NotFoundException('服务节点不存在');

    if (!serviceNode.inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');
    const occupied = await this.prisma.customerNode.findFirst({
      where: { serviceNodeId: input.serviceNodeId },
      select: { id: true }
    });
    if (occupied) throw new BadRequestException('该节点已绑定其他用户，请先解除原绑定后再操作');
    const remoteClient = await this.serviceNodeRemoteClientIdentity(serviceNode);
    const xuiEmail = remoteClient.email;
    const uuid = remoteClient.uuid || null;
    if (!xuiEmail) throw new BadRequestException('该路由节点没有可绑定的官方客户端，请先同步或修复路由节点');
    const remoteIdentity = { email: xuiEmail, uuid, subId: remoteClient.subId };
    const expireAt = input.expireAt || null;
    const enabled = !expireAt || expireAt > new Date();
    const node = await this.prisma.customerNode.create({
      data: {
        customerId,
        serviceNodeId: input.serviceNodeId,
        clientName: null,
        xuiEmail,
        uuid,
        expireAt,
        trafficLimitGb: new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
        status: enabled ? 'active' : 'disabled',
        disabledReason: enabled ? null : 'expired',
        remoteControl: 'reference',
        config: this.toJsonValue({ uuid, subId: remoteClient.subId })
      },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });

    let remoteBefore: Awaited<ReturnType<XuiService['serviceNodeRemoteClientState']>> | undefined;
    let syncResult: Awaited<ReturnType<XuiService['updateServiceNodeRemoteAuthorization']>>;
    try {
      await this.xui.refreshCustomerNodeBinding(customerId, node.id);
      remoteBefore = await this.xui.serviceNodeRemoteClientState(serviceNode.id, remoteIdentity);
      syncResult = await this.xui.updateServiceNodeRemoteAuthorization(serviceNode.id, remoteIdentity, expireAt, enabled);
    } catch (error) {
      if (remoteBefore) {
        await this.xui.updateServiceNodeRemoteAuthorization(
          serviceNode.id,
          remoteIdentity,
          remoteBefore.expiryTime > 0 ? new Date(remoteBefore.expiryTime) : null,
          remoteBefore.enable
        ).catch(() => undefined);
      }
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
    const current = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      select: { serviceNodeId: true }
    });
    if (!current) throw new NotFoundException('用户节点不存在');
    const lockedServiceNodeId = input.serviceNodeId || current.serviceNodeId;
    const serviceNodeIds = [...new Set([current.serviceNodeId, lockedServiceNodeId])].sort();
    return this.withServiceNodeLocks(serviceNodeIds, () =>
      this.locks.withLock(this.locks.customerNodeKey(customerNodeId), () =>
        this.updateCustomerNodeUnlocked(customerId, customerNodeId, input, lockedServiceNodeId)
      )
    );
  }

  private async updateCustomerNodeUnlocked(
    customerId: string,
    customerNodeId: string,
    input: Partial<z.infer<typeof customerNodeCreateSchema>>,
    lockedServiceNodeId: string
  ) {
    const current = await this.prisma.customerNode.findFirst({ where: { id: customerNodeId, customerId }, include: { serviceNode: true } });
    if (!current) throw new NotFoundException('用户节点不存在');
    const pendingRenewal = await this.prisma.renewalLog.findFirst({
      where: { customerNodeId, status: 'pending' },
      select: { id: true }
    });
    if (pendingRenewal) throw new BadRequestException('该用户节点存在待处理续费，完成自动恢复或人工对账后才能修改绑定');

    const serviceNodeId = input.serviceNodeId || current.serviceNodeId;
    if (serviceNodeId !== lockedServiceNodeId) throw new BadRequestException('绑定关系已被其他操作修改，请刷新后重试');
    const serviceNode = serviceNodeId === current.serviceNodeId ? current.serviceNode : await this.prisma.serviceNode.findUnique({ where: { id: serviceNodeId } });
    if (!serviceNode) throw new NotFoundException('服务节点不存在');

    const nodeChanged = serviceNodeId !== current.serviceNodeId;
    if (nodeChanged) {
      const occupied = await this.prisma.customerNode.findFirst({
        where: { serviceNodeId, id: { not: customerNodeId } },
        select: { id: true }
      });
      if (occupied) throw new BadRequestException('目标节点已绑定其他用户，请先解除原绑定后再操作');
    }
    const remoteClient = nodeChanged
      ? await this.serviceNodeRemoteClientIdentity(serviceNode)
      : { email: current.xuiEmail, uuid: current.uuid || undefined, subId: stringValue(jsonObject(current.config).subId) };
    const nextXuiEmail = remoteClient.email;
    if (!nextXuiEmail) throw new BadRequestException('该路由节点没有可绑定的官方客户端，请先同步或修复路由节点');
    const nextUuid = remoteClient.uuid || null;
    const currentConfig = jsonObject(current.config);
    const nextConfig = nodeChanged
      ? { uuid: nextUuid, subId: remoteClient.subId }
      : currentConfig;
    const nextExpireAt = input.expireAt === undefined ? current.expireAt : input.expireAt || null;
    const expiryAllowsAccess = !nextExpireAt || nextExpireAt > new Date();
    const nextEnabled = current.disabledReason === 'admin' || current.disabledReason === 'traffic_exceeded'
      ? false
      : expiryAllowsAccess;
    const nextStatus = nextEnabled ? 'active' : 'disabled';
    const nextDisabledReason = nextEnabled ? null : current.disabledReason === 'admin' || current.disabledReason === 'traffic_exceeded'
      ? current.disabledReason
      : 'expired';
    const oldRemoteIdentity = {
      email: current.xuiEmail,
      uuid: current.uuid,
      subId: stringValue(currentConfig.subId)
    };
    const targetRemoteIdentity = {
      email: nextXuiEmail,
      uuid: nextUuid,
      subId: remoteClient.subId
    };

    const oldRemoteBefore = await this.xui.serviceNodeRemoteClientState(current.serviceNodeId, oldRemoteIdentity);
    if (nodeChanged) await this.xui.setServiceNodeRemoteClientEnabled(current.serviceNodeId, oldRemoteIdentity, false);

    let node;
    try {
      node = await this.prisma.customerNode.update({
        where: { id: customerNodeId },
        data: {
          serviceNodeId: input.serviceNodeId,
          clientName: nodeChanged ? null : undefined,
          xuiEmail: nextXuiEmail,
          uuid: nextUuid,
          expireAt: nextExpireAt,
          trafficLimitGb: input.trafficLimitGb === undefined ? undefined : new Prisma.Decimal(input.trafficLimitGb ?? serviceNode.trafficLimitGb),
          status: nextStatus,
          disabledReason: nextDisabledReason,
          remoteControl: 'reference',
          config: this.toJsonValue(nextConfig)
        },
        include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
      });
    } catch (error) {
      if (nodeChanged) {
        await this.xui.updateServiceNodeRemoteAuthorization(
          current.serviceNodeId,
          oldRemoteIdentity,
          oldRemoteBefore.expiryTime > 0 ? new Date(oldRemoteBefore.expiryTime) : null,
          oldRemoteBefore.enable
        ).catch(() => undefined);
      }
      throw error;
    }

    let targetRemoteBefore: Awaited<ReturnType<XuiService['serviceNodeRemoteClientState']>> | undefined;
    let syncResult: Awaited<ReturnType<XuiService['updateServiceNodeRemoteAuthorization']>>;
    try {
      await this.xui.refreshCustomerNodeBinding(customerId, customerNodeId);
      targetRemoteBefore = nodeChanged
        ? await this.xui.serviceNodeRemoteClientState(serviceNodeId, targetRemoteIdentity)
        : oldRemoteBefore;
      syncResult = await this.xui.updateServiceNodeRemoteAuthorization(serviceNodeId, targetRemoteIdentity, nextExpireAt, nextEnabled);
    } catch (error) {
      if (targetRemoteBefore) {
        await this.xui.updateServiceNodeRemoteAuthorization(
          serviceNodeId,
          targetRemoteIdentity,
          targetRemoteBefore.expiryTime > 0 ? new Date(targetRemoteBefore.expiryTime) : null,
          targetRemoteBefore.enable
        ).catch(() => undefined);
      }
      await this.prisma.customerNode.update({
        where: { id: customerNodeId },
        data: {
          serviceNodeId: current.serviceNodeId,
          clientName: current.clientName,
          xuiEmail: current.xuiEmail,
          uuid: current.uuid,
          expireAt: current.expireAt,
          trafficLimitGb: current.trafficLimitGb,
          remoteControl: current.remoteControl,
          status: current.status,
          disabledReason: current.disabledReason,
          config: this.toJsonValue(current.config)
        }
      }).catch(() => undefined);
      if (nodeChanged) {
        await this.xui.updateServiceNodeRemoteAuthorization(
          current.serviceNodeId,
          oldRemoteIdentity,
          oldRemoteBefore.expiryTime > 0 ? new Date(oldRemoteBefore.expiryTime) : null,
          oldRemoteBefore.enable
        ).catch(() => undefined);
      }
      throw error;
    }

    const syncedNode = await this.prisma.customerNode.findUnique({
      where: { id: node.id },
      include: { serviceNode: { include: { server: true } }, customer: { select: { id: true, name: true, loginUsername: true } } }
    });
    return { node: syncedNode, sync: syncResult };
  }

  private async serviceNodeRemoteClientIdentity(serviceNode: { id: string; serverId: string; inboundId: number | null; config: Prisma.JsonValue | null }) {
    if (!serviceNode.inboundId) throw new BadRequestException('服务节点缺少官方 3x-ui 入站 ID');
    const config = jsonObject(serviceNode.config) as ServiceNodeConfig;
    const saved = {
      email: stringValue(config.remoteClientEmail),
      uuid: stringValue(config.remoteClientUuid),
      subId: stringValue(config.remoteClientSubId)
    };
    if (saved.email) return saved;

    const validation = await this.xui.validateServiceNodeInbound(serviceNode.serverId, serviceNode.inboundId);
    const resolved = {
      email: validation.remoteClient.email || '',
      uuid: validation.remoteClient.uuid || '',
      subId: validation.remoteClient.subId || ''
    };
    if (resolved.email) {
      await this.prisma.serviceNode.update({
        where: { id: serviceNode.id },
        data: {
          config: this.toJsonValue({
            ...config,
            remoteClientEmail: resolved.email,
            remoteClientUuid: resolved.uuid || undefined,
            remoteClientSubId: resolved.subId || undefined
          })
        }
      });
    }
    return resolved;
  }

  async unbindCustomerNode(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({ where: { id: customerNodeId, customerId }, select: { serviceNodeId: true } });
    if (!node) throw new NotFoundException('用户节点不存在');
    return this.locks.withLock(this.locks.serviceNodeKey(node.serviceNodeId), () =>
      this.locks.withLock(this.locks.customerNodeKey(customerNodeId), () => this.unbindCustomerNodeUnlocked(customerId, customerNodeId))
    );
  }

  private async unbindCustomerNodeUnlocked(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      select: { id: true, serviceNodeId: true, xuiEmail: true, uuid: true, config: true }
    });
    if (!node) throw new NotFoundException('用户节点不存在');
    const pendingRenewal = await this.prisma.renewalLog.findFirst({
      where: { customerNodeId, status: 'pending' },
      select: { id: true }
    });
    if (pendingRenewal) throw new BadRequestException('该用户节点存在待处理续费，完成自动恢复或人工对账后才能解绑');
    const remoteIdentity = {
      email: node.xuiEmail,
      uuid: node.uuid,
      subId: stringValue(jsonObject(node.config).subId)
    };
    const remoteBefore = await this.xui.serviceNodeRemoteClientState(node.serviceNodeId, remoteIdentity);
    const remoteCleanup = await this.xui.setServiceNodeRemoteClientEnabled(node.serviceNodeId, remoteIdentity, false);
    try {
      await this.prisma.customerNode.delete({ where: { id: customerNodeId } });
    } catch (error) {
      await this.xui.updateServiceNodeRemoteAuthorization(
        node.serviceNodeId,
        remoteIdentity,
        remoteBefore.expiryTime > 0 ? new Date(remoteBefore.expiryTime) : null,
        remoteBefore.enable
      ).catch(() => undefined);
      throw error;
    }
    return { deleted: true, id: customerNodeId, remoteCleanup };
  }

  private async withServiceNodeLocks<T>(serviceNodeIds: string[], operation: () => Promise<T>, index = 0): Promise<T> {
    const serviceNodeId = serviceNodeIds[index];
    if (!serviceNodeId) return operation();
    return this.locks.withLock(this.locks.serviceNodeKey(serviceNodeId), () => this.withServiceNodeLocks(serviceNodeIds, operation, index + 1));
  }

  async deleteServiceNodeFromCustomerNode(customerId: string, customerNodeId: string) {
    const node = await this.prisma.customerNode.findFirst({
      where: { id: customerNodeId, customerId },
      select: { id: true, serviceNodeId: true }
    });
    if (!node) throw new NotFoundException('用户节点不存在');
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
      if (action === 'socks-delete-check') {
        const taskDetail = jsonObject(detail);
        return this.deleteSocksNode(entityId, Boolean(taskDetail.takeover || taskDetail.remoteDeleted), false);
      }
    }
    throw new BadRequestException('该任务不支持自动重试');
  }

  private async syncServiceNodeInboundFromLocal(id: string, forceRuntimeReload = false) {
    const node = await this.ensureServiceNode(id);
    if (node.ownership !== 'managed') throw new BadRequestException('引用入站不能写回远端，请先明确接管');
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
    await this.prisma.serviceNode.update({
      where: { id },
      data: {
        config: this.toJsonValue({
          ...config,
          remoteManaged: true,
          remoteInboundTag: result.remoteInboundTag || config.remoteInboundTag,
          remoteInboundRemark: result.remoteInboundRemark,
          remoteInboundPort: result.port,
          remoteInboundFingerprint: result.remoteInboundFingerprint,
          remoteInboundObservedFingerprint: result.remoteInboundFingerprint,
          remoteInboundDrift: false,
          remoteInboundLastCheckedAt: result.remoteInboundLastCheckedAt
        })
      }
    });
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

  private trafficErrorMessage(error: unknown) {
    const message = this.errorMessage(error);
    if (/标识不一致/i.test(message)) return '绑定记录与路由节点的官方客户端标识不一致，请联系管理员同步绑定';
    if (/缺少官方客户端标识/i.test(message)) return '路由节点缺少官方客户端标识，请联系管理员修复节点配置';
    if (/401|403|unauthor|forbidden|登录|认证|凭据|密码/i.test(message)) return '官方面板认证失败，暂时无法读取流量';
    if (/not found|不存在|未找到|找不到|404/i.test(message)) return '官方面板中未找到绑定的客户端，请联系管理员核对绑定';
    if (/timeout|超时/i.test(message)) return '官方面板响应超时，当前显示上次成功同步的数据';
    if (/network|fetch failed|econn|enotfound|网络|连接/i.test(message)) return '暂时无法连接官方面板，当前显示上次成功同步的数据';
    return '官方客户端流量获取失败，请联系管理员检查面板连接和客户端绑定';
  }

  private async ensureServer(id: string) {
    const exists = await this.prisma.xuiServer.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException('3x-ui 服务器不存在');
  }

  private async ensureServiceNode(id: string) {
    const exists = await this.prisma.serviceNode.findUnique({ where: { id }, select: { id: true, serverId: true, name: true, protocol: true, inboundId: true, ownership: true, enabled: true, trafficLimitGb: true, remark: true, config: true } });
    if (!exists) throw new NotFoundException('服务节点不存在');
    return exists;
  }

  private async ensureManagedServiceNode(id: string) {
    const node = await this.ensureServiceNode(id);
    if (node.ownership !== 'managed') throw new BadRequestException('该入站为官方面板引用资源，请明确接管后再执行远端写操作');
    return node;
  }

  private async assertNoPendingRenewalsForServiceNode(serviceNodeId: string, action: string) {
    const pending = await this.prisma.renewalLog.findFirst({
      where: { status: 'pending', customerNode: { serviceNodeId } },
      select: { id: true }
    });
    if (pending) throw new BadRequestException(`该路由节点存在待处理续费，完成自动恢复或人工对账后才能${action}`);
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
    if (!exists) throw new NotFoundException('Socks 节点不存在');
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
    if (!socksNodeId) return { deleted: false, skipped: true, reason: '服务节点没有绑定 Socks 节点' };

    const socksNode = await this.prisma.socksNode.findUnique({
      where: { id: socksNodeId },
      select: { id: true, name: true, sourceServerId: true, remoteOutboundTag: true }
    });
    if (!socksNode) return { deleted: false, skipped: true, reason: 'Socks 节点已经不存在', socksNodeId };
    if (!socksNode.sourceServerId || !socksNode.remoteOutboundTag) {
      return { deleted: false, skipped: true, reason: '该 Socks 节点由本地创建', socksNodeId, socksNodeName: socksNode.name };
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
        reason: '该 Socks 节点仍被其他服务节点引用',
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
      realityMinClientVersion: input.realityMinClientVersion === undefined
        ? previous.realityMinClientVersion || ''
        : input.realityMinClientVersion || '',
      socksRelayEnabled: input.socksRelayEnabled === undefined ? Boolean(previous.socksRelayEnabled) : input.socksRelayEnabled,
      socksNodeId: input.socksNodeId === undefined ? previous.socksNodeId || null : input.socksNodeId || null
    };
    if (next.socksRelayEnabled) {
      if (!next.socksNodeId) throw new BadRequestException('启用 Socks 中转时必须选择 Socks 节点');
      const socks = await this.prisma.socksNode.findUnique({ where: { id: next.socksNodeId }, select: { id: true, enabled: true } });
      if (!socks) throw new NotFoundException('Socks 节点不存在');
      if (!socks.enabled) throw new BadRequestException('所选 Socks 节点已停用');
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

function routeReferencesOutboundTag(value: unknown, outboundTag: string) {
  const configured = jsonObject(value).outboundTag;
  if (Array.isArray(configured)) return configured.some((item) => stringValue(item) === outboundTag);
  return stringValue(configured) === outboundTag;
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
