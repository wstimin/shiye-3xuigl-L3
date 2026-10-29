export type PanelRecord = Record<string, unknown>;
export type FieldSchema = {
  type?: string;
  format?: string;
  enum?: unknown[];
  default?: unknown;
  properties?: Record<string, FieldSchema>;
  items?: FieldSchema;
  required?: string[];
  oneOf?: FieldSchema[];
  anyOf?: FieldSchema[];
  allOf?: FieldSchema[];
};

const labels: Record<string, string> = {
  pass: "密码",
  accounts: "登录账号",
  vnext: "代理服务器",
  endpoint: "对端地址",
  secretKey: "私钥",
  private_key: "私钥",
  public_key: "公钥",
  allowed_ips: "允许的地址",
  pre_shared_key: "预共享密钥",
  id: "标识",
  name: "名称",
  remark: "备注名称",
  tag: "标签",
  type: "类型",
  protocol: "协议",
  enable: "启用",
  enabled: "启用",
  address: "地址",
  server: "服务器",
  port: "端口",
  listen: "监听地址",
  listen_port: "监听端口",
  server_port: "服务器端口",
  password: "密码",
  username: "账号",
  uuid: "用户标识",
  email: "用户标识",
  subId: "订阅标识",
  client: "客户端",
  clients: "客户端",
  config: "协议设置",
  settings: "协议设置",
  streamSettings: "传输设置",
  sniffing: "流量识别",
  network: "传输方式",
  security: "连接加密",
  flow: "流控模式",
  decryption: "解密方式",
  encryption: "加密方式",
  inbounds: "授权入站",
  inboundIds: "授权入站",
  inboundId: "入站",
  outboundId: "出站",
  totalGB: "流量额度",
  total: "流量额度",
  volume: "流量额度",
  expiryTime: "到期时间",
  expiry: "到期时间",
  expiresAt: "到期时间",
  limitIp: "同时在线 IP 数量",
  limitHwid: "设备数量限制",
  tgId: "Telegram 用户编号",
  comment: "备注",
  desc: "说明",
  group: "分组",
  groups: "分组",
  up: "已用上传",
  down: "已用下载",
  uplink: "上传",
  downlink: "下载",
  traffic: "流量",
  upload: "上传",
  download: "下载",
  used: "已使用",
  online: "在线",
  onlines: "在线用户",
  lastOnline: "最后在线",
  createdAt: "创建时间",
  updatedAt: "更新时间",
  dateTime: "发生时间",
  actor: "操作人",
  action: "操作",
  key: "项目",
  value: "内容",
  obj: "详细信息",
  msg: "说明",
  success: "操作成功",
  status: "状态",
  state: "运行状态",
  running: "运行中",
  version: "版本",
  panelVersion: "面板版本",
  xrayVersion: "核心版本",
  xray: "代理核心",
  cpu: "处理器使用率",
  mem: "内存",
  memory: "内存",
  disk: "磁盘",
  swap: "交换空间",
  netIO: "网络流量",
  netTraffic: "累计流量",
  netUp: "上传流量",
  netDown: "下载流量",
  uptime: "运行时长",
  uptimeSecs: "运行秒数",
  publicKey: "公钥",
  privateKey: "私钥",
  preSharedKey: "预共享密钥",
  shortIds: "短标识",
  serverNames: "允许的域名",
  serverName: "服务器域名",
  server_name: "服务器域名",
  dest: "目标地址",
  target: "目标地址",
  sni: "握手域名",
  alpn: "应用协议",
  fingerprint: "浏览器指纹",
  certificates: "证书列表",
  certificate: "证书内容",
  certificate_path: "证书文件路径",
  key_path: "私钥文件路径",
  keyFile: "私钥文件",
  certFile: "证书文件",
  certContent: "证书内容",
  certificateFile: "证书文件路径",
  tls: "安全连接",
  tls_id: "证书",
  tlsSettings: "安全连接设置",
  realitySettings: "Reality 设置",
  insecure: "跳过证书校验",
  allowInsecure: "跳过证书校验",
  rejectUnknownSni: "拒绝未匹配域名",
  minVersion: "最低安全协议版本",
  maxVersion: "最高安全协议版本",
  tlsDisableSNI: "关闭域名指示",
  path: "访问路径",
  host: "主机名",
  headers: "请求头",
  wsSettings: "WebSocket 设置",
  httpSettings: "HTTP 设置",
  tcpSettings: "TCP 设置",
  grpcSettings: "gRPC 设置",
  xhttpSettings: "XHTTP 设置",
  serviceName: "服务名称",
  transport: "传输设置",
  method: "加密算法",
  users: "用户列表",
  peers: "对端",
  auth: "认证密码",
  secret: "密钥",
  token: "访问令牌",
  apiToken: "访问令牌",
  scope: "权限",
  expectedScope: "原有权限",
  clearApiToken: "清除已保存的令牌",
  hasApiToken: "已保存令牌",
  basePath: "面板路径",
  scheme: "连接方式",
  allowPrivateAddress: "允许内网地址",
  allowPrivate: "允许访问内网",
  guid: "节点标识",
  parentGuid: "上级节点",
  pinnedCertSha256: "证书指纹",
  tlsVerifyMode: "证书验证方式",
  inboundSyncMode: "入站同步方式",
  inboundTags: "入站标签",
  outboundTag: "目标出站",
  outbound: "出站设置",
  outbounds: "出站列表",
  out_json: "出站附加设置",
  addrs: "分享地址",
  server_port_range: "服务器端口范围",
  user: "用户",
  domains: "域名列表",
  domain: "域名",
  ip: "IP 地址",
  ips: "IP 地址",
  cidr: "地址范围",
  domain_suffix: "域名后缀",
  domain_keyword: "域名关键词",
  domain_regex: "域名匹配规则",
  ip_cidr: "IP 地址范围",
  source_ip_cidr: "来源地址范围",
  inbound: "入站标签",
  inboundTag: "入站标签",
  domainStrategy: "域名解析策略",
  routing: "路由设置",
  route: "路由设置",
  rules: "规则列表",
  dns: "域名解析",
  servers: "服务器列表",
  log: "日志设置",
  level: "日志级别",
  disabled: "停用",
  output: "日志文件",
  timestamp: "记录时间",
  final: "默认出口",
  detour: "上游出站",
  strategy: "策略",
  default_domain_resolver: "默认解析服务器",
  cache: "缓存",
  disable_cache: "关闭缓存",
  independent_cache: "独立缓存",
  timeout: "超时时间",
  delay: "延迟",
  latencyMs: "延迟（毫秒）",
  interval: "间隔",
  count: "数量",
  filter: "筛选关键词",
  syslog: "读取系统日志",
  tags: "标签列表",
  mode: "检测方式",
  regex: "匹配规则",
  fileName: "文件名称",
  db: "备份文件",
  keepHostSettings: "保留本机地址、证书和节点身份",
  dev: "使用开发版本",
  url: "地址",
  outboundTestUrl: "连通性检测地址",
  tagPrefix: "标签前缀",
  userAgent: "访问标识",
  updateInterval: "更新间隔（秒）",
  prepend: "优先于手动出站",
  dir: "移动方向",
  sortOrder: "排序",
  subSortIndex: "订阅排序",
  childId: "下级入站",
  fallbacks: "回落规则",
  xver: "代理协议版本",
  seed: "私密种子",
  verify: "验证密钥",
  clientStats: "客户端流量",
  access: "访问日志",
  error: "错误日志",
  loglevel: "日志级别",
  dnsLog: "记录域名解析日志",
  webListen: "面板监听地址",
  webDomain: "面板域名",
  webPort: "面板端口",
  webBasePath: "面板路径",
  webCertFile: "面板证书路径",
  webKeyFile: "面板私钥路径",
  sessionMaxAge: "登录会话有效期",
  timeLocation: "时区",
  subEnable: "启用订阅",
  subListen: "订阅监听地址",
  subPort: "订阅端口",
  subPath: "订阅路径",
  subDomain: "订阅域名",
  subURI: "订阅地址",
  subTitle: "订阅标题",
  subCertFile: "订阅证书路径",
  subKeyFile: "订阅私钥路径",
  subUpdates: "订阅更新间隔",
  subEncrypt: "订阅加密",
  subJsonEnable: "启用通用订阅",
  subJsonPort: "通用订阅端口",
  subJsonPath: "通用订阅路径",
  subJsonURI: "通用订阅地址",
  subJsonFragment: "订阅分片",
  tgBotEnable: "启用 Telegram 通知",
  tgBotToken: "Telegram 机器人令牌",
  tgBotChatId: "通知群组编号",
  tgRunTime: "通知时间",
  tgBackup: "自动备份通知",
  tgCpu: "处理器告警阈值",
  smtpHost: "邮件服务器",
  smtpPort: "邮件端口",
  smtpUser: "邮件账号",
  smtpPass: "邮件密码",
  smtpFrom: "发件人",
  smtpEnable: "启用邮件通知",
  secretToken: "订阅密钥",
  reset: "流量重置方式",
  resetDays: "重置周期（天）",
  autoReset: "自动重置流量",
  delayStart: "首次连接后开始计时",
  nextReset: "下次重置时间",
  udp: "允许 UDP",
  sniff: "识别连接协议",
  sniff_override_destination: "使用识别后的目标",
  destOverride: "识别协议",
  routeOnly: "仅用于路由",
  metadataOnly: "只识别元数据",
  mux: "多路复用",
  sockopt: "连接选项",
  dialerProxy: "上游代理",
  serverOptions: "服务器选项",
  clientOptions: "客户端选项",
  serverKey: "服务器密钥",
  address_resolver: "地址解析服务器",
  packet_encoding: "数据包编码",
  congestion_control: "拥塞控制",
  up_mbps: "上传速率（Mbps）",
  down_mbps: "下载速率（Mbps）",
  masquerade: "伪装地址",
  obfs: "混淆设置",
  obfsPassword: "混淆密码",
  keepAlive: "保活间隔",
  allowedIPs: "允许的地址",
  local_address: "本机地址",
  mtu: "最大传输单元",
  endpoints: "端点",
  services: "服务",
  destination: "连接目标",
  source: "来源",
  maintenance: "维护模式",
  sys: "系统信息",
  sbd: "代理核心",
  emails: "选择用户",
  ids: "选择资源",
  bucket: "采样间隔",
  metric: "监控项目",
  inboundCount: "入站数量",
  clientCount: "客户端数量",
  onlineCount: "在线数量",
  activeCount: "有效数量",
  disabledCount: "停用数量",
  depletedCount: "到期数量",
  lastError: "最近错误",
  lastHeartbeat: "最近心跳",
  xrayState: "核心状态",
  cpuPct: "处理器使用率",
  memPct: "内存使用率",
  nameServer: "解析服务器",
  interface_name: "网卡名称",
  bind_interface: "绑定网卡",
  auto_route: "自动路由",
  address_family: "地址类型",
  detach: "解除关联",
  hosts: "分享主机列表",
  groupId: "主机组",
  randomCount: "随机主机数量",
  isDisabled: "已停用",
  isHidden: "隐藏订阅",
  hostHeader: "请求主机",
  serverDescription: "服务器说明",
  memberWeights: "成员权重",
  xraySetting: "核心设置",
  data: "导入内容",
  allOutbounds: "可选上游出站",
  currentPassword: "当前密码",
  newPassword: "新密码",
  newUsername: "新账号",
  usernameOld: "原账号",
  passwordOld: "原密码",
  usernameNew: "新账号",
  passwordNew: "新密码",
};
export const optionLabels: Record<string, string> = {
  true: "是",
  false: "否",
  running: "运行中",
  stopped: "已停止",
  online: "在线",
  offline: "离线",
  reg: "注册连接",
  regMasque: "注册加密连接",
  changeIp: "更换出口地址",
  license: "设置授权",
  interval: "设置自动更换间隔",
  data: "查看连接状态",
  config: "查看连接设置",
  countries: "查看可用国家",
  servers: "查看可用服务器",
  setKey: "保存访问密钥",
  addKey: "注册连接密钥",
  cpu: "处理器",
  mem: "内存",
  netUp: "上传流量",
  netDown: "下载流量",
  load1: "一分钟负载",
  load5: "五分钟负载",
  load15: "十五分钟负载",
  xrAlloc: "已分配内存",
  xrSys: "系统内存",
  xrHeapObjects: "内存对象数",
  xrNumGC: "内存回收次数",
  xrPauseNs: "内存回收耗时",
  field: "按条件匹配",
  same: "沿用入站设置",
  direct: "直连",
  block: "阻断",
  freedom: "直连",
  blackhole: "阻断",
  none: "无",
  admin: "管理员",
  monitor: "只读监控",
  "node-sync": "节点同步",
  "node-admin": "节点管理",
  random: "随机",
  roundRobin: "轮询",
  leastPing: "最低延迟",
  leastLoad: "最低负载",
  up: "上移",
  down: "下移",
  stable: "稳定版",
  latest: "最新稳定版",
  debug: "调试",
  info: "常规",
  warning: "警告",
  warn: "警告",
  error: "错误",
  fatal: "严重错误",
  prefer_ipv4: "优先 IPv4",
  prefer_ipv6: "优先 IPv6",
  ipv4_only: "仅 IPv4",
  ipv6_only: "仅 IPv6",
  enabled: "已启用",
  disabled: "已停用",
  new: "新建",
  edit: "修改",
  del: "删除",
  set: "保存",
  "": "默认",
};
export function fieldLabel(key: string) {
  return (
    labels[key] || key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ")
  );
}
export function clonePanelValue<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}
export function emptyPanelItem(value: unknown, field = ""): unknown {
  if (Array.isArray(value)) return [];
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key, item]) =>
            !["createdAt", "updatedAt"].includes(key) &&
            !(key === "id" && typeof item === "number"),
        )
        .map(([key, item]) => [key, emptyPanelItem(item, key)]),
    );
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return 0;
  if (["type", "protocol", "network", "security", "decryption"].includes(field))
    return value;
  return "";
}
export function isSecretField(key: string) {
  return /password|private.?key|secret|token|seed|auth$/i.test(key);
}
export function decodePanelValue(value: unknown, key = ""): unknown {
  if (isSecretField(key)) return value;
  if (value === "true" || value === "false") return value === "true";
  if (typeof value === "string" && /^\s*[\[{]/.test(value)) {
    try {
      return decodePanelValue(JSON.parse(value));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value))
    return value.map((item) => decodePanelValue(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        decodePanelValue(item, key),
      ]),
    );
  return value;
}
export function encodePanelValue(
  value: unknown,
  original: unknown,
  field = "",
): unknown {
  if (isSecretField(field)) return value;
  if (
    (original === "true" || original === "false") &&
    typeof value === "boolean"
  )
    return String(value);
  if (typeof original === "string" && /^\s*[\[{]/.test(original)) {
    try {
      return JSON.stringify(encodePanelValue(value, JSON.parse(original)));
    } catch {
      return value;
    }
  }
  if (Array.isArray(value))
    return value.map((item, index) =>
      encodePanelValue(
        item,
        Array.isArray(original) ? original[index] : undefined,
        field,
      ),
    );
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        encodePanelValue(item, (original as PanelRecord | null)?.[key], key),
      ]),
    );
  return value;
}
export function normalizeSchema(schema: FieldSchema = {}): FieldSchema {
  const variants = [
    ...(schema.allOf || []),
    ...(schema.oneOf || schema.anyOf || []).slice(0, 1),
  ];
  return variants.reduce<FieldSchema>((result, item) => {
    const next = normalizeSchema(item);
    return {
      ...result,
      ...next,
      properties: { ...result.properties, ...next.properties },
    };
  }, schema);
}
export function initialValue(schema: FieldSchema = {}): unknown {
  schema = normalizeSchema(schema);
  if (schema.default !== undefined) return clonePanelValue(schema.default);
  if (schema.enum?.length) return schema.enum[0];
  if (schema.type === "array") return [];
  if (schema.type === "object" || schema.properties)
    return Object.fromEntries(
      Object.entries(schema.properties || {})
        .filter(
          ([key, field]) =>
            schema.required?.includes(key) || field.default !== undefined,
        )
        .map(([key, field]) => [key, initialValue(field)]),
    );
  if (schema.type === "boolean") return false;
  if (["integer", "number"].includes(schema.type || "")) return 0;
  return "";
}
export const fieldOptions: Record<string, string[]> = {
  protocol: [
    "freedom",
    "blackhole",
    "socks",
    "http",
    "shadowsocks",
    "vless",
    "vmess",
    "trojan",
    "wireguard",
  ],
  security: ["none", "tls", "reality"],
  network: ["tcp", "ws", "grpc", "xhttp", "httpupgrade", "udp"],
  level: ["trace", "debug", "info", "warn", "error", "fatal"],
  loglevel: ["debug", "info", "warning", "error", "none"],
  scope: ["admin", "monitor", "node-sync", "node-admin"],
  expectedScope: ["admin", "monitor", "node-sync", "node-admin"],
  strategy: ["random", "roundRobin", "leastPing", "leastLoad"],
  scheme: ["https", "http"],
  dir: ["up", "down"],
  domainStrategy: ["AsIs", "IPIfNonMatch", "IPOnDemand"],
  mode: ["", "tcp", "real"],
  tlsVerifyMode: ["verify", "pin", "insecure"],
};
export const objectPresets: Record<string, PanelRecord> = {
  clients: { email: "", id: "", enable: true, totalGB: 0, expiryTime: 0 },
  client: {
    email: "",
    enable: true,
    totalGB: 0,
    expiryTime: 0,
    limitIp: 0,
    limitHwid: 0,
    comment: "",
  },
  rules: { type: "field", domain: [], ip: [], inboundTag: [], outboundTag: "" },
  fallbacks: { childId: 0, name: "", alpn: "", path: "", dest: "", xver: 0 },
  servers: { type: "udp", tag: "", server: "1.1.1.1", server_port: 53 },
  settings: { clients: [], decryption: "none" },
  streamSettings: { network: "tcp", security: "none" },
  sniffing: { enabled: true, destOverride: ["http", "tls"] },
  server: {
    enabled: true,
    server_name: "",
    certificate_path: "",
    key_path: "",
  },
  config: { vless: { uuid: "" } },
  vless: { uuid: "" },
  vmess: { uuid: "" },
  trojan: { password: "" },
  shadowsocks: { password: "" },
  tls: { enabled: true, server_name: "", insecure: false },
  log: { level: "info", timestamp: true },
  dns: { servers: [] },
  route: { rules: [], final: "" },
  transport: { type: "ws", path: "/" },
  peers: { server: "", server_port: 51820, public_key: "", allowed_ips: [] },
  outbounds: { tag: "", protocol: "freedom", settings: {} },
};

