import test from "node:test";
import assert from "node:assert/strict";
import {
  PanelNetworkService,
  suiOutboundImportSchema,
  outboundMatches,
} from "../apps/api/src/modules/nodes/panel-network.service.js";
import {
  toSuiOutbound,
  parseSuiOutbounds,
  outboundImportText,
  prepareSuiOutbounds,
} from "../apps/api/src/modules/sui/outbound-import.js";
import { XuiService } from "../apps/api/src/modules/xui/xui.service.js";
import { testLocks } from "./test-locks.js";

test("S-UI batch dependencies are imported first and renamed references stay within the imported group", () => {
  const rows = [
    {
      name: "group",
      outbound: {
        type: "selector",
        tag: "group",
        outbounds: ["proxy"],
        default: "proxy",
      },
    },
    {
      name: "proxy",
      outbound: {
        type: "socks",
        tag: "proxy",
        server: "example.test",
        server_port: 1080,
      },
    },
  ];
  const planned = prepareSuiOutbounds(rows, ["proxy"], ["proxy"], "rename");
  assert.deepEqual(
    planned.map((r) => r.outbound.tag),
    ["proxy-2", "group"],
  );
  assert.deepEqual(planned[1]!.outbound.outbounds, ["proxy-2"]);
  assert.equal(planned[1]!.outbound.default, "proxy-2");
  assert.equal(rows[0]!.outbound.default, "proxy");
  assert.throws(
    () =>
      prepareSuiOutbounds(
        [
          {
            name: "a",
            outbound: { type: "selector", tag: "a", outbounds: ["b"] },
          },
          {
            name: "b",
            outbound: { type: "selector", tag: "b", outbounds: ["a"] },
          },
        ],
        [],
        [],
        "reject",
      ),
    /循环/,
  );
});
function fixture() {
  const panel = { id: "s1", provider: "sui", enabled: true },
    writes: any[] = [],
    saved: any[] = [];
  let remote: any[] = [{ id: 1, type: "direct", tag: "direct" }],
    inbounds: any[] = [
      { id: 1, type: "vless", tag: "original", listen_port: 50001 },
    ],
    config: any = {
      dns: { keep: true },
      route: {
        final: "direct",
        rules: [
          { action: "sniff" },
          {
            domain_suffix: ["example.test"],
            action: "route",
            outbound: "direct",
          },
        ],
      },
    },
    failConfig = false,
    failDatabase = false;
  const client = {
    read: async (resource: string) =>
      structuredClone(
        resource === "outbounds"
          ? { outbounds: remote }
          : resource === "inbounds"
            ? { inbounds }
            : resource === "config"
              ? { config }
              : { endpoints: [] },
      ),
  };
  const prisma: any = {
    xuiServer: { findUnique: async () => panel },
    socksNode: { findMany: async () => [], findUnique: async () => null },
    networkOutbound: {
      findMany: async ({ where }: any = {}) =>
        saved.filter((r) => !where?.serverId || r.serverId === where.serverId),
      findUnique: async ({ where }: any) =>
        saved.find((r) => r.id === where.id),
      create: async ({ data }: any) => {
        if (failDatabase) throw Error("database failed");
        const row = {
          id: "local-" + (saved.length + 1),
          ...structuredClone(data),
        };
        saved.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        if (failDatabase) throw Error("database failed");
        const row = saved.find((r) => r.id === where.id);
        Object.assign(row, structuredClone(data));
        return row;
      },
    },
    $transaction: async (fn: any) => fn(prisma),
  };
  const sui: any = {
    client: async () => client,
    save: async (_id: string, value: any) => {
      writes.push(structuredClone(value));
      if (value.object === "config") {
        config = structuredClone(value.data);
        if (failConfig) {
          failConfig = false;
          throw Error("route write failed after apply");
        }
        return {};
      }
      const list = value.object === "outbounds" ? remote : inbounds;
      if (value.action === "new")
        list.push({
          id: Math.max(0, ...list.map((x) => x.id)) + 1,
          ...structuredClone(value.data),
        });
      if (value.action === "del") {
        const index = list.findIndex((x) => x.id === value.data.id);
        if (index >= 0) list.splice(index, 1);
      }
      return {};
    },
  };
  const service = new PanelNetworkService(
    prisma,
    { decryptNullable: (x: any) => x } as any,
    testLocks(),
    {} as any,
    sui,
  );
  return {
    service,
    saved,
    writes,
    panel,
    remote: () => remote,
    inbounds: () => inbounds,
    config: () => config,
    failRoute: () => {
      failConfig = true;
    },
    failDatabase: () => {
      failDatabase = true;
    },
  };
}
const input = (patch: any = {}) =>
  suiOutboundImportSchema.parse({
    input: "socks://alice:secret@proxy.example:1080#office",
    ...patch,
  });
