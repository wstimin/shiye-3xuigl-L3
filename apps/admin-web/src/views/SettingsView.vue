<script setup lang="ts">
import { computed, onMounted, reactive, ref, type Component } from 'vue';
import 'element-plus/es/components/alert/style/css';
import 'element-plus/es/components/button/style/css';
import 'element-plus/es/components/form/style/css';
import 'element-plus/es/components/form-item/style/css';
import 'element-plus/es/components/input/style/css';
import { ElAlert, ElButton, ElForm, ElFormItem, ElInput, ElMessage, ElMessageBox } from 'element-plus';
import {
  AlertTriangle,
  ChevronRight,
  Copy,
  ExternalLink,
  Image as ImageIcon,
  KeyRound,
  Layers3,
  Link2,
  LockKeyhole,
  Palette,
  RefreshCw,
  Route,
  Save,
  ShieldCheck,
  Upload,
  X
} from 'lucide-vue-next';
import { api } from '../api';

type BrandSettings = { brandName: string; logoDataUrl: string };
type BusinessSettings = { cardPurchaseUrl: string };
type RuntimeSettings = { adminPath: string; activeAdminPath: string; restartRequired: boolean };
type AdminSettings = { brand: BrandSettings; business: BusinessSettings; runtime: RuntimeSettings };
type SettingsUpdatePayload = {
  brand?: BrandSettings;
  business?: BusinessSettings;
  runtime?: Pick<RuntimeSettings, 'adminPath'>;
};
type SettingsModuleId = 'brand' | 'business' | 'runtime' | 'security';
type SettingsModule = {
  id: SettingsModuleId;
  title: string;
  description: string;
  endpoint: string;
  method: 'PUT' | 'POST';
  tone: 'indigo' | 'emerald' | 'cyan' | 'rose';
  icon: Component;
};

const defaultRuntime: RuntimeSettings = { adminPath: '/admin', activeAdminPath: '/admin', restartRequired: false };
const settingsModules: SettingsModule[] = [
  { id: 'brand', title: '品牌与外观', description: '系统名称、Logo 与品牌展示', endpoint: '/api/admin/settings', method: 'PUT', tone: 'indigo', icon: Palette },
  { id: 'business', title: '业务入口', description: '用户端卡密购买地址', endpoint: '/api/admin/settings', method: 'PUT', tone: 'emerald', icon: Link2 },
  { id: 'runtime', title: '访问与运行', description: '管理后台访问路径', endpoint: '/api/admin/settings', method: 'PUT', tone: 'cyan', icon: Route },
  { id: 'security', title: '账号安全', description: '管理员登录密码', endpoint: '/api/change-password', method: 'POST', tone: 'rose', icon: LockKeyhole }
];

const activeModuleId = ref<SettingsModuleId>('brand');
const loading = ref(false);
const savingBrand = ref(false);
const savingBusiness = ref(false);
const savingRuntime = ref(false);
const changingPassword = ref(false);
const error = ref('');
const brandForm = reactive<BrandSettings>({ brandName: '十夜管理系统', logoDataUrl: '' });
const businessForm = reactive<BusinessSettings>({ cardPurchaseUrl: '' });
const runtimeForm = reactive<RuntimeSettings>({ ...defaultRuntime });
const passwordForm = reactive({ currentPassword: '', newPassword: '' });
const savedBrand = ref<BrandSettings>({ ...brandForm });
const savedBusiness = ref<BusinessSettings>({ ...businessForm });
const savedRuntime = ref<RuntimeSettings>({ ...runtimeForm });

