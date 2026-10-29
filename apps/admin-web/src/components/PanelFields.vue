<script setup lang="ts">
import { computed, ref } from "vue";
import { ElMessage } from "element-plus";
import { ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-vue-next";
import {
  fieldLabel,
  emptyPanelItem,
  clonePanelValue,
  xrayProtocolSettings,
  fieldOptions,
  initialValue,
  isSecretField,
  normalizeSchema,
  objectPresets,
  optionLabels,
  type FieldSchema,
  type PanelRecord,
} from "../panel-fields";

defineOptions({ name: "PanelFields" });
const props = withDefaults(
  defineProps<{
    modelValue: unknown;
    schema?: FieldSchema;
    field?: string;
    readonly?: boolean;
    disabled?: boolean;
    choices?: Record<string, { value: string | number; label: string }[]>;
    immutable?: string[];
    presets?: Record<string, PanelRecord>;
    required?: boolean;
    fileFields?: string[];
  }>(),
  {
    field: "",
    readonly: false,
    disabled: false,
    immutable: () => [
      "id",
      "createdAt",
      "updatedAt",
      "clientStats",
      "hasApiToken",
      "up",
      "down",
    ],
  },
);
const emit = defineEmits<{ "update:modelValue": [value: unknown] }>();

const uploadName = ref("");
const schema = computed(() => normalizeSchema(props.schema));
const isArray = computed(
  () => Array.isArray(props.modelValue) || schema.value.type === "array",
);
const isObject = computed(
  () =>
    !isArray.value &&
    (Boolean(props.modelValue && typeof props.modelValue === "object") ||
      schema.value.type === "object" ||
      Boolean(schema.value.properties)),
);
const keys = computed(() =>
  [
    ...new Set([
      ...Object.keys((isObject.value ? props.modelValue : {}) || {}),
      ...Object.keys(schema.value.properties || {}),
    ]),
  ].filter((key) => !["__proto__", "prototype", "constructor"].includes(key)),
);
const items = computed(() =>
  Array.isArray(props.modelValue) ? props.modelValue : [],
);
const record = computed(() => (props.modelValue || {}) as PanelRecord);
const options = computed(() => {
  const choices = props.choices?.[props.field];
  if (choices) return choices;
  const fallback = fieldOptions[props.field];
  const list =
    schema.value.enum ||
    (props.modelValue === undefined ||
    props.modelValue === "" ||
    fallback?.includes(String(props.modelValue))
      ? fallback
      : undefined);
  return list?.map((value) => ({
    value: value as string | number,
    label: optionLabels[String(value)] || String(value),
  }));
});
const boolean = computed(
  () =>
    typeof props.modelValue === "boolean" || schema.value.type === "boolean",
);
const numeric = computed(
  () =>
    typeof props.modelValue === "number" ||
    ["integer", "number"].includes(schema.value.type || ""),
);
const quota = computed(
  () => ["totalGB", "volume", "total"].includes(props.field) && numeric.value,
);
const date = computed(
  () =>
    ["expiryTime", "expiresAt", "expiry"].includes(props.field) &&
    numeric.value,
);
const secret = computed(() => isSecretField(props.field));
const multiline = computed(
  () =>
    /certificate|certContent|privateKey|publicKey/.test(props.field) &&
    String(props.modelValue || "").includes("\n"),
);
const display = computed(() => {
  if (date.value)
    return Number(props.modelValue) > 0
      ? new Date(
          Number(props.modelValue) * (props.field === "expiry" ? 1000 : 1),
        ).toLocaleString("zh-CN")
      : "不限期";
  if (quota.value)
    return Number(props.modelValue) > 0
      ? `${(Number(props.modelValue) / 1024 ** 3).toFixed(2)} GB`
      : "不限量";
  if (
    props.modelValue === null ||
    props.modelValue === undefined ||
    props.modelValue === ""
  )
    return "未设置";
  return optionLabels[String(props.modelValue)] || String(props.modelValue);
});
const inputValue = computed(() => {
  if (quota.value) return Number(props.modelValue || 0) / 1024 ** 3;
  if (date.value) {
    if (!Number(props.modelValue)) return "";
    const value = new Date(
      Number(props.modelValue) * (props.field === "expiry" ? 1000 : 1),
    );
    return new Date(value.getTime() - value.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  }
  return props.modelValue as string | number | undefined;
});
function updateInput(event: Event) {
  const value = (event.target as HTMLInputElement).value;
  emit(
    "update:modelValue",
    date.value
      ? value
        ? new Date(value).getTime() / (props.field === "expiry" ? 1000 : 1)
        : 0
      : quota.value
        ? Math.round(Number(value) * 1024 ** 3)
        : numeric.value
          ? Number(value)
          : value,
  );
}
function changeKey(key: string, value: unknown) {
  const next = { ...record.value, [key]: value };
  if (
    key === "protocol" &&
    record.value.settings &&
    typeof record.value.settings === "object" &&
    value !== record.value.protocol
  )
    next.settings = xrayProtocolSettings(
      String(value),
      props.field === "outbounds",
    );
  if (props.field === "streamSettings" && key === "security") {
    if (value === "tls" && !next.tlsSettings)
      next.tlsSettings = {
        serverName: "",
        certificates: [{ certificateFile: "", keyFile: "" }],
        alpn: [],
      };
    if (value === "reality" && !next.realitySettings)
      next.realitySettings = {
        dest: "",
        serverNames: [],
        privateKey: "",
        shortIds: [],
      };
  }
  if (props.field === "streamSettings" && key === "network") {
    const defaults: Record<string, PanelRecord> = {
      ws: { path: "/", headers: { Host: "" } },
      grpc: { serviceName: "" },
      xhttp: { path: "/", host: "", mode: "auto" },
      httpupgrade: { path: "/", host: "" },
    };
    const settingsKey = `${String(value)}Settings`;
    if (defaults[String(value)] && !next[settingsKey])
      next[settingsKey] = defaults[String(value)];
  }
  emit("update:modelValue", next);
}
function changeItem(index: number, value: unknown) {
  const copy = [...items.value];
  copy[index] = value;
  emit("update:modelValue", copy);
}
function moveItem(index: number, offset: number) {
  const copy = [...items.value];
  [copy[index], copy[index + offset]] = [copy[index + offset], copy[index]];
  emit("update:modelValue", copy);
}
function addItem() {
  const itemSchema = schema.value.items;
  const sample = items.value[0];
  const preset =
    props.presets?.[props.field] ||
    (sample === undefined ? objectPresets[props.field] : undefined);
  const value = preset
    ? clonePanelValue(preset)
    : itemSchema
      ? initialValue(itemSchema)
      : sample && typeof sample === "object"
        ? emptyPanelItem(sample)
        : typeof sample === "number"
          ? 0
          : "";
  if (props.field === "clients" && value && typeof value === "object")
    (value as PanelRecord).id = crypto.randomUUID();
  emit("update:modelValue", [...items.value, value]);
}
async function copyValue() {
  try {
    await navigator.clipboard.writeText(String(props.modelValue || ""));
    ElMessage.success("已复制");
  } catch {
    ElMessage.error("复制失败，请展开后手动复制");
  }
}
async function readConfig(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  if (file.size > 2 * 1024 ** 2) {
    ElMessage.error("配置文件不能超过 2 MB");
    return;
  }
  try {
    const text = await file.text();
    JSON.parse(text);
    emit("update:modelValue", text);
    uploadName.value = file.name;
  } catch {
    ElMessage.error("无法读取配置，请选择从面板导出的文件");
  }
}
</script>

<template>
  <div
    v-if="isObject"
    class="panel-fields"
    :class="{ 'is-readonly': readonly }"
  >
    <div
      v-for="key in keys"
      :key="key"
      class="panel-field"
      :class="{
        'panel-field-nested':
          (record[key] && typeof record[key] === 'object') ||
          schema.properties?.[key]?.type === 'object' ||
          schema.properties?.[key]?.type === 'array',
      }"
    >
      <div class="panel-field-label">
        {{ fieldLabel(key)
        }}<span v-if="schema.required?.includes(key)" class="required-mark">
          *</span
        >
      </div>
      <PanelFields
        :model-value="record[key]"
        :schema="schema.properties?.[key]"
        :field="key"
        :readonly="
          readonly ||
          (immutable.includes(key) &&
            (key !== 'id' || typeof record[key] === 'number'))
        "
        :disabled="disabled"
        :choices="choices"
        :immutable="immutable"
        :presets="presets"
        :file-fields="fileFields"
        :required="schema.required?.includes(key)"
        @update:model-value="changeKey(key, $event)"
      />
    </div>
    <span v-if="!keys.length" class="muted-text">{{
      readonly ? "暂无设置" : "此项无需额外填写"
    }}</span>
  </div>
  <div v-else-if="isArray" class="panel-field-array">
    <div v-for="(item, index) in items" :key="index" class="panel-array-item">
      <div v-if="item && typeof item === 'object'" class="panel-array-heading">
      <span class="panel-array-index">第 {{ index + 1 }} 项</span>
      <div v-if="!readonly" class="panel-array-order">
        <button type="button" class="icon-button" :disabled="disabled || index === 0" :aria-label="`上移${fieldLabel(field)}第 ${index + 1} 项`" @click="moveItem(index, -1)"><ArrowUp :size="14" /></button>
        <button type="button" class="icon-button" :disabled="disabled || index === items.length - 1" :aria-label="`下移${fieldLabel(field)}第 ${index + 1} 项`" @click="moveItem(index, 1)"><ArrowDown :size="14" /></button>
      </div>
      </div>
      <PanelFields
        :model-value="item"
        :schema="schema.items"
        :field="field"
        :readonly="readonly"
        :disabled="disabled"
        :choices="choices"
        :immutable="immutable"
        :presets="presets"
        @update:model-value="changeItem(index, $event)"
      />
      <button
        v-if="!readonly"
        type="button"
        class="icon-button danger"
        :disabled="disabled"
        :aria-label="`移除${fieldLabel(field)}第 ${index + 1} 项`"
        @click="
          emit(
            'update:modelValue',
            items.filter((_, i) => i !== index),
          )
        "
      >
        <Trash2 :size="14" />
      </button>
    </div>
    <button
      v-if="!readonly"
      class="hub-button"
      type="button"
      :disabled="disabled"
      @click="addItem"
    >
      <Plus :size="14" />添加{{ fieldLabel(field) }}
    </button>
    <span v-else-if="!items.length" class="muted-text">暂无记录</span>
  </div>
  <div v-else-if="readonly" class="panel-field-value">
    <span>{{ display }}</span
    ><template v-if="secret && modelValue"
      ><button type="button" class="hub-link" @click="copyValue">
        复制
      </button></template
    >
  </div>
  <div v-else-if="fileFields?.includes(field)" class="panel-field-input">
    <input
      type="file"
      accept=".json"
      :aria-label="'选择' + fieldLabel(field) + '文件'"
      :disabled="disabled"
      @change="readConfig"
    /><small>{{ uploadName || "选择从面板导出的配置文件" }}</small>
  </div>
  <label v-else-if="boolean" class="panel-switch"
    ><input
      type="checkbox"
      :checked="Boolean(modelValue)"
      :disabled="disabled"
      @change="
        emit('update:modelValue', ($event.target as HTMLInputElement).checked)
      "
    /><span>{{ modelValue ? "已启用" : "未启用" }}</span></label
  >
  <select
    v-else-if="options"
    :value="modelValue"
    :aria-label="fieldLabel(field)"
    :disabled="disabled"
    :required="required"
    @change="
      emit(
        'update:modelValue',
        typeof modelValue === 'number' || schema.type === 'integer'
          ? Number(($event.target as HTMLSelectElement).value)
          : ($event.target as HTMLSelectElement).value,
      )
    "
  >
    <option v-if="modelValue === undefined || modelValue === ''" value="">
      请选择
    </option>
    <option
      v-if="modelValue && !options.some((item) => item.value === modelValue)"
      :value="String(modelValue)"
    >
      {{ optionLabels[String(modelValue)] || modelValue }}
    </option>
    <option v-for="option in options" :key="option.value" :value="option.value">
      {{ option.label }}
    </option>
  </select>
  <textarea
    v-else-if="multiline"
    :value="String(modelValue || '')"
    :aria-label="fieldLabel(field)"
    :disabled="disabled"
    rows="5"
    @input="updateInput"
  />
  <div v-else class="panel-field-input">
    <input
      :type="
        date
          ? 'datetime-local'
          : numeric
            ? 'number'
            : 'text'
      "
      :value="inputValue"
      :aria-label="fieldLabel(field)"
      :disabled="disabled"
      :required="required"
      :step="
        quota
          ? 'any'
          : schema.type === 'integer'
            ? '1'
            : numeric
              ? 'any'
              : undefined
      "
      :min="quota ? 0 : undefined"
      autocomplete="off"
      @input="updateInput"
    />
    <small v-if="quota">GB，0 表示不限量</small
    ><small v-if="date">留空表示不限期</small>
  </div>
</template>
