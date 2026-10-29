export function normalizeBase64(value: string) {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  return normalized.padEnd(normalized.length + (4 - normalized.length % 4) % 4, '=');
}

export function readableIdentifier(value: string, fallback: string, maxLength: number) {
  const normalized = String(value || '').normalize('NFKC').trim()
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return truncateText(normalized || fallback, maxLength);
}

export function xuiObject(data: unknown): Record<string, unknown> {
  const parsed = parseMaybeJson(data);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  return {};
}

export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() || undefined : undefined;
}

export function truncateText(value: string, maxLength: number) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}


export function hostFromUrl(value: string) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

export function positiveInteger(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

export function stringList(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  const text = stringValue(value);
  return text ? [text] : [];
}
