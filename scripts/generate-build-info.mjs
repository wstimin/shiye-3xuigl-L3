import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageMetadata = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const buildInfo = {
  version: String(packageMetadata.version || ''),
  commit: resolveCommit(),
  buildTime: resolveBuildTime()
};

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(buildInfo.version)) {
  throw new Error(`Invalid release version: ${buildInfo.version || '(empty)'}`);
}
if (!buildInfo.commit) throw new Error('Build commit cannot be empty.');
if (!Number.isFinite(Date.parse(buildInfo.buildTime))) throw new Error(`Invalid build time: ${buildInfo.buildTime}`);

writeFileSync(resolve(root, 'build-info.json'), `${JSON.stringify(buildInfo, null, 2)}\n`);
console.log(`Build identity: ${buildInfo.version} ${buildInfo.commit} ${buildInfo.buildTime}`);

function resolveCommit() {
  const configured = String(process.env.SHIYE_BUILD_COMMIT || process.env.GITHUB_SHA || '').trim();
  if (configured) return configured;
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    try {
      execFileSync('git', ['diff', '--quiet', 'HEAD', '--'], { cwd: root, stdio: 'ignore' });
      return commit;
    } catch {
      return `${commit}-dirty`;
    }
  } catch {
    return 'unknown';
  }
}

function resolveBuildTime() {
  const configured = String(process.env.SHIYE_BUILD_TIME || '').trim();
  return configured || new Date().toISOString();
}
