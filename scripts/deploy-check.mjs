import { existsSync, readFileSync } from 'node:fs';

const errors = [];

readRequiredFile('apps/api/dist/main.js');
readRequiredFile('packages/shared/dist/index.js');
readRequiredFile('packages/xui-client/dist/index.js');
readRequiredFile('packages/payment-core/dist/index.js');
const adminIndex = readRequiredFile('dist/admin-web/index.html');
const userIndex = readRequiredFile('dist/user-web/index.html');
const nginxConfig = readRequiredFile('infra/nginx/shiye.conf');
const prismaSchema = readRequiredFile('prisma/schema.prisma');
const syncTaskMigration = readRequiredFile('prisma/migrations/20260801010000_sync_tasks/migration.sql');
const installerScript = readRequiredFile('install.sh');
const migrationCheckScript = readRequiredFile('scripts/check-update-migrations.mjs');
const packageMetadata = JSON.parse(readRequiredFile('package.json') || '{}');
const buildInfo = JSON.parse(readRequiredFile('build-info.json') || '{}');

if (adminIndex) {
  requireMatch(adminIndex, /src="\.\/assets\//, 'Admin build must load JS from relative ./assets/ so ADMIN_PATH can change at runtime.');
  requireMatch(adminIndex, /href="\.\/assets\//, 'Admin build must load CSS from relative ./assets/ so ADMIN_PATH can change at runtime.');
  forbidMatch(adminIndex, /(?:src|href)="\/(?:admin\/)?assets\//, 'Admin build must not reference fixed /admin/assets/ or root /assets/.');
  verifyFrontendBuildIdentity(adminIndex, 'Admin');
}

if (userIndex) {
  requireMatch(userIndex, /src="\/assets\//, 'User build must load JS from /assets/.');
  requireMatch(userIndex, /href="\/assets\//, 'User build must load CSS from /assets/.');
  verifyFrontendBuildIdentity(userIndex, 'User');
}

if (prismaSchema) {
  requireMatch(prismaSchema, /model\s+SyncTask\s*\{/, 'Prisma schema must include the SyncTask model.');
  requireMatch(prismaSchema, /@@map\("sync_tasks"\)/, 'SyncTask must map to the sync_tasks table.');
}

if (syncTaskMigration) {
  requireMatch(syncTaskMigration, /CREATE TABLE[^\n]*sync_tasks/, 'Sync task migration must create the sync_tasks table.');
  requireMatch(syncTaskMigration, /sync_tasks_entityType_entityId_action_key/, 'Sync task migration must enforce one task per entity action.');
}

if (installerScript) {
  requireMatch(installerScript, /prepare_atomic_update()/, 'Installer must prepare updates before stopping the current service.');
  requireMatch(installerScript, /activate_atomic_update()/, 'Installer must activate prepared updates with a short directory switch.');
  requireMatch(installerScript, /rollback_atomic_update()/, 'Installer must restore the previous runtime after failed health checks.');
  requireMatch(installerScript, /installed_release_identity()/, 'Installer must read the staged build identity.');
  requireMatch(installerScript, /value\.version, value\.commit, value\.buildTime/, 'Installer must compare version, commit and build time.');
  requireMatch(installerScript, /shiye-version/, 'Installer must verify the frontend build identity.');
  requireMatch(installerScript, /assert_migrations_are_rollback_compatible()/, 'Installer must reject destructive migrations before automatic switching.');
  requireMatch(installerScript, /node scripts\/check-update-migrations\.mjs/, 'Installer must check only pending database migrations before switching.');
}

if (migrationCheckScript) requireMatch(migrationCheckScript, /_prisma_migrations/, 'Migration safety check must read Prisma migration history.');

if (packageMetadata.version !== '1.0.6') errors.push('Release package version must be 1.0.6.');
if (buildInfo.version !== packageMetadata.version) errors.push('Build identity version must match package.json.');
if (!String(buildInfo.commit || '').trim()) errors.push('Build identity must include a commit.');
if (!Number.isFinite(Date.parse(String(buildInfo.buildTime || '')))) errors.push('Build identity must include a valid build time.');

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

function verifyFrontendBuildIdentity(content, label) {
  const expected = {
    version: String(buildInfo.version || ''),
    commit: String(buildInfo.commit || ''),
    buildTime: String(buildInfo.buildTime || '')
  };
  const actual = {
    version: readMeta(content, 'shiye-version'),
    commit: readMeta(content, 'shiye-commit'),
    buildTime: readMeta(content, 'shiye-build-time')
  };
  for (const key of Object.keys(expected)) {
    if (actual[key] !== expected[key]) errors.push(`${label} build identity ${key} must match build-info.json.`);
  }
}

function readMeta(content, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.match(new RegExp(`<meta[^>]+name=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'))?.[1] || '';
}
