import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { suiObjects, SuiClient } from '@shiye/xui-client';
import type {
  suiControlSchema,
  suiSaveSchema,
  suiServerSchema
} from '@shiye/shared';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';
import { EncryptionService } from '../security/encryption.service.js';
import { DatabaseLockService } from '../../shared/database-lock.service.js';
import { Prisma } from '@prisma/client';
import { suiAuthorization } from './sui-state.js';
import { assertSuiNetwork, assertSuiResourceUnused, suiConfig } from './sui-network.js';
import { isDeepStrictEqual } from 'node:util';

const publicFields = {
  id: true,
  name: true,
  baseUrl: true,
  enabled: true,
  remark: true,
  createdAt: true,
  updatedAt: true
} as const;

@Injectable()
export class SuiService {
  private readonly logger = new Logger(SuiService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly locks: DatabaseLockService
  ) {}

  list() {
    return this.prisma.xuiServer.findMany({
      where: { provider: 'sui' },
      select: publicFields,
      orderBy: { createdAt: 'desc' }
    });
  }

  async secrets(id: string) {
    const server = await this.stored(id);
    return { token: server.tokenEnc ? this.encryption.decrypt(server.tokenEnc) : '' };
  }

  async upsert(input: z.infer<typeof suiServerSchema>, id?: string) {
    return id
      ? this.locks.withLock(this.locks.panelOperationKey(id), () =>
          this.upsertUnlocked(input, id)
        )
      : this.upsertUnlocked(input);
  }

  private async upsertUnlocked(
    input: z.infer<typeof suiServerSchema>,
    id?: string
  ) {
    const current = id ? await this.stored(id) : null;
    if (
      current &&
      current.baseUrl !== input.baseUrl &&
      (await this.prisma.serviceNode.count({ where: { serverId: id } }))
    ) {
      throw new BadRequestException(
        '已有业务入站的连接不能更换远端地址，请新增面板连接'
      );
    }
    if (!input.token && !current)
      throw new BadRequestException('首次接入需要 API Token');
    const { token, ...data } = input;
    const tokenEnc = token ? this.encryption.encrypt(token) : current!.tokenEnc;
    const result = id
      ? this.prisma.xuiServer.update({
          where: { id },
          data: { ...data, tokenEnc },
          select: publicFields
        })
      : this.prisma.xuiServer.create({
          data: { ...data, tokenEnc, provider: 'sui' },
          select: publicFields
        });
    const saved = await result;
    await this.log(saved.id, 'connection', id ? 'edit' : 'new');
    return saved;
  }

  async remove(id: string) {
    return this.locks.withLock(this.locks.panelOperationKey(id), async () => {
      await this.stored(id);
      if (await this.prisma.serviceNode.count({ where: { serverId: id } }))
        throw new BadRequestException('请先移除关联的服务入站及用户绑定');
      await this.prisma.xuiServer.delete({ where: { id } });
      await this.log(id, 'connection', 'del');
      return { removed: true };
    });
  }

  async test(id: string) {
    const client = await this.client(id, true);
    return this.remote(() => client.status());
  }

  async read(id: string, resource: string, remoteId?: string) {
    const allowed = [
      ...suiObjects,
      'status',
      'sessions',
      'onlines',
      'logs',
      'changes',
      'stats'
    ];
    if (!allowed.includes(resource))
      throw new BadRequestException('不支持的资源');
    if (
      remoteId !== undefined &&
      (!['clients', 'inbounds'].includes(resource) ||
        !/^[1-9]\d{0,9}$/.test(remoteId))
    )
      throw new BadRequestException('资源 ID 无效');
    const client = await this.client(id);
    return this.remote(() =>
      resource === 'status'
        ? client.status()
        : client.request(
            remoteId
              ? `${resource}?id=${remoteId}`
              : resource === 'logs'
                ? 'logs?c=100'
                : resource === 'changes'
                  ? 'changes?c=50'
                  : resource
          )
    );
  }

