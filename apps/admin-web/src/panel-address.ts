export function splitPanelAddress(address: string) {
  let url: URL;
  try { url = new URL(address.trim()); } catch { throw new Error('请粘贴完整面板地址，包含 http:// 或 https://'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('请填写不含账号、查询参数和锚点的 HTTP 或 HTTPS 面板地址');
  return { baseUrl: url.origin, basePath: url.pathname.replace(/^\/+|\/+$/g, '') || undefined };
}

export function fullPanelAddress(baseUrl: string, basePath?: string | null) {
  return `${baseUrl.replace(/\/+$/, '')}${basePath ? '/' + basePath.replace(/^\/+|\/+$/g, '') : ''}/`;
}
