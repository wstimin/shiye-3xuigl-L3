import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };
const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8')) as { version: string; packages: Record<string, { version?: string }> };
const adminApp = readFileSync('apps/admin-web/src/App.vue', 'utf8');
const userApp = readFileSync('apps/user-web/src/App.vue', 'utf8');
const installer = readFileSync('scripts/panel-start.mjs', 'utf8');
const healthController = readFileSync('apps/api/src/modules/health/health.controller.ts', 'utf8');
const installScript = readFileSync('install.sh', 'utf8');
const workflow = readFileSync('.github/workflows/build-release.yml', 'utf8');
const deployCheck = readFileSync('scripts/deploy-check.mjs', 'utf8');
const buildInfoScript = readFileSync('scripts/generate-build-info.mjs', 'utf8');

test('all product surfaces use the root release version', () => {
  const version = packageJson.version;
  assert.equal(version, packageLock.version);
  assert.equal(version, packageLock.packages['']?.version);
  assert.match(adminApp, /appVersion = __SHIYE_BUILD_INFO__\.version/);
  assert.match(userApp, /appVersion = __SHIYE_BUILD_INFO__\.version/);
  assert.match(installer, new RegExp(`installerVersion = ['"]${escapeRegex(version)}['"]`));
  assert.match(healthController, /readBuildInfo/);
  assert.match(installScript, /api_health_matches_installed_release/);
  assert.match(installScript, /installed_release_identity/);
  assert.match(installScript, /value\.version, value\.commit, value\.buildTime/);
  assert.match(deployCheck, /verifyFrontendBuildIdentity/);
  assert.match(buildInfoScript, /-dirty/);
});

test('release workflow creates versioned releases without deleting older releases', () => {
  assert.equal(workflow.includes('release_tag="v$(node -p'), true);
  assert.doesNotMatch(workflow, /gh release delete|delete-release/i);
  assert.match(workflow, /Release tag .* already points/);
});

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
