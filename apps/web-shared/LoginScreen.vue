<script setup lang="ts">
import { computed, ref } from 'vue';
import { ArrowRight, CircleAlert, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, Network, ShieldCheck, UserRound, WalletCards } from 'lucide-vue-next';
import BrandMark from './BrandMark.vue';
import ThemeToggle from './ThemeToggle.vue';
import './auth.css';

const props = defineProps<{ entry: 'admin' | 'user'; brand: { brandName: string; logoDataUrl: string }; username: string; password: string; busy: boolean; error: string }>();
const emit = defineEmits<{ 'update:username': [value: string]; 'update:password': [value: string]; submit: [] }>();
const visible = ref(false);
const admin = computed(() => props.entry === 'admin');
const features = computed(() => admin.value
  ? [{ icon: Network, title: '面板与网络', copy: '3x-ui 与 S-UI，集中管理' }, { icon: ShieldCheck, title: '业务与运维', copy: '用户、账单与运行状态，一目了然' }]
  : [{ icon: Network, title: '你的连接服务', copy: '查看用量、获取连接与续费' }, { icon: WalletCards, title: '你的账户空间', copy: '余额、账单与安全设置，清晰有序' }]);
</script>

<template>
  <section class="auth-shell">
    <header class="auth-header"><div class="auth-brand"><BrandMark :src="brand.logoDataUrl" :name="brand.brandName" /><strong>{{ brand.brandName }}</strong><span>{{ admin ? '管理控制台' : '个人服务中心' }}</span></div><ThemeToggle /></header>
    <main class="auth-stage">
      <section class="auth-card" :aria-label="admin ? '管理员登录' : '用户登录'">
        <div class="auth-story">
          <div class="auth-story-top"><span class="auth-edition"><i></i>{{ admin ? '统一管理 · 从容掌握' : '专属空间 · 从容连接' }}</span><span class="auth-story-index">{{ admin ? 'WORKSPACE' : 'PERSONAL' }}</span></div>
          <div class="auth-story-copy"><h1>{{ admin ? '每一处运行，' : '让每一次连接，' }}<br /><span>{{ admin ? '尽在掌握。' : '都从容开始。' }}</span></h1><p>{{ admin ? '让面板、业务与运维回到同一个工作空间。' : '服务、账户与连接，在这里井然有序。' }}</p></div>
          <div class="auth-art" aria-hidden="true"><svg viewBox="0 0 480 240" fill="none"><path d="M70 215V135a170 170 0 0 1 340 0v80" class="auth-art-arch"/><path d="M104 215V138a136 136 0 0 1 272 0v77" class="auth-art-line"/><path d="M138 215v-74a102 102 0 0 1 204 0v74" class="auth-art-line"/><path d="M0 215h480M38 232h404" class="auth-art-line"/><circle cx="240" cy="120" r="44" class="auth-art-disc"/><path d="M260 78a47 47 0 1 0 22 77 47 47 0 0 1-22-77Z" class="auth-art-moon"/><circle cx="310" cy="70" r="3" class="auth-art-moon"/><path d="M145 66v12m-6-6h12M338 149v10m-5-5h10" class="auth-art-arch"/></svg><span>{{ brand.brandName }}</span></div>
          <div class="auth-benefits"><div v-for="feature in features" :key="feature.title"><component :is="feature.icon" :size="19" /><span><strong>{{ feature.title }}</strong><small>{{ feature.copy }}</small></span></div></div>
        </div>
        <div class="auth-form-area">
          <form class="auth-form" autocomplete="on" :aria-busy="busy" @submit.prevent="emit('submit')">
            <div class="auth-form-mark"><BrandMark :src="brand.logoDataUrl" :name="brand.brandName" /><span>{{ admin ? '管理员身份验证' : '欢迎回到你的空间' }}</span></div>
            <div class="auth-heading"><h2>{{ admin ? '登录控制台' : '登录你的账户' }}</h2><p>{{ admin ? '使用管理员账号，继续管理你的工作区。' : '使用已开通的账号，开始管理你的服务。' }}</p></div>
            <div v-if="error" class="auth-error" role="alert"><CircleAlert :size="18" /><span>{{ error }}</span></div>
            <div class="auth-fields">
              <label class="auth-label" :for="entry + '-account'">{{ admin ? '管理员账号' : '登录账号' }}</label><div class="auth-input"><UserRound :size="19" /><input :id="entry + '-account'" :value="username" :name="admin ? 'shiye-admin-account' : 'shiye-user-username'" :placeholder="admin ? '请输入管理员账号' : '请输入你的账号'" autocomplete="username" autocapitalize="none" spellcheck="false" :disabled="busy" required @input="emit('update:username', ($event.target as HTMLInputElement).value)" /></div>
              <label class="auth-label auth-password-label" :for="entry + '-password'">登录密码<LockKeyhole :size="14" /></label><div class="auth-input"><KeyRound :size="19" /><input :id="entry + '-password'" :value="password" :name="admin ? 'shiye-admin-passcode' : 'shiye-user-passcode'" :type="visible ? 'text' : 'password'" placeholder="请输入登录密码" autocomplete="current-password" :disabled="busy" required @input="emit('update:password', ($event.target as HTMLInputElement).value)" /><button class="auth-reveal" type="button" :aria-label="visible ? '隐藏密码' : '显示密码'" :aria-pressed="visible" @click="visible = !visible"><EyeOff v-if="visible" :size="18" /><Eye v-else :size="18" /></button></div>
            </div>
            <button class="auth-submit" :disabled="busy || !username.trim() || !password"><LoaderCircle v-if="busy" class="auth-spinner" :size="19" /><span>{{ busy ? '正在验证账号…' : admin ? '进入管理控制台' : '进入服务中心' }}</span><ArrowRight v-if="!busy" :size="19" /></button>
            <p class="auth-assistance"><ShieldCheck :size="16" />{{ admin ? '仅限授权管理员访问' : '账号或密码有疑问？请联系管理员。' }}</p>
          </form>
        </div>
      </section>
    </main>
    <footer class="auth-footer"><span>{{ brand.brandName }}<span class="auth-footer-dot">·</span>{{ admin ? '管理控制台' : '个人服务中心' }}</span><span>让服务更清晰，让连接更简单。</span></footer>
  </section>
</template>
