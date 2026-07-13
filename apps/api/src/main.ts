import 'reflect-metadata';
import cookieParser from 'cookie-parser';
import express from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './modules/app.module.js';
import { HttpExceptionFilter } from './shared/http-exception.filter.js';
import { ResponseInterceptor } from './shared/response.interceptor.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true, bodyParser: false });

  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.text({ type: ['text/xml', 'application/xml', '*/xml'], limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: true }));
  app.useGlobalFilters(new HttpExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());

  serveWebApps(app.getHttpAdapter().getInstance());

  const port = Number(process.env.PORT || 3388);
  await app.listen(port, '0.0.0.0');
  console.log(`Shiye API listening on http://0.0.0.0:${port}`);
}

function serveWebApps(server: express.Express) {
  const rootDir = findRuntimeRoot();
  const userWebDir = join(rootDir, 'dist/user-web');
  const adminWebDir = join(rootDir, 'dist/admin-web');
  const adminStatic = express.static(adminWebDir, { index: false });

  if (existsSync(userWebDir)) {
    server.use(express.static(userWebDir, { index: false }));
  }

  if (existsSync(adminWebDir)) {
    server.use((request, response, next) => {
      const adminPath = currentAdminPath();
      if (!isPathWithin(request.path, adminPath)) return next();
      const originalUrl = request.url;
      const stripped = originalUrl.slice(adminPath.length);
      request.url = stripped.startsWith('/') ? stripped : `/${stripped}`;
      adminStatic(request, response, (error?: unknown) => {
        request.url = originalUrl;
        if (error) return next(error);
        return next();
      });
    });
  }

  server.get(/^\/.*$/, (request, response, next) => {
    const adminPath = currentAdminPath();
    if (!isPathWithin(request.path, adminPath)) {
      if (adminPath !== '/admin' && isPathWithin(request.path, '/admin')) {
        return response.status(404).type('text/plain').send('Admin path not found');
      }
      return next();
    }
    const indexFile = join(adminWebDir, 'index.html');
    if (!existsSync(indexFile)) return next();
    return response.type('html').send(renderAdminIndex(indexFile, adminPath));
  });

  server.get(/^\/(?!api(?:\/|$)).*$/, (_request, response, next) => {
    const indexFile = join(userWebDir, 'index.html');
    if (!existsSync(indexFile)) return next();
    return response.sendFile(indexFile);
  });
}

function currentAdminPath() {
  return normalizeAdminPath(process.env.ADMIN_PATH || '/admin');
}

function normalizeAdminPath(value: string) {
  const trimmed = value.trim().replace(/\/+$/, '') || '/admin';
  const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (withLeadingSlash === '/' || /^\/api(?:\/|$)/i.test(withLeadingSlash)) return '/admin';
  return withLeadingSlash;
}

function isPathWithin(path: string, basePath: string) {
  return path === basePath || path.startsWith(`${basePath}/`);
}

function renderAdminIndex(indexFile: string, adminPath: string) {
  const html = readFileSync(indexFile, 'utf8');
  const basePath = `${adminPath}/`.replace(/\/+/g, '/');
  const script = `<base href="${escapeHtml(basePath)}"><script>window.__SHIYE_ADMIN_BASE__=${JSON.stringify(basePath)};</script>`;
  return /<head[^>]*>/i.test(html) ? html.replace(/<head([^>]*)>/i, `<head$1>${script}`) : `${script}${html}`;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[char] || char);
}

function findRuntimeRoot() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    process.cwd(),
    resolve(process.cwd(), '../..'),
    resolve(moduleDir, '../../..')
  ];

  return candidates.find((candidate) => (
    existsSync(join(candidate, 'dist/user-web/index.html')) ||
    existsSync(join(candidate, 'dist/admin-web/index.html'))
  )) || process.cwd();
}

void bootstrap();
