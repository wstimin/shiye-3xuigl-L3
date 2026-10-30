<script setup lang="ts">
import { Monitor, Moon, Sun } from 'lucide-vue-next';
import { dark, setTheme, themePreference } from './theme';
</script>
<template>
  <div class="theme-control">
    <button class="theme-toggle" type="button" :aria-label="dark ? '切换到亮色模式' : '切换到暗色模式'" :title="dark ? '切换到亮色模式' : '切换到暗色模式'" @click="setTheme(dark ? 'light' : 'dark')"><Sun v-if="dark" :size="18" /><Moon v-else :size="18" /><span>{{ dark ? '亮色' : '暗色' }}</span></button>
    <button class="theme-system" type="button" aria-label="跟随系统主题" title="跟随系统主题" :aria-pressed="themePreference === 'system'" @click="setTheme('system')"><Monitor :size="16" /></button>
  </div>
</template>
