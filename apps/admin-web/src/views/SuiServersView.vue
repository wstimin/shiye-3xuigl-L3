<script setup lang="ts">
import SuiBusinessLink from "../components/SuiBusinessLink.vue";
import PanelFields from "../components/PanelFields.vue";
import {
  clonePanelValue,
  decodePanelValue,
  encodePanelValue,
  type FieldSchema,
} from "../panel-fields";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import {
  Activity,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Code2,
  Edit3,
  Globe2,
  Layers,
  Network,
  Plus,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  Trash2,
  Users,
  X,
} from "lucide-vue-next";
import { ElMessage, ElMessageBox } from "element-plus";
import { suiSaveSchema, suiServerSchema } from "@shiye/shared";
import { api } from "../api";

type Row = Record<string, unknown>;
type ServerConnection = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  remark: string;
};
const linkClient = ref<Row | null>(null);
const businessNodes = ref<{ id: string; config: { suiClientId?: number } }[]>(
  [],
);
const servers = ref<ServerConnection[]>([]);
const selected = ref<ServerConnection | null>(null);
const loading = ref(false);
const busy = ref(false);
const error = ref("");
const search = ref("");
const resource = ref("clients");
const data = ref<unknown>(null);
const status = ref<Row | null>(null);
const checkedAt = ref("");
const connectionDialog = ref(false);
const editingId = ref("");
const connection = ref({
  name: "",
  baseUrl: "",
  token: "",
  enabled: true,
  remark: "",
});
const editor = ref(false);
const editorRecord = ref<unknown>({});
const editorOriginal = ref<unknown>({});
const editorError = ref("");
const confirmSave = ref(false);
const editorAction = ref<"new" | "edit" | "set">("new");
const clientOriginal = ref<Row>({});
const clientFields = ref({
  name: "",
  remark: "",
  enable: true,
  volumeGb: 0,
  expiry: "",
  inbounds: [] as number[],
});
const clientConfig = ref<unknown>({});
const inboundChoices = ref<Row[]>([]);
const certificateChoices = ref<{ value: number; label: string }[]>([]);
const editorSchema = computed((): FieldSchema => {
  if (resource.value === "inbounds")
    return {
      type: "object",
      properties: {
        type: {
          enum: [
            "vless",
            "vmess",
            "trojan",
            "shadowsocks",
            "socks",
            "http",
            "mixed",
            "hysteria2",
            "tuic",
          ],
        },
        tag: { type: "string" },
        listen: { type: "string" },
        listen_port: { type: "integer" },
        tls_id: { type: "integer" },
        addrs: { type: "array", items: { type: "string" } },
      },
      required: ["type", "tag", "listen_port"],
    };
  if (resource.value === "outbounds")
    return {
      type: "object",
      properties: {
        type: {
          enum: [
            "direct",
            "block",
            "socks",
            "http",
            "shadowsocks",
            "vless",
            "vmess",
            "trojan",
            "hysteria2",
            "tuic",
          ],
        },
        tag: { type: "string" },
        server: { type: "string" },
        server_port: { type: "integer" },
        username: { type: "string" },
        password: { type: "string" },
        uuid: { type: "string" },
      },
      required: ["type", "tag"],
    };
  if (resource.value === "endpoints")
    return {
      type: "object",
      properties: {
        type: {
          enum: ["wireguard", "tailscale", "openconnect", "openvpn", "warp"],
        },
      },
    };
  if (resource.value === "services")
    return {
      type: "object",
      properties: { type: { enum: ["derp", "resolved", "ssm-api"] } },
    };
  return { type: "object" };
});
watch(
  () => clientFields.value.inbounds,
  (ids) => {
    if (editorAction.value !== "new" || resource.value !== "clients") return;
    const config = { ...(clientConfig.value as Row) };
    const protocols = [
      ...new Set(
        ids.map((id) =>
          String(
            inboundChoices.value.find((row) => Number(row.id) === id)?.type ||
              "vless",
          ),
        ),
      ),
    ];
    for (const protocol of protocols)
      if (!config[protocol]) {
        config[protocol] = ["vless", "vmess", "tuic"].includes(protocol)
          ? {
              uuid: crypto.randomUUID(),
              ...(protocol === "tuic" ? { password: crypto.randomUUID() } : {}),
            }
          : { password: crypto.randomUUID() };
      }
    clientConfig.value = config;
  },
  { deep: true },
);

