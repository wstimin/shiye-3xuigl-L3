<script setup lang="ts">
import { nextTick, onMounted, ref } from 'vue';
import { X } from 'lucide-vue-next';
import { api } from '../api';
const props = defineProps<{
  serverId: string;
  client: Record<string, unknown>;
}>();
const emit = defineEmits<{ close: []; linked: [] }>();
const dialog = ref<HTMLDialogElement>();
const name = ref(String(props.client.remark || props.client.name || ''));
const price = ref(0);
const busy = ref(false);
const error = ref('');
async function save() {
  busy.value = true;
  error.value = '';
  try {
    await api(`/api/admin/sui-servers/${props.serverId}/business-link`, {
      method: 'POST',
      body: {
        clientId: Number(props.client.id),
        inboundId: Number((props.client.inbounds as number[] | undefined)?.[0]),
        name: name.value,
        priceMonthly: price.value
      }
    });
    emit('linked');
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
    @click.self="!busy && emit('close')"
  >
    <section class="hub-dialog" aria-labelledby="business-link-title">
      <header>
        <div>
          <div class="eyebrow">S-UI / BUSINESS</div>
          <h2 id="business-link-title">接入业务管理</h2>
        </div>
        <button
          class="icon-button"
          aria-label="关闭"
          :disabled="busy"
          @click="emit('close')"
        >
          <X :size="20" />
        </button>
      </header>
      <form class="hub-form" @submit.prevent="save">
        <p>
          将「{{
            client.name
          }}」接入服务入站，随后可在用户管理中绑定用户，统一续费、流量同步和到期停用。
        </p>
        <label>服务名称<input v-model="name" required maxlength="120" /></label
        ><label
          >每月价格（元）<input
            v-model.number="price"
            type="number"
            min="0"
            max="99999999"
            step="0.01"
            required
        /></label>
        <div class="hub-alert">
          客户端须仅授权一个入站；每个入站仅对应一个业务客户端。现有额度和协议凭据会保留。
        </div>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <footer>
          <button
            type="button"
            class="hub-button"
            :disabled="busy"
            @click="emit('close')"
          >
            取消</button
          ><button class="hub-button primary" :disabled="busy">
            {{ busy ? '接入中…' : '确认接入' }}
          </button>
        </footer>
      </form>
    </section>
  </dialog>
</template>
