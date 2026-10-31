import { BadRequestException } from "@nestjs/common";
import {
  parseOutboundInput,
  applySingleOutboundName,
  importedOutboundTag,
} from "../xui/outbound-import.js";
import { xuiObject } from "../xui/xui-values.js";
type Row = Record<string, any>;
const obj = (value: unknown): Row => xuiObject(value);
const fail = (message: string): never => {
  throw new BadRequestException(message);
};

export function prepareSuiOutbounds(
  rows: { name: string; outbound: Row }[],
  occupiedTags: string[],
  availableTags: string[],
  conflict: string,
) {
  const occupied = new Set(occupiedTags),
    renamed = new Map<string, string>(),
    counts = new Map<string, number>();
  for (const row of rows)
    counts.set(
      String(row.outbound.tag),
      (counts.get(String(row.outbound.tag)) || 0) + 1,
    );
  const planned = rows.map((row) => {
    const outbound = structuredClone(row.outbound);
    delete outbound.id;
    const original = String(outbound.tag || "").trim();
    let tag = original;
    if (
      !tag ||
      tag.length > 160 ||
      typeof outbound.type !== "string" ||
      !outbound.type
    )
      fail("出站需要有效的名称和协议");
    if (occupied.has(tag)) {
      if (conflict !== "rename") fail(`出站「${tag}」已存在，请选择自动改名`);
      let n = 2;
      while (occupied.has(tag)) tag = original.slice(0, 150) + "-" + n++;
    }
    occupied.add(tag);
    if (counts.get(original) === 1) renamed.set(original, tag);
    outbound.tag = tag;
    return { ...row, outbound };
  });
  function visit(value: unknown, dependency: (tag: string) => string): void {
    if (Array.isArray(value)) {
      for (const item of value) visit(item, dependency);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      if (["detour", "default", "outbounds"].includes(key)) {
        if (typeof item === "string" && item)
          (value as Row)[key] = dependency(item);
        else if (Array.isArray(item))
          (value as Row)[key] = item.map((tag) =>
            typeof tag === "string" ? dependency(tag) : tag,
          );
      } else visit(item, dependency);
    }
  }
  for (const row of planned)
    visit(row.outbound, (tag) => {
      if ((counts.get(tag) || 0) > 1)
        fail(`出站「${tag}」有多个导入项，无法确定依赖目标，请先改名`);
      return renamed.get(tag) || tag;
    });
  const pending = [...planned],
    ordered: typeof planned = [],
    available = new Set(availableTags);
  while (pending.length) {
    const index = pending.findIndex((row) => {
      let ready = true;
      visit(row.outbound, (tag) => {
        if (!available.has(tag)) ready = false;
        return tag;
      });
      return ready;
    });
    if (index < 0)
      fail("出站依赖缺失或存在循环，请同时导入所需出站，或先启用依赖出站");
    const row = pending.splice(index, 1)[0]!;
    ordered.push(row);
    available.add(row.outbound.tag);
  }
  return ordered;
}
/** Reject unsupported conversions instead of silently losing transport or authentication options. */
export function toSuiOutbound(raw: Row): Row {
  if (raw.type && !raw.protocol) {
    if (typeof raw.type !== "string") fail("出站协议格式无效");
    const { id, ...native } = raw;
    return structuredClone(native);
  }
  const type = String(raw.protocol || "");
  if (type === "freedom") {
    if (
      Object.keys(obj(raw.settings)).length ||
      raw.sendThrough ||
      raw.proxySettings
    )
      fail("此直连出站包含自定义选项，请使用原生 sing-box 配置");
    return { type: "direct", tag: raw.tag };
  }
  if (
    !["socks", "http", "shadowsocks", "vmess", "vless", "trojan"].includes(type)
  )
    fail(`S-UI 无法转换 ${type || "未知"} 出站，请使用 sing-box 配置文件`);
  for (const key of Object.keys(raw))
    if (
      !["tag", "protocol", "settings", "streamSettings"].includes(key) &&
      raw[key] !== undefined &&
      raw[key] !== null
    )
      fail(`出站包含无法安全转换的 ${key}，请导入原生 sing-box 配置`);
  const settings = obj(raw.settings),
    servers = settings.vnext || settings.servers;
  if (!Array.isArray(servers) || servers.length !== 1)
    fail("转换出站需要唯一的目标服务器");
  const server = obj(servers[0]),
    users = server.users || [],
    user = obj(users[0]);
  if (users.length > 1) fail("多账号出站请拆分后导入");
  const result: Row = {
    type,
    tag: raw.tag,
    server: server.address,
    server_port: Number(server.port),
  };
  if (
    !result.server ||
    !Number.isInteger(result.server_port) ||
    result.server_port < 1 ||
    result.server_port > 65535
  )
    fail("出站服务器或端口无效");
  if (["socks", "http"].includes(type)) {
    if (type === "socks") result.version = "5";
    if (user.user) {
      result.username = user.user;
      result.password = user.pass || "";
    }
  }
  if (type === "shadowsocks") {
    result.method = server.method;
    result.password = server.password;
  }
  if (type === "trojan") result.password = server.password || user.password;
  if (["vless", "vmess"].includes(type)) {
    result.uuid = user.id;
    if (!result.uuid) fail("出站缺少 UUID");
  }
  if (type === "vless") {
    if (user.encryption && user.encryption !== "none")
      fail("该 vless 加密配置不能转换到 S-UI");
    if (user.flow) result.flow = user.flow;
  }
  if (type === "vmess") {
    result.security = user.security || "auto";
    result.alter_id = Number(user.alterId || 0);
  }
  const stream = obj(raw.streamSettings),
    network = stream.network || "tcp";
  for (const key of Object.keys(stream))
    if (
      ![
        "network",
        "security",
        "tcpSettings",
        "wsSettings",
        "grpcSettings",
        "httpupgradeSettings",
        "tlsSettings",
        "realitySettings",
      ].includes(key)
    )
      fail(`S-UI 无法转换传输选项 ${key}`);
  if (
    network === "tcp" &&
    obj(obj(stream.tcpSettings).header).type &&
    obj(obj(stream.tcpSettings).header).type !== "none"
  )
    fail("S-UI 不支持此 TCP 伪装，请使用原生配置");
  if (network !== "tcp") {
    const map: Row = {
      ws: "wsSettings",
      grpc: "grpcSettings",
      httpupgrade: "httpupgradeSettings",
    };
    if (!map[network]) fail(`S-UI 不支持转换 ${network} 传输`);
    const value = obj(stream[map[network]]);
    if (network === "grpc") {
      if (value.multiMode) fail("gRPC 多路模式不能转换到 S-UI");
      result.transport = {
        type: "grpc",
        service_name: value.serviceName || "",
      };
    } else
      result.transport = {
        type: network,
        path: value.path || "/",
        ...(network === "ws"
          ? { headers: value.headers || {} }
          : { host: value.host || "" }),
      };
  }
  if (stream.security && stream.security !== "none") {
    if (!["tls", "reality"].includes(stream.security))
      fail(`S-UI 无法转换 ${stream.security} 安全设置`);
    const value = obj(
      stream.security === "reality"
        ? stream.realitySettings
        : stream.tlsSettings,
    );
    if (
      value.certificates?.length ||
      value.pinnedPeerCertificateChainSha256?.length
    )
      fail("证书固定和客户端证书请使用原生 sing-box 配置");
    result.tls = {
      enabled: true,
      server_name: value.serverName || result.server,
      ...(value.allowInsecure === undefined
        ? {}
        : { insecure: value.allowInsecure }),
      ...(value.alpn ? { alpn: value.alpn } : {}),
    };
    if (value.fingerprint || stream.security === "reality")
      result.tls.utls = {
        enabled: true,
        fingerprint: value.fingerprint || "chrome",
      };
    if (stream.security === "reality") {
      if (!value.publicKey) fail("Reality 出站缺少公钥");
      result.tls.reality = {
        enabled: true,
        public_key: value.publicKey,
        short_id: value.shortId || "",
      };
    }
  }
  return result;
}
export async function outboundImportText(
  input: string,
  format: string,
  fetchImpl: typeof fetch = fetch,
) {
  let text = input.trim();
  if (format === "subscription" && /^https?:\/\//i.test(text)) {
    let url = new URL(text);
    for (let redirects = 0; ; redirects++) {
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        fail("订阅地址必须是有效的 HTTP(S) 地址");
      const response = await fetchImpl(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15000),
      });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        if (redirects >= 3 || !response.headers.get("location"))
          fail("订阅重定向过多或地址无效");
        url = new URL(response.headers.get("location")!, url);
        continue;
      }
      if (!response.ok || !response.body)
        fail("订阅读取失败，请检查地址与授权");
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body!) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          fail("订阅超过 1 MB，请拆分导入");
        }
        chunks.push(chunk);
      }
      text = Buffer.concat(chunks).toString("utf8").trim();
      break;
    }
  }
  if (!/^[\[{]|[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const decoded = Buffer.from(
      text.replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    )
      .toString("utf8")
      .trim();
    if (/^[\[{]|[a-z][a-z0-9+.-]*:\/\//i.test(decoded)) text = decoded;
  }
  return text;
}
export function parseSuiOutbounds(input: string, name?: string) {
  const text = input.trim();
  let items: {
    name: string;
    outbound: Row;
  }[];
  if (/^[\[{]/.test(text)) {
    let value: any;
    try {
      value = JSON.parse(text);
    } catch {
      return fail("配置文件不是有效的 JSON");
    }
    const list = Array.isArray(value)
      ? value
      : Array.isArray(value.outbounds)
        ? value.outbounds
        : [value];
    items = list.map((raw: any, index: number) => {
      const outbound = toSuiOutbound(obj(raw));
      const label = String(outbound.tag || `${outbound.type}-${index + 1}`);
      return {
        name: label,
        outbound: {
          ...outbound,
          tag: outbound.tag || importedOutboundTag(label, index),
        },
      };
    });
  } else {
    items = text
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith("#"))
      .flatMap((line) => {
        const match = line.match(/^(anytls|hy2|hysteria2|tuic):\/\//i);
        if (!match)
          return parseOutboundInput(line, "auto").map((item) => {
            const outbound = toSuiOutbound(item.outbound);
            if (/^(vless|trojan):\/\//i.test(line)) {
              const url = new URL(line),
                known = new Set([
                  "type",
                  "security",
                  "host",
                  "path",
                  "serviceName",
                  "sni",
                  "fp",
                  "pbk",
                  "sid",
                  "spx",
                  "encryption",
                  "flow",
                  "insecure",
                  "allowInsecure",
                  "alpn",
                ]);
              for (const key of url.searchParams.keys())
                if (!known.has(key))
                  fail(`无法安全转换链接参数 ${key}，请使用 sing-box 配置文件`);
              if (
                outbound.type === "trojan" &&
                !url.searchParams.has("security")
              )
                outbound.tls = {
                  enabled: true,
                  server_name: url.searchParams.get("sni") || outbound.server,
                };
              if (outbound.tls) {
                const insecure =
                  url.searchParams.get("insecure") ??
                  url.searchParams.get("allowInsecure");
                if (insecure !== null)
                  outbound.tls.insecure = ["1", "true"].includes(insecure);
                if (url.searchParams.has("alpn"))
                  outbound.tls.alpn = url.searchParams.get("alpn")!.split(",");
              }
            }
            return { name: item.name, outbound };
          });
        const url = new URL(line),
          type = match[1]!.toLowerCase().replace(/^hy2$/, "hysteria2");
        const label =
          decodeURIComponent(url.hash.slice(1)) || `${type}-${url.hostname}`;
        const outbound: Row = {
          type,
          tag: importedOutboundTag(label, 0),
          server: url.hostname,
          server_port: Number(url.port || 443),
          password: decodeURIComponent(url.password || url.username),
          tls: {
            enabled: true,
            server_name: url.searchParams.get("sni") || url.hostname,
            ...(url.searchParams.get("insecure") === "1"
              ? { insecure: true }
              : {}),
          },
        };
        if (type === "tuic") {
          outbound.uuid = decodeURIComponent(url.username);
          if (!url.password) fail("tuic 链接缺少密码");
        }
        if (
          !outbound.password ||
          !Number.isInteger(outbound.server_port) ||
          outbound.server_port < 1 ||
          outbound.server_port > 65535
        )
          fail("出站链接缺少凭据或有效端口");
        if (url.searchParams.has("obfs")) {
          if (
            type !== "hysteria2" ||
            url.searchParams.get("obfs") !== "salamander"
          )
            fail("不支持此混淆设置");
          outbound.obfs = {
            type: "salamander",
            password: url.searchParams.get("obfs-password") || "",
          };
        }
        const known = new Set([
          "sni",
          "insecure",
          "obfs",
          "obfs-password",
          "alpn",
          "congestion_control",
        ]);
        for (const key of url.searchParams.keys())
          if (!known.has(key))
            fail(`无法安全导入链接参数 ${key}，请使用 sing-box 配置文件`);
        if (url.searchParams.has("alpn"))
          outbound.tls.alpn = url.searchParams.get("alpn")!.split(",");
        if (type === "tuic" && url.searchParams.has("congestion_control"))
          outbound.congestion_control =
            url.searchParams.get("congestion_control");
        return [{ name: label, outbound }];
      });
  }
  if (!items.length || items.length > 100) fail("一次请导入 1–100 个出站");
  return applySingleOutboundName(items, name);
}
