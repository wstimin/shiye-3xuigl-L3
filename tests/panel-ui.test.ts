import test from "node:test";
import assert from "node:assert/strict";
import { reactive } from "vue";
import {
  clonePanelValue,
  emptyPanelItem,
  xrayProtocolSettings,
  decodePanelValue,
  encodePanelValue,
  initialValue,
} from "../apps/admin-web/src/panel-fields.js";
import {
  operationLabel,
  operationSection,
  operationTemplate,
  xuiClientFormValue,
  type PanelOperation,
} from "../apps/admin-web/src/xui-panel.js";
import { nativeCatalog } from "../apps/api/src/modules/xui/native-api.js";

test("visual settings preserve nested objects, unknown fields and legacy string encoding", () => {
  const original = {
    xraySetting: JSON.stringify({
      outbounds: [
        { tag: "proxy", settings: { secret: "keep", extension: 27 } },
      ],
      routing: { rules: [] },
    }),
    enabled: "false",
    newerSetting: { untouched: [1, 2] },
  };
  const draft = decodePanelValue(original) as any;
  draft.xraySetting.outbounds[0].tag = "edited";
  draft.enabled = true;
  const saved = encodePanelValue(draft, original) as any;
  assert.equal(typeof saved.xraySetting, "string");
  assert.deepEqual(JSON.parse(saved.xraySetting).outbounds[0], {
    tag: "edited",
    settings: { secret: "keep", extension: 27 },
  });
  assert.equal(saved.enabled, "true");
  assert.deepEqual(saved.newerSetting, original.newerSetting);
  assert.equal(JSON.parse(original.xraySetting).outbounds[0].tag, "proxy");
});

test("client editing converts the read model into a valid full write model", () => {
  const draft = xuiClientFormValue({
    client: {
      id: 31,
      uuid: "original-uuid",
      email: "alice",
      password: "keep",
      enable: true,
      totalGB: 0,
      allowedIPs: '["10.0.0.2/32"]',
      reverse: "",
      group: "vip",
      futureFlag: true,
    },
    inboundIds: [1],
  });
  assert.equal(draft.id, "original-uuid");
  assert.deepEqual(draft.allowedIPs, ["10.0.0.2/32"]);
  assert.equal(draft.reverse, undefined);
  assert.equal(draft.password, "keep");
  assert.equal(draft.group, "vip");
  assert.equal(draft.futureFlag, true);
  assert.equal(draft.client, undefined);
  assert.equal(xuiClientFormValue({ id: 12, password: "p" }).id, undefined);
});

test("credentials that look like serialized values remain byte-for-byte unchanged", () => {
  const source = {
    password: '{ "secret": 1 }',
    token: "true",
    config: { trojan: { password: "[1, 2]" } },
  };
  assert.deepEqual(decodePanelValue(source), source);
  assert.deepEqual(encodePanelValue(decodePanelValue(source), source), source);
});

test("form values can be copied from reactive remote data without cloning failures", () => {
  const source = reactive({ id: 1, config: { password: "keep" } });
  const copy = clonePanelValue(source);
  copy.config.password = "changed";
  assert.equal(source.config.password, "keep");
  assert.equal(clonePanelValue(undefined), undefined);
});

test("new client forms use safe empty identities and no sample expiry or quota", () => {
  const operation = {
    path: "/panel/api/clients/add",
    schema: {},
    mutates: true,
  } as PanelOperation;
  assert.deepEqual(operationTemplate(operation), {
    client: {
      email: "",
      enable: true,
      totalGB: 0,
      expiryTime: 0,
      limitIp: 0,
      limitHwid: 0,
      comment: "",
    },
    inboundIds: [],
  });
  assert.deepEqual(
    initialValue({
      type: "object",
      required: ["enable"],
      properties: { enable: { type: "boolean" }, ignored: { type: "string" } },
    }),
    { enable: false },
  );
});

test("panel settings reads do not ask for a write confirmation and request examples remain available", () => {
  const catalog = nativeCatalog({
    paths: {
      "/panel/api/setting/all": { post: {} },
      "/panel/api/setting/update": {
        post: {
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object" },
                example: { webPort: 2053 },
              },
            },
          },
        },
      },
    },
  });
  assert.equal(catalog[0]!.mutates, false);
  assert.equal(catalog[1]!.mutates, true);
  assert.deepEqual(catalog[1]!.example, { webPort: 2053 });
});

test("management actions show task names rather than HTTP paths", () => {
  for (const [path, method, label, group] of [
    [
      "/panel/api/server/restartXrayService",
      "POST",
      "重启代理核心",
      "overview",
    ],
    ["/panel/api/server/getDb", "GET", "下载面板备份", "backup"],
    ["/panel/api/inbounds/update/{id}", "POST", "编辑设置", "inbounds"],
    ["/panel/api/clients/del/{email}", "POST", "删除", "clients"],
  ]) {
    const operation = { path, method } as PanelOperation;
    assert.equal(operationLabel(operation), label);
    assert.equal(operationSection(operation), group);
  }
});

test("adding nested rows preserves form shape without copying another identity", () => {
  const next = emptyPanelItem({
    id: 8,
    protocol: "vless",
    client: { id: "old-uuid", email: "alice", enable: true },
    inboundIds: [1],
  });
  assert.deepEqual(next, {
    protocol: "vless",
    client: { id: "", email: "", enable: true },
    inboundIds: [],
  });
  assert.deepEqual(xrayProtocolSettings("socks", true), {
    servers: [{ address: "", port: 1080, users: [{ user: "", pass: "" }] }],
  });
  const inbound = xrayProtocolSettings("vless", false);
  assert.deepEqual(inbound.clients, []);
  assert.equal(inbound.decryption, "none");
});
