<script setup lang="ts">
import { ref, watch } from 'vue';
const props = defineProps<{ src?: string; name?: string }>();
const failed = ref(false);
watch(() => props.src, () => { failed.value = false; });
</script>
<template>
  <span class="brand-emblem" role="img" :aria-label="(name || '十夜') + '品牌标识'">
    <img v-if="src && !failed" :src="src" alt="" @error="failed = true" />
    <svg v-else viewBox="0 0 40 40" fill="none" aria-hidden="true"><path d="M27 7a14 14 0 1 0 6 23A14 14 0 0 1 27 7Z" fill="currentColor"/><path d="M13 13v14M6 20h14" stroke="var(--surface)" stroke-width="2.5" stroke-linecap="round"/><circle cx="32" cy="10" r="2.5" fill="currentColor"/></svg>
  </span>
</template>
