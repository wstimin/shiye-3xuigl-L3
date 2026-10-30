import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { compareVersions, validateRelease, snapshotUpload, packBackup, unpackBackup, migrationEnv, parseEnv, serializeEnv, updateProgress, writeJson } from '../scripts/maintenance-core.mjs';
import { MaintenanceService } from '../apps/api/src/modules/maintenance/maintenance.service.js';
import { maintenanceBackground, maintenanceOperations } from '../apps/api/src/shared/maintenance-state.js';

const secrets = { ENCRYPTION_KEY: 'source-encryption', CARD_HASH_SECRET: 'source-card-hash', JWT_SECRET: 'source-jwt', SESSION_SECRET: 'source-session', DEFAULT_ADMIN_USERNAME: 'original-admin', DEFAULT_ADMIN_PASSWORD: 'original-password' };
async function fixture(fn: (root: string) => Promise<void>) { const root = await mkdtemp(join(tmpdir(), 'shiye-maintenance-')); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
const release = () => ({ tag_name: 'v1.10.0', assets: [{ name: 'shiye-3xuigl.zip', size: 100, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/wstimin/shiye-3xuigl-L3/releases/download/v1.10.0/shiye-3xuigl.zip' }] });

test('uploaded files are privately snapshotted without overwriting existing files', async () => fixture(async root => {
  await writeFile(join(root, 'upload'), 'backup bytes');
  await snapshotUpload(join(root, 'upload'), join(root, 'private'));
  assert.equal(await readFile(join(root, 'private'), 'utf8'), 'backup bytes');
  await assert.rejects(snapshotUpload(join(root, 'upload'), join(root, 'private')));
  await writeFile(join(root, 'empty'), '');
  await assert.rejects(snapshotUpload(join(root, 'empty'), join(root, 'invalid')));
  await assert.rejects(snapshotUpload(root, join(root, 'directory')));
}));

test('release comparison uses numeric versions and rejects malformed versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1); assert.equal(compareVersions('v1.2.0', '1.2.0'), 0); assert.equal(compareVersions('1.1.9', '1.2.0'), -1);
  assert.throws(() => compareVersions('latest', '1.2.0')); assert.throws(() => compareVersions('1.2.0;reboot', '1.2.0'));
});
test('updates accept only a stable official asset with SHA256 and bounded size', () => {
  assert.equal(validateRelease(release(), '1.9.9').hasUpdate, true); assert.equal(validateRelease(release(), '1.10.0').hasUpdate, false);
  for (const mutate of [(r: any) => { r.assets[0].digest = null; }, (r: any) => { r.assets[0].browser_download_url = 'https://evil.invalid/update.zip'; }, (r: any) => { r.prerelease = true; }, (r: any) => { r.assets[0].size = 1024 ** 3; }]) { const value = release(); mutate(value); assert.throws(() => validateRelease(value, '1.0.0')); }
});
test('migration carries decryption and login secrets while preserving target addresses and database', () => {
  const target = { DATABASE_URL: 'mysql://target/db', PUBLIC_WEB_URL: 'https://new.example.com', ADMIN_PATH: '/new-admin', PORT: '3390', SHIYE_MAINTENANCE_DIR: '/target-maintenance', SESSION_SECRET: 'target-session' };
  const result = migrationEnv({ ...secrets, DATABASE_URL: 'mysql://source/db', PUBLIC_WEB_URL: 'https://old.example.com', NODE_OPTIONS: '--require=evil' }, target);
  for (const key of Object.keys(target).filter(key => key !== 'SESSION_SECRET')) assert.equal(result[key], target[key as keyof typeof target]);
  assert.equal(result.ENCRYPTION_KEY, secrets.ENCRYPTION_KEY); assert.equal(result.SESSION_SECRET, secrets.SESSION_SECRET); assert.equal(result.NODE_OPTIONS, undefined);
  assert.throws(() => migrationEnv({ ...secrets, ENCRYPTION_KEY: '' }, target));
  assert.throws(() => migrationEnv({ ...secrets, SESSION_SECRET: 'bad\nNODE_OPTIONS=evil' }, target));
});
test('environment serialization preserves special characters and ignores executable lines', () => {
  const env = { SIMPLE: 'plain', PASSWORD: 'space # hash " quote', URL: 'mysql://u:p@127.0.0.1/db' };
  assert.deepEqual(parseEnv(serializeEnv(env)), env); assert.deepEqual(parseEnv('export PATH=evil\n# ignored\nA=ok'), { A: 'ok' });
});
test('backup round trip retains exact SQL bytes and site metadata', async () => fixture(async root => {
  const sql = Buffer.from("SET NAMES utf8mb4;\nSELECT '测试数据';\n" + 'x'.repeat(256000)); await writeFile(join(root, 'source.sql'), sql);
  await packBackup(join(root, 'source.sql'), join(root, 'site.shiye'), { version: '1.2.0', env: secrets, pendingOperations: 0 });
  const result = await unpackBackup(join(root, 'site.shiye'), join(root, 'restored.sql'));
  assert.deepEqual(await readFile(join(root, 'restored.sql')), sql); assert.equal(result.env.ENCRYPTION_KEY, secrets.ENCRYPTION_KEY); assert.equal(result.sqlSize, sql.length);
}));
test('truncated, altered or foreign backups fail before restoration', async () => fixture(async root => {
  await writeFile(join(root, 'source.sql'), 'SELECT 1;'); await packBackup(join(root, 'source.sql'), join(root, 'valid.shiye'), { version: '1.2.0', env: secrets });
  const valid = await readFile(join(root, 'valid.shiye')); const raw = gunzipSync(valid); raw[raw.length - 1] ^= 1;
  const variants = [valid.subarray(0, valid.length - 8), gzipSync(raw), gzipSync(Buffer.from('foreign file'))];
  for (let i = 0; i < variants.length; i++) { await writeFile(join(root, `bad${i}`), variants[i]!); await assert.rejects(unpackBackup(join(root, `bad${i}`), join(root, `out${i}`))); }
}));
test('rollback keeps update progress frozen and carries independent recovery status', async () => fixture(async root => {
  const path = join(root, 'status.json'); writeJson(path, { state: 'running', progress: 80 });
  updateProgress(path, { state: 'failed', recovery: { state: 'running', message: '正在恢复' } }); updateProgress(path, { progress: 95, message: '恢复检查' });
  const state = JSON.parse(await readFile(path, 'utf8')); assert.equal(state.progress, 80); assert.equal(state.state, 'failed'); assert.equal(state.recovery.state, 'running');
  updateProgress(path, { recovery: { state: 'succeeded' } }); assert.equal(JSON.parse(await readFile(path, 'utf8')).progress, 80);
}));
test('background maintenance drain counts operations and always releases after exceptions', async () => fixture(async root => {
  const before = process.env.SHIYE_MAINTENANCE_DIR; process.env.SHIYE_MAINTENANCE_DIR = root;
  try {
    assert.equal(maintenanceOperations(), 0);
    await assert.rejects(maintenanceBackground(async () => { assert.equal(maintenanceOperations(), 1); throw new Error('test'); })); assert.equal(maintenanceOperations(), 0);
    await writeFile(join(root, 'gate.json'), '{}'); let ran = false; await maintenanceBackground(async () => { ran = true; }); assert.equal(ran, false);
  } finally { if (before === undefined) delete process.env.SHIYE_MAINTENANCE_DIR; else process.env.SHIYE_MAINTENANCE_DIR = before; }
}));
test('maintenance queue rejects concurrent jobs and arbitrary file identifiers', async () => fixture(async root => {
  const before = process.env.SHIYE_MAINTENANCE_DIR; process.env.SHIYE_MAINTENANCE_DIR = root;
  try {
    for (const dir of ['jobs', 'uploads', 'requests']) await mkdir(join(root, dir));
    const service = new MaintenanceService(); (service as any).available = () => true;
    assert.throws(() => service.startUpdate('not-checked'));
    const queued = service.enqueue('backup'); assert.equal(queued.state, 'queued'); assert.throws(() => service.enqueue('backup'), /已有维护/);
    assert.throws(() => service.job('../../etc/passwd')); assert.throws(() => service.download('../../etc/passwd'));
    assert.equal((await readFile(join(root, 'requests', queued.id + '.json'), 'utf8')).includes('backup'), true);
  } finally { if (before === undefined) delete process.env.SHIYE_MAINTENANCE_DIR; else process.env.SHIYE_MAINTENANCE_DIR = before; }
}));
