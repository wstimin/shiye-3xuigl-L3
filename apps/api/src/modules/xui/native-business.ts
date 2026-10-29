import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { nativeCatalog, nativeExecuteSchema } from './native-api.js';
import type { z } from 'zod';

type Node = { id: string; inboundId: number | null; protocol?: string; config: Prisma.JsonValue | null };

/** Keep raw panel operations from bypassing the binding and billing contract. */
export function assertNativeBusinessMutation<T extends Node>(
  operation: ReturnType<typeof nativeCatalog>[number] | undefined,
  input: z.infer<typeof nativeExecuteSchema>,
  nodes: T[]
): T[] {
  if (!operation?.mutates || !nodes.length) return [];
  const path = operation.path;
  const body = input.body && typeof input.body === 'object' ? input.body as Record<string, unknown> : {};
  const managed = nodes.filter(node => (node.config as Prisma.JsonObject | null)?.remoteClientEmail);
  if (/\/importDB$/.test(path))
    throw new BadRequestException('面板已关联业务，恢复备份前请先解除业务接入');
  if (path.includes('/clients/')) {
    const emails = input.parameters.email !== undefined ? [String(input.parameters.email)]
      : Array.isArray(body.emails) ? body.emails.map(String) : null;
    const affected = managed.filter(node => !emails || emails.includes(String((node.config as Prisma.JsonObject).remoteClientEmail)));
    if (!affected.length) return [];
    if (/\/clients\/update\//.test(path)) {
      const data = (body.client && typeof body.client === 'object' ? body.client : body) as Record<string, unknown>;
      if (Number(data.expiryTime) < 0)
        throw new BadRequestException('业务客户端使用固定到期时间，不支持首次使用计时');
      const inboundIds = body.inboundIds;
      if (Array.isArray(inboundIds) && affected.some(node => !inboundIds.includes(node.inboundId)))
        throw new BadRequestException('不能移除业务客户端的授权入站，请先解除业务接入');
      return affected;
    }
    if (/\/(del|bulkDel|delDepleted|delOrphans|detach|bulkDetach|import|bulkAdjust|bulkEnable|bulkDisable|groups\/resetTraffic|bulkResetTraffic|resetAllTraffics|resetTraffic)(\/|$)/.test(path))
      throw new BadRequestException('操作涉及已关联业务的客户端，请在服务节点中调整额度、启停或删除，以同步用户与计费状态');
  }
  if (path.includes('/inbounds/')) {
    const ids = input.parameters.id !== undefined ? [Number(input.parameters.id)]
      : Array.isArray(body.ids) ? body.ids.map(Number) : null;
    const affected = nodes.filter(node => !ids || ids.includes(Number(node.inboundId)));
    if (!affected.length) return [];
    if (/\/(del|bulkDel|delAllClients|import|resetAllTraffics|resetTraffic)(\/|$)/.test(path))
      throw new BadRequestException('入站已接入业务，请在服务节点中处理，避免用户绑定失效');
    if (/\/update\//.test(path) && affected.some(node => body.protocol !== undefined && body.protocol !== node.protocol))
      throw new BadRequestException('业务入站不能直接更换协议，请先解除业务接入');
    if (/\/(update|setEnable)\//.test(path))
      throw new BadRequestException('该入站已接入业务，请在服务节点中修改入站配置或启用状态，以同步用户连接');
  }
  return [];
}
