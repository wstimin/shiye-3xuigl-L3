import { computed, ref } from 'vue';

type Theme = 'light' | 'dark' | 'system';
const key = 'shiye:theme';
function savedTheme(): Theme {
  try { const value = localStorage.getItem(key); if (value === 'light' || value === 'dark') return value; } catch {}
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark.value ? '#1a1916' : '#f7f5f2');
}
export function setTheme(value: Theme) {
  preference.value = value;
  try { if (value === 'system') localStorage.removeItem(key); else localStorage.setItem(key, value); } catch {}
  apply();
}
media.addEventListener('change', event => { systemDark.value = event.matches; apply(); });
window.addEventListener('storage', event => { if (event.key === key) { preference.value = savedTheme(); apply(); } });
apply();