test("S-UI import preserves native options and converts common Xray credentials, Reality and websocket", () => {
  const native = {
    id: 5,
    type: "anytls",
    tag: "office",
    server: "example.test",
    server_port: 443,
    password: "private",
    tls: { enabled: true, server_name: "example.test" },
    future: { preserve: true },
  };
  const parsed = parseSuiOutbounds(JSON.stringify({ outbounds: [native] }));
  assert.equal(parsed[0]!.outbound.id, undefined);
  assert.deepEqual(parsed[0]!.outbound.future, { preserve: true });
  assert.equal(native.id, 5);
  const converted = toSuiOutbound({
    tag: "vless",
    protocol: "vless",
    settings: {
      vnext: [
        {
          address: "proxy.test",
          port: 443,
          users: [{ id: "uuid", flow: "xtls-rprx-vision", encryption: "none" }],
        },
      ],
    },
    streamSettings: {
      network: "ws",
      wsSettings: { path: "/ws", headers: { Host: "cdn.test" } },
      security: "reality",
      realitySettings: {
        serverName: "tls.test",
        publicKey: "public",
        shortId: "abcd",
        fingerprint: "chrome",
      },
    },
  });
  assert.equal(converted.uuid, "uuid");
  assert.equal(converted.flow, "xtls-rprx-vision");
  assert.deepEqual(converted.transport, {
    type: "ws",
    path: "/ws",
    headers: { Host: "cdn.test" },
  });
  assert.equal(converted.tls.reality.public_key, "public");
  assert.equal(converted.tls.server_name, "tls.test");
  assert.throws(
    () =>
      toSuiOutbound({
        protocol: "vless",
        settings: {
          vnext: [{ address: "a", port: 443, users: [{ id: "u" }] }],
        },
        streamSettings: { network: "xhttp" },
      }),
    /xhttp/,
  );
  assert.throws(() => toSuiOutbound({ protocol: "wireguard" }), /无法转换/);
});
test("subscription import decodes base64 and rejects oversized or unsafe redirects", async () => {
  const text = "socks://user:password@host.test:1080#demo";
  const decoded = await outboundImportText(
    "https://subscription.test/list",
    "subscription",
    (async () => new Response(Buffer.from(text).toString("base64"))) as any,
  );
  assert.equal(decoded, text);
  assert.equal(parseSuiOutbounds(decoded)[0]!.outbound.password, "password");
  await assert.rejects(
    () =>
      outboundImportText(
        "https://subscription.test/list",
        "subscription",
        (async () => new Response("x".repeat(1024 * 1024 + 1))) as any,
      ),
    /1 MB/,
  );
  await assert.rejects(
    () =>
      outboundImportText(
        "https://subscription.test/list",
        "subscription",
        (async () =>
          new Response(null, {
            status: 302,
            headers: { location: "file:///tmp/private" },
          })) as any,
      ),
    /HTTP/,
  );
});
test("local-only S-UI import makes no remote write; enable publishes and verifies immediately and is idempotent", async () => {
  const f = fixture();
  const preview = await f.service.previewSui(
    "s1",
    input({ strategy: "local_only" }),
  );
  await f.service.importSui(
    "s1",
    input({
      strategy: "local_only",
      confirmed: true,
      fingerprint: preview.fingerprint,
    }),
  );
  assert.equal(f.writes.length, 0);
  assert.equal(f.saved.length, 1);
  assert.equal(f.saved[0].lastSyncedAt, null);
  let choices = await f.service.choices("s1");
  const local = choices.find((x) => x.origin === "local")!;
  assert.equal(local.tag, undefined);
  assert(!JSON.stringify(choices).includes("secret"));
  const enabled = await f.service.publish("s1", local.key);
  assert.equal(enabled.verified, true);
  assert.equal(
    f.remote().find((r) => r.tag === enabled.tag).password,
    "secret",
  );
  assert.equal(f.saved.length, 1, "enable updates the existing local record");
  assert(f.saved[0].lastSyncedAt);
  const count = f.writes.length;
  await f.service.publish("s1", local.key);
  assert.equal(
    f.writes.length,
    count,
    "repeated enable must not duplicate remote outbounds",
  );
  choices = await f.service.choices("s1");
  assert.equal(choices.find((x) => x.key === local.key)!.tag, enabled.tag);
});
test("S-UI preview drift, unconfirmed writes and all duplicate tags are rejected before modification", async () => {
  const f = fixture();
  await assert.rejects(() => f.service.importSui("s1", input()), /确认/);
  await assert.rejects(
    () =>
      f.service.importSui(
        "s1",
        input({ confirmed: true, fingerprint: "0".repeat(64) }),
      ),
    /重新预览/,
  );
  await assert.rejects(
    () =>
      f.service.importSui(
        "s1",
        input({
          confirmed: true,
          input: JSON.stringify({
            outbounds: [{ type: "direct", tag: "direct" }],
          }),
        }),
      ),
    /已存在/,
  );
  assert.equal(f.writes.length, 0);
});
test("S-UI multi-outbound import rolls back created resources when local persistence fails", async () => {
  const f = fixture();
  f.failDatabase();
  await assert.rejects(
    () => f.service.importSui("s1", input({ confirmed: true })),
    /database failed/,
  );
  assert.deepEqual(f.remote(), [{ id: 1, type: "direct", tag: "direct" }]);
  assert.equal(f.saved.length, 0);
});
test("new S-UI inbound links only the selected inbound and preserves existing route and DNS configuration", async () => {
  const f = fixture(),
    before = structuredClone(f.config());
  const result = await f.service.createInbound("s1", {
    inbound: { type: "vless", tag: "new", listen_port: 50002 },
    outboundTag: "direct",
    confirmed: true,
  });
  assert.equal(result.verified, true);
  assert.deepEqual(f.config().dns, before.dns);
  assert.equal(f.config().route.final, "direct");
  assert.deepEqual(f.config().route.rules, [
    before.route.rules[0],
    { action: "route", inbound: ["new"], outbound: "direct" },
    before.route.rules[1],
  ]);
  assert.equal(f.inbounds().length, 2);
});
test("S-UI failed route association restores the old route and removes only the new inbound", async () => {
  const f = fixture(),
    before = structuredClone(f.config());
  f.failRoute();
  await assert.rejects(
    () =>
      f.service.createInbound("s1", {
        inbound: { type: "vless", tag: "new", listen_port: 50002 },
        outboundTag: "direct",
        confirmed: true,
      }),
    /route write failed/,
  );
  assert.deepEqual(f.config(), before);
  assert.deepEqual(
    f.inbounds().map((r) => r.tag),
    ["original"],
  );
  assert.equal(
    f.remote()[0].tag,
    "direct",
    "explicitly enabled outbound is retained",
  );
});
test("missing outbounds and existing inbound IDs cannot write remote resources", async () => {
  const f = fixture();
  await assert.rejects(
    () =>
      f.service.createInbound("s1", {
        inbound: { id: 1, tag: "new" },
        confirmed: true,
      }),
    /已有 ID/,
  );
  await assert.rejects(
    () =>
      f.service.createInbound("s1", {
        inbound: { tag: "new" },
        outboundTag: "missing",
        confirmed: true,
      }),
    /尚未/,
  );
  assert.equal(f.writes.length, 0);
  assert.equal(
    outboundMatches(
      { id: 7, tag: "a", password: "changed" },
      { tag: "a", password: "original" },
    ),
    false,
  );
});
test("3x-ui route failure restores original routing and deletes only its new inbound", async () => {
  let rows: any[] = [{ id: 1, port: 50001, tag: "old", remark: "old" }],
    restored = 0;
  const calls: string[] = [];
  const client = {
    listInbounds: async () => ({ success: true, obj: structuredClone(rows) }),
    deleteInbound: async (id: number) => {
      calls.push("delete:" + id);
      rows = rows.filter((r) => r.id !== id);
      return { success: true };
    },
  };
  const service = new XuiService(
    {
      xuiServer: {
        findUnique: async () => ({ id: "s1", provider: "xui", enabled: true }),
      },
    } as any,
    {} as any,
    testLocks(),
    {} as any,
  ) as any;
  service.loadXrayState = async () => ({
    client,
    setting: { outbounds: [{ tag: "out" }] },
    originalSetting: { routing: { rules: ["keep"] } },
  });
  service.nativeExecute = async (_id: string, input: any) => {
    rows.push({ ...input.body, id: 2 });
    return { success: true };
  };
  service.upsertNetworkRoute = async (input: any) => {
    assert.deepEqual(input.rule.inboundTag, [rows[1].tag]);
    assert.equal(input.rule.outboundTag, "out");
    throw Error("route failed");
  };
  service.restoreXrayState = async () => {
    restored++;
  };
  await assert.rejects(
    () =>
      service.createInboundWithOutbound(
        "s1",
        { protocol: "vless", port: 50002, remark: "new" },
        "out",
      ),
    /route failed/,
  );
  assert.equal(restored, 1);
  assert.deepEqual(calls, ["delete:2"]);
  assert.deepEqual(
    rows.map((r) => r.id),
    [1],
  );
});
