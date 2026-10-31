<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { X } from 'lucide-vue-next';
import { api } from '../api';
const props = defineProps<{
  node: {
    id: string;
    serverId: string;
    inboundId?: number | null;
    name: string;
    priceMonthly: string;
    trafficLimitGb: string;
    enabled: boolean;
    remark?: string | null;
  };
}>();
const emit = defineEmits<{ close: []; saved: [] }>();
const dialog = ref<HTMLDialogElement>();
const form = ref({
  name: props.node.name,
  priceMonthly: Number(props.node.priceMonthly),
  trafficLimitGb: Number(props.node.trafficLimitGb),
  enabled: props.node.enabled,
  remark: props.node.remark || ''
});
const busy = ref(false),
  error = ref('');
async function save() {
  busy.value = true;
  error.value = '';
  try {
    await api(`/api/admin/service-nodes/${props.node.id}`, {
      method: 'PATCH',
      body: form.value
    });
    emit('saved');
    emit('close');
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : String(cause);
  } finally {
    busy.value = false;
  }
}
onMounted(async () => {
  await nextTick();
  dialog.value?.showModal();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="hub-overlay"
    @cancel.prevent="!busy && emit('close')"
  >
    <section class="hub-dialog" aria-labelledby="pricing-title">
      <header>
        <h2 id="pricing-title">S-UI 业务入站设置</h2>
        <button
          class="icon-button"
          :disabled="busy"
          aria-label="关闭"
          @click="emit('close')"
        >
          <X :size="20" />
        </button>
      </header>
      <form class="hub-form" @submit.prevent="save">
        <label
          >名称<input v-model="form.name" required maxlength="120"
        /></label>
        <div class="hub-form-grid">
          <label
            >月费（元）<input
              v-model.number="form.priceMonthly"
              type="number"
              min="0"
              step="0.01"
              required /></label
          ><label
            >客户端额度（GB）<input
              v-model.number="form.trafficLimitGb"
              type="number"
              min="0"
              step="0.01"
              required
          /></label>
        </div>
        <label class="hub-checkbox"
          ><input
            v-model="form.enabled"
            type="checkbox"
          />启用服务及远端客户端</label
        ><label>备注<input v-model="form.remark" maxlength="2000" /></label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <footer>
          <router-link class="hub-link" :to="{ path: '/sui-servers', query: { serverId: node.serverId, resource: 'inbounds', ...(node.inboundId ? { inboundId: String(node.inboundId) } : {}) } }"
            >管理协议与远端资源</router-link
          ><button class="hub-button primary" :disabled="busy">
            {{ busy ? '保存中…' : '保存' }}
          </button>
        </footer>
      </form>
    </section>
  </dialog>
</template>
