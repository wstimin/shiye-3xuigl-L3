import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "node:crypto";
import { suiClientProtocols, suiClientCredentials, suiClientConfigKey } from "@shiye/shared";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service.js";
import { EncryptionService } from "../security/encryption.service.js";
import { DatabaseLockService } from "../../shared/database-lock.service.js";
import { SuiService } from "../sui/sui.service.js";
import { suiConfig } from "../sui/sui-network.js";
import {
  outboundImportText,
  parseSuiOutbounds,
  toSuiOutbound,
  prepareSuiOutbounds,
} from "../sui/outbound-import.js";
import { XuiService } from "../xui/xui.service.js";
type Row = Record<string, any>;
export const panelInboundCreateSchema = z.object({
  inbound: z.record(z.string(), z.unknown()),
  outboundTag: z.string().trim().min(1).max(160).optional(),
  client: z
    .object({
      name: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .regex(/^[^\s/?#\\]+$/, "客户端用户名不能包含空格、斜杠、问号或井号"),
      remark: z.string().trim().max(160).default(""),
    })
    .optional(),
  confirmed: z.literal(true),
});
export const panelOutboundPublishSchema = z.object({
  source: z.string().min(1).max(200),
  confirmed: z.literal(true),
});
export const suiOutboundImportSchema = z.object({
  input: z
    .string()
    .trim()
    .min(1)
    .max(1024 * 1024),
  format: z.enum(["auto", "json", "subscription"]).default("auto"),
  name: z.string().trim().min(1).max(120).optional(),
  strategy: z.enum(["local_only", "target_panel"]).default("target_panel"),
  conflict: z.enum(["reject", "rename"]).default("reject"),
  confirmed: z.boolean().default(false),
  fingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export function outboundMatches(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((v, i) => outboundMatches(actual[i], v))
    );
  if (expected && typeof expected === "object")
    return Boolean(
      actual &&
        typeof actual === "object" &&
        Object.entries(expected).every(([k, v]) =>
          outboundMatches((actual as Row)[k], v),
        ),
    );
  return isDeepStrictEqual(actual, expected);
}
const json = (x: unknown) =>
  JSON.parse(JSON.stringify(x)) as Prisma.InputJsonValue;
const digest = (x: unknown) =>
  createHash("sha256").update(JSON.stringify(x)).digest("hex");
@Injectable()
export class PanelNetworkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly locks: DatabaseLockService,
    private readonly xui: XuiService,
    private readonly sui: SuiService,
  ) {}
  private async panel(id: string) {
    const panel = await this.prisma.xuiServer.findUnique({ where: { id } });
    if (!panel) throw new NotFoundException("面板连接不存在");
    if (!panel.enabled) throw new BadRequestException("请先启用面板连接");
    return panel;
  }
  private async remote(id: string, provider: string): Promise<Row[]> {
    if (provider === "xui") return this.xui.inboundOutbounds(id);
    const client = await this.sui.client(id);
    const [r, e] = await Promise.all([
      client.read("outbounds"),
      client.read("endpoints"),
    ]);
    if (!Array.isArray(r.outbounds))
      throw new BadGatewayException("无法读取目标面板出站");
    return [
      ...r.outbounds,
      ...(Array.isArray(e.endpoints) ? e.endpoints : []),
    ] as Row[];
  }
  private async source(key: string, provider: string, serverId: string) {
    if (key.startsWith("saved:")) {
      const saved = await this.prisma.networkOutbound.findUnique({
        where: { id: key.slice(6) },
      });
      if (!saved) throw new BadRequestException("本地出站已不存在");
      const raw = saved.normalizedConfig as Row;
      if (provider === "xui" && !raw.protocol)
        throw new BadRequestException(
          "此出站是 sing-box 配置，不能直接写入 3x-ui；请导入 Xray 配置或使用 SOCKS 模板",
        );
      return {
        name: saved.name,
        tag: saved.serverId === serverId ? saved.tag : "shiye-" + saved.id,
        outbound:
          provider === "sui" ? toSuiOutbound(raw) : structuredClone(raw),
        localId: saved.serverId === serverId ? saved.id : undefined,
      };
    }
    if (key.startsWith("socks:")) {
      const saved = await this.prisma.socksNode.findUnique({
        where: { id: key.slice(6) },
      });
      if (!saved || !saved.enabled)
        throw new BadRequestException("SOCKS 模板不存在或已停用");
      const password = this.encryption.decryptNullable(saved.passwordEnc);
      const outbound =
        provider === "sui"
          ? {
              type: "socks",
              server: saved.host,
              server_port: saved.port,
              version: "5",
              ...(saved.username
                ? { username: saved.username, password: password || "" }
                : {}),
            }
          : {
              protocol: "socks",
              settings: {
                servers: [
                  {
                    address: saved.host,
                    port: saved.port,
                    ...(saved.username
                      ? {
                          users: [
                            { user: saved.username, pass: password || "" },
                          ],
                        }
                      : {}),
                  },
                ],
              },
            };
      return {
        name: saved.name,
        tag: "shiye-socks-" + saved.id,
        outbound,
        localId: undefined,
      };
    }
    throw new BadRequestException("请选择本系统保存的出站或 SOCKS 模板");
  }
  async choices(id: string) {
    const panel = await this.panel(id);
    const [remote, saved, socks] = await Promise.all([
      this.remote(id, panel.provider),
      this.prisma.networkOutbound.findMany({ orderBy: { createdAt: "desc" } }),
      this.prisma.socksNode.findMany({ orderBy: { createdAt: "desc" } }),
    ]);
    const choices: {
      key: string;
      name: string;
      protocol: string;
      origin: string;
      tag?: string;
      reason?: string;
      serverId?: string;
    }[] = remote
      .filter((r) => r.tag)
      .map((r) => ({
        key: "remote:" + r.tag,
        name: String(r.tag),
        protocol: String(r.protocol || r.type),
        origin: "panel",
        tag: String(r.tag),
      }));
    for (const item of saved) {
      let reason = "",
        ready = false;
      const tag = item.serverId === id ? item.tag : "shiye-" + item.id;
      try {
        const raw = item.normalizedConfig as Row;
        const expected = panel.provider === "sui" ? toSuiOutbound(raw) : raw;
        if (panel.provider === "xui" && !raw.protocol)
          reason = "sing-box 配置不能直接写入 3x-ui";
        const found = remote.find((r) => r.tag === tag);
        if (found) {
          ready = outboundMatches(found, { ...expected, tag });
          if (!ready) reason = "目标面板同名出站与本地配置不一致";
        }
      } catch (e) {
        reason = e instanceof Error ? e.message : "与当前面板不兼容";
      }
      choices.push({
        key: "saved:" + item.id,
        name: item.name,
        protocol: item.protocol,
        origin: "local",
        serverId: item.serverId,
        tag: ready ? tag : undefined,
        reason,
      });
    }
    for (const item of socks) {
      const tag = "shiye-socks-" + item.id,
        found = remote.find((r) => r.tag === tag);
      let reason = item.enabled ? "" : "模板已停用",
        ready = false;
      if (found && item.enabled) {
        const source = await this.source(
          "socks:" + item.id,
          panel.provider,
          id,
        );
        ready = outboundMatches(found, { ...source.outbound, tag });
        if (!ready) reason = "目标面板同名出站与模板不一致";
      }
      choices.push({
        key: "socks:" + item.id,
        name: item.name,
        protocol: "socks",
        origin: "template",
        tag: ready ? tag : undefined,
        reason,
      });
    }
    return choices;
  }
  async publish(id: string, key: string) {
    return this.locks.withLock(this.locks.panelOperationKey(id), async () => {
      const panel = await this.panel(id),
        source = await this.source(key, panel.provider, id),
        outbound = { ...source.outbound, tag: source.tag };
      const existing = (await this.remote(id, panel.provider)).find(
        (r) => r.tag === source.tag,
      );
      if (existing) {
        if (!outboundMatches(existing, outbound))
          throw new BadRequestException(
            "目标面板的同名出站与本地配置不一致，请在网络规则中核对，系统不会覆盖",
          );
        if (source.localId) {
          if (panel.provider === "xui")
            await this.xui.confirmInboundOutbound(source.localId, existing);
          else
            await this.prisma.networkOutbound.update({
              where: { id: source.localId },
              data: {
                lastSyncedAt: new Date(),
                remoteFingerprint: digest(outbound),
              },
            });
        }
        return { tag: source.tag, name: source.name, verified: true };
      }
      if (panel.provider === "xui") {
        const result = await this.xui.importNetworkOutbounds({
          serverId: id,
          input: JSON.stringify(outbound),
          format: "xray_json",
          strategy: "target_panel",
          ownership: "managed",
          conflict: source.localId ? "takeover" : "reject",
          createRoute: false,
          inboundTags: [],
        });
        const record = result.results[0];
        if (record)
          await this.prisma.networkOutbound.update({
            where: { id: record.id },
            data: { name: source.name },
          });
      } else
        await this.importSuiRows(
          id,
          [{ name: source.name, outbound }],
          "target_panel",
          "reject",
          source.localId,
        );
      const verified = (await this.remote(id, panel.provider)).find(
        (r) => r.tag === source.tag,
      );
      if (!verified || !outboundMatches(verified, outbound))
        throw new BadGatewayException(
          "出站写入后未通过回读确认，请刷新面板核对",
        );
      return { tag: source.tag, name: source.name, verified: true };
    });
  }
  async previewSui(id: string, input: z.infer<typeof suiOutboundImportSchema>) {
    const panel = await this.panel(id);
    if (panel.provider !== "sui")
      throw new BadRequestException("请选择 S-UI 面板");
    const rows = parseSuiOutbounds(
      await outboundImportText(input.input, input.format),
      input.name,
    );
    return {
      count: rows.length,
      items: rows.map((r) => ({
        name: r.name,
        tag: r.outbound.tag,
        protocol: r.outbound.type,
      })),
      fingerprint: digest(rows),
    };
  }
  async importSui(id: string, input: z.infer<typeof suiOutboundImportSchema>) {
    if (!input.confirmed) throw new BadRequestException("请先预览并确认导入");
    const panel = await this.panel(id);
    if (panel.provider !== "sui")
      throw new BadRequestException("请选择 S-UI 面板");
    const rows = parseSuiOutbounds(
      await outboundImportText(input.input, input.format),
      input.name,
    );
    if (input.fingerprint && input.fingerprint !== digest(rows))
      throw new BadRequestException("订阅或导入内容已变化，请重新预览后确认");
    return this.locks.withLock(this.locks.panelOperationKey(id), () =>
      this.importSuiRows(id, rows, input.strategy, input.conflict),
    );
  }
  private async importSuiRows(
    id: string,
    rows: {
      name: string;
      outbound: Row;
    }[],
    strategy: string,
    conflict: string,
    localId?: string,
  ) {
    const remote = await this.remote(id, "sui"),
      local = await this.prisma.networkOutbound.findMany({
        where: { serverId: id },
      }),
      occupied = new Set(
        [...remote, ...local.filter((r) => r.id !== localId)].map((r) => r.tag),
      );
    const planned = prepareSuiOutbounds(
      rows,
      [...occupied],
      strategy === "target_panel"
        ? remote.map((r) => String(r.tag))
        : [...occupied],
      conflict,
    );
    const created: Row[] = [];
    try {
      if (strategy === "target_panel")
        for (const row of planned) {
          created.push(row.outbound);
          await this.sui.save(id, {
            object: "outbounds",
            action: "new",
            data: row.outbound,
          });
          const saved = (await this.remote(id, "sui")).find(
            (r) => r.tag === row.outbound.tag,
          );
          if (!saved || !outboundMatches(saved, row.outbound))
            throw new BadGatewayException("S-UI 出站回读与导入配置不一致");
        }
      await this.prisma.$transaction(async (tx) => {
        for (const row of planned) {
          const data = {
            serverId: id,
            name: row.name,
            tag: row.outbound.tag,
            protocol: String(row.outbound.type),
            ownership: "managed" as const,
            sourceFormat: "singbox_json",
            normalizedConfig: json(row.outbound),
            remoteFingerprint:
              strategy === "target_panel" ? digest(row.outbound) : null,
            lastSyncedAt: strategy === "target_panel" ? new Date() : null,
          };
          if (localId)
            await tx.networkOutbound.update({ where: { id: localId }, data });
          else await tx.networkOutbound.create({ data });
        }
      });
      return {
        imported: planned.length,
        results: planned.map((r) => ({ name: r.name, tag: r.outbound.tag })),
        verified: strategy === "target_panel",
      };
    } catch (error) {
      let recoveryFailed = false;
      for (const raw of created.reverse())
        try {
          const row = (await this.remote(id, "sui")).find(
            (r) => r.tag === raw.tag,
          );
          if (row) {
            if (!outboundMatches(row, raw)) throw new Error("resource changed");
            await this.sui.save(id, {
              object: "outbounds",
              action: "del",
              data: { id: row.id },
            });
            if ((await this.remote(id, "sui")).some((r) => r.tag === raw.tag))
              throw new Error("resource remains");
          }
        } catch {
          recoveryFailed = true;
        }
      if (recoveryFailed)
        throw new BadGatewayException(
          "导入未完成，部分出站未能自动清理，请刷新面板核对后再试",
        );
      throw error;
    }
  }
  async createInbound(
    id: string,
    input: z.infer<typeof panelInboundCreateSchema>,
  ) {
    const panel = await this.panel(id);
    if (input.inbound.id !== undefined && input.inbound.id !== 0)
      throw new BadRequestException("新建入站不能带有已有 ID");
    if (input.client && panel.provider !== "sui")
      throw new BadRequestException("同时创建客户端仅适用于 S-UI");
    if (panel.provider === "xui")
      return this.xui.createInboundWithOutbound(
        id,
        input.inbound,
        input.outboundTag,
      );
    return this.locks.withLock(this.locks.panelOperationKey(id), async () => {
      const client = await this.sui.client(id),
        before = (await client.read("inbounds")).inbounds as Row[],
        tag = String(input.inbound.tag || "").trim();
      if (!tag || before.some((r) => r.tag === tag))
        throw new BadRequestException("请填写未被使用的入站名称");
      if (
        input.outboundTag &&
        !(await this.remote(id, "sui")).some((r) => r.tag === input.outboundTag)
      )
        throw new BadRequestException(
          "目标出站尚未在当前面板启用，请先启用出站",
        );
      if (
        typeof input.inbound.type !== "string" ||
        !input.inbound.type ||
        tag.length > 160
      )
        throw new BadRequestException("请选择有效的入站协议并填写名称");
      if (
        !["tun", "cloudflared"].includes(input.inbound.type) &&
        (!Number.isInteger(input.inbound.listen_port) ||
          Number(input.inbound.listen_port) < 1 ||
          Number(input.inbound.listen_port) > 65535)
      )
        throw new BadRequestException("请填写有效的监听端口");
      if (input.client && !suiClientProtocols.includes(input.inbound.type)) throw new BadRequestException("此入站协议不使用客户端账号");
      const credentials = input.client
        ? suiClientCredentials(
            input.inbound.type,
            input.client.name,
            input.inbound,
          )
        : undefined;
      const configKey = suiClientConfigKey(input.inbound.type, input.inbound);
      const oldClients = input.client
        ? ((await client.read("clients")).clients as Row[])
        : [];
      if (
        input.client &&
        (!Array.isArray(oldClients) ||
          oldClients.some((row) => row.name === input.client!.name))
      )
        throw new BadRequestException(
          "客户端用户名已存在或列表读取失败，请刷新后更换用户名",
        );
      const previous = input.outboundTag
        ? suiConfig(await client.read("config"))
        : undefined;
      let created: Row | undefined,
        createdClient: Row | undefined,
        clientAttempted = false,
        routeAttempted = false;
      const findCreatedClient = async () => {
        const rows = (await client.read("clients")).clients as Row[];
        if (!Array.isArray(rows)) throw new Error("客户端列表读取失败");
        return rows.find(
          (row) =>
            row.name === input.client!.name &&
            !oldClients.some((old) => old.id === row.id) &&
            Array.isArray(row.inbounds) &&
            row.inbounds.length === 1 &&
            Number(row.inbounds[0]) === Number(created?.id),
        );
      };
      try {
        await this.sui.save(id, {
          object: "inbounds",
          action: "new",
          data: input.inbound,
        });
        created = ((await client.read("inbounds")).inbounds as Row[]).find(
          (r) => r.tag === tag && !before.some((old) => old.id === r.id),
        );
        if (!created) throw new BadGatewayException("新入站创建后回读失败");
        if (input.client && credentials) {
          clientAttempted = true;
          await this.sui.save(id, {
            object: "clients",
            action: "new",
            data: {
              name: input.client.name,
              remark: input.client.remark,
              enable: true,
              volume: 0,
              expiry: 0,
              up: 0,
              down: 0,
              delayStart: false,
              inbounds: [created.id],
              config: { [configKey]: credentials },
              links: [],
            },
          });
          createdClient = await findCreatedClient();
          if (!createdClient)
            throw new BadGatewayException("客户端创建后回读失败");
          const full = (
            (await client.request(`clients?id=${createdClient.id}`))
              .clients as Row[]
          )?.find((row) => row.id === createdClient!.id);
          const config =
            typeof full?.config === "string"
              ? JSON.parse(full.config)
              : full?.config;
          if (
            !full ||
            full.enable !== true ||
            !outboundMatches(full.inbounds, [created.id]) ||
            !outboundMatches(config?.[configKey], credentials)
          )
            throw new BadGatewayException("客户端凭据或入站授权回读不一致");
        }
        if (input.outboundTag && previous) {
          const route = { ...((previous.route as Row) || {}) },
            rules = Array.isArray(route.rules) ? [...route.rules] : [],
            rule = {
              action: "route",
              inbound: [tag],
              outbound: input.outboundTag,
            };
          let index = rules.findIndex(
            (r) =>
              !["sniff", "resolve", "hijack-dns"].includes(r.action) &&
              !r.inbound?.length,
          );
          if (index < 0) index = rules.length;
          rules.splice(index, 0, rule);
          route.rules = rules;
          routeAttempted = true;
          await this.sui.save(id, {
            object: "config",
            action: "edit",
            data: { ...previous, route },
          });
        }
        return {
          inboundId: created.id,
          clientId: createdClient?.id,
          outboundTag: input.outboundTag,
          verified: true,
        };
      } catch (error) {
        let failed = false;
        try {
          if (routeAttempted && previous)
            await this.sui.save(id, {
              object: "config",
              action: "edit",
              data: previous,
            });
        } catch {
          failed = true;
        }
        try {
          if (clientAttempted) {
            createdClient ||= await findCreatedClient();
            if (createdClient) {
              await this.sui.save(id, {
                object: "clients",
                action: "del",
                data: { id: createdClient.id },
              });
              if (
                ((await client.read("clients")).clients as Row[]).some(
                  (row) => row.id === createdClient!.id,
                )
              )
                throw new Error("client remains");
            }
          }
        } catch {
          failed = true;
        }
        try {
          created ||= ((await client.read("inbounds")).inbounds as Row[]).find(
            (r) => r.tag === tag && !before.some((old) => old.id === r.id),
          );
          if (created) {
            await this.sui.save(id, {
              object: "inbounds",
              action: "del",
              data: { id: created.id },
            });
            if (
              ((await client.read("inbounds")).inbounds as Row[]).some(
                (r) => r.id === created!.id,
              )
            )
              throw new Error("inbound remains");
          }
        } catch {
          failed = true;
        }
        if (failed)
          throw new BadGatewayException(
            "入站、客户端或路由创建未完成，自动清理失败，请刷新面板核对；已启用的出站会保留",
          );
        throw error;
      }
    });
  }
}
