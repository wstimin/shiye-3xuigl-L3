<script setup lang="ts">
import { randomUuid } from '@shiye/shared';
import SuiBusinessLink from "../components/SuiBusinessLink.vue";
import PanelFields from "../components/PanelFields.vue";
import PanelDetails from '../components/PanelDetails.vue';
import PanelConfig from '../components/PanelConfig.vue';
import { suiRouteRule, suiRouteSchema, suiTagChoices } from "../sui-panel";
import {
  clonePanelValue,
  decodePanelValue,
  encodePanelValue,
  fieldLabel,
  type FieldSchema,
} from "../panel-fields";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useRoute } from 'vue-router';
const props = defineProps<{ createServerId?: string; networkOnly?: boolean; networkResource?: 'outbounds' | 'config' }>();
const createProtocol = ref('');
watch(createProtocol, value => { if (value) editorRecord.value = { ...(editorRecord.value as Row), type: value }; });
const emit = defineEmits<{ saved: []; close: []; busy: [value: boolean]; protocolSelected: [value: boolean] }>();
watch(createProtocol, value => emit('protocolSelected', Boolean(value)), { immediate: true });
const route = useRoute();
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
watch(() => props.networkResource, value => { if (props.networkOnly && value) resource.value = value; });
const syncingId = ref('');
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
const networkOutbounds = ref<Row[]>([]);
const networkInbounds = ref<Row[]>([]);
const routingChoices = computed(() => ({
  inbound: suiTagChoices(networkInbounds.value),
  outbound: [{ value: '', label: '请选择目标出站' }, ...suiTagChoices(networkOutbounds.value)],
  final: [{ value: '', label: '自动选择默认出站' }, ...suiTagChoices(networkOutbounds.value)],
}));
const outboundChoices = computed(() => ({
  detour: [{ value: '', label: '不使用其他出站' }, ...suiTagChoices(networkOutbounds.value)],
  outbounds: suiTagChoices(networkOutbounds.value),
  default: [{ value: '', label: '自动选择' }, ...suiTagChoices(networkOutbounds.value)],
}));
const routeDraft = computed({
  get: () => (editorRecord.value as Row)?.route || {},
  set: (route: unknown) => { editorRecord.value = { ...(editorRecord.value as Row), route }; },
});
const otherConfig = computed({
  get: () => Object.fromEntries(Object.entries((editorRecord.value || {}) as Row).filter(([key]) => key !== 'route')),
  set: (rest: unknown) => { editorRecord.value = { ...(rest as Row), ...('route' in (editorRecord.value as Row) ? { route: (editorRecord.value as Row).route } : {}) }; },
});
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
            "anytls",
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
            "anytls",
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
              name: "",
              uuid: randomUuid(),
              ...(protocol === "tuic" ? { password: randomUuid() } : {}),
            }
          : {
              ...(["socks", "http", "mixed"].includes(protocol)
                ? { username: "" }
                : { name: "" }),
              password: randomUuid(),
            };
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
    if (open && !props.createServerId) dialogElement.value?.showModal();
    if (!open && props.createServerId) emit('close');
  },
);
watch(busy, value => emit('busy', value));
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
const networkRoute = computed(() => ((data.value as Row)?.config as Row)?.route as Row | undefined);
const networkRules = computed(() => Array.isArray(networkRoute.value?.rules) ? networkRoute.value.rules as Row[] : []);
function routeConditions(rule: Row) {
  return Object.entries(rule).filter(([key]) => !['action', 'outbound', 'inbound'].includes(key)).map(([key, value]) =>
    `${fieldLabel(key)}：${Array.isArray(value) ? value.every(item => typeof item !== 'object') ? value.join('、') : '组合条件' : typeof value === 'object' ? '组合条件' : String(value)}`
  ).join('；') || '全部流量';
}
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
  resource.value = props.networkOnly ? props.networkResource || 'outbounds' : 'clients';
  search.value = "";
  status.value = null;
  checkedAt.value = "";
  void refresh();
}
async function syncPanel(server: ServerConnection) {
  busy.value = true;
  syncingId.value = server.id;
  try {
    const result = await api<{ synced: boolean; results: { synced: boolean; error?: string }[] }>(`/api/admin/sui-servers/${server.id}/sync`, { method: 'POST' });
    const counts = await Promise.all(['inbounds', 'clients', 'outbounds'].map(async key => {
      const response = await api<Record<string, Row[]>>(`/api/admin/sui-servers/${server.id}/resources/${key}`);
      if (!Array.isArray(response[key])) throw new Error('远端资源读取失败，请刷新重试');
      return response[key].length;
    }));
    if (selected.value?.id === server.id) await refresh();
    if (!result.synced) ElMessage.warning(result.results.filter(item => !item.synced).map(item => item.error || '同步失败').join('；'));
    else if (!error.value) ElMessage.success(`已读取 ${counts[0]} 个入站、${counts[1]} 个客户端、${counts[2]} 个出站；同步 ${result.results.length} 个业务客户端`);
  } catch (cause) { ElMessage.error(message(cause)); }
  finally { busy.value = false; syncingId.value = ''; }
}
function selectNetworkPanel(event: Event) {
  const panel = servers.value.find(item => item.id === (event.target as HTMLSelectElement).value);
  if (panel) enter(panel);
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
      config: { vless: { name: "", uuid: randomUuid() } },
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
      if (props.createServerId) error.value = message(cause);
      ElMessage.error(message(cause));
      return;
    }
  }
  if (["config", "outbounds", "endpoints"].includes(resource.value)) {
    busy.value = true;
    try {
      const root = `/api/admin/sui-servers/${selected.value!.id}/resources/`;
      const [inbounds, outbounds, endpoints] = await Promise.all([
        api<Row>(root + 'inbounds'), api<Row>(root + 'outbounds'), api<Row>(root + 'endpoints'),
      ]);
      networkInbounds.value = (inbounds.inbounds || []) as Row[];
      networkOutbounds.value = [...((outbounds.outbounds || []) as Row[]), ...((endpoints.endpoints || []) as Row[])];
      if (resource.value !== 'config') networkOutbounds.value = networkOutbounds.value.filter(item => item.tag !== (editorRecord.value as Row).tag);
    } catch (cause) {
      ElMessage.error(message(cause));
      return;
    } finally {
      busy.value = false;
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
    ElMessage.success("远端配置已保存");
    if (!props.createServerId) {
      editor.value = false;
      await refresh();
    }
  } catch (cause) {
    editorError.value = message(cause);
    confirmSave.value = false;
  } finally {
    busy.value = false;
  }
  if (props.createServerId && !editorError.value) emit('saved');
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
onMounted(async () => {
  await loadServers();
  const panel = servers.value.find(item => item.id === (props.createServerId || route.query.serverId)) || (props.networkOnly ? servers.value.find(item => item.enabled) : undefined);
  if (!panel) {
    if (props.createServerId && !error.value) error.value = '未找到所选面板，请关闭后重新选择。';
    return;
  }
  resource.value = props.createServerId ? 'inbounds' : props.networkOnly ? props.networkResource || 'outbounds' : resources.some(item => item.id === route.query.resource) ? String(route.query.resource) : 'clients';
  await nextTick();
  selected.value = panel;
  await refresh();
  if (error.value) return;
  if ((props.createServerId || route.query.create === '1') && writable.value) await editResource();
  else if (route.query.inboundId && resource.value === 'inbounds') {
    const row = rows.value.find(item => Number(item.id) === Number(route.query.inboundId));
    if (row) await editResource(row);
  }
});
</script>

<template>
  <div class="panel-hub" :class="{ 'inbound-create-inline': createServerId }">
    <template v-if="!createServerId">
    <header v-if="!networkOnly" class="hub-heading">
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
        <button v-if="selected" class="hub-button" :disabled="busy || loading || !selected.enabled" @click="syncPanel(selected)"><RefreshCw :size="16" :class="{ spinning: syncingId === selected.id }" />同步面板</button>
        <router-link v-if="route.query.from === 'services'" class="hub-button" to="/nodes"><ArrowLeft :size="16" />返回服务入站</router-link>
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
    <div v-else class="sui-network-toolbar">
      <label>S-UI 面板<select aria-label="选择 S-UI 面板" :value="selected?.id || ''" :disabled="busy || loading" @change="selectNetworkPanel"><option value="" disabled>请选择面板</option><option v-for="server in servers" :key="server.id" :value="server.id" :disabled="!server.enabled">{{ server.name }}</option></select></label>
      <span v-if="checkedAt" class="muted-text">最近读取 {{ checkedAt }}</span>
      <div class="hub-actions"><button class="hub-button" :disabled="busy || loading" @click="selected ? refresh() : loadServers()"><RefreshCw :size="16" :class="{ spinning: loading }" />刷新资源</button><button v-if="selected" class="hub-button" :disabled="busy || loading || !selected.enabled" @click="syncPanel(selected)"><RefreshCw :size="16" :class="{ spinning: syncingId === selected.id }" />同步面板</button></div>
    </div>
    <div v-if="error" class="hub-alert error" role="alert">
      <CircleAlert :size="18" /><span>{{ error }}</span
      ><button class="hub-button" @click="selected ? refresh() : loadServers()">
        重试
      </button>
    </div>
    <template v-if="!selected">
      <div v-if="!networkOnly" class="hub-summary">
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
          <table class="hub-table hub-connections resource-table" aria-label="S-UI 面板连接列表">
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
                      :disabled="!server.enabled || busy"
                      @click="syncPanel(server)"
                    ><RefreshCw :size="14" :class="{ spinning: syncingId === server.id }" />同步面板</button>
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
      <aside v-if="!networkOnly" class="hub-guide">
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
      <div v-if="!networkOnly" class="hub-summary">
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
        <div v-if="!networkOnly" class="hub-resource-nav" role="tablist" aria-label="面板资源">
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
            <router-link v-if="resource === 'outbounds'" class="hub-button" to="/network-config?provider=sui&tab=library">SOCKS 模板</router-link>
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
          <table class="hub-table" :class="{ 'resource-table': networkOnly }">
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
        <div v-else-if="networkOnly && resource === 'config'" class="hub-table-wrap">
          <table class="hub-table resource-table" aria-label="S-UI 路由列表">
            <thead><tr><th>规则 / 顺序</th><th>关联入站</th><th>匹配条件</th><th>目标出站</th><th>操作</th></tr></thead>
            <tbody><tr v-for="(rule, index) in networkRules" :key="index"><td>规则 {{ index + 1 }}<small class="resource-note">{{ ({ route: '转发', reject: '拒绝', sniff: '流量识别', resolve: '解析地址', 'hijack-dns': 'DNS 处理' } as Record<string, string>)[String(rule.action)] || '转发' }}</small></td><td>{{ Array.isArray(rule.inbound) && rule.inbound.length ? rule.inbound.join('、') : '全部入站' }}</td><td>{{ routeConditions(rule) }}</td><td>{{ rule.outbound || '按规则处理' }}</td><td><button class="hub-link" @click="editResource()">编辑</button></td></tr><tr v-if="!networkRules.length"><td colspan="5" class="table-empty">暂无路由规则，可在编辑配置中添加。</td></tr></tbody>
            <tfoot><tr><td colspan="5">默认出站：{{ networkRoute?.final || '自动选择' }}</td></tr></tfoot>
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
          <PanelConfig v-if="resource === 'config'" :model-value="decodePanelValue((data as Row)?.config ?? data)" mode="core" readonly />
          <PanelDetails v-else :model-value="decodePanelValue(data)" />
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
          <span>数据来自 {{ selected.name }} · {{ networkOnly ? '出站与路由保存后直接写入当前面板' : '接入业务后可绑定用户并续费' }}</span
          ><span v-if="checkedAt">更新于 {{ checkedAt }}</span>
        </footer>
      </section>
      <section v-if="!networkOnly" class="hub-control">
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
    </template>
    <div v-if="createServerId && error" class="hub-alert error" role="alert">{{ error }}</div>
    <div v-if="createServerId && !editor && !error" class="hub-empty" role="status">正在准备入站表单…</div>
    <component
      :is="createServerId ? 'div' : 'dialog'"
      v-if="connectionDialog || editor"
      ref="dialogElement"
      :class="createServerId ? 'inbound-create-content' : 'hub-overlay'"
      @click.self="!createServerId && !busy && ((connectionDialog = false), (editor = false))"
      @cancel.prevent="!busy && ((connectionDialog = false), (editor = false))"
    >
      <section
        :class="[createServerId ? 'inbound-create-form' : 'hub-dialog', { wide: editor }]"
        :role="createServerId ? undefined : 'dialog'"
        :aria-modal="createServerId ? undefined : true"
        :aria-labelledby="createServerId ? undefined : 'sui-dialog-title'"
      >
        <header v-if="!createServerId">
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
        <label v-if="createServerId && editor" class="hub-form" style="margin-bottom: 20px">入站协议<select v-model="createProtocol" aria-label="新建入站协议" :disabled="busy"><option value="" disabled>请选择协议</option><option v-for="protocol in editorSchema.properties?.type?.enum" :key="String(protocol)" :value="String(protocol)">{{ String(protocol).toLowerCase() }}</option></select></label>
        <form v-if="!connectionDialog && (!createServerId || createProtocol)" class="hub-form" @submit.prevent="saveResource">
          <template v-if="resource === 'clients'">
            <div class="hub-form-grid">
              <label
                >客户端用户名<input
                  v-model="clientFields.name"
                  required
                  maxlength="160"
                  placeholder="唯一的订阅标识，例如 alice"
                /><small>可以自定义用户名；修改后系统会同步用户绑定，订阅地址也会更新，请重新复制。</small></label
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
          <template v-else-if="resource === 'config'">
            <section class="panel-credential-section">
              <h3>入站与出站关联</h3>
              <p class="muted-text">按名称选择入站和目标出站。规则按列表顺序匹配；默认出站用于未匹配规则的流量。已有规则会完整保留。</p>
              <PanelFields v-model="routeDraft" :schema="suiRouteSchema" :choices="routingChoices" :presets="{ rules: suiRouteRule }" :disabled="busy" />
            </section>
            <details class="panel-credential-section">
              <summary>DNS 与其他核心设置</summary>
              <PanelConfig v-model="otherConfig" mode="core" :disabled="busy" />
            </details>
          </template>
          <PanelFields
            v-else
            v-model="editorRecord"
            :omit="createServerId ? ['type'] : []"
            :schema="editorSchema"
            :disabled="busy"
            :choices="{ tls_id: certificateChoices, ...outboundChoices }"
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
          <p v-if="resource === 'inbounds' && (editorRecord as Row).type === 'anytls'" class="muted-text">anytls 需要 TLS，请选择已配置的证书；客户端使用密码认证。</p>
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
    </component>
  </div>
</template>
