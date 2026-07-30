import type { CSSProperties } from 'vue';

const avatarPalettes = [
  ['#6366f1', '#818cf8'],
  ['#0ea5e9', '#38bdf8'],
  ['#059669', '#34d399'],
  ['#d97706', '#fbbf24'],
  ['#db2777', '#f472b6'],
  ['#7c3aed', '#a78bfa'],
  ['#dc2626', '#f87171'],
  ['#0891b2', '#22d3ee']
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
