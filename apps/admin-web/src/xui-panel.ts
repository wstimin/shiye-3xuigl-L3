import {
  decodePanelValue,
  emptyPanelItem,
  initialValue,
  type FieldSchema,
  type PanelRecord,
} from "./panel-fields";
export type PanelOperation = {
  id: string;
  path: string;
  method: string;
  group: string;
  mutates: boolean;
  encoding?: string;
  schema: FieldSchema;
  example?: unknown;
  parameters: {
    name: string;
    in: string;
    required?: boolean;
    schema: FieldSchema;
  }[];
};
export const panelSections = [
  { id: "overview", label: "运行概览", home: "GET /panel/api/server/status" },
  { id: "inbounds", label: "入站管理", home: "GET /panel/api/inbounds/list" },
  { id: "clients", label: "客户端", home: "GET /panel/api/clients/list" },
  { id: "xray", label: "出站与路由", home: "POST /panel/api/xray/" },
  { id: "nodes", label: "集群节点", home: "GET /panel/api/nodes/list" },
  { id: "hosts", label: "分享主机", home: "GET /panel/api/hosts/list" },
  {
    id: "certs",
    label: "证书与密钥",
    home: "GET /panel/api/server/getWebCertFiles",
  },
  { id: "setting", label: "面板设置", home: "POST /panel/api/setting/all" },
  {
    id: "logs",
    label: "运行日志",
    home: "POST /panel/api/server/logs/{count}",
  },
  { id: "backup", label: "备份与恢复", home: "" },
  {
    id: "sub-balancers",
    label: "订阅分组",
    home: "GET /panel/api/sub-balancers",
  },
];
const names: Record<string, string> = {
  list: "查看列表",
  "list/slim": "查看入站摘要",
  options: "查看可选入站",
  subId: "按订阅标识",
  tgId: "按 Telegram 用户",
  paged: "分页浏览",
  bulk: "批量管理",
  amneziawgKernelReadiness: "检查 WireGuard 运行环境",
  allLinks: "导出全部分享链接",
  get: "查看详情",
  add: "新建",
  del: "删除",
  bulkDel: "批量删除",
  update: "编辑设置",
  setEnable: "设置启停",
  subSortIndex: "调整订阅排序",
  resetTraffic: "重置流量",
  delAllClients: "移除全部客户端",
  resetAllTraffics: "重置全部流量",
  import: "导入文件",
  pushClientTraffics: "同步客户端流量",
  fallbacks: "回落规则",
  status: "运行状态",
  fail2banStatus: "检查 IP 数量限制",
  cpuHistory: "处理器历史",
  history: "运行历史",
  xrayMetricsState: "核心运行指标",
  xrayMetricsHistory: "核心指标历史",
  xrayObservatory: "出站健康状态",
  xrayObservatoryHistory: "出站健康历史",
  getXrayVersion: "可安装的核心版本",
  getPanelUpdateInfo: "检查面板更新",
  getUpdateStatus: "查看更新进度",
  getConfigJson: "当前核心设置",
  getDb: "下载面板备份",
  getMigration: "下载迁移备份",
  getNewUUID: "生成用户标识",
  getWebCertFiles: "查看面板证书",
  descendants: "下级节点",
  getNewX25519Cert: "生成 Reality 密钥",
  getNewmldsa65: "生成签名密钥",
  getNewmlkem768: "生成后量子密钥",
  getNewVlessEnc: "生成 VLESS 加密凭据",
  stopXrayService: "停止代理核心",
  restartXrayService: "重启代理核心",
  installXray: "安装核心版本",
  updatePanel: "更新面板",
  setUpdateChannel: "设置更新渠道",
  updateGeofile: "更新地理规则库",
  logs: "查看面板日志",
  xraylogs: "查看代理日志",
  amneziawglogs: "查看 WireGuard 日志",
  importDB: "恢复备份",
  getNewEchCert: "生成加密握手证书",
  getCertHash: "计算证书指纹",
  getRemoteCertHash: "检测服务器证书",
  scanRealityTarget: "检测 Reality 目标",
  scanRealityTargets: "批量检测 Reality 目标",
  clientIps: "在线设备地址",
  renewalPreview: "预览续费结果",
  attach: "关联入站",
  detach: "解除入站关联",
  externalLinks: "设置外部订阅链接",
  delDepleted: "清理到期客户端",
  delOrphans: "清理无入站客户端",
  export: "导出客户端",
  bulkAdjust: "批量调整额度与到期",
  bulkEnable: "批量启用",
  bulkDisable: "批量停用",
  bulkCreate: "批量新建客户端",
  bulkAdd: "批量加入分组",
  bulkRemove: "批量移出分组",
  bulkAttach: "批量关联入站",
  bulkDetach: "批量解除入站",
  bulkResetTraffic: "批量重置流量",
  groups: "用户分组",
  create: "新建",
  rename: "重命名",
  delete: "删除",
  emails: "分组成员",
  updateTraffic: "更新流量记录",
  ips: "查看设备地址",
  clearIps: "清除设备地址",
  hwids: "设备授权",
  onlines: "查看在线用户",
  onlinesByGuid: "按节点查看在线用户",
  clientIpsByGuid: "按节点查看设备",
  activeInbounds: "活跃入站",
  lastOnline: "最近在线时间",
  traffic: "查看流量用量",
  subLinks: "订阅链接",
  happLink: "生成 Happ 链接",
  links: "分享链接",
  mtls: "节点双向认证",
  ca: "生成节点认证证书",
  trustCA: "信任节点证书",
  reloadClient: "重新加载节点证书",
  webCert: "节点证书",
  test: "测试连接",
  certFingerprint: "检查证书指纹",
  inbounds: "查看节点入站",
  probe: "探测节点",
  raw: "分享主机详情",
  byInbound: "按入站查看主机",
  tags: "主机标签",
  reorder: "调整排序",
  setEnabled: "设置启停",
  all: "当前面板设置",
  defaultSettings: "推荐设置",
  factoryDefaults: "恢复出厂设置",
  validateRegex: "检查匹配规则",
  updateUser: "修改管理员账号",
  restartPanel: "重启面板",
  testSmtp: "发送测试邮件",
  testTgBot: "测试 Telegram 通知",
  tgBotCapabilities: "检查 Telegram 权限",
  testDiscord: "测试 Discord 通知",
  apiTokens: "访问令牌",
  getDefaultJsonConfig: "查看默认核心设置",
  getOutboundsTraffic: "出站用量",
  getXrayResult: "核心启动结果",
  warp: "Cloudflare Warp",
  nord: "NordVPN",
  pia: "PIA",
  resetOutboundsTraffic: "重置出站流量",
  testOutbound: "检测单个出站",
  testOutbounds: "批量检测出站",
  balancerStatus: "负载均衡状态",
  balancerOverride: "指定负载均衡出口",
  routeTest: "测试路由匹配",
  geodata: "地理规则库",
  files: "规则库文件",
  categories: "规则分类",
  entries: "规则条目",
  validate: "检查规则",
  "outbound-subs": "出站订阅",
  refresh: "立即更新订阅",
  move: "调整订阅优先级",
  parse: "预览订阅",
  backuptotgbot: "发送备份到 Telegram",
};
export function operationSection(item: PanelOperation) {
  const path = item.path.replace("/panel/api/", "");
  if (/getDb|getMigration|importDB|backuptotgbot/.test(path)) return "backup";
  if (/getNew|get.*Cert|scanReality/.test(path)) return "certs";
  if (/server\/(logs|xraylogs|amneziawglogs)/.test(path)) return "logs";
  return path.startsWith("server/") ? "overview" : path.split("/")[0]!;
}
export function operationLabel(item: PanelOperation) {
  const parts = item.path
    .replace("/panel/api/", "")
    .split("/")
    .filter((part) => part && !part.startsWith("{"));
  const label = parts
    .slice(1)
    .map((part) => names[part] || part.replace(/([a-z])([A-Z])/g, "$1 $2"))
    .join(" · ");
  if (parts[0] === "sub-balancers")
    return item.method === "GET"
      ? "订阅分组列表"
      : parts.length === 1
        ? "新建订阅分组"
        : /del/.test(parts.at(-1)!) || item.method === "DELETE"
          ? "删除订阅分组"
          : "编辑订阅分组";
  if (parts[0] === "backuptotgbot") return names.backuptotgbot!;
  if (item.path.endsWith("/fallbacks"))
    return `${item.method === "GET" ? "查看" : "编辑"}回落规则`;
  if (item.path.includes("/apiTokens") && parts.length === 2)
    return "访问令牌列表";
  if (parts[0] === "xray" && parts.length === 1) return "当前出站与路由";
  if (item.path.includes("/outbound-subs") && parts.at(-1) === "outbound-subs")
    return item.method === "GET"
      ? "出站订阅列表"
      : item.path.endsWith("{id}")
        ? "编辑出站订阅"
        : "新建出站订阅";
  return label || names[parts[0]!] || "查看设置";
}
export function visibleOperation(item: PanelOperation) {
  return (
    !/openapi\.json|\/options$|\/list\/slim$|\/pushClientTraffics$|\/raw$/.test(
      item.path,
    )
  );
}
export function unwrapPanelResult(value: unknown): unknown {
  if (value && typeof value === "object" && "obj" in value)
    return (value as PanelRecord).obj;
  return value;
}
export function xuiClientFormValue(value: unknown): PanelRecord {
  const root = value as PanelRecord;
  const client = { ...((root.client || root) as PanelRecord) };
  // Read models use a database id; writes require the protocol UUID instead.
  if (typeof client.uuid === "string" && client.uuid) client.id = client.uuid;
  else if (typeof client.id !== "string") delete client.id;
  if (client.allowedIPs !== undefined)
    client.allowedIPs =
      client.allowedIPs === "" ? [] : decodePanelValue(client.allowedIPs);
  if (client.reverse === "" || client.reverse === null) delete client.reverse;
  else if (client.reverse !== undefined)
    client.reverse = decodePanelValue(client.reverse);
  return client;
}
export function operationTemplate(item: PanelOperation): unknown {
  const path = item.path;
  if (path.endsWith("/inbounds/add"))
    return {
      remark: "",
      enable: true,
      listen: "",
      port: 443,
      protocol: "vless",
      total: 0,
      expiryTime: 0,
      settings: { clients: [], decryption: "none", fallbacks: [] },
      streamSettings: { network: "tcp", security: "none" },
      sniffing: { enabled: true, destOverride: ["http", "tls"] },
    };
  if (path.endsWith("/clients/add"))
    return {
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
    };
  if (path.endsWith("/nodes/add"))
    return {
      name: "",
      remark: "",
      scheme: "https",
      address: "",
      port: 2053,
      basePath: "/",
      apiToken: "",
      enable: true,
      allowPrivateAddress: false,
    };
  if (path.endsWith("/hosts/add"))
    return {
      inboundIds: [],
      remark: "",
      hosts: [],
      port: 443,
      security: "same",
      tags: [],
    };
  if (path.includes("/setting/apiTokens/create"))
    return { name: "", scope: "monitor", expiresAt: 0 };
  if (path.endsWith("/outbound-subs") && item.mutates)
    return {
      remark: "",
      url: "",
      enabled: true,
      updateInterval: 600,
      allowPrivate: false,
      allowInsecure: false,
    };
  if (path.endsWith("/sub-balancers") && item.mutates)
    return {
      remark: "",
      strategy: "random",
      inboundIds: [],
      enabled: true,
      sortOrder: 1,
    };
  if (Array.isArray(item.example))
    return item.example.length ? [emptyPanelItem(item.example[0])] : [];
  const base = initialValue(item.schema);
  // The remote example supplies missing field shapes, never live sample identities or quotas.
  if (
    item.example &&
    typeof item.example === "object" &&
    !Array.isArray(item.example)
  ) {
    return {
      ...Object.fromEntries(
        Object.entries(item.example as PanelRecord).map(([key, value]) => [
          key,
          value && typeof value === "object"
            ? Array.isArray(value)
              ? []
              : {}
            : typeof value === "boolean"
              ? value
              : typeof value === "number"
                ? 0
                : "",
        ]),
      ),
      ...(base as PanelRecord),
    };
  }
  return base;
}
