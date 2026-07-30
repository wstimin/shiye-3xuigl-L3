import type { CSSProperties } from 'vue';

const avatarPalettes = [
  ['#4338ca', '#6366f1'],
  ['#0369a1', '#0284c7'],
  ['#047857', '#059669'],
  ['#b45309', '#d97706'],
  ['#be185d', '#db2777'],
  ['#6d28d9', '#7c3aed'],
  ['#b91c1c', '#dc2626'],
  ['#0e7490', '#0891b2']
] as const;

export function userInitial(value?: string | null) {
  return Array.from(value?.trim() || '用户')[0]?.toUpperCase() || '用';
}

export function userAvatarStyle(value?: string | null): CSSProperties {
  let hash = 0;
  for (const char of Array.from(value?.trim() || '用户')) {
    hash = ((hash << 5) - hash + (char.codePointAt(0) || 0)) | 0;
  }
  const palette = avatarPalettes[Math.abs(hash) % avatarPalettes.length] || avatarPalettes[0];
  return {
    '--avatar-start': palette[0],
    '--avatar-end': palette[1]
  } as CSSProperties;
}
