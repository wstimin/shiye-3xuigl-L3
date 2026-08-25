<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { AtSign, KeyRound, LockKeyhole, Mail, Phone, ShieldCheck, UserRound } from 'lucide-vue-next';
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
  <div class="user-page">
    <div class="user-page-header">
      <div>
        <span class="user-page-kicker">PERSONAL SETTINGS</span>
        <h2>个人设置</h2>
        <p>查看真实账户资料，并管理当前账号的登录密码。</p>
      </div>
    </div>

    <div v-if="message" class="user-feedback success">{{ message }}</div>
    <div v-if="error" class="user-feedback error">{{ error }}</div>

    <div class="profile-layout" :class="{ loading }">
      <section class="user-section-card profile-identity-card">
        <div class="profile-avatar-wrap">
          <span class="profile-avatar" :style="userAvatarStyle(displayName)">{{ avatarText }}</span>
          <i></i>
        </div>
        <h3>{{ displayName }}</h3>
        <p>{{ dashboard?.customer.loginUsername || user?.username || '--' }}</p>
        <span class="profile-role"><ShieldCheck :size="14" />{{ dashboard?.customer.status === 'active' ? '账号状态正常' : '账号已停用' }}</span>
        <div class="profile-created"><span>加入时间</span><strong>{{ formatDate(dashboard?.customer.createdAt) }}</strong></div>
      </section>

      <section class="user-section-card profile-detail-card">
        <header class="business-card-head compact">
          <span class="business-card-icon blue"><UserRound :size="20" /></span>
          <div><h3>账号资料</h3><p>这些信息来自当前面板账户。</p></div>
        </header>
        <div class="profile-detail-list">
          <div><i><AtSign :size="17" /></i><span>登录账号</span><strong>{{ user?.username || '--' }}</strong></div>
          <div><i><UserRound :size="17" /></i><span>账号类型</span><strong>{{ user?.role === 'user' ? '用户账号' : '--' }}</strong></div>
          <div><i><Mail :size="17" /></i><span>邮箱</span><strong>{{ dashboard?.customer.email || '未设置' }}</strong></div>
          <div><i><Phone :size="17" /></i><span>手机</span><strong>{{ dashboard?.customer.phone || '未设置' }}</strong></div>
        </div>
      </section>

      <section class="user-section-card profile-security-card">
        <header class="business-card-head compact">
          <span class="business-card-icon purple"><KeyRound :size="20" /></span>
          <div><h3>修改密码</h3><p>新密码至少 8 位，提交后请使用新密码重新登录。</p></div>
        </header>
        <form class="password-form" autocomplete="off" @submit.prevent="changePassword">
          <label><span>当前密码</span><i><LockKeyhole :size="17" /></i><input v-model="form.currentPassword" name="shiye-user-current-passcode" type="password" placeholder="请输入当前密码" autocomplete="current-password" /></label>
          <label><span>新密码</span><i><KeyRound :size="17" /></i><input v-model="form.newPassword" name="shiye-user-next-passcode" type="password" placeholder="请输入至少 8 位的新密码" autocomplete="new-password" /></label>
          <button :disabled="changing || !form.currentPassword || form.newPassword.length < 8">{{ changing ? '提交中' : '确认修改密码' }}</button>
        </form>
      </section>
    </div>
  </div>
</template>
