const mark = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" rx="10" fill="#24221e"/><path d="M27 7a14 14 0 1 0 6 23A14 14 0 0 1 27 7Z" fill="#e0b83a"/><path d="M13 13v14M6 20h14" stroke="#24221e" stroke-width="2.5" stroke-linecap="round"/><circle cx="32" cy="10" r="2.5" fill="#e0b83a"/></svg>';
export function applyBranding(settings: { brandName: string; logoDataUrl: string }, fallback: string) {
  document.title = settings.brandName || fallback;
  let icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!icon) { icon = document.createElement('link'); icon.rel = 'icon'; document.head.appendChild(icon); }
  icon.type = settings.logoDataUrl ? '' : 'image/svg+xml';
  icon.href = settings.logoDataUrl || `data:image/svg+xml,${encodeURIComponent(mark)}`;
}