const dialogElement = ref<HTMLDialogElement | null>(null);
watch(
  () => connectionDialog.value || editor.value,
  async (open) => {
    await nextTick();
    if (open) dialogElement.value?.showModal();
  },
);
const resources = [
  { id: "clients", label: "客户端", icon: Users },
  { id: "inbounds", label: "入站", icon: Network },
  { id: "outbounds", label: "出站", icon: ArrowUpRight },
  { id: "endpoints", label: "端点", icon: Globe2 },
  { id: "services", label: "服务", icon: Layers },
  { id: "tls", label: "TLS 证书", icon: ShieldCheck },
  { id: "config", label: "路由与 DNS", icon: Code2 },
  { id: "settings", label: "面板设置", icon: Server },
  { id: "sessions", label: "实时会话", icon: Activity },
  { id: "stats", label: "流量统计", icon: Activity },
  { id: "logs", label: "核心日志", icon: Code2 },
  { id: "changes", label: "操作记录", icon: Layers },
];
const resourceLabel = computed(
  () => resources.find((item) => item.id === resource.value)?.label || "",
);
const writable = computed(() =>
  [
    "clients",
    "inbounds",
    "outbounds",
    "endpoints",
    "services",
    "tls",
    "config",
    "settings",
  ].includes(resource.value),
);
const singleton = computed(() =>
  ["config", "settings"].includes(resource.value),
);
const rows = computed<Row[]>(() => {
  const root = data.value;
  const value =
    root && typeof root === "object" && !Array.isArray(root)
      ? ((root as Row)[resource.value] ?? root)
      : root;
  return Array.isArray(value)
    ? (value.filter((item) => item && typeof item === "object") as Row[])
    : [];
});
const filtered = computed(() =>
  rows.value.filter((row) =>
    JSON.stringify(row).toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const filteredServers = computed(() =>
  servers.value.filter((server) =>
    `${server.name} ${server.baseUrl}`
      .toLowerCase()
      .includes(search.value.toLowerCase()),
  ),
);
const core = computed(() => status.value?.sbd as Row | undefined);
const cpu = computed(() =>
  typeof status.value?.cpu === "number"
    ? `${Number(status.value.cpu).toFixed(1)}%`
    : "—",
);
let readVersion = 0;

function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
function bytes(value: unknown) {
  const size = Number(value || 0);
  if (!Number.isFinite(size) || size <= 0) return "0 B";
  const index = Math.min(Math.floor(Math.log(size) / Math.log(1024)), 4);
  return `${(size / 1024 ** index).toFixed(index ? 1 : 0)} ${["B", "KB", "MB", "GB", "TB"][index]}`;
}
function title(row: Row) {
  return String(
    row.remark || row.name || row.tag || row.domain || row.id || "—",
  );
}
function expiry(row: Row) {
  return Number(row.expiry) > 0
    ? new Date(Number(row.expiry) * 1000).toLocaleDateString("zh-CN")
    : "不限期";
}
async function loadServers() {
  loading.value = true;
  error.value = "";
  try {
    servers.value = await api<ServerConnection[]>("/api/admin/sui-servers");
  } catch (cause) {
    error.value = message(cause);
  } finally {
    loading.value = false;
  }
}
async function openConnection(server?: ServerConnection) {
  editingId.value = server?.id || "";
  connection.value = {
    name: server?.name || "",
    baseUrl: server?.baseUrl || "",
    token: "",
    enabled: server?.enabled ?? true,
    remark: server?.remark || "",
  };
  editorError.value = "";
  if (server) {
    try {
      const saved = await api<{ token: string }>(`/api/admin/sui-servers/${server.id}/secrets`);
      if (editingId.value !== server.id) return;
      connection.value.token = saved.token;
    } catch (cause) { editorError.value = message(cause); }
  }
  connectionDialog.value = true;
}
async function saveConnection() {
  const parsed = suiServerSchema.safeParse(connection.value);
  if (!parsed.success) {
    editorError.value = parsed.error.issues[0]?.message || "请检查表单";
    return;
  }
  if (!editingId.value && !connection.value.token) {
    editorError.value = "请输入在 S-UI 管理页面生成的 访问令牌";
    return;
  }
  busy.value = true;
  editorError.value = "";
  try {
    await api(
      `/api/admin/sui-servers${editingId.value ? `/${editingId.value}` : ""}`,
      { method: editingId.value ? "PATCH" : "POST", body: parsed.data },
    );
    connection.value.token = "";
    connectionDialog.value = false;
    ElMessage.success("面板连接已保存");
    await loadServers();
  } catch (cause) {
    editorError.value = message(cause);
  } finally {
    busy.value = false;
  }
}
async function removeConnection(server: ServerConnection) {
  try {
    await ElMessageBox.confirm(
      `移除「${server.name}」的本地连接？远端配置将保留。`,
      "移除连接",
      { type: "warning", confirmButtonText: "移除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    await api(`/api/admin/sui-servers/${server.id}`, { method: "DELETE" });
    await loadServers();
  } catch (cause) {
    ElMessage.error(message(cause));
  } finally {
    busy.value = false;
  }
}
async function testConnection(server: ServerConnection) {
  busy.value = true;
  try {
    await api(`/api/admin/sui-servers/${server.id}/test`, { method: "POST" });
    ElMessage.success(`${server.name} 连接正常`);
  } catch (cause) {
    ElMessage.error(message(cause));
  } finally {
    busy.value = false;
  }
}
function enter(server: ServerConnection) {
  selected.value = server;
  resource.value = "clients";
  search.value = "";
  status.value = null;
  checkedAt.value = "";
  void refresh();
}
function back() {
  readVersion++;
  selected.value = null;
  data.value = null;
  search.value = "";
  error.value = "";
  loading.value = false;
}
async function refresh() {
  if (!selected.value) return;
  const version = ++readVersion;
  const id = selected.value.id;
  const key = resource.value;
  loading.value = true;
  error.value = "";
  data.value = null;
  try {
    const [result, health, linked] = await Promise.all([
      api<unknown>(`/api/admin/sui-servers/${id}/resources/${key}`),
      api<Row>(`/api/admin/sui-servers/${id}/resources/status`),
      api<typeof businessNodes.value>(
        `/api/admin/sui-servers/${id}/business-nodes`,
      ),
    ]);
    if (version !== readVersion) return;
    businessNodes.value = linked;
    data.value = result;
    status.value = health;
    checkedAt.value = new Date().toLocaleTimeString("zh-CN");
  } catch (cause) {
    if (version === readVersion) error.value = message(cause);
  } finally {
    if (version === readVersion) loading.value = false;
  }
}
watch(resource, () => {
  search.value = "";
  if (selected.value) void refresh();
});
async function editResource(row?: Row) {
  if (row && ["clients", "inbounds"].includes(resource.value)) {
    busy.value = true;
    try {
      const full = await api<Row>(
        `/api/admin/sui-servers/${selected.value!.id}/resources/${resource.value}?id=${Number(row.id)}`,
      );
      row =
        (full[resource.value] as Row[])?.find(
          (item) => Number(item.id) === Number(row!.id),
        ) || row;
    } catch (cause) {
      ElMessage.error(message(cause));
      return;
    } finally {
      busy.value = false;
    }
  }
  editorAction.value = singleton.value
    ? resource.value === "settings"
      ? "set"
      : "edit"
    : row
      ? "edit"
      : "new";
  const templates: Record<string, Row> = {
    clients: {
      enable: true,
      name: "",
      remark: "",
      inbounds: [],
      volume: 0,
      expiry: 0,
      links: [],
      config: { vless: { uuid: crypto.randomUUID() } },
    },
    inbounds: {
      type: "vless",
      tag: "",
      listen: "::",
      listen_port: 443,
      tls_id: 0,
      addrs: [],
      out_json: {},
    },
    outbounds: { type: "direct", tag: "" },
    endpoints: {
      type: "wireguard",
      tag: "",
      system: false,
      mtu: 1408,
      address: [],
      private_key: "",
      peers: [],
    },
    services: { type: "derp", tag: "", listen: "::", listen_port: 443 },
    tls: {
      name: "",
      server: {
        enabled: true,
        server_name: "",
        certificate_path: "",
        key_path: "",
      },
      client: { enabled: true, server_name: "", insecure: false },
    },
  };
  const root = data.value as Row | null;
  editorOriginal.value = clonePanelValue(
    singleton.value
      ? (root?.[resource.value] ?? root ?? {})
      : row || templates[resource.value] || {},
  );
  editorRecord.value = decodePanelValue(editorOriginal.value);
  if (resource.value === "clients") {
    const record = row || templates.clients!;
    clientOriginal.value = record;
    clientFields.value = {
      name: String(record.name || ""),
      remark: String(record.remark || ""),
      enable: record.enable !== false,
      volumeGb: Number(record.volume || 0) / 1024 ** 3,
      expiry:
        Number(record.expiry) > 0
          ? new Date(Number(record.expiry) * 1000).toISOString().slice(0, 10)
          : "",
      inbounds: Array.isArray(record.inbounds)
        ? ([...record.inbounds] as number[])
        : [],
    };
    clientConfig.value = decodePanelValue(record.config || {});
    inboundChoices.value = [];
    busy.value = true;
    try {
      const result = await api<Row>(
        `/api/admin/sui-servers/${selected.value!.id}/resources/inbounds`,
      );
      inboundChoices.value = Array.isArray(result.inbounds)
        ? (result.inbounds as Row[])
        : [];
    } catch (cause) {
      ElMessage.error(message(cause));
      return;
    } finally {
      busy.value = false;
    }
  }
  if (resource.value === "inbounds" || resource.value === "services") {
    try {
      const result = await api<Row>(
        `/api/admin/sui-servers/${selected.value!.id}/resources/tls`,
      );
      certificateChoices.value = [
        { value: 0, label: "不使用证书" },
        ...((result.tls || []) as Row[]).map((row) => ({
          value: Number(row.id),
          label: String(row.name || row.id),
        })),
      ];
    } catch (cause) {
      ElMessage.error(message(cause));
      return;
    }
  }
  editorError.value = "";
  confirmSave.value = false;
  editor.value = true;
}
async function saveResource() {
  let body;
  try {
    let record = encodePanelValue(
      editorRecord.value,
      editorOriginal.value,
    ) as Row;
    if (resource.value === "clients") {
      const form = clientFields.value;
      const originalDate =
        Number(clientOriginal.value.expiry) > 0
          ? new Date(Number(clientOriginal.value.expiry) * 1000)
              .toISOString()
              .slice(0, 10)
          : "";
      record = {
        ...clientOriginal.value,
        name: form.name,
        remark: form.remark,
        enable: form.enable,
        volume: Math.round(form.volumeGb * 1024 ** 3),
        expiry:
          form.expiry === originalDate
            ? Number(clientOriginal.value.expiry || 0)
            : form.expiry
              ? Math.floor(new Date(form.expiry + "T23:59:59").getTime() / 1000)
              : 0,
        inbounds: form.inbounds,
        config: encodePanelValue(
          clientConfig.value,
          clientOriginal.value.config,
        ),
      };
    }
    body = suiSaveSchema.parse({
      object: resource.value,
      action: editorAction.value,
      data: record,
    });
  } catch {
    editorError.value = "请检查必填项、流量额度与到期时间。";
    return;
  }
  if (!confirmSave.value) {
    confirmSave.value = true;
    return;
  }
  busy.value = true;
  editorError.value = "";
  try {
    await api(`/api/admin/sui-servers/${selected.value!.id}/save`, {
      method: "POST",
      body,
    });
    editor.value = false;
    ElMessage.success("远端配置已保存");
    await refresh();
  } catch (cause) {
    editorError.value = message(cause);
    confirmSave.value = false;
  } finally {
    busy.value = false;
  }
}
async function deleteResource(row: Row) {
  try {
    await ElMessageBox.confirm(
      `将从远端永久删除「${title(row)}」，并可能中断其连接。`,
      "删除远端资源",
      { type: "warning", confirmButtonText: "删除", cancelButtonText: "取消" },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    await api(`/api/admin/sui-servers/${selected.value!.id}/save`, {
      method: "POST",
      body: { object: resource.value, action: "del", data: { id: row.id } },
    });
    ElMessage.success("资源已删除");
    await refresh();
  } catch (cause) {
    ElMessage.error(message(cause));
  } finally {
    busy.value = false;
  }
}
async function control(
  action: "restartSb" | "maintenance" | "closeSessions",
  user?: string,
) {
  const label =
    action === "restartSb"
      ? "重启 sing-box 核心"
      : action === "closeSessions"
        ? `断开 ${user} 的所有会话`
        : core.value?.maintenance
          ? "退出维护模式并启动核心"
          : "进入维护模式并停止核心";
  try {
    await ElMessageBox.confirm(
      `${label}？此操作可能中断用户连接。`,
      "运行控制",
      {
        type: "warning",
        confirmButtonText: "确认执行",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }
  busy.value = true;
  try {
    await api(`/api/admin/sui-servers/${selected.value!.id}/control`, {
      method: "POST",
      body: {
        action,
        ...(action === "maintenance"
          ? { enable: !core.value?.maintenance }
          : action === "closeSessions"
            ? { u: user }
            : {}),
      },
    });
    ElMessage.success("远端已接受操作，请刷新检查核心状态");
    await refresh();
  } catch (cause) {
    ElMessage.error(message(cause));
  } finally {
    busy.value = false;
  }
}
onMounted(loadServers);
</script>

<template>
  <div class="panel-hub">
    <header class="hub-heading">
      <div>
        <div class="eyebrow">INFRASTRUCTURE / SING-BOX</div>
        <h1>
          {{ selected ? selected.name : "S-UI 面板"
          }}<span class="soft-badge">S-UI</span>
        </h1>
        <p>
          {{
            selected
              ? "管理远端资源与核心状态，所有修改直接同步至面板。"
              : "连接 sing-box 面板，在一个工作区管理网络与客户端。"
          }}
        </p>
      </div>
      <div class="hub-actions">
        <button
          v-if="selected"
          class="hub-button"
          :disabled="busy"
          @click="back"
        >
          <ArrowLeft :size="16" />面板列表</button
        ><button
          class="hub-button"
          :disabled="loading || busy"
          @click="selected ? refresh() : loadServers()"
        >
          <RefreshCw :size="16" :class="{ spinning: loading }" />刷新</button
        ><button
          v-if="!selected"
          class="hub-button primary"
          @click="openConnection()"
        >
          <Plus :size="17" />接入面板
        </button>
      </div>
    </header>
    <div v-if="error" class="hub-alert error" role="alert">
      <CircleAlert :size="18" /><span>{{ error }}</span
      ><button class="hub-button" @click="selected ? refresh() : loadServers()">
        重试
      </button>
    </div>
    <template v-if="!selected">
      <div class="hub-summary">
        <article>
          <span>已接入面板</span
          ><strong>{{ servers.length }}<small>个</small></strong
          ><Server :size="24" />
        </article>
        <article>
          <span>已启用连接</span
          ><strong
            >{{ servers.filter((s) => s.enabled).length
            }}<small>个</small></strong
          ><Check :size="24" />
        </article>
        <article>
          <span>核心引擎</span><strong>sing-box</strong><Network :size="24" />
        </article>
      </div>
      <section class="hub-card">
        <div class="hub-toolbar">
          <h2>
            面板连接 <span class="count-badge">{{ servers.length }}</span>
          </h2>
          <label class="hub-search"
            ><Search :size="16" /><input
              v-model="search"
              aria-label="搜索 S-UI 面板"
              placeholder="搜索名称或地址…"
          /></label>
        </div>
        <div v-if="loading" class="hub-empty" role="status">
          <RefreshCw class="spinning" :size="26" />
          <p>正在读取面板连接…</p>
        </div>
        <div v-else-if="!servers.length && !error" class="hub-empty">
          <div class="empty-icon"><Server :size="30" /></div>
          <h3>接入你的第一个 S-UI 面板</h3>
          <p>准备面板访问地址和 访问令牌，即可开始管理。</p>
          <button class="hub-button primary" @click="openConnection()">
            <Plus :size="16" />接入面板</button
          ><span class="empty-note">支持自定义路径 · 凭据加密存储</span>
        </div>
        <div v-else class="hub-table-wrap">
          <table class="hub-table hub-connections">
            <thead>
              <tr>
                <th>面板</th>
                <th>访问地址</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="server in filteredServers" :key="server.id">
                <td>
                  <div class="hub-entity">
                    <span class="hub-avatar"><Server :size="20" /></span>
                    <div>
                      <strong>{{ server.name }}</strong
                      ><small>{{ server.remark || "sing-box 管理面板" }}</small>
                    </div>
                  </div>
                </td>
                <td class="mono">{{ server.baseUrl }}</td>
                <td>
                  <span class="status-pill" :class="{ off: !server.enabled }"
                    ><i></i>{{ server.enabled ? "已启用" : "已停用" }}</span
                  >
                </td>
                <td>
                  <div class="hub-actions">
                    <button
                      class="hub-link"
                      :disabled="busy"
                      @click="testConnection(server)"
                    >
                      测试连接</button
                    ><button
                      class="hub-link"
                      :disabled="!server.enabled || busy"
                      @click="enter(server)"
                    >
                      管理 <ChevronRight :size="14" /></button
                    ><button
                      class="icon-button"
                      :disabled="busy"
                      :aria-label="`编辑 ${server.name}`"
                      @click="openConnection(server)"
                    >
                      <Edit3 :size="16" /></button
                    ><button
                      class="icon-button danger"
                      :disabled="busy"
                      :aria-label="`移除 ${server.name}`"
                      @click="removeConnection(server)"
                    >
                      <Trash2 :size="16" />
                    </button>
                  </div>
                </td>
              </tr>
              <tr v-if="!filteredServers.length">
                <td colspan="4" class="table-empty">没有匹配的面板</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
      <aside class="hub-guide">
        <ShieldCheck :size="22" />
        <div>
          <strong>连接前，准备好这两项</strong>
          <p>
            在 S-UI「管理」页面生成 访问令牌；复制包含面板路径的完整地址，例如
            https://panel.example.com:2095/app/。
          </p>
          <a
            href="https://github.com/alireza0/s-ui/wiki/API-Documentation"
            target="_blank"
            rel="noreferrer"
            >查看官方接入文档 <ArrowUpRight :size="13"
          /></a>
        </div>
        <span class="soft-badge">API v2</span>
      </aside>
    </template>
    <template v-else>
      <div class="hub-summary">
        <article>
          <span>sing-box 核心</span
          ><strong>{{
            status
              ? core?.maintenance
                ? "维护中"
                : core?.running
                  ? "运行中"
                  : "已停止"
              : "—"
          }}</strong
          ><Activity :size="24" />
        </article>
        <article>
          <span>CPU 使用率</span><strong>{{ cpu }}</strong
          ><Server :size="24" />
        </article>
        <article>
          <span>最近读取</span><strong>{{ checkedAt || "—" }}</strong
          ><RefreshCw :size="24" />
        </article>
      </div>
      <section class="hub-card">
        <div class="hub-resource-nav" role="tablist" aria-label="面板资源">
          <button
            v-for="item in resources"
            :key="item.id"
            role="tab"
            :aria-selected="resource === item.id"
            :disabled="busy"
            :class="{ active: resource === item.id }"
            @click="resource = item.id"
          >
            <component :is="item.icon" :size="15" />{{ item.label }}
          </button>
        </div>
        <div class="hub-toolbar">
          <h2>
            {{ resourceLabel
            }}<span v-if="rows.length" class="count-badge">{{
              rows.length
            }}</span>
          </h2>
          <div class="hub-actions">
            <label v-if="rows.length" class="hub-search"
              ><Search :size="16" /><input
                v-model="search"
                aria-label="搜索远端资源"
                placeholder="搜索资源…" /></label
            ><button
              v-if="writable"
              class="hub-button primary"
              :disabled="loading || busy || !!error"
              @click="editResource()"
            >
              <component :is="singleton ? Edit3 : Plus" :size="16" />{{
                singleton ? "编辑配置" : "新建" + resourceLabel
              }}
            </button>
          </div>
        </div>
        <div v-if="loading" class="hub-empty" role="status">
          <RefreshCw class="spinning" :size="24" />
          <p>正在读取远端资源…</p>
        </div>
        <div
          v-else-if="
            rows.length && !['logs', 'changes', 'stats'].includes(resource)
          "
          class="hub-table-wrap"
        >
          <table class="hub-table">
            <thead>
              <tr>
                <th>名称 / 标识</th>
                <template v-if="resource === 'clients'"
                  ><th>状态</th>
                  <th>已用 / 配额</th>
                  <th>到期日</th></template
                ><template v-else
                  ><th>类型</th>
                  <th>详情</th></template
                >
                <th v-if="writable || resource === 'sessions'">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, index) in filtered"
                :key="String(row.id ?? index)"
              >
                <td>
                  <div class="hub-entity">
                    <span class="hub-avatar"
                      ><component
                        :is="resource === 'clients' ? Users : Network"
                        :size="17"
                    /></span>
                    <div>
                      <strong>{{ title(row) }}</strong
                      ><small>{{ row.name || row.tag || row.id }}</small>
                    </div>
                  </div>
                </td>
                <template v-if="resource === 'clients'"
                  ><td>
                    <span class="status-pill" :class="{ off: !row.enable }"
                      ><i></i>{{ row.enable ? "启用" : "停用" }}</span
                    >
                  </td>
                  <td class="mono">
                    {{ bytes(Number(row.up || 0) + Number(row.down || 0)) }} /
                    {{ Number(row.volume) ? bytes(row.volume) : "不限量" }}
                  </td>
                  <td>{{ expiry(row) }}</td></template
                ><template v-else
                  ><td>{{ row.type || row.network || "—" }}</td>
                  <td class="resource-detail mono">
                    {{
                      row.listen_port ||
                      row.destination ||
                      row.msg ||
                      row.action ||
                      row.tag ||
                      "—"
                    }}
                  </td></template
                >
                <td v-if="writable">
                  <div class="hub-actions">
                    <router-link
                      v-if="
                        resource === 'clients' &&
                        businessNodes.some(
                          (node) => node.config?.suiClientId === row.id,
                        )
                      "
                      class="hub-link"
                      to="/nodes"
                      >已接入业务</router-link
                    ><button
                      v-else-if="resource === 'clients'"
                      class="hub-link"
                      :disabled="busy"
                      @click="linkClient = row"
                    >
                      接入业务</button
                    ><button
                      class="hub-link"
                      :disabled="busy"
                      @click="editResource(row)"
                    >
                      编辑</button
                    ><button
                      class="hub-link danger"
                      :disabled="busy"
                      @click="deleteResource(row)"
                    >
                      删除
                    </button>
                  </div>
                </td>
                <td v-else-if="resource === 'sessions'">
                  <button
                    class="hub-link danger"
                    :disabled="busy || !row.user"
                    @click="control('closeSessions', String(row.user))"
                  >
                    断开该用户
                  </button>
                </td>
              </tr>
              <tr v-if="!filtered.length">
                <td colspan="5" class="table-empty">没有匹配的资源</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div
          v-else-if="
            singleton ||
            ['logs', 'changes', 'stats'].includes(resource) ||
            (data &&
              !Array.isArray(data) &&
              !Array.isArray((data as Row)[resource]))
          "
          class="hub-resource-detail"
        >
          <PanelFields :model-value="decodePanelValue(data)" readonly />
        </div>
        <div v-else class="hub-empty">
          <Layers :size="30" />
          <h3>{{ error ? "资源读取失败" : "暂无" + resourceLabel }}</h3>
          <p>
            {{
              error
                ? "请检查连接后刷新重试。"
                : "远端尚未返回资源，创建后可在此管理。"
            }}
          </p>
        </div>
        <footer class="hub-table-footer">
          <span>数据来自 {{ selected.name }} · 接入业务后可绑定用户并续费</span
          ><span v-if="checkedAt">更新于 {{ checkedAt }}</span>
        </footer>
      </section>
      <section class="hub-control">
        <div>
          <h2>核心运行控制</h2>
          <p>操作将直接发送到远端面板，可能影响在线连接。</p>
        </div>
        <div class="hub-actions">
          <button
            class="hub-button"
            :disabled="busy || !status"
            @click="control('restartSb')"
          >
            重启核心</button
          ><button
            class="hub-button"
            :disabled="busy || !status"
            @click="control('maintenance')"
          >
            {{ core?.maintenance ? "退出维护" : "进入维护" }}
          </button>
        </div>
      </section>
    </template>

    <SuiBusinessLink
      v-if="linkClient && selected"
      :client="linkClient"
      :server-id="selected.id"
      @close="linkClient = null"
      @linked="refresh"
    />
    <dialog
      v-if="connectionDialog || editor"
      ref="dialogElement"
      class="hub-overlay"
      @click.self="!busy && ((connectionDialog = false), (editor = false))"
      @cancel.prevent="!busy && ((connectionDialog = false), (editor = false))"
    >
      <section
        class="hub-dialog"
        :class="{ wide: editor }"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sui-dialog-title"
      >
        <header>
          <div>
            <div class="eyebrow">S-UI WORKSPACE</div>
            <h2 id="sui-dialog-title">
              {{
                connectionDialog
                  ? editingId
                    ? "编辑面板连接"
                    : "接入 S-UI 面板"
                  : (editorAction === "new" ? "新建" : "编辑") + resourceLabel
              }}
            </h2>
          </div>
          <button
            class="icon-button"
            aria-label="关闭对话框"
            :disabled="busy"
            @click="
              connectionDialog = false;
              editor = false;
            "
          >
            <X :size="20" />
          </button>
        </header>
        <form
          v-if="connectionDialog"
          class="hub-form"
          @submit.prevent="saveConnection"
        >
          <label
            >面板名称<input
              v-model="connection.name"
              autofocus
              required
              maxlength="120"
              placeholder="例如：香港 · 主节点"
          /></label>
          <label
            >面板地址<input
              v-model="connection.baseUrl"
              required
              type="url"
              placeholder="https://panel.example.com:2095/app/"
            /><small>包含端口与面板路径，无需填写 /apiv2。</small></label
          >
          <label
            >访问令牌<input
              v-model="connection.token"
              type="text"
              autocomplete="new-password"
              :required="!editingId"
              :placeholder="
                editingId
                  ? '留空保留已保存的 Token'
                  : '输入在 S-UI 管理页面生成的 Token'
              "
            /><small>加密存储，保存后不再返回浏览器。</small></label
          >
          <label
            >备注<input
              v-model="connection.remark"
              maxlength="2000"
              placeholder="可选，用于识别用途或区域"
          /></label>
          <label class="hub-checkbox"
            ><input
              v-model="connection.enabled"
              type="checkbox"
            />启用面板连接</label
          >
          <p v-if="editorError" class="form-error" role="alert">
            {{ editorError }}
          </p>
          <footer>
            <button
              type="button"
              class="hub-button"
              :disabled="busy"
              @click="connectionDialog = false"
            >
              取消</button
            ><button class="hub-button primary" :disabled="busy">
              {{ busy ? "保存中…" : "保存连接" }}
            </button>
          </footer>
        </form>
        <form v-else class="hub-form" @submit.prevent="saveResource">
          <template v-if="resource === 'clients'">
            <div class="hub-form-grid">
              <label
                >客户端标识<input
                  v-model="clientFields.name"
                  required
                  maxlength="160"
                  :readonly="editorAction === 'edit'"
                  placeholder="唯一的订阅标识，例如 alice"
                /><small>创建后保持不变，避免已有订阅失效。</small></label
              ><label
                >显示名称<input
                  v-model="clientFields.remark"
                  maxlength="160"
                  placeholder="用户可见的名称" /></label
              ><label
                >流量配额（GB）<input
                  v-model.number="clientFields.volumeGb"
                  type="number"
                  min="0"
                  step="any"
                  required
                /><small>0 表示不限量</small></label
              ><label
                >到期日期<input
                  v-model="clientFields.expiry"
                  type="date"
                /><small>留空表示不限期</small></label
              >
            </div>
            <fieldset class="panel-choice-list">
              <legend>授权入站</legend>
              <label
                v-for="inbound in inboundChoices"
                :key="Number(inbound.id)"
                class="hub-checkbox"
                ><input
                  v-model="clientFields.inbounds"
                  type="checkbox"
                  :value="Number(inbound.id)"
                />{{ inbound.tag }} · {{ inbound.type }}</label
              >
              <small v-if="!inboundChoices.length"
                >面板暂无入站，请先创建入站。</small
              >
            </fieldset>
            <label class="hub-checkbox"
              ><input
                v-model="clientFields.enable"
                type="checkbox"
              />启用客户端</label
            >
            <section class="panel-credential-section">
              <h3>连接凭据</h3>
              <p class="muted-text">
                新客户端已生成凭据；编辑时会保留原有凭据。
              </p>
              <PanelFields v-model="clientConfig" :disabled="busy" />
            </section>
          </template>
          <PanelFields
            v-else
            v-model="editorRecord"
            :schema="editorSchema"
            :disabled="busy"
            :choices="{ tls_id: certificateChoices }"
            :presets="{
              rules: {
                domain_suffix: [],
                ip_cidr: [],
                inbound: [],
                outbound: '',
              },
            }"
          />
          <p v-if="editorError" class="form-error" role="alert">
            {{ editorError }}
          </p>
          <div v-if="confirmSave" class="hub-alert" role="alert">
            <CircleAlert :size="18" /><span
              >即将修改远端配置，可能触发核心重启并中断连接。确认后再次点击保存。</span
            >
          </div>
          <footer>
            <button
              type="button"
              class="hub-button"
              :disabled="busy"
              @click="editor = false"
            >
              取消</button
            ><button class="hub-button primary" :disabled="busy">
              {{
                busy ? "保存中…" : confirmSave ? "确认保存至远端" : "保存到远端"
              }}
            </button>
          </footer>
        </form>
      </section>
    </dialog>
  </div>
</template>
