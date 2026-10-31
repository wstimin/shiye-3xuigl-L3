import {
  BadGatewayException,
  BadRequestException,
  Injectable
} from '@nestjs/common';
import { Prisma, type ServiceNode, type XuiServer } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { DatabaseLockService } from '../../shared/database-lock.service.js';
import { SuiService } from './sui.service.js';
import { suiAuthorization } from './sui-state.js';

type Row = Record<string, unknown>;
type Node = Pick<
  ServiceNode,
  'id' | 'serverId' | 'inboundId' | 'config' | 'protocol'
> & { server: XuiServer };
export const suiLinkSchema = z.object({
  clientId: z.number().int().positive(),
  inboundId: z.number().int().positive(),
  name: z.string().trim().min(1).max(120),
  priceMonthly: z.coerce.number().finite().min(0).max(99999999)
});
const obj = (value: unknown): Row =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Row)
    : {};
const json = (value: unknown) =>
  JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const rows = (value: unknown, key: string): Row[] => {
  const list = obj(value)[key];
  return Array.isArray(list) ? (list as Row[]) : [];
};

/** Translates the existing node/billing contract, keeping seconds and bytes at the S-UI boundary. */
@Injectable()
export class SuiBusinessService {
  private readonly subscriptionUris = new Map<string, { expires: number; value: Promise<string> }>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly sui: SuiService,
    private readonly locks: DatabaseLockService
  ) {}

  list(serverId: string) {
    return this.prisma.serviceNode.findMany({
      where: { serverId },
      select: {
        id: true,
        name: true,
        inboundId: true,
        config: true,
        priceMonthly: true,
        enabled: true,
        _count: { select: { customerNodes: true } }
      }
    });
  }

  status(serverId: string) {
    return this.sui.test(serverId);
  }

  async link(serverId: string, input: z.infer<typeof suiLinkSchema>) {
    return this.locks.withLock(
      this.locks.panelOperationKey(serverId),
      async () => {
        const api = await this.sui.client(serverId);
        const [clients, inbounds] = await Promise.all([
          api.request(`clients?id=${input.clientId}`),
          api.read('inbounds')
        ]);
        const client = rows(clients, 'clients').find(
          (row) => Number(row.id) === input.clientId
        );
        const inbound = rows(inbounds, 'inbounds').find(
          (row) => Number(row.id) === input.inboundId
        );
        if (!client || !inbound)
          throw new BadRequestException('所选客户端或入站已不存在，请刷新');
        if (client.delayStart === true || Number(client.expiry) < 0)
          throw new BadRequestException(
            '请先关闭客户端的首次使用计时，再接入按月续费业务'
          );
        suiAuthorization(client);
        // A shared S-UI quota/expiry cannot be billed independently by several business nodes.
        if (
          !Array.isArray(client.inbounds) ||
          client.inbounds.length !== 1 ||
          Number(client.inbounds[0]) !== input.inboundId
        ) {
          throw new BadRequestException(
            '业务客户端必须仅关联所选入站，避免共享额度和续费互相影响'
          );
        }
        const existing = await this.prisma.serviceNode.findMany({
          where: { serverId }
        });
        if (
          existing.some(
            (node) =>
              node.inboundId === input.inboundId ||
              Number(obj(node.config).suiClientId) === input.clientId
          )
        ) {
          throw new BadRequestException(
            '该入站或客户端已接入业务，请到服务入站管理'
          );
        }
        const node = await this.prisma.serviceNode.create({
          data: {
            serverId,
            inboundId: input.inboundId,
            name: input.name,
            protocol: String(inbound.type),
            priceMonthly: input.priceMonthly,
            trafficLimitGb: Number(client.volume || 0) / 1024 ** 3,
            enabled: client.enable === true,
            ownership: 'managed',
            config: json({
              suiClientId: input.clientId,
              remoteManaged: true,
              remoteMode: 'bind',
              remoteInboundTag: inbound.tag,
              remoteClientEmail: client.name,
              remoteClientName: client.remark,
              remoteClientSubId: client.name,
              remoteClientEnabled: client.enable,
              remoteClientExpireAt:
                Number(client.expiry) > 0
                  ? new Date(Number(client.expiry) * 1000).toISOString()
                  : null
            })
          },
          include: {
            server: {
              select: {
                id: true,
                name: true,
                baseUrl: true,
                enabled: true,
                provider: true
              }
            }
          }
        });
        await this.log(serverId, node.id, 'link');
        return node;
      }
    );
  }

  async remote(node: Node, identity?: { email: string }) {
    if (!node.server.enabled) throw new BadRequestException('S-UI 连接已停用');
    const api = await this.sui.client(node.serverId);
    const config = obj(node.config);
    const client = rows(
      await api.request(`clients?id=${Number(config.suiClientId)}`),
      'clients'
    ).find((row) => Number(row.id) === Number(config.suiClientId));
    if (!client || (identity && client.name !== identity.email))
      throw new BadGatewayException(
        'S-UI 客户端不存在或标识已变化，请先同步业务绑定'
      );
    if (client.delayStart === true || Number(client.expiry) < 0)
      throw new BadGatewayException(
        'S-UI 客户端已改为首次使用计时，请先恢复固定到期时间再续费'
      );
    suiAuthorization(client);
    if (
      !Array.isArray(client.inbounds) ||
      client.inbounds.length !== 1 ||
      Number(client.inbounds[0]) !== node.inboundId
    ) {
      throw new BadGatewayException(
        'S-UI 入站关联已变化，请恢复独立业务客户端后再操作'
      );
    }
    return { api, client };
  }

  async state(node: Node, identity: { email: string }) {
    const { client } = await this.remote(node, identity);
    return {
      serviceNodeId: node.id,
      inboundId: node.inboundId!,
      xuiEmail: String(client.name),
      expiryTime: Math.max(0, Number(client.expiry) || 0) * 1000,
      totalGB: Math.max(0, Number(client.volume) || 0),
      enable: client.enable === true
    };
  }

  async patch(
    node: Node,
    identity: { email: string },
    patch: Row,
    operation: string
  ) {
    const { api, client } = await this.remote(node, identity);
    const native: Row = {};
    if ('expiryTime' in patch)
      native.expiry = Math.floor(Number(patch.expiryTime) / 1000);
    if ('enable' in patch) native.enable = patch.enable;
    if ('totalGB' in patch) {
      if (
        !Number.isSafeInteger(Number(patch.totalGB)) ||
        Number(patch.totalGB) < 0
      )
        throw new BadRequestException('流量额度超出有效字节范围');
      native.volume = Number(patch.totalGB);
    }
    if ('remark' in patch) native.remark = patch.remark;
    await api.save('clients', 'edit', {
      ...client,
      ...native
    });
    const verified = (await this.remote(node, identity)).client;
    for (const [field, value] of Object.entries(native)) {
      if (verified[field] !== value)
        throw new BadGatewayException(
          `S-UI 字段 ${field} 回读不一致，等待续费恢复核对`
        );
    }
    await this.prisma.serviceNode.update({
      where: { id: node.id },
      data: {
        config: json({
          ...obj(node.config),
          remoteClientName: verified.remark,
          remoteClientEnabled: verified.enable,
          remoteClientExpireAt:
            Number(verified.expiry) > 0
              ? new Date(Number(verified.expiry) * 1000).toISOString()
              : null,
          remoteClientTrafficLimitGb: Number(verified.volume || 0) / 1024 ** 3
        })
      }
    });
    await this.log(node.serverId, node.id, operation);
    return {
      synced: true,
      remoteWrite: true,
      route: 'apiv2/save',
      operation,
      fields: Object.keys(patch),
      before: {
        expiryTime: Number(client.expiry || 0) * 1000,
        enable: client.enable,
        totalGB: client.volume
      },
      detail: {
        serviceNodeId: node.id,
        inboundId: node.inboundId,
        xuiEmail: identity.email,
        operation,
        fields: Object.keys(patch)
      },
      // /save can return every panel client, including other customers' credentials.
      response: { success: true, clientId: Number(client.id) },
      verified: {
        expiryTime: Number(verified.expiry || 0) * 1000,
        enable: verified.enable === true
      }
    };
  }

  async traffic(node: Node) {
    const { client } = await this.remote(node);
    if (
      !['up', 'down', 'volume'].every(
        (key) =>
          typeof client[key] === 'number' &&
          Number.isFinite(client[key]) &&
          Number(client[key]) >= 0
      )
    )
      throw new BadGatewayException(
        'S-UI 流量响应缺少有效的 up/down/volume 字段'
      );
    const upBytes = Math.max(0, Number(client.up) || 0),
      downBytes = Math.max(0, Number(client.down) || 0);
    const usedBytes = upBytes + downBytes,
      totalBytes = Math.max(0, Number(client.volume) || 0);
    return {
      xuiEmail: String(client.name),
      upBytes,
      downBytes,
      usedBytes,
      usedTrafficGb: usedBytes / 1024 ** 3,
      totalBytes,
      remainingBytes: totalBytes ? Math.max(0, totalBytes - usedBytes) : null,
      unlimited: totalBytes === 0,
      syncedAt: new Date(),
      source: 'sui'
    };
  }

  async editClient(
    node: Node,
    input: {
      email?: string;
      clientName?: string;
      expireAt?: Date | null;
      trafficLimitGb?: number;
      enabled?: boolean;
    }
  ) {
    await this.pending(node.id);
    const email = String(obj(node.config).remoteClientEmail);
    const { client } = await this.remote(node);
    await this.sui.save(node.serverId, {
      object: 'clients', action: 'edit', data: {
        ...client,
        name: input.email || email,
        ...(input.clientName === undefined ? {} : { remark: input.clientName }),
        ...(input.expireAt === undefined ? {} : { expiry: Math.floor((input.expireAt?.getTime() || 0) / 1000) }),
        ...(input.trafficLimitGb === undefined ? {} : { volume: Math.round(input.trafficLimitGb * 1024 ** 3) }),
        ...(input.enabled === undefined ? {} : { enable: input.enabled })
      }
    });
    return {
      updated: true,
      route: 'apiv2/save',
      serviceNodeId: node.id,
      inboundId: node.inboundId!,
      previousEmail: email,
      xuiEmail: input.email || email,
      response: { success: true, clientId: Number(client.id) }
    };
  }

  async customerTraffic(
    customerId: string,
    customerNodeId: string,
    node: Node
  ) {
    const traffic = await this.traffic(node);
    await this.prisma.customerNode.update({
      where: { id: customerNodeId },
      data: {
        usedTrafficGb: traffic.usedTrafficGb,
        lastSyncedAt: traffic.syncedAt
      }
    });
    return { customerId, customerNodeId, ...traffic };
  }

  async resetTraffic(node: Node) {
    await this.pending(node.id);
    const { api, client } = await this.remote(node);
    await api.save('clients', 'edit', { ...client, up: 0, down: 0 });
    const traffic = await this.traffic(node);
    if (traffic.usedBytes !== 0)
      throw new BadGatewayException('S-UI 流量重置后回读不为零，请刷新核对');
    await this.prisma.customerNode.updateMany({
      where: { serviceNodeId: node.id },
      data: { usedTrafficGb: 0, lastSyncedAt: new Date() }
    });
    await this.log(node.serverId, node.id, 'reset-traffic');
    return {
      synced: true,
      serviceNodeId: node.id,
      inboundId: node.inboundId,
      response: { reset: true }
    };
  }

  async links(node: Node) {
    const { api, client } = await this.remote(node);
    const links = Array.isArray(client.links)
      ? client.links
          .map((link) =>
            typeof link === 'string' ? link : String(obj(link).uri || '')
          )
          .filter((link) =>
            /^(https?:|vless:|vmess:|trojan:|ss:|hy2:|hysteria2?:|tuic:|anytls:)/.test(
              link
            )
          )
      : [];
    const subURI = await this.subscriptionUri(node, api);
    if (subURI) {
      // S-UI's own subscription service renders every supported protocol correctly.
      links.unshift(
        `${subURI.replace(/\/+$/, '')}/${encodeURIComponent(String(client.name))}`
      );
    }
    return [...new Set(links)];
  }

  private subscriptionUri(node: Node, api: { request<T>(path: string): Promise<T> }) {
    const key = `${node.serverId}:${node.server.baseUrl}`;
    const cached = this.subscriptionUris.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;
    if (this.subscriptionUris.size >= 128) this.subscriptionUris.delete(this.subscriptionUris.keys().next().value!);
    // Only cache panel metadata, never clients or their credentials.
    const value = api.request<Row>('load').then(loaded =>
      typeof loaded.subURI === 'string' && /^https?:\/\//.test(loaded.subURI) ? loaded.subURI : ''
    ).catch(error => {
      if (this.subscriptionUris.get(key)?.value === value) this.subscriptionUris.delete(key);
      throw error;
    });
    this.subscriptionUris.set(key, { expires: Date.now() + 60_000, value });
    return value;
  }

  async refreshBinding(customerId: string, customerNodeId: string, node: Node) {
    const { client } = await this.remote(node);
    const links = await this.links(node);
    const updated = await this.prisma.customerNode.update({
      where: { id: customerNodeId },
      data: {
        xuiEmail: String(client.name),
        clientName: String(client.remark || client.name),
        lastSyncedAt: new Date(),
        config: json({ subId: client.name, links, suiClientId: client.id })
      },
      include: {
        serviceNode: { include: { server: true } },
        customer: { select: { id: true, name: true, loginUsername: true } }
      }
    });
    return {
      synced: true,
      action: 'refresh',
      route: 'apiv2/clients',
      remoteWrite: false,
      node: updated,
      detail: { customerId, customerNodeId, links }
    };
  }

  async sync(serverId: string) {
    return this.locks.withLock(
      this.locks.panelOperationKey(serverId),
      async () => {
        await this.sui.client(serverId);
        const nodes = await this.prisma.serviceNode.findMany({
          where: { serverId },
          include: { server: true }
        });
        const results = [];
        for (const node of nodes) {
          try {
            await this.locks.withLock(
              this.locks.serviceNodeKey(node.id),
              async () => {
                await this.pending(node.id);
                const { client } = await this.remote(node);
                const traffic = await this.traffic(node);
                const authorization = suiAuthorization(client);
                await this.prisma.$transaction([
                  this.prisma.serviceNode.update({
                    where: { id: node.id },
                    data: {
                      trafficLimitGb: Number(client.volume || 0) / 1024 ** 3,
                      config: json({
                        ...obj(node.config),
                        remoteClientEmail: client.name,
                        remoteClientName: client.remark,
                        remoteClientSubId: client.name,
                        remoteClientEnabled: client.enable,
                        remoteClientExpireAt:
                          authorization.expireAt?.toISOString() || null
                      })
                    }
                  }),
                  this.prisma.customerNode.updateMany({
                    where: { serviceNodeId: node.id },
                    data: {
                      xuiEmail: String(client.name),
                      ...authorization,
                      usedTrafficGb: traffic.usedTrafficGb,
                      lastSyncedAt: traffic.syncedAt
                    }
                  })
                ]);
              }
            );
            results.push({ serviceNodeId: node.id, synced: true });
          } catch (error) {
            results.push({
              serviceNodeId: node.id,
              synced: false,
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
        await this.log(
          serverId,
          undefined,
          'sync',
          results.every((row) => row.synced) ? 'success' : 'partial'
        );
        return { synced: results.every((row) => row.synced), results };
      }
    );
  }

  async update(
    node: Node,
    input: {
      serverId?: string;
      inboundId?: number | null;
      protocol?: string;
      name?: string;
      priceMonthly?: number;
      trafficLimitGb?: number;
      enabled?: boolean;
      remark?: string | null;
    }
  ) {
    if (
      (input.serverId && input.serverId !== node.serverId) ||
      (input.inboundId && input.inboundId !== node.inboundId) ||
      (input.protocol && input.protocol !== node.protocol)
    ) {
      throw new BadRequestException(
        'S-UI 资源关联请在 S-UI 工作区管理，业务入站不支持跨面板重绑'
      );
    }
    await this.pending(node.id);
    const patch: Row = {};
    if (input.enabled !== undefined) patch.enable = input.enabled;
    if (input.trafficLimitGb !== undefined)
      patch.totalGB = Math.round(input.trafficLimitGb * 1024 ** 3);
    if (Object.keys(patch).length)
      await this.patch(
        node,
        { email: String(obj(node.config).remoteClientEmail) },
        patch,
        'account'
      );
    if (input.trafficLimitGb !== undefined)
      await this.prisma.customerNode.updateMany({
        where: { serviceNodeId: node.id },
        data: { trafficLimitGb: input.trafficLimitGb }
      });
    const saved = await this.prisma.serviceNode.update({
      where: { id: node.id },
      data: {
        name: input.name,
        priceMonthly: input.priceMonthly,
        trafficLimitGb: input.trafficLimitGb,
        enabled: input.enabled,
        remark: input.remark
      },
      include: {
        server: {
          select: {
            id: true,
            name: true,
            baseUrl: true,
            enabled: true,
            provider: true
          }
        }
      }
    });
    return saved;
  }

  async unlink(node: Node) {
    await this.pending(node.id);
    if (
      await this.prisma.customerNode.count({
        where: { serviceNodeId: node.id }
      })
    )
      throw new BadRequestException('请先解绑用户；解绑会关闭远端客户端');
    await this.prisma.serviceNode.delete({ where: { id: node.id } });
    await this.log(node.serverId, node.id, 'unlink');
    return { deleted: true, id: node.id, remoteDeleted: false };
  }

  async pending(serviceNodeId: string) {
    if (
      await this.prisma.renewalLog.findFirst({
        where: { status: 'pending', customerNode: { serviceNodeId } },
        select: { id: true }
      })
    ) {
      throw new BadRequestException(
        '该入站存在待确认续费，请先等待自动恢复或完成对账'
      );
    }
  }
  private async log(
    serverId: string,
    serviceNodeId: string | undefined,
    operation: string,
    status: 'success' | 'partial' = 'success'
  ) {
    await this.prisma.syncLog.create({
      data: {
        serverId,
        action: `sui-business-${operation}`,
        status,
        message: `S-UI 业务${operation}`,
        detail: json({ serviceNodeId, operation })
      }
    });
  }
}