  async save(id: string, input: z.infer<typeof suiSaveSchema>) {
    return this.locks.withLock(this.locks.panelOperationKey(id), async () => {
      const nodes = await this.prisma.serviceNode.findMany({
        where: { serverId: id },
        orderBy: { id: 'asc' }
      });
      return this.locks.withLocks(
        nodes.map((node) => this.locks.serviceNodeKey(node.id)),
        async () => {
          const linked = nodes.filter((node) =>
            input.object === 'clients'
              ? Number(
                  (node.config as Record<string, unknown>)?.suiClientId
                ) === Number(input.data.id)
              : input.object === 'inbounds' &&
                node.inboundId === Number(input.data.id)
          );
          for (const node of linked) {
            if (input.action === 'del')
              throw new BadRequestException(
                '资源已接入业务，请先解绑用户并移除服务入站'
              );
            if (
              await this.prisma.renewalLog.findFirst({
                where: {
                  status: 'pending',
                  customerNode: { serviceNodeId: node.id }
                },
                select: { id: true }
              })
            ) {
              throw new BadRequestException(
                '该资源存在待确认续费，请先完成自动恢复或对账'
              );
            }
            if (
              input.object === 'clients' &&
              (input.data.name !==
                (node.config as Record<string, unknown>)?.remoteClientEmail ||
                !Array.isArray(input.data.inbounds) ||
                input.data.inbounds.length !== 1 ||
                Number(input.data.inbounds[0]) !== node.inboundId)
            ) {
              throw new BadRequestException(
                '业务客户端的标识和授权入站不能直接更换，请先解绑'
              );
            }
            if (
              input.object === 'clients' &&
              (input.data.delayStart === true || Number(input.data.expiry) < 0)
            )
              throw new BadRequestException(
                '业务客户端使用固定到期时间，不支持首次使用计时'
              );
            if (
              input.object === 'inbounds' &&
              input.data.type !== node.protocol
            )
              throw new BadRequestException(
                '业务入站的协议不能直接更换，请先解除业务接入'
              );
          }
          const client = await this.client(id);
          if (input.object === 'config' || ['inbounds', 'outbounds', 'endpoints'].includes(input.object)) {
            await this.checkNetworkWrite(client, input);
          }
          const result = await this.remote(() =>
            client.save(input.object, input.action, input.data)
          );
          if (input.object === 'config') {
            const saved = suiConfig(await this.remote(() => client.read('config')));
            if (!isDeepStrictEqual(saved.route, input.data.route))
              throw new BadGatewayException('S-UI 路由写入后回读不一致，请刷新核对');
          }
          if (linked.length && input.object === 'clients') {
            const payload = await this.remote(() =>
              client.request(`clients?id=${Number(input.data.id)}`)
            );
            const remote = Array.isArray(payload.clients)
              ? (payload.clients as Record<string, unknown>[]).find(
                  (row) => Number(row.id) === Number(input.data.id)
                )
              : null;
            if (!remote)
              throw new BadGatewayException(
                'S-UI 写入后客户端回读失败，请刷新核对'
              );
            for (const node of linked) {
              const authorization = suiAuthorization(remote);
              await this.prisma.$transaction([
                this.prisma.serviceNode.update({
                  where: { id: node.id },
                  data: {
                    trafficLimitGb: Number(remote.volume || 0) / 1024 ** 3,
                    config: {
                      ...(node.config as Prisma.JsonObject),
                      remoteClientName: String(remote.remark || remote.name),
                      remoteClientEnabled: remote.enable === true,
                      remoteClientExpireAt:
                        authorization.expireAt?.toISOString() || null
                    }
                  }
                }),
                this.prisma.customerNode.updateMany({
                  where: { serviceNodeId: node.id },
                  data: {
                    ...authorization,
                    lastSyncedAt: new Date()
                  }
                })
              ]);
            }
          }
          await this.log(id, input.object, input.action);
          return result;
        }
      );
    });
  }

  async control(id: string, input: z.infer<typeof suiControlSchema>) {
    return this.locks.withLock(`sui:${id}`, async () => {
      const client = await this.client(id);
      const { action, ...body } = input;
      const result = await this.remote(() => client.request(action, body));
      await this.log(id, 'core', action);
      return result;
    });
  }

  private async checkNetworkWrite(client: SuiClient, input: z.infer<typeof suiSaveSchema>) {
    const [base, inboundData, outboundData, endpointData] = await this.remote(() => Promise.all([
      client.read('config'), client.read('inbounds'), client.read('outbounds'), client.read('endpoints')
    ]));
    const config = suiConfig(base);
    const rows = (data: Record<string, unknown>, key: string) =>
      Array.isArray(data[key]) ? data[key] as Record<string, unknown>[] : [];
    const inbounds = rows(inboundData, 'inbounds');
    const outbounds = rows(outboundData, 'outbounds');
    const endpoints = rows(endpointData, 'endpoints');
    if (input.object === 'config') {
      assertSuiNetwork(input.data, inbounds, outbounds, endpoints);
      return;
    }
    const list = input.object === 'inbounds' ? inbounds : input.object === 'outbounds' ? outbounds : endpoints;
    const previous = list.find(row => Number(row.id) === Number(input.data.id));
    if (previous && (input.action === 'del' || previous.tag !== input.data.tag))
      assertSuiResourceUnused(input.object, String(previous.tag), config, outbounds, endpoints);
    if (input.action !== 'del' && input.object !== 'inbounds') {
      const next = [...list.filter(row => row !== previous), input.data];
      assertSuiNetwork(config, inbounds, input.object === 'outbounds' ? next : outbounds, input.object === 'endpoints' ? next : endpoints);
    }
  }

  private async stored(id: string) {
    const server = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!server || server.provider !== 'sui')
      throw new NotFoundException('S-UI 面板不存在');
    return server;
  }

  async client(id: string, allowDisabled = false) {
    const server = await this.stored(id);
    if (!server.enabled && !allowDisabled)
      throw new BadRequestException('请先启用该面板连接');
    return new SuiClient({
      baseUrl: server.baseUrl,
      token: this.encryption.decrypt(server.tokenEnc || '')
    });
  }

  private async remote<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      throw new BadGatewayException(
        error instanceof Error ? error.message : 'S-UI 请求失败'
      );
    }
  }

  private async log(suiServerId: string, resource: string, operation: string) {
    // Native objects may contain secrets; log operation metadata only.
    await this.prisma.syncLog
      .create({
        data: {
          serverId:
            resource === 'connection' && operation === 'del'
              ? undefined
              : suiServerId,
          action: 'sui-operation',
          status: 'success',
          message: `S-UI ${resource} · ${operation}`,
          detail: { suiServerId, resource, operation }
        }
      })
      .catch(() => this.logger.warn('S-UI 操作已完成，但本地日志写入失败'));
  }
}
