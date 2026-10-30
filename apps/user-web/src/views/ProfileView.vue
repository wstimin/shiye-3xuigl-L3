<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ArrowRight, KeyRound, LockKeyhole, ShieldCheck, UserRound } from 'lucide-vue-next';
import { readableError } from '@shiye/shared';
import { api } from '../api';
import { userAvatarStyle, userInitial } from '../avatar';
import { notifyError, notifySuccess } from '../notify';

type SessionUser = { role: string; username: string; customerId?: string };
type UserDashboard = {
  customer: {
    name: string;
    loginUsername: string;
    email?: string | null;
    phone?: string | null;
    status: string;
    createdAt?: string | null;
  };
};

const loading = ref(false);
const changing = ref(false);
const error = ref('');
const message = ref('');
const user = ref<SessionUser | null>(null);
const dashboard = ref<UserDashboard | null>(null);
const form = reactive({ currentPassword: '', newPassword: '' });
const displayName = computed(() => dashboard.value?.customer.name || user.value?.username || '用户');
const avatarText = computed(() => userInitial(displayName.value));

async function loadProfile() {
  loading.value = true;
  error.value = '';
  try {
    const [session, profile] = await Promise.all([
      api<SessionUser>('/api/auth/me?entry=user'),
      api<UserDashboard>('/api/user/me')
    ]);
    user.value = session;
    dashboard.value = profile;
  } catch (caught) {
    error.value = readableError(caught, '加载失败');
  } finally {
    loading.value = false;
  }
}

async function changePassword() {
  changing.value = true;
  error.value = '';
  message.value = '';
  try {
    await api('/api/change-password', { method: 'POST', body: form });
    message.value = '修改成功';
    notifySuccess(message.value);
    Object.assign(form, { currentPassword: '', newPassword: '' });
  } catch (caught) {
    notifyError(caught, '修改失败');
  } finally {
    changing.value = false;
  }
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleDateString('zh-CN') : '--';
}

onMounted(loadProfile);
</script>

<template>
  <div class="user-page settings-page" :aria-busy="loading">
    <header class="page-heading"><div><span class="eyebrow">个人账户</span><h1>账户设置</h1><p>查看个人账户资料，管理登录安全。</p></div></header>
    <div v-if="message" class="user-feedback success" role="status">{{ message }}</div><div v-if="error" class="user-feedback error" role="alert">{{ error }}</div>
    <section class="identity-band"><span class="profile-avatar" :style="userAvatarStyle(displayName)">{{ avatarText }}</span><div><h2>{{ displayName }}</h2><p>@{{ dashboard?.customer.loginUsername || user?.username || '—' }}<span class="footer-divider">/</span>用户账号</p></div><span class="identity-status"><ShieldCheck :size="16" />{{ dashboard?.customer.status === 'active' ? '账户正常' : '账户已停用' }}</span></section>
    <div class="settings-layout"><nav class="settings-index" aria-label="设置分区"><span class="section-number">PREFERENCES</span><a href="#account-details"><UserRound :size="16" />账户资料</a><a href="#account-security"><LockKeyhole :size="16" />登录与安全</a></nav><div class="surface settings-content">
      <section id="account-details" class="settings-section"><header><span class="section-number">01 / PROFILE</span><h2>账户资料</h2><p>资料由管理员维护。如需更改，请联系管理员。</p></header><dl class="account-details"><div><dt>显示名称</dt><dd>{{ dashboard?.customer.name || '—' }}</dd></div><div><dt>登录账号</dt><dd>{{ dashboard?.customer.loginUsername || user?.username || '—' }}</dd></div><div><dt>电子邮箱</dt><dd>{{ dashboard?.customer.email || '未设置' }}</dd></div><div><dt>联系电话</dt><dd>{{ dashboard?.customer.phone || '未设置' }}</dd></div><div><dt>加入时间</dt><dd>{{ formatDate(dashboard?.customer.createdAt) }}</dd></div></dl></section>
      <section id="account-security" class="settings-section"><header><span class="section-number">02 / SECURITY</span><h2>登录与安全</h2><p>定期更新密码，让账户访问更安心。</p></header><form class="password-form" autocomplete="off" @submit.prevent="changePassword"><label><span>当前密码</span><input v-model="form.currentPassword" name="shiye-user-current-passcode" type="password" placeholder="输入当前密码" autocomplete="current-password" required /></label><label><span>新密码</span><input v-model="form.newPassword" name="shiye-user-next-passcode" type="password" placeholder="至少 8 位字符" autocomplete="new-password" minlength="8" required /></label><div class="password-form-footer"><span><KeyRound :size="14" />修改成功后，请使用新密码重新登录。</span><button class="button primary" :disabled="changing || !form.currentPassword || form.newPassword.length < 8">{{ changing ? '正在更新…' : '更新登录密码' }}<ArrowRight :size="16" /></button></div></form></section>
    </div></div>
  </div>
</template>
