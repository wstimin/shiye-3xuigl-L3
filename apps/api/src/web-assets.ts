import express, { type RequestHandler } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { setStaticAssetHeaders } from './web-cache.js';

export function serveStaticAssets(directory: string): RequestHandler {
  const fallback = express.static(directory, { index: false, setHeaders: setStaticAssetHeaders });
  return (request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method) || !/^\/assets\/[^/\\%]+\.(js|css|svg)$/.test(request.path)) return fallback(request, response, next);
    response.vary('Accept-Encoding');
    const encoding = request.acceptsEncodings('br', 'gzip', 'identity');
    const path = join(directory, request.path);
    const compressed = path + (encoding === 'br' ? '.br' : '.gz');
    if (!['br', 'gzip'].includes(String(encoding)) || !existsSync(compressed)) return fallback(request, response, next);
    response.type(path);
    response.setHeader('Content-Encoding', String(encoding));
    setStaticAssetHeaders(response, path);
    response.sendFile(compressed, error => { if (error) next(error); });
  };
}
