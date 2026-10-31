<script setup lang="ts">
import { ref, watch } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { api } from "../api";
const props = defineProps<{
    serverId: string;
    revision?: number;
  }>(),
  emit = defineEmits<{
    changed: [];
  }>();
type Choice = {
  key: string;
  name: string;
  protocol: string;
  origin: string;
  serverId?: string;
  tag?: string;
  reason?: string;
};
const rows = ref<Choice[]>([]),
  loading = ref(false),
  publishing = ref(""),
  error = ref("");
let request = 0;
async function load() {
  const n = ++request;
  loading.value = true;
  try {
    const list = await api<Choice[]>(
      `/api/admin/panel-servers/${props.serverId}/outbound-choices`,
    );
    if (n === request) {
      rows.value = list.filter(
        (x) => x.origin === "local" && x.serverId === props.serverId && !x.tag,
      );
      error.value = "";
    }
  } catch (e) {
    if (n === request)
      error.value = e instanceof Error ? e.message : "读取本地出站失败";
  } finally {
    if (n === request) loading.value = false;
  }
}
watch(
  [() => props.serverId, () => props.revision],
  () => {
    rows.value = [];
    if (props.serverId) void load();
  },
  { immediate: true },
);
async function publish(row: Choice) {
  if (publishing.value) return;
  publishing.value = row.key;
  error.value = "";
  try {
    await api(`/api/admin/panel-servers/${props.serverId}/publish-outbound`, {
      method: "POST",
      body: { source: row.key, confirmed: true },
    });
    await load();
    ElMessage.success("出站已写入目标面板并回读确认");
    emit("changed");
  } catch (e) {
    error.value = e instanceof Error ? e.message : "启用失败";
  } finally {
    publishing.value = "";
  }
}
async function remove(row: Choice) {
  if (publishing.value) return;
  try {
    await ElMessageBox.confirm(
      `删除本地出站“${row.name}”？此操作只删除本系统记录，不修改远端面板。`,
      "删除本地出站",
      {
        type: "warning",
        confirmButtonText: "删除本地记录",
        cancelButtonText: "取消",
      },
    );
  } catch {
    return;
  }
  publishing.value = row.key;
  try {
    await api(`/api/admin/network-outbounds/${row.key.slice(6)}`, {
      method: "DELETE",
    });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : "删除本地出站失败";
  } finally {
    publishing.value = "";
  }
}
</script>
<template>
  <section v-if="rows.length || error" class="saved-outbounds">
    <header>
      <h3>待启用的本地出站</h3>
      <p class="muted-text">
        点击“启用到面板”会立即写入并回读确认，随后可关联入站。
      </p>
    </header>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <div class="hub-table-wrap">
      <table class="hub-table" aria-label="本系统保存的出站">
        <thead>
          <tr>
            <th>名称</th>
            <th>协议</th>
            <th>目标面板状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key">
            <td>{{ row.name }}</td>
            <td>{{ row.protocol }}</td>
            <td>
              {{ row.reason || (row.tag ? "已启用并确认" : "仅本地保存") }}
            </td>
            <td>
              <button
                class="hub-link"
                type="button"
                :disabled="
                  Boolean(row.tag || row.reason) || Boolean(publishing)
                "
                @click="publish(row)"
              >
                {{
                  publishing === row.key
                    ? "正在写入并确认…"
                    : row.tag
                      ? "已启用"
                      : "启用到面板"
                }}
              </button>
              <button
                class="hub-link danger"
                type="button"
                :disabled="Boolean(publishing)"
                @click="remove(row)"
              >
                删除本地
              </button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
<style scoped>
.saved-outbounds {
  margin: 16px 0;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.saved-outbounds header {
  padding: 14px 16px;
}
.saved-outbounds h3 {
  font-size: 14px;
  margin: 0 0 5px;
}
.saved-outbounds header p {
  font-size: 13px;
  margin: 0;
}
</style>