export function xrayProtocolSettings(
  protocol: string,
  outbound: boolean,
): PanelRecord {
  if (outbound) {
    if (protocol === "vless" || protocol === "vmess")
      return {
        vnext: [
          {
            address: "",
            port: 443,
            users: [
              {
                id: "",
                ...(protocol === "vless"
                  ? { encryption: "none", flow: "" }
                  : { security: "auto" }),
              },
            ],
          },
        ],
      };
    if (protocol === "socks" || protocol === "http")
      return {
        servers: [
          {
            address: "",
            port: protocol === "socks" ? 1080 : 8080,
            users: [{ user: "", pass: "" }],
          },
        ],
      };
    if (protocol === "trojan" || protocol === "shadowsocks")
      return {
        servers: [
          {
            address: "",
            port: 443,
            password: "",
            ...(protocol === "shadowsocks" ? { method: "aes-128-gcm" } : {}),
          },
        ],
      };
    if (protocol === "wireguard")
      return {
        secretKey: "",
        address: [],
        peers: [{ publicKey: "", endpoint: "", allowedIPs: [] }],
        mtu: 1420,
      };
    return {};
  }
  if (protocol === "socks" || protocol === "http")
    return {
      auth: "password",
      accounts: [{ user: "", pass: "" }],
      ...(protocol === "socks" ? { udp: true } : {}),
    };
  if (protocol === "shadowsocks")
    return {
      method: "aes-128-gcm",
      password: "",
      network: "tcp,udp",
      clients: [],
    };
  return {
    clients: [],
    ...(protocol === "vless" ? { decryption: "none" } : {}),
    ...(["vless", "trojan"].includes(protocol) ? { fallbacks: [] } : {}),
  };
}
