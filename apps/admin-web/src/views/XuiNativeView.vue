<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import {
  ArrowLeft,
  Download,
  RefreshCw,
  Search,
  Settings2,
} from "lucide-vue-next";
import { ElMessage, ElMessageBox } from "element-plus";
import PanelFields from "../components/PanelFields.vue";
import { api } from "../api";
import {
  clonePanelValue,
  emptyPanelItem,
  decodePanelValue,
  encodePanelValue,
  type FieldSchema,
  type PanelRecord,
} from "../panel-fields";
import {
  operationLabel,
  operationSection,
  operationTemplate,
  panelSections,
  unwrapPanelResult,
  visibleOperation,
  xuiClientFormValue,
  type PanelOperation,
} from "../xui-panel";

type Panel = { id: string; name: string };
const route = useRoute();
const panels = ref<Panel[]>([]);
const serverId = ref(String(route.query.serverId || ""));
const catalog = ref<PanelOperation[]>([]);
const section = ref("overview");
const selected = ref("");
const search = ref("");
const loading = ref(false);
const running = ref(false);
const error = ref("");
const draft = ref<unknown>({});
const original = ref<unknown>({});
const parameters = ref<PanelRecord>({});
const data = ref<unknown>(null);
const detail = ref<unknown>(null);
const inboundChoices = ref<{ value: number; label: string }[]>([]);
const file = ref<{
  field: string;
  name: string;
  type: string;
  base64: string;
}>();
const prepared = ref(false);
const completed = ref(false);
const editTarget = ref(false);
let revision = 0;
const operation = computed(() =>
  catalog.value.find((item) => item.id === selected.value),
);
const actions = computed(() =>
  catalog.value.filter(
    (item) =>
      visibleOperation(item) && operationSection(item) === section.value,
  ),
);
const tabs = computed(() =>
  panelSections.filter((item) =>
    catalog.value.some((operation) => operationSection(operation) === item.id),
  ),
);
const title = computed(
  () =>
    panelSections.find((item) => item.id === section.value)?.label ||
    "面板管理",
);
const rows = computed<PanelRecord[]>(() => {
  let value = data.value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as PanelRecord;
    value =
      record.items ||
      record.clients ||
      record.inbounds ||
      record.nodes ||
      record.hosts ||
      value;
  }
  return Array.isArray(value)
    ? (value.filter(
        (item) => item && typeof item === "object",
      ) as PanelRecord[])
    : [];
});
const filteredRows = computed(() =>
  rows.value.filter((row) =>
    JSON.stringify(row).toLowerCase().includes(search.value.toLowerCase()),
  ),
);
const parameterSchema = computed<FieldSchema>(() => ({
  type: "object",
  properties: Object.fromEntries(
    (operation.value?.parameters || []).map((field) => {
      const schema = { ...field.schema };
      if (field.name === "bucket") schema.enum = [2, 30, 60, 120, 180, 300];
      if (field.name === "metric")
        schema.enum = operation.value?.path.includes("xrayMetrics")
          ? ["xrAlloc", "xrSys", "xrHeapObjects", "xrNumGC", "xrPauseNs"]
          : [
              "cpu",
              "mem",
              "netUp",
              "netDown",
              "online",
              "load1",
              "load5",
              "load15",
            ];
      if (field.name === "action")
        schema.enum = operation.value?.path.includes("/warp/")
          ? [
              "data",
              "config",
              "reg",
              "regMasque",
              "changeIp",
              "license",
              "interval",
              "del",
            ]
          : operation.value?.path.includes("/nord/")
            ? ["countries", "servers", "reg", "setKey", "data", "del"]
            : ["countries", "servers", "reg", "data", "del", "addKey"];
      return [field.name, schema];
    }),
  ),
  required: operation.value?.parameters
    .filter((field) => field.required)
    .map((field) => field.name),
}));
const choices = computed(() => {
  const resources = rows.value.map((row) => ({
    value: (row.id || row.groupId || row.email) as string | number,
    label: rowTitle(row),
  }));
  return {
    id: resources,
    ids: resources,
    email: rows.value.map((row) => ({
      value: String(row.email || ""),
      label: rowTitle(row),
    })),
    inboundId: inboundChoices.value,
    inboundIds: inboundChoices.value,
    childId: inboundChoices.value,
  };
});
const download = computed(
  () =>
    (
      data.value as {
        download?: { base64: string; name: string; type: string };
      } | null
    )?.download,
);
const binaryField = computed(
  () =>
    Object.entries(operation.value?.schema.properties || {}).find(
      ([, field]) => field.format === "binary",
    )?.[0],
);
const bodySchema = computed<FieldSchema>(() => {
  const schema = operation.value?.schema || {};
  if (Array.isArray(draft.value))
    return {
      type: "array",
      items: {
        type: "object",
        default: emptyPanelItem(
          (operation.value?.example as unknown[] | undefined)?.[0] ||
            draft.value[0] ||
            {},
        ),
      },
    };
  const properties = Object.fromEntries(
    Object.entries(schema.properties || {}).filter(
      ([, field]) => field.format !== "binary",
    ),
  );
  if (/\/inbounds\/(add|update)/.test(operation.value?.path || ""))
    properties.protocol = {
      enum: [
        "vless",
        "vmess",
        "trojan",
        "shadowsocks",
        "socks",
        "http",
        "wireguard",
        "hysteria",
      ],
    };
  return { ...schema, properties };
});
const editing = computed(() =>
  Boolean(
    operation.value?.mutates ||
      operation.value?.parameters.length ||
      operation.value?.encoding,
  ),
);
function rowTitle(row: PanelRecord) {
  return String(
    row.remark ||
      row.email ||
      row.name ||
      row.tag ||
      row.groupId ||
      row.id ||
      "未命名",
  );
}
function rowEnabled(row: PanelRecord) {
  return (
    row.enable ??
    row.enabled ??
    (row.isDisabled === undefined ? undefined : !row.isDisabled)
  );
}
function findOperation(id: string) {
  return catalog.value.find((item) => item.id === id);
}
async function request(
  item: PanelOperation,
  values: PanelRecord = {},
  body?: unknown,
  confirmed = false,
) {
  return api<unknown>(
    `/api/admin/xui-servers/${serverId.value}/native/execute`,
    {
      method: "POST",
      body: {
        operation: item.id,
        parameters: values,
        body,
        confirmed,
        file: file.value,
      },
    },
  );
}
async function readOperation(id: string, values: PanelRecord = {}) {
  const item = findOperation(id);
  if (!item) throw new Error("当前面板版本尚不支持这项操作");
  return unwrapPanelResult(await request(item, values));
}
async function loadCatalog() {
  const version = ++revision;
  catalog.value = [];
  selected.value = "";
  data.value = null;
  detail.value = null;
  file.value = undefined;
  if (!serverId.value) return;
  loading.value = true;
  error.value = "";
  try {
    const result = await api<{ operations: PanelOperation[] }>(
      `/api/admin/xui-servers/${serverId.value}/native/catalog`,
    );
    if (version !== revision) return;
    catalog.value = result.operations;
    section.value = "overview";
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取面板失败";
  } finally {
    if (version === revision) loading.value = false;
  }
  if (version === revision && catalog.value.length)
    await openSection("overview");
}
watch(serverId, loadCatalog);
async function openSection(id: string) {
  section.value = id;
  search.value = "";
  detail.value = null;
  data.value = null;
  selected.value = "";
  const home = panelSections.find((item) => item.id === id)?.home;
  const item = home ? findOperation(home) : undefined;
  if (item) await choose(item);
}
async function choose(item: PanelOperation, row?: PanelRecord) {
  if (loading.value || running.value) return;
  selected.value = item.id;
  error.value = "";
  detail.value = null;
  file.value = undefined;
  prepared.value = false;
  completed.value = false;
  editTarget.value = false;
  parameters.value = Object.fromEntries(
    item.parameters.map((field) => [
      field.name,
      field.name === "count" ? 100 : (field.schema.default ?? ""),
    ]),
  );
  if (row)
    for (const field of item.parameters)
      parameters.value[field.name] =
        row[field.name] ?? (field.name === "id" ? row.id : "") ?? "";
  draft.value = operationTemplate(item);
  original.value = clonePanelValue(draft.value);
  const requiresResource =
    /\/(inbounds|clients|nodes|hosts)\/update\//.test(item.path) ||
    (item.path === "/panel/api/sub-balancers/{id}" && item.method === "POST");
  if (requiresResource && !row) return;
  editTarget.value = requiresResource;
  loading.value = true;
  try {
    if (
      /\/(inbounds|clients)\/add$/.test(item.path) ||
      item.parameters.some((field) => /id|email/.test(field.name))
    ) {
      const inboundList = findOperation("GET /panel/api/inbounds/options");
      if (inboundList) {
        const list = unwrapPanelResult(await request(inboundList));
        if (Array.isArray(list))
          inboundChoices.value = list.map((item) => ({
            value: Number(item.id),
            label: `${item.remark || item.tag || "入站"} · ${item.port || ""}`,
          }));
      }
    }
    let current: unknown;
    if (/\/inbounds\/update\//.test(item.path) && row)
      current = await readOperation("GET /panel/api/inbounds/get/{id}", {
        id: row.id,
      });
    else if (/\/clients\/update\//.test(item.path) && row)
      current = await readOperation("GET /panel/api/clients/get/{email}", {
        email: row.email,
      });
    else if (/\/nodes\/update\//.test(item.path) && row)
      current = {
        ...((await readOperation("GET /panel/api/nodes/get/{id}", {
          id: row.id,
        })) as PanelRecord),
        apiToken: "",
        clearApiToken: false,
      };
    else if (/\/hosts\/update\//.test(item.path) && row)
      current = await readOperation("GET /panel/api/hosts/get/{groupId}", {
        groupId: row.groupId,
      });
    else if (item.path === "/panel/api/setting/update")
      current = await readOperation("POST /panel/api/setting/all");
    else if (
      item.path === "/panel/api/xray/update" ||
      /\/xray\/testOutbounds?$/.test(item.path)
    ) {
      const core = (await readOperation(
        "POST /panel/api/xray/",
      )) as PanelRecord;
      if (item.path.endsWith("/update"))
        current = {
          xraySetting: core.xraySetting,
          outboundTestUrl: core.outboundTestUrl || "",
        };
      else {
        const config = decodePanelValue(core.xraySetting) as PanelRecord;
        const outbounds = (config.outbounds || []) as unknown[];
        current = item.path.endsWith("testOutbound")
          ? {
              outbound: JSON.stringify(outbounds[0] || {}),
              allOutbounds: JSON.stringify(outbounds),
              mode: "tcp",
            }
          : {
              outbounds: JSON.stringify(outbounds),
              allOutbounds: JSON.stringify(outbounds),
              mode: "tcp",
            };
      }
    } else if (row && item.encoding)
      current = { ...(draft.value as PanelRecord), ...row };
    if (current !== undefined) {
      if (/\/clients\/update\//.test(item.path))
        current = xuiClientFormValue(current);
      original.value = current;
      draft.value = decodePanelValue(current);
    }
    if (
      (item.parameters.length === 0 && !item.mutates && !item.encoding) ||
      item.path.endsWith("/logs/{count}")
    ) {
      data.value = decodePanelValue(
        unwrapPanelResult(
          await request(
            item,
            parameters.value,
            item.encoding ? draft.value : undefined,
          ),
        ),
      );
    }
    prepared.value = true;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取设置失败";
  } finally {
    loading.value = false;
  }
}
async function execute() {
  const item = operation.value;
  if (!item || running.value || loading.value || !prepared.value) return;
  for (const field of item.parameters)
    if (
      field.required &&
      (parameters.value[field.name] === "" ||
        parameters.value[field.name] === undefined)
    ) {
      error.value = "请先选择要操作的资源，并填写必要信息";
      return;
    }
  if (binaryField.value && !file.value) {
    error.value = "请先选择备份文件";
    return;
  }
  const risky =
    /stop|restart|updatePanel|installXray|importDB|factoryDefaults|\/del|reset|bulk/i.test(
      item.path,
    );
  if (item.mutates) {
    try {
      await ElMessageBox.confirm(
        `将在「${panels.value.find((panel) => panel.id === serverId.value)?.name}」${operationLabel(item)}。${risky ? "可能中断连接、清除记录或重启服务，请核对后继续。" : "保存后立即生效。"}`,
        "确认操作",
        {
          type: "warning",
          confirmButtonText: "确认执行",
          cancelButtonText: "取消",
        },
      );
    } catch {
      return;
    }
  }
  running.value = true;
  error.value = "";
  try {
    const result = await request(
      item,
      parameters.value,
      item.encoding ? encodePanelValue(draft.value, original.value) : undefined,
      item.mutates,
    );
    data.value = decodePanelValue(unwrapPanelResult(result));
    if (item.mutates) {
      ElMessage.success("操作已完成");
      completed.value = true;
    }
  } catch (cause) {
    error.value =
      cause instanceof Error ? cause.message : "操作失败，请检查连接";
  } finally {
    running.value = false;
  }
}
function rowAction(kind: "update" | "del", row: PanelRecord) {
  const item = actions.value.find(
    (item) =>
      item.path.includes(`/${section.value}/${kind}/`) ||
      (kind === "del" &&
        item.method === "DELETE" &&
        item.path.endsWith("/{id}")) ||
      (kind === "update" &&
        item.method === "POST" &&
        item.path === "/panel/api/sub-balancers/{id}"),
  );
  if (item) void choose(item, row);
}
const canEditRows = computed(() =>
  ["inbounds", "clients", "nodes", "hosts", "sub-balancers"].includes(
    section.value,
  ),
);
function saveDownload() {
  if (!download.value) return;
  const value = download.value;
  const url = URL.createObjectURL(
    new Blob(
      [Uint8Array.from(atob(value.base64), (char) => char.charCodeAt(0))],
      { type: value.type },
    ),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = value.name;
  anchor.click();
  URL.revokeObjectURL(url);
}
async function upload(event: Event) {
  const chosen = (event.target as HTMLInputElement).files?.[0];
  file.value = undefined;
  if (!chosen || !binaryField.value) return;
  if (chosen.size > 16 * 1024 ** 2) {
    error.value = "备份文件不能超过 16 MB";
    return;
  }
  const bytes = new Uint8Array(await chosen.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  file.value = {
    field: binaryField.value,
    name: chosen.name,
    type: chosen.type || "application/octet-stream",
    base64: btoa(binary),
  };
}
onMounted(async () => {
  try {
    panels.value = await api("/api/admin/xui-servers");
    if (!serverId.value) serverId.value = panels.value[0]?.id || "";
    else await loadCatalog();
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "读取连接失败";
  }
});
</script>

<template>
  <section class="panel-hub">
    <header class="hub-heading">
      <div>
        <div class="eyebrow">3X-UI</div>
        <h1>面板管理</h1>
        <p>选择面板后，直接管理入站、客户端、网络、证书与运行设置。</p>
      </div>
      <router-link class="hub-button" to="/xui-servers"
        ><ArrowLeft :size="15" />返回面板列表</router-link
      >
    </header>
    <div class="hub-actions">
      <select
        v-model="serverId"
        class="panel-select"
        aria-label="选择管理面板"
        :disabled="loading || running"
      >
        <option value="" disabled>选择面板</option>
        <option v-for="panel in panels" :key="panel.id" :value="panel.id">
          {{ panel.name }}
        </option></select
      ><button
        class="hub-button"
        :disabled="!serverId || loading || running"
        @click="openSection(section)"
      >
        <RefreshCw :size="15" />刷新
      </button>
    </div>
    <nav v-if="catalog.length" class="hub-resource-nav" aria-label="面板功能">
      <button
        v-for="tab in tabs"
        :key="tab.id"
        :class="{ active: section === tab.id }"
        :disabled="loading || running"
        @click="openSection(tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>
    <div v-if="error" class="hub-alert error" role="alert">{{ error }}</div>
    <section v-if="catalog.length" class="hub-card">
      <div class="hub-toolbar">
        <h2>{{ title }}</h2>
        <div class="hub-actions">
          <button
            v-for="item in actions.filter((item) =>
              /\/add$|\/restartXrayService$/.test(item.path),
            )"
            :key="item.id"
            class="hub-button primary"
            :disabled="loading || running"
            @click="choose(item)"
          >
            {{ operationLabel(item) }}</button
          ><select
            class="panel-select"
            aria-label="更多管理操作"
            :disabled="loading || running"
            :value="selected"
            @change="
              choose(
                actions.find(
                  (item) =>
                    item.id === ($event.target as HTMLSelectElement).value,
                )!,
              )
            "
          >
            <option value="" disabled>更多操作</option>
            <option v-for="item in actions" :key="item.id" :value="item.id">
              {{ operationLabel(item) }}
            </option>
          </select>
        </div>
      </div>
      <div v-if="loading" class="hub-empty" role="status">
        <RefreshCw class="spinning" :size="24" />正在读取面板数据…
      </div>
      <template v-else>
        <form
          v-if="operation && editing && !completed"
          class="panel-task-form hub-form"
          @submit.prevent="execute"
        >
          <header class="panel-task-heading">
            <Settings2 :size="18" />
            <h3>{{ operationLabel(operation) }}</h3>
          </header>
          <label v-if="!prepared && !error"
            >选择要编辑的资源<select
              aria-label="选择要编辑的资源"
              @change="
                choose(
                  operation!,
                  rows.find(
                    (row) =>
                      String(row.id || row.email || row.groupId) ===
                      ($event.target as HTMLSelectElement).value,
                  ),
                )
              "
            >
              <option value="">请选择</option>
              <option
                v-for="(row, index) in rows"
                :key="index"
                :value="String(row.id || row.email || row.groupId)"
              >
                {{ rowTitle(row) }}
              </option>
            </select></label
          >
          <div v-if="prepared && operation.parameters.length">
            <PanelFields
              v-model="parameters"
              :schema="parameterSchema"
              :choices="choices"
              :disabled="running"
              :immutable="[]"
              :readonly="editTarget"
            />
          </div>
          <PanelFields
            v-if="prepared && operation.encoding"
            v-model="draft"
            :schema="bodySchema"
            :choices="choices"
            :immutable="
              operation.path.includes('/inbounds/update/')
                ? [
                    'id',
                    'clients',
                    'protocol',
                    'enable',
                    'up',
                    'down',
                    'clientStats',
                  ]
                : ['id', 'uuid', 'createdAt', 'updatedAt', 'up', 'down']
            "
            :file-fields="operation.path.endsWith('/import') ? ['data'] : []"
            :disabled="running"
          />
          <label v-if="binaryField"
            >选择备份文件<input
              type="file"
              accept=".db,.dump"
              :disabled="running"
              @change="upload"
          /></label>
          <footer>
            <span v-if="operation.mutates">保存后同步到远端面板</span
            ><button
              class="hub-button primary"
              :disabled="running || !prepared"
            >
              {{
                running
                  ? "处理中…"
                  : operation.mutates
                    ? "确认" + operationLabel(operation)
                    : "查看结果"
              }}
            </button>
          </footer>
        </form>
        <div v-if="download" class="hub-empty">
          <Download :size="28" />
          <h3>文件已准备好</h3>
          <button class="hub-button primary" @click="saveDownload">
            下载 {{ download.name }}
          </button>
        </div>
        <template v-else-if="rows.length && !operation?.mutates">
          <div class="panel-list-search">
            <label class="hub-search"
              ><Search :size="15" /><input
                v-model="search"
                aria-label="搜索资源"
                placeholder="搜索名称或备注"
            /></label>
          </div>
          <div class="hub-table-wrap">
            <table class="hub-table panel-resource-table">
              <thead>
                <tr>
                  <th>名称</th>
                  <th>协议 / 类型</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="(row, index) in filteredRows"
                  :key="String(row.id || row.email || index)"
                >
                  <td>
                    <strong>{{ rowTitle(row) }}</strong
                    ><small class="resource-detail">{{
                      row.port ? "端口 " + row.port : row.address || ""
                    }}</small>
                  </td>
                  <td>{{ row.protocol || row.type || "—" }}</td>
                  <td>
                    <span
                      v-if="rowEnabled(row) !== undefined"
                      class="status-pill"
                      :class="{ off: !rowEnabled(row) }"
                      >{{ rowEnabled(row) ? "已启用" : "已停用" }}</span
                    ><span v-else>—</span>
                  </td>
                  <td>
                    <div class="hub-actions">
                      <button
                        class="hub-link"
                        @click="detail = decodePanelValue(row)"
                      >
                        查看详情</button
                      ><button
                        v-if="canEditRows"
                        class="hub-link"
                        :disabled="running"
                        @click="rowAction('update', row)"
                      >
                        编辑</button
                      ><button
                        v-if="canEditRows"
                        class="hub-link danger"
                        :disabled="running"
                        @click="rowAction('del', row)"
                      >
                        删除
                      </button>
                    </div>
                  </td>
                </tr>
                <tr v-if="!filteredRows.length">
                  <td colspan="4" class="table-empty">没有匹配的记录</td>
                </tr>
              </tbody>
            </table>
          </div>
        </template>
        <div
          v-else-if="data !== null && (!operation?.mutates || completed)"
          class="panel-result"
        >
          <div class="panel-task-heading">
            <h3>{{ completed ? "操作结果" : "当前" + title }}</h3>
            <button
              v-if="completed"
              class="hub-button"
              @click="openSection(section)"
            >
              返回列表
            </button>
          </div>
          <PanelFields :model-value="data" readonly />
        </div>
        <div v-else-if="!editing" class="hub-empty">
          <h3>{{ section === "backup" ? "备份与恢复" : "暂无记录" }}</h3>
          <p>
            {{
              section === "backup"
                ? "从上方选择下载备份或恢复备份。"
                : "可从上方选择新建或其他管理操作。"
            }}
          </p>
        </div>
        <section v-if="detail" class="panel-result">
          <div class="panel-task-heading">
            <h3>资源详情</h3>
            <button class="hub-button" @click="detail = null">收起</button>
          </div>
          <PanelFields :model-value="detail" readonly />
        </section>
      </template>
    </section>
    <div v-else-if="!loading && !error" class="hub-empty">
      <h3>选择一个已接入的面板</h3>
      <p>接入后即可在这里使用可视化管理功能。</p>
    </div>
  </section>
</template>
