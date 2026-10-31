<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { ElDialog, ElMessage } from "element-plus";
import { api } from "../api";
const props = defineProps<{
  modelValue: boolean;
  serverId: string;
  serverName?: string;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: boolean];
  imported: [];
}>();
const format = ref("auto"),
  input = ref(""),
  name = ref(""),
  strategy = ref("target_panel"),
  conflict = ref("reject"),
  busy = ref(false),
  error = ref("");
type Preview = {
  count: number;
  items: {
    name: string;
    tag: string;
    protocol: string;
  }[];
  fingerprint: string;
};
const preview = ref<Preview | null>(null);
const signature = computed(() =>
  JSON.stringify([
    props.serverId,
    format.value,
    input.value,
    name.value,
    strategy.value,
    conflict.value,
  ]),
);
watch(signature, () => {
  preview.value = null;
  error.value = "";
});
watch(
  () => props.modelValue,
  (value) => {
    if (value) {
      format.value = "auto";
      input.value = "";
      name.value = "";
      preview.value = null;
      error.value = "";
    }
  },
);
async function fileChanged(event: Event) {
  input.value = "";
  preview.value = null;
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 1024 * 1024) {
    error.value = "文件超过 1 MB，请拆分导入";
    return;
  }
  try {
    const text = await file.text();
    if (format.value === "json") input.value = text;
  } catch {
    error.value = "文件读取失败，请重新选择";
  }
}
function close() {
  if (!busy.value) emit("update:modelValue", false);
}
async function run(save: boolean) {
  if (busy.value || !input.value.trim()) return;
  busy.value = true;
  error.value = "";
  const snapshot = signature.value;
  try {
    const result = await api<
      Preview & {
        imported: number;
        verified: boolean;
      }
    >(
      `/api/admin/panel-servers/${props.serverId}/outbounds/${save ? "import" : "preview"}`,
      {
        method: "POST",
        body: {
          format: format.value,
          input: input.value,
          name: name.value.trim() || undefined,
          strategy: strategy.value,
          conflict: conflict.value,
          confirmed: save,
          ...(save ? { fingerprint: preview.value?.fingerprint } : {}),
        },
      },
    );
    if (snapshot !== signature.value) return;
    if (save) {
      ElMessage.success(
        result.verified
          ? "出站已写入 S-UI 并回读确认"
          : "出站已保存到本系统，启用后才会写入面板",
      );
      emit("imported");
      emit("update:modelValue", false);
    } else preview.value = result;
  } catch (e) {
    error.value = e instanceof Error ? e.message : "导入失败";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <ElDialog
    :model-value="modelValue"
    title="导入 S-UI 出站"
    width="min(720px, 94vw)"
    :close-on-click-modal="!busy"
    :close-on-press-escape="!busy"
    :show-close="!busy"
    @update:model-value="close"
  >
    <form class="hub-form" @submit.prevent="run(Boolean(preview))">
      <p class="muted-text">
        目标面板：{{
          serverName || "当前 S-UI 面板"
        }}。预览只识别内容，确认导入后才保存。
      </p>
      <div class="panel-form-grid">
        <label
          >导入方式<select
            v-model="format"
            :disabled="busy"
            aria-label="S-UI 出站导入方式"
          >
            <option value="auto">分享链接 / 订阅内容</option>
            <option value="subscription">订阅地址</option>
            <option value="json">配置文件</option>
          </select></label
        ><label
          >保存位置<select
            v-model="strategy"
            :disabled="busy"
            aria-label="S-UI 出站保存位置"
          >
            <option value="target_panel">导入并启用到当前面板</option>
            <option value="local_only">仅保存到本系统</option>
          </select></label
        >
      </div>
      <label v-if="format === 'json'"
        >选择配置文件<input
          type="file"
          accept=".json,application/json"
          :disabled="busy"
          @change="fileChanged"
        /><small
          >支持 sing-box 原生出站，以及可兼容转换的 Xray 出站。</small
        ></label
      >
      <label v-else
        >{{ format === "subscription" ? "订阅地址" : "分享链接或订阅内容"
        }}<textarea
          v-model="input"
          :rows="4"
          :disabled="busy"
          :aria-label="
            format === 'subscription' ? 'S-UI 订阅地址' : 'S-UI 出站分享链接'
          "
          :placeholder="
            format === 'subscription'
              ? '粘贴完整订阅地址'
              : '粘贴分享链接，多条可分行填写'
          "
        />
      </label>
      <div class="panel-form-grid">
        <label
          >出站名称（单项可选）<input
            v-model="name"
            maxlength="120"
            :disabled="busy" /></label
        ><label
          >同名出站处理<select v-model="conflict" :disabled="busy">
            <option value="reject">提示冲突，保留现有出站</option>
            <option value="rename">自动改名后导入</option>
          </select></label
        >
      </div>
      <div v-if="preview" class="hub-table-wrap">
        <table class="hub-table">
          <thead>
            <tr>
              <th>已识别 {{ preview.count }} 个出站</th>
              <th>协议</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in preview.items" :key="index">
              <td>{{ item.name }}</td>
              <td>{{ item.protocol }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <footer>
        <button
          type="button"
          class="hub-button"
          :disabled="busy"
          @click="close"
        >
          取消</button
        ><button
          type="button"
          class="hub-button"
          :disabled="busy || !input.trim()"
          @click="run(false)"
        >
          {{ busy ? "处理中…" : "预览识别" }}</button
        ><button
          type="submit"
          class="hub-button primary"
          :disabled="busy || !preview"
        >
          {{
            strategy === "target_panel" ? "确认导入并启用" : "确认保存到本系统"
          }}
        </button>
      </footer>
    </form>
  </ElDialog>
</template>