const activeModule = computed(() => settingsModules.find((item) => item.id === activeModuleId.value) ?? settingsModules[0]!);
const brandDirty = computed(() => brandForm.brandName !== savedBrand.value.brandName || brandForm.logoDataUrl !== savedBrand.value.logoDataUrl);
const businessDirty = computed(() => businessForm.cardPurchaseUrl !== savedBusiness.value.cardPurchaseUrl);
const runtimeDirty = computed(() => runtimeForm.adminPath !== savedRuntime.value.adminPath);
const securityDirty = computed(() => Boolean(passwordForm.currentPassword || passwordForm.newPassword));
const changedModuleCount = computed(() => settingsModules.filter((item) => moduleChanged(item.id)).length);
const businessUrlValid = computed(() => !businessForm.cardPurchaseUrl.trim() || isValidUrl(businessForm.cardPurchaseUrl));
const runtimePathPreview = computed(() => normalizeAdminPathPreview(runtimeForm.adminPath));
const runtimePathError = computed(() => validateAdminPath(runtimeForm.adminPath));
const currentAdminUrl = computed(() => `${window.location.origin}${runtimeForm.activeAdminPath}`);
const proposedAdminUrl = computed(() => `${window.location.origin}${runtimePathPreview.value}`);
const passwordStrength = computed(() => {
  const value = passwordForm.newPassword;
  if (!value) return { score: 0, label: '尚未输入', tone: 'neutral' };
  let score = value.length >= 8 ? 1 : 0;
  if (value.length >= 12) score += 1;
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1;
  if (/\d/.test(value)) score += 1;
  if (/[^A-Za-z0-9]/.test(value)) score += 1;
  if (score <= 1) return { score: 1, label: '较弱', tone: 'danger' };
  if (score <= 3) return { score: 2, label: '一般', tone: 'warning' };
  return { score: 3, label: '较强', tone: 'success' };
});

async function loadSettings() {
  loading.value = true;
  error.value = '';
  try {
    applySettings(await fetchSettings());
    return true;
  } catch (err) {
    showError(err, '加载系统配置失败');
    return false;
  } finally {
    loading.value = false;
  }
}

function fetchSettings() {
  return api<AdminSettings>('/api/admin/settings', { cache: 'no-store' });
}

function applySettings(settings: AdminSettings) {
  const brand = settings.brand || { brandName: '十夜管理系统', logoDataUrl: '' };
  const business = settings.business || { cardPurchaseUrl: '' };
  const runtime = settings.runtime || defaultRuntime;
  Object.assign(brandForm, brand);
  Object.assign(businessForm, business);
  Object.assign(runtimeForm, runtime);
  savedBrand.value = { ...brand };
  savedBusiness.value = { ...business };
  savedRuntime.value = { ...runtime };
}

async function refreshSettings() {
  if (changedModuleCount.value) {
    try {
      await ElMessageBox.confirm('刷新会放弃当前尚未保存的修改，是否继续？', '刷新系统配置', {
        type: 'warning',
        confirmButtonText: '继续刷新',
        cancelButtonText: '取消',
        customClass: 'operations-dark-message-box'
      });
    } catch {
      return;
    }
  }
  if (await loadSettings()) ElMessage.success('系统配置已刷新');
}

async function updateSettings(payload: SettingsUpdatePayload) {
  await api<AdminSettings>('/api/admin/settings', { method: 'PUT', body: payload });
  const settings = await fetchSettings();
  assertSettingsMatch(payload, settings);
  return settings;
}

function assertSettingsMatch(payload: SettingsUpdatePayload, settings: AdminSettings) {
  if (payload.brand && (settings.brand?.brandName !== payload.brand.brandName || settings.brand?.logoDataUrl !== payload.brand.logoDataUrl)) {
    throw new Error('品牌设置未保存');
  }
  if (payload.business && settings.business?.cardPurchaseUrl !== payload.business.cardPurchaseUrl) {
    throw new Error('业务设置未保存');
  }
  if (payload.runtime && settings.runtime?.adminPath !== normalizeAdminPathPreview(payload.runtime.adminPath)) {
    throw new Error('管理路径未保存');
  }
}

async function saveBrand() {
  if (!brandForm.brandName.trim()) return;
  savingBrand.value = true;
  error.value = '';
  try {
    const settings = await updateSettings({ brand: { ...brandForm } });
    Object.assign(brandForm, settings.brand);
    savedBrand.value = { ...settings.brand };
    window.dispatchEvent(new CustomEvent('shiye:branding-updated', { detail: settings.brand }));
    ElMessage.success('品牌与外观设置已保存');
  } catch (err) {
    showError(err, '保存品牌设置失败');
  } finally {
    savingBrand.value = false;
  }
}

async function saveBusiness() {
  if (!businessUrlValid.value) {
    ElMessage.warning('请输入完整有效的购买地址');
    return;
  }
  savingBusiness.value = true;
  error.value = '';
  try {
    const settings = await updateSettings({ business: { ...businessForm } });
    Object.assign(businessForm, settings.business);
    savedBusiness.value = { ...settings.business };
    ElMessage.success('业务入口设置已保存');
  } catch (err) {
    showError(err, '保存业务入口失败');
  } finally {
    savingBusiness.value = false;
  }
}

