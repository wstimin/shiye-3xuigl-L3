<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "../api";
type Choice = {
  key: string;
  name: string;
  protocol: string;
  origin: string;
  tag?: string;
  reason?: string;
};
const props = defineProps<{
  serverId: string;
  modelValue?: string;
  disabled?: boolean;
}>();
const emit = defineEmits<{
  "update:modelValue": [value: string];
  busy: [value: boolean];
}>();
const enabled = ref(false),
  loading = ref(false),
  publishing = ref(false),
  selected = ref(""),
  error = ref(""),
  choices = ref<Choice[]>([]);
const choice = computed(() =>
  choices.value.find((x) => x.key === selected.value),
);
let revision = 0;
watch(
  () => props.serverId,
  () => {
    revision++;
    enabled.value = false;
    selected.value = "";
    choices.value = [];
    error.value = "";
    loading.value = false;
    emit("update:modelValue", "");
  },
);
watch(enabled, async (value) => {
  error.value = "";
  emit("update:modelValue", "");
  if (!value) {
    selected.value = "";
    return;
  }
  await load();
});
watch(selected, () => {
  error.value = "";
  emit(
    "update:modelValue",
    choice.value?.reason ? "" : choice.value?.tag || "",
  );
});
async function load() {
  const request = ++revision;
  loading.value = true;
  try {
    const list = await api<Choice[]>(
      `/api/admin/panel-servers/${props.serverId}/outbound-choices`,
    );
    if (request === revision) choices.value = list;
  } catch (e) {
    if (request === revision)
      error.value = e instanceof Error ? e.message : "读取出站失败";
  } finally {
    if (request === revision) loading.value = false;
  }
}
async function publish() {
  if (!choice.value || publishing.value) return;
  const request = revision,
    current = choice.value;
  publishing.value = true;
  emit("busy", true);
  error.value = "";
  try {
    const result = await api<{
      tag: string;
      verified: boolean;
    }>(`/api/admin/panel-servers/${props.serverId}/publish-outbound`, {
      method: "POST",
      body: { source: current.key, confirmed: true },
    });
    if (!result.verified) throw Error("远端尚未确认启用");
    if (request !== revision) return;
    current.tag = result.tag;
    emit("update:modelValue", result.tag);
  } catch (e) {
    if (request !== revision) return;
    error.value = e instanceof Error ? e.message : "出站启用失败";
    emit("update:modelValue", "");
  } finally {
    publishing.value = false;
    emit("busy", false);
  }
}
function validate() {
  if (!enabled.value) return "";
  if (loading.value || publishing.value) return "请等待出站读取或启用完成";
  if (!props.modelValue) return "请选择出站；本地出站需要先点击“启用到面板”";
  return "";
}
defineExpose({ validate });
</script>

<template>
  <fieldset class="inbound-outbound-select">
    <legend>出站转发</legend>
    <label class="hub-checkbox"
      ><input
        v-model="enabled"
        type="checkbox"
        :disabled="disabled || publishing"
      />为此入站指定出站</label
    >
    <p v-if="!enabled" class="muted-text">沿用当前面板的现有路由和默认出站。</p>
    <template v-else>
      <div class="outbound-selection-row">
        <label
          >目标出站<select
            v-model="selected"
            aria-label="入站目标出站"
            :disabled="disabled || loading || publishing"
          >
            <option value="" disabled>
              {{ loading ? "正在读取出站…" : "请选择出站" }}
            </option>
            <optgroup
              v-for="group in [
                ['panel', '当前面板出站'],
                ['local', '本系统保存的出站'],
                ['template', 'SOCKS 模板'],
              ]"
              :key="group[0]"
              :label="group[1]"
            >
              <option
                v-for="item in choices.filter((x) => x.origin === group[0])"
                :key="item.key"
                :value="item.key"
                :disabled="Boolean(item.reason)"
              >
                {{ item.name }} · {{ item.protocol
                }}{{
                  item.reason
                    ? " · " + item.reason
                    : item.origin !== "panel" && !item.tag
                      ? " · 尚未启用"
                      : ""
                }}
              </option>
            </optgroup>
          </select></label
        >
        <button
          v-if="choice && !choice.tag && !choice.reason"
          type="button"
          class="hub-button primary"
          :disabled="disabled || publishing"
          @click="publish"
        >
          {{ publishing ? "正在写入并确认…" : "启用到面板" }}
        </button>
        <button
          v-else
          type="button"
          class="hub-button"
          :disabled="disabled || loading || publishing"
          @click="load"
        >
          刷新出站
        </button>
      </div>
      <p v-if="choice?.tag" class="outbound-ready" role="status">
        已在目标面板确认 · 保存入站后建立路由关联
      </p>
      <p v-else class="muted-text">
        本地出站启用后会立即写入当前面板。取消新建入站时，已启用的出站仍会保留。
      </p>
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </template>
  </fieldset>
</template>

<style scoped>
.inbound-outbound-select {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 16px;
  margin: 20px 0 8px;
  min-width: 0;
}
legend {
  padding: 0 6px;
  color: var(--text);
  font-weight: 600;
  font-size: 14px;
}
.outbound-selection-row {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  margin-top: 14px;
}
.outbound-selection-row label {
  display: grid;
  gap: 7px;
  flex: 1;
  min-width: 0;
}
.outbound-selection-row select {
  width: 100%;
  min-width: 0;
}
.muted-text,
.outbound-ready {
  margin: 10px 0 0;
  font-size: 13px;
  line-height: 1.65;
}
.outbound-ready {
  color: var(--success, #18824e);
}
@media (max-width: 600px) {
  .outbound-selection-row {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
