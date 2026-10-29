export function entityInitial(name: string, fallback: string) {
  return Array.from(name.trim() || fallback.trim())[0]?.toUpperCase() || fallback;
}
