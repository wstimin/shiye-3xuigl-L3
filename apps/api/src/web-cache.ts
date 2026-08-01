import type { Response } from 'express';

export const htmlCacheControl = 'no-store, no-cache, must-revalidate';
export const hashedAssetCacheControl = 'public, max-age=31536000, immutable';

export function setStaticAssetHeaders(response: Response, filePath: string) {
  if (/[\\/]index\.html$/i.test(filePath)) {
    setHtmlNoStore(response);
    return;
  }
  response.setHeader('Cache-Control', isHashedAssetPath(filePath) ? hashedAssetCacheControl : 'no-cache');
}

export function setHtmlNoStore(response: Response) {
  response.setHeader('Cache-Control', htmlCacheControl);
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
}

export function isHashedAssetPath(filePath: string) {
  return /[\\/]assets[\\/]/.test(filePath);
}
