import { existsSync, readFileSync } from 'node:fs';

const errors = [];

readRequiredFile('apps/api/dist/main.js');
readRequiredFile('packages/shared/dist/index.js');
readRequiredFile('packages/xui-client/dist/index.js');
readRequiredFile('packages/payment-core/dist/index.js');
const adminIndex = readRequiredFile('dist/admin-web/index.html');
const userIndex = readRequiredFile('dist/user-web/index.html');
const nginxConfig = readRequiredFile('infra/nginx/shiye.conf');

if (adminIndex) {
  requireMatch(adminIndex, /src="\.\/assets\//, 'Admin build must load JS from relative ./assets/ so ADMIN_PATH can change at runtime.');
  requireMatch(adminIndex, /href="\.\/assets\//, 'Admin build must load CSS from relative ./assets/ so ADMIN_PATH can change at runtime.');
  forbidMatch(adminIndex, /(?:src|href)="\/(?:admin\/)?assets\//, 'Admin build must not reference fixed /admin/assets/ or root /assets/.');
}

if (userIndex) {
  requireMatch(userIndex, /src="\/assets\//, 'User build must load JS from /assets/.');
  requireMatch(userIndex, /href="\/assets\//, 'User build must load CSS from /assets/.');
}

if (nginxConfig) {
  requireMatch(nginxConfig, /location\s+\/\s*{/, 'Nginx must proxy the whole site from /.');
  requireMatch(nginxConfig, /proxy_pass\s+http:\/\/127\.0\.0\.1:3388\s*;/, 'Nginx must proxy the whole site to the Node service on 3388.');
  forbidMatch(nginxConfig, /proxy_pass\s+http:\/\/127\.0\.0\.1:3388\/api\//, 'Nginx must not require a separate /api/ proxy.');
  forbidMatch(nginxConfig, /root\s+\/opt\/shiye\/dist\/user-web/, 'Nginx should not serve frontend static files directly.');
  forbidMatch(nginxConfig, /alias\s+\/opt\/shiye\/dist\/admin-web/, 'Nginx should not require admin static aliases.');
}

if (errors.length) {
  console.error('\nDeploy check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log('Deploy check passed.');

function readRequiredFile(path) {
  if (!existsSync(path)) {
    errors.push(`${path} does not exist. Run npm run build first.`);
    return '';
  }
  return readFileSync(path, 'utf8');
}

function requireMatch(content, pattern, message) {
  if (!pattern.test(content)) errors.push(message);
}

function forbidMatch(content, pattern, message) {
  if (pattern.test(content)) errors.push(message);
}