async function saveRuntime() {
  if (runtimePathError.value) {
    ElMessage.warning(runtimePathError.value);
    return;
  }
  const nextPath = runtimePathPreview.value;
  if (nextPath !== runtimeForm.activeAdminPath) {
    try {
      await ElMessageBox.confirm(
        `管理后台地址将从 ${runtimeForm.activeAdminPath} 变更为 ${nextPath}。保存后页面会自动跳转到新地址，请确认已记录。`,
        '确认修改管理路径',
        {
          type: 'warning',
          confirmButtonText: '保存并跳转',
          cancelButtonText: '取消',
          customClass: 'operations-dark-message-box'
        }
      );
    } catch {
      return;
    }
  }

  savingRuntime.value = true;
  error.value = '';
  const previousAdminPath = runtimeForm.activeAdminPath;
  try {
    const settings = await updateSettings({ runtime: { adminPath: runtimeForm.adminPath } });
    const runtime = settings.runtime || defaultRuntime;
    Object.assign(runtimeForm, runtime);
    savedRuntime.value = { ...runtime };
    ElMessage.success('管理路径已保存并生效');
    if (runtime.activeAdminPath !== previousAdminPath) {
      window.setTimeout(() => {
        window.location.assign(`${window.location.origin}${runtime.activeAdminPath}/settings`);
      }, 500);
    }
  } catch (err) {
    showError(err, '保存管理路径失败');
  } finally {
    savingRuntime.value = false;
  }
}

async function changePassword() {
  if (!passwordForm.currentPassword || passwordForm.newPassword.length < 8) return;
  changingPassword.value = true;
  error.value = '';
  try {
    await api('/api/change-password', { method: 'POST', body: { ...passwordForm } });
    Object.assign(passwordForm, { currentPassword: '', newPassword: '' });
    ElMessage.success('密码已修改，正在返回登录页');
    window.setTimeout(() => window.location.reload(), 700);
  } catch (err) {
    showError(err, '修改管理员密码失败');
  } finally {
    changingPassword.value = false;
  }
}

async function onLogoSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    ElMessage.error('请选择图片文件');
    return;
  }
  if (file.size > 3 * 1024 * 1024) {
    ElMessage.error('Logo 图片不能超过 3MB');
    return;
  }
  try {
    brandForm.logoDataUrl = await imageToDataUrl(file, 256);
  } catch {
    ElMessage.error('图片读取失败');
  }
}

function resetActiveModule() {
  if (activeModuleId.value === 'brand') Object.assign(brandForm, savedBrand.value);
  if (activeModuleId.value === 'business') Object.assign(businessForm, savedBusiness.value);
  if (activeModuleId.value === 'runtime') Object.assign(runtimeForm, savedRuntime.value);
  if (activeModuleId.value === 'security') Object.assign(passwordForm, { currentPassword: '', newPassword: '' });
}

function moduleChanged(id: SettingsModuleId) {
  if (id === 'brand') return brandDirty.value;
  if (id === 'business') return businessDirty.value;
  if (id === 'runtime') return runtimeDirty.value;
  return securityDirty.value;
}

function moduleStatus(id: SettingsModuleId) {
  if (moduleChanged(id)) return { label: '未保存', tone: 'warning' };
  if (id === 'brand') return { label: brandForm.logoDataUrl ? '已配置' : '名称已配置', tone: 'success' };
  if (id === 'business') return { label: businessForm.cardPurchaseUrl ? '已配置' : '未配置', tone: businessForm.cardPurchaseUrl ? 'success' : 'neutral' };
  if (id === 'runtime') return { label: '已生效', tone: 'success' };
  return { label: '受保护', tone: 'success' };
}

async function copyText(value: string, message = '地址已复制') {
  if (!value) return;
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
    } else {
      const textarea = document.createElement('textarea');
      textarea.value = value;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      textarea.remove();
    }
    ElMessage.success(message);
  } catch {
    ElMessage.error('复制失败，请手动复制');
  }
}

function openUrl(value: string) {
  if (!isValidUrl(value)) return;
  window.open(value, '_blank', 'noopener,noreferrer');
}

function isValidUrl(value: string) {
  try {
    return Boolean(new URL(value.trim()));
  } catch {
    return false;
  }
}

