import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { findUnsafePendingMigrations } from '../scripts/check-update-migrations.mjs';

const bash = findBash();
const installer = join(process.cwd(), 'install.sh').replace(/\\/g, '/');

test('install script passes Bash syntax validation', { skip: !bash }, () => {
  const result = spawnSync(bash!, ['-n', installer], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('atomic activation switches to the prepared runtime', { skip: !bash }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiye-atomic-success-'));
  try {
    const app = join(root, 'shiye');
    const stage = join(root, '.shiye.next.test');
    const backup = join(root, '.shiye.previous.test');
    await mkdir(app);
    await mkdir(stage);
    await writeFile(join(app, 'version'), 'old');
    await writeFile(join(stage, 'version'), 'new');
    const result = runBash([
      'systemctl() { return 0; }',
      'wait_for_api_health_soft() { return 0; }',
      'verify_web_routes_soft() { return 0; }',
      "APP_DIR='" + shellQuote(app) + "'",
      "ATOMIC_STAGE='" + shellQuote(stage) + "'",
      "ATOMIC_BACKUP='" + shellQuote(backup) + "'",
      "APP_NAME='shiye-test'",
      "KEEP_PREVIOUS_RELEASE='no'",
      'activate_atomic_update'
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(await readFile(join(app, 'version'), 'utf8'), 'new');
    assert.equal(existsSync(backup), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed health checks restore the previous runtime', { skip: !bash }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiye-atomic-rollback-'));
  try {
    const app = join(root, 'shiye');
    const stage = join(root, '.shiye.next.test');
    const backup = join(root, '.shiye.previous.test');
    await mkdir(app);
    await mkdir(stage);
    await writeFile(join(app, 'version'), 'old');
    await writeFile(join(stage, 'version'), 'new');
    const result = runBash([
      'systemctl() { return 0; }',
      'wait_for_api_health_soft() { [ "$(cat "${APP_DIR}/version")" = "old" ]; }',
      'verify_web_routes_soft() { return 0; }',
      "APP_DIR='" + shellQuote(app) + "'",
      "ATOMIC_STAGE='" + shellQuote(stage) + "'",
      "ATOMIC_BACKUP='" + shellQuote(backup) + "'",
      "APP_NAME='shiye-test'",
      'activate_atomic_update'
    ]);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(join(app, 'version'), 'utf8'), 'old');
    assert.equal(existsSync(backup), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('existing deployment settings keep custom ports and public paths', { skip: !bash }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiye-atomic-env-'));
  try {
    const app = join(root, 'shiye');
    await mkdir(app);
    await writeFile(join(app, '.env'), ['PORT=4512', 'PUBLIC_WEB_URL=https://panel.example.com', 'ADMIN_PATH=/secret-admin', 'DATABASE_URL=mysql://example'].join('\n'));
    const result = runBash([
      'normalize_app_dir() { return 0; }',
      "APP_DIR='" + shellQuote(app) + "'",
      "PORT='3388'",
      "PORT_WAS_SET=''",
      "PUBLIC_WEB_URL=''",
      "ADMIN_PATH=''",
      'load_existing_env_defaults',
      'printf "%s|%s|%s" "${PORT}" "${PUBLIC_WEB_URL}" "${ADMIN_PATH}"'
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.endsWith('4512|https://panel.example.com|/secret-admin'), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('an already applied destructive migration does not block an update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiye-atomic-migration-'));
  try {
    const migrationsDir = join(root, 'prisma', 'migrations');
    const migrationDir = join(migrationsDir, 'already-applied');
    await mkdir(migrationDir, { recursive: true });
    await writeFile(join(migrationDir, 'migration.sql'), 'ALTER TABLE users MODIFY COLUMN legacy VARCHAR(32);');
    assert.deepEqual(findUnsafePendingMigrations(migrationsDir, new Set(['already-applied'])), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a pending destructive migration is rejected before service switching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiye-atomic-unsafe-migration-'));
  try {
    const migrationsDir = join(root, 'prisma', 'migrations');
    const migrationDir = join(migrationsDir, 'pending-unsafe');
    await mkdir(migrationDir, { recursive: true });
    await writeFile(join(migrationDir, 'migration.sql'), 'ALTER TABLE users DROP COLUMN legacy;');
    const unsafe = findUnsafePendingMigrations(migrationsDir, new Set());
    assert.equal(unsafe.length, 1);
    assert.deepEqual(unsafe[0]?.operations, ['DROP COLUMN']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a pending column modification is rejected before service switching', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiye-atomic-modify-migration-'));
  try {
    const migrationsDir = join(root, 'prisma', 'migrations');
    const migrationDir = join(migrationsDir, 'pending-modify');
    await mkdir(migrationDir, { recursive: true });
    await writeFile(join(migrationDir, 'migration.sql'), 'ALTER TABLE users MODIFY COLUMN nickname VARCHAR(128);');
    const unsafe = findUnsafePendingMigrations(migrationsDir, new Set());
    assert.equal(unsafe.length, 1);
    assert.deepEqual(unsafe[0]?.operations, ['ALTER TABLE MODIFY']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a pending additive migration remains eligible for atomic update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'shiye-atomic-safe-migration-'));
  try {
    const migrationsDir = join(root, 'prisma', 'migrations');
    const migrationDir = join(migrationsDir, 'pending-safe');
    await mkdir(migrationDir, { recursive: true });
    await writeFile(join(migrationDir, 'migration.sql'), 'ALTER TABLE users ADD COLUMN nickname VARCHAR(64);');
    assert.deepEqual(findUnsafePendingMigrations(migrationsDir, new Set()), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runBash(lines: string[]) {
  const script = ['export SHIYE_INSTALL_LIBRARY_ONLY=1', "source '" + shellQuote(installer) + "'", ...lines].join('\n');
  return spawnSync(bash!, ['-lc', script], { encoding: 'utf8' });
}

function shellQuote(value: string) {
  return value.replace(/'/g, "'\\''");
}

function findBash() {
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe']
    : ['/bin/bash', '/usr/bin/bash'];
  return candidates.find((candidate) => existsSync(candidate));
}
