import { computed, ref } from 'vue';

type Theme = 'light' | 'dark' | 'system';
const entry = document.documentElement.dataset.themeEntry === 'admin' ? 'admin' : 'user';
let key = `shiye:theme:${entry}`;
function savedTheme(): Theme {
  try {
    const value = localStorage.getItem(key) ?? (entry === 'admin' ? localStorage.getItem('shiye:theme') : null);
    if (value === 'light' || value === 'dark') return value;
  } catch {}
  return 'system';
}
const preference = ref<Theme>(savedTheme());
const media = window.matchMedia('(prefers-color-scheme: dark)');
const systemDark = ref(media.matches);
export const dark = computed(() => preference.value === 'dark' || preference.value === 'system' && systemDark.value);
export const themePreference = preference;
function apply() {
  const value = dark.value ? 'dark' : 'light';
  document.documentElement.dataset.theme = value;
  document.documentElement.classList.toggle('dark', dark.value);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark.value ? '#14171b' : '#f7f8fa');
}
export function setThemeAccount(customerId: string | null) {
  if (entry !== 'user') return;
  key = customerId ? `shiye:theme:user:${encodeURIComponent(customerId)}` : 'shiye:theme:user';
  preference.value = savedTheme();
  apply();
}
export function setTheme(value: Theme) {
  preference.value = value;
  try { localStorage.setItem(key, value); } catch {}
  apply();
}
media.addEventListener('change', event => { systemDark.value = event.matches; apply(); });
window.addEventListener('storage', event => { if (event.key === key || event.key === null) { preference.value = savedTheme(); apply(); } });
apply();
