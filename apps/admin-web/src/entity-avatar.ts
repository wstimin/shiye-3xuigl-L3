const entityAvatarPalettes = [
  ['#4338ca', '#6366f1'],
  ['#0369a1', '#0284c7'],
  ['#047857', '#059669'],
  ['#b45309', '#d97706'],
  ['#be185d', '#db2777'],
  ['#6d28d9', '#7c3aed'],
  ['#b91c1c', '#dc2626'],
  ['#0e7490', '#0891b2']
] as const;

export function entityInitial(name: string, fallback: string) {
  return Array.from(name.trim() || fallback.trim())[0]?.toUpperCase() || fallback;
}

export function entityAvatarStyle(name: string, id: string) {
  const seed = id.trim() || name.trim() || 'entity';
  let hash = 0;
  for (const char of Array.from(seed)) {
    hash = ((hash << 5) - hash + (char.codePointAt(0) || 0)) | 0;
  }
  const palette = entityAvatarPalettes[Math.abs(hash) % entityAvatarPalettes.length] || entityAvatarPalettes[0];
  return {
    '--entity-avatar-start': palette[0],
    '--entity-avatar-end': palette[1]
  };
}