function normalizeAdminPathPreview(value: string) {
  const trimmed = String(value || '/admin').trim().replace(/\/+$/, '') || '/admin';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function validateAdminPath(value: string) {
  const path = normalizeAdminPathPreview(value);
  if (path === '/' || /^\/api(?:\/|$)/i.test(path)) return '管理路径不能为 / 或 /api';
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(path)) return '管理路径只能包含字母、数字、横线、下划线、点和斜杠';
  if (path.includes('//')) return '管理路径不能包含连续斜杠';
  return '';
}

function showError(err: unknown, fallback: string) {
  const message = err instanceof Error && err.message ? err.message : fallback;
  error.value = message;
  ElMessage.error(message);
}

function imageToDataUrl(file: File, maxSize: number) {
  return new Promise<string>((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);
    image.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxSize / Math.max(image.width, image.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('浏览器不支持图片处理'));
      ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Logo 图片读取失败'));
    };
    image.src = url;
  });
}

onMounted(loadSettings);
</script>

<template>
  <div class="operations-page settings-page settings-console-page">
    <div class="page-head operations-page-header">
      <div class="page-head-main">
        <h1 class="page-title">系统配置中心</h1>
        <p>统一管理面板品牌、业务入口、后台访问路径和管理员账号安全。</p>
      </div>
      <div class="page-actions">
        <span v-if="changedModuleCount" class="settings-unsaved-summary"><i></i>{{ changedModuleCount }} 个模块待保存</span>
        <el-button :loading="loading" @click="refreshSettings"><RefreshCw :size="15" />刷新配置</el-button>
      </div>
    </div>

    <el-alert v-if="error" class="page-alert" :title="error" type="error" show-icon closable @close="error = ''" />

    <div class="metric-grid compact-metrics operations-stat-grid settings-overview-grid">
      <div class="metric operations-stat-card"><span class="operations-stat-icon tone-indigo"><Layers3 :size="19" /></span><div><span>配置模块</span><strong>{{ settingsModules.length }}</strong><small>{{ changedModuleCount ? `${changedModuleCount} 项修改待保存` : '所有配置均已同步' }}</small></div></div>
      <div class="metric operations-stat-card"><span class="operations-stat-icon tone-emerald"><ImageIcon :size="19" /></span><div><span>品牌标识</span><strong>{{ brandForm.logoDataUrl ? '完整' : '基础' }}</strong><small>{{ brandForm.logoDataUrl ? '名称与 Logo 已配置' : '当前使用文字标识' }}</small></div></div>
      <div class="metric operations-stat-card"><span class="operations-stat-icon" :class="businessForm.cardPurchaseUrl ? 'tone-cyan' : 'tone-amber'"><Link2 :size="19" /></span><div><span>购买入口</span><strong>{{ businessForm.cardPurchaseUrl ? '已接入' : '未配置' }}</strong><small>{{ businessForm.cardPurchaseUrl ? '用户端入口可展示' : '不会显示购买入口' }}</small></div></div>
      <div class="metric operations-stat-card"><span class="operations-stat-icon tone-rose"><ShieldCheck :size="19" /></span><div><span>后台路径</span><strong class="settings-path-stat" :title="runtimeForm.activeAdminPath">{{ runtimeForm.activeAdminPath }}</strong><small>当前访问地址已生效</small></div></div>
    </div>

    <div class="settings-console-layout">
      <aside class="panel settings-console-navigation">
        <div class="settings-navigation-head">
          <strong>配置模块</strong>
          <span>选择需要管理的设置项</span>
        </div>
        <nav aria-label="系统设置模块">
          <button
            v-for="item in settingsModules"
            :key="item.id"
            type="button"
            class="settings-navigation-item"
            :class="[{ active: activeModuleId === item.id }, `tone-${item.tone}`]"
            @click="activeModuleId = item.id"
          >
            <span class="settings-navigation-icon"><component :is="item.icon" :size="18" /></span>
            <span class="settings-navigation-copy"><strong>{{ item.title }}</strong><small>{{ item.description }}</small></span>
            <span class="settings-navigation-state" :class="moduleStatus(item.id).tone">{{ moduleStatus(item.id).label }}</span>
            <ChevronRight :size="16" class="settings-navigation-arrow" />
          </button>
        </nav>
        <div class="settings-navigation-footer">
          <ShieldCheck :size="16" />
          <span>配置通过鉴权接口保存</span>
        </div>
      </aside>

      <main class="panel settings-console-workspace" v-loading="loading">
        <header class="settings-workspace-head" :class="`tone-${activeModule.tone}`">
          <div class="settings-workspace-title">
            <span><component :is="activeModule.icon" :size="21" /></span>
            <div><strong>{{ activeModule.title }}</strong><small>{{ activeModule.description }}</small></div>
          </div>
          <div class="settings-workspace-meta">
            <span class="settings-api-badge"><b>{{ activeModule.method }}</b>{{ activeModule.endpoint }}</span>
            <span v-if="moduleChanged(activeModule.id)" class="settings-change-badge"><i></i>存在未保存修改</span>
          </div>
        </header>

        <section v-if="activeModuleId === 'brand'" class="settings-workspace-body settings-brand-workspace">
          <div class="settings-form-section">
            <div class="settings-section-heading"><div><strong>品牌信息</strong><span>保存后同步更新管理端、用户端和登录页的品牌展示。</span></div></div>
            <el-form :model="brandForm" label-position="top">
              <el-form-item label="系统名称" required>
                <el-input v-model="brandForm.brandName" maxlength="80" show-word-limit placeholder="请输入系统名称" />
              </el-form-item>
              <el-form-item label="系统 Logo">
                <div class="settings-logo-uploader">
                  <div class="settings-logo-preview">
                    <img v-if="brandForm.logoDataUrl" :src="brandForm.logoDataUrl" alt="系统 Logo" />
                    <span v-else>{{ brandForm.brandName.trim().slice(0, 1) || '十' }}</span>
                  </div>
                  <div class="settings-logo-actions">
                    <label class="settings-file-button">
                      <Upload :size="16" />
                      <span>上传 Logo</span>
                      <input type="file" accept="image/*" @change="onLogoSelected" />
                    </label>
                    <el-button v-if="brandForm.logoDataUrl" @click="brandForm.logoDataUrl = ''"><X :size="15" />清除图片</el-button>
                    <small>支持常见图片格式，最大 3MB，自动缩放至 256px。</small>
                  </div>
                </div>
              </el-form-item>
            </el-form>
          </div>

          <div class="settings-brand-preview-card">
            <span class="settings-preview-label">品牌预览</span>
            <div class="settings-brand-preview-mark">
              <img v-if="brandForm.logoDataUrl" :src="brandForm.logoDataUrl" alt="品牌预览" />
              <span v-else>{{ brandForm.brandName.trim().slice(0, 1) || '十' }}</span>
            </div>
            <strong>{{ brandForm.brandName.trim() || '未命名系统' }}</strong>
            <small>管理控制台</small>
            <div class="settings-preview-status"><i></i>品牌配置预览</div>
          </div>
        </section>

        <section v-else-if="activeModuleId === 'business'" class="settings-workspace-body">
          <div class="settings-form-section settings-form-section-wide">
            <div class="settings-section-heading">
              <div><strong>卡密购买入口</strong><span>该地址将用于用户端购买卡密，留空时用户端不会显示购买入口。</span></div>
              <span class="settings-config-state" :class="businessForm.cardPurchaseUrl ? 'success' : 'neutral'">{{ businessForm.cardPurchaseUrl ? '已配置' : '未配置' }}</span>
            </div>
            <el-form :model="businessForm" label-position="top">
              <el-form-item label="购买页面地址" :error="businessUrlValid ? '' : '请输入完整有效的 URL'">
                <el-input v-model="businessForm.cardPurchaseUrl" type="url" placeholder="https://example.com/buy">
                  <template #prefix><Link2 :size="15" /></template>
                </el-input>
              </el-form-item>
            </el-form>
            <div class="settings-url-preview" :class="{ empty: !businessForm.cardPurchaseUrl }">
              <span><Link2 :size="16" /></span>
              <div><small>当前业务入口</small><strong :title="businessForm.cardPurchaseUrl">{{ businessForm.cardPurchaseUrl || '尚未配置购买地址' }}</strong></div>
              <button v-if="businessForm.cardPurchaseUrl" type="button" title="复制购买地址" @click="copyText(businessForm.cardPurchaseUrl, '购买地址已复制')"><Copy :size="15" /></button>
              <button v-if="businessForm.cardPurchaseUrl && businessUrlValid" type="button" title="打开购买页面" @click="openUrl(businessForm.cardPurchaseUrl)"><ExternalLink :size="15" /></button>
            </div>
          </div>
        </section>

        <section v-else-if="activeModuleId === 'runtime'" class="settings-workspace-body">
          <div class="settings-form-section settings-form-section-wide">
            <div class="settings-section-heading">
              <div><strong>后台访问路径</strong><span>用于隔离管理端入口，修改后新路径会立即生效。</span></div>
              <span class="settings-config-state success">运行中</span>
            </div>
            <div class="settings-runtime-current">
              <span><Route :size="18" /></span>
              <div><small>当前管理地址</small><strong>{{ currentAdminUrl }}</strong></div>
              <button type="button" title="复制当前管理地址" @click="copyText(currentAdminUrl, '管理地址已复制')"><Copy :size="15" /></button>
            </div>
            <el-form :model="runtimeForm" label-position="top">
              <el-form-item label="管理路径" :error="runtimePathError">
                <el-input v-model="runtimeForm.adminPath" maxlength="80" placeholder="/admin">
                  <template #prefix><Route :size="15" /></template>
                </el-input>
              </el-form-item>
            </el-form>
            <div class="settings-runtime-notice" :class="{ changed: runtimePathPreview !== runtimeForm.activeAdminPath }">
              <AlertTriangle :size="17" />
              <div>
                <strong>{{ runtimePathPreview !== runtimeForm.activeAdminPath ? '保存后访问地址将发生变化' : '管理路径与当前生效地址一致' }}</strong>
                <span>{{ runtimePathPreview !== runtimeForm.activeAdminPath ? `新地址：${proposedAdminUrl}` : '请妥善保管后台地址，并避免使用容易猜测的路径。' }}</span>
              </div>
            </div>
          </div>
        </section>

        <section v-else class="settings-workspace-body settings-security-workspace">
          <div class="settings-security-summary">
            <span><ShieldCheck :size="22" /></span>
            <div><strong>管理员账号保护</strong><small>密码修改成功后当前登录状态会失效，需要使用新密码重新登录。</small></div>
          </div>
          <div class="settings-form-section settings-form-section-wide">
            <div class="settings-section-heading"><div><strong>修改登录密码</strong><span>新密码最少 8 位，建议同时包含大小写字母、数字和符号。</span></div></div>
            <el-form :model="passwordForm" label-position="top" autocomplete="off">
              <div class="settings-password-grid">
                <el-form-item label="当前密码" required>
                  <el-input v-model="passwordForm.currentPassword" name="shiye-current-passcode" type="password" show-password autocomplete="current-password" maxlength="256"><template #prefix><LockKeyhole :size="15" /></template></el-input>
                </el-form-item>
                <el-form-item label="新密码" required>
                  <el-input v-model="passwordForm.newPassword" name="shiye-next-passcode" type="password" show-password autocomplete="new-password" minlength="8" maxlength="256"><template #prefix><KeyRound :size="15" /></template></el-input>
                </el-form-item>
              </div>
            </el-form>
            <div class="settings-password-strength" :class="passwordStrength.tone">
              <span>密码强度</span>
              <div><i v-for="index in 3" :key="index" :class="{ active: index <= passwordStrength.score }"></i></div>
              <strong>{{ passwordStrength.label }}</strong>
            </div>
          </div>
        </section>

        <footer class="settings-workspace-footer">
          <span>{{ moduleChanged(activeModule.id) ? '当前模块有尚未保存的修改' : '当前模块配置已同步' }}</span>
          <div>
            <el-button :disabled="!moduleChanged(activeModule.id)" @click="resetActiveModule">撤销修改</el-button>
            <el-button v-if="activeModuleId === 'brand'" type="primary" :loading="savingBrand" :disabled="!brandDirty || !brandForm.brandName.trim()" @click="saveBrand"><Save :size="15" />保存品牌设置</el-button>
            <el-button v-else-if="activeModuleId === 'business'" type="primary" :loading="savingBusiness" :disabled="!businessDirty || !businessUrlValid" @click="saveBusiness"><Save :size="15" />保存业务入口</el-button>
            <el-button v-else-if="activeModuleId === 'runtime'" type="primary" :loading="savingRuntime" :disabled="!runtimeDirty || Boolean(runtimePathError)" @click="saveRuntime"><Save :size="15" />保存管理路径</el-button>
            <el-button v-else type="primary" :loading="changingPassword" :disabled="!passwordForm.currentPassword || passwordForm.newPassword.length < 8" @click="changePassword"><KeyRound :size="15" />修改密码</el-button>
          </div>
        </footer>
      </main>
    </div>
  </div>
</template>
