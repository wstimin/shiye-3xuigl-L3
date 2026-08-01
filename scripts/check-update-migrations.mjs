import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'mysql2/promise';

const unsafePatterns = [
  { label: 'DROP TABLE', pattern: /\bDROP\s+TABLE\b/i },
  { label: 'DROP COLUMN', pattern: /\bDROP\s+COLUMN\b/i },
  { label: 'RENAME TABLE', pattern: /(?:\bRENAME\s+TABLE\b|\bALTER\s+TABLE\b[\s\S]*?\bRENAME\s+(?:TO|AS)\b)/i },
  { label: 'RENAME COLUMN', pattern: /\bRENAME\s+COLUMN\b/i },
  { label: 'TRUNCATE TABLE', pattern: /\bTRUNCATE\s+TABLE\b/i },
  { label: 'ALTER TABLE MODIFY', pattern: /\bALTER\s+TABLE\b[\s\S]*?\bMODIFY\s+(?:COLUMN\s+)?/i },
  { label: 'ALTER TABLE CHANGE', pattern: /\bALTER\s+TABLE\b[\s\S]*?\bCHANGE\s+(?:COLUMN\s+)?/i }
];

export function findUnsafePendingMigrations(migrationsDir, appliedNames) {
  if (!existsSync(migrationsDir)) return [];

  const applied = appliedNames instanceof Set ? appliedNames : new Set(appliedNames);
  const unsafe = [];
  const entries = readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (applied.has(entry.name)) continue;
    const migrationFile = resolve(migrationsDir, entry.name, 'migration.sql');
    if (!existsSync(migrationFile)) continue;

    const sql = stripSqlComments(readFileSync(migrationFile, 'utf8'));
    const operations = unsafePatterns
      .filter(({ pattern }) => pattern.test(sql))
      .map(({ label }) => label);
    if (operations.length) unsafe.push({ name: entry.name, file: migrationFile, operations });
  }

  return unsafe;
}

export async function checkPendingMigrations(root = process.cwd()) {
  const migrationsDir = resolve(root, 'prisma', 'migrations');
  if (!existsSync(migrationsDir)) return [];

  const env = loadEnv(resolve(root, '.env'));
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required to check pending migrations.');

  let connection;
  try {
    connection = await createConnection(env.DATABASE_URL);
    const [rows] = await connection.query(
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'
    );
    const appliedNames = new Set(rows.map((row) => String(row.migration_name)));
    return findUnsafePendingMigrations(migrationsDir, appliedNames);
  } catch (error) {
    if (isMissingMigrationTable(error)) {
      console.log('Prisma migration history is not present; treating this as an initial deployment.');
      return [];
    }
    throw error;
  } finally {
    await connection?.end().catch(() => undefined);
  }
}

function loadEnv(envPath) {
  const values = { ...process.env };
  if (!existsSync(envPath)) return values;

  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    if (values[key] === undefined) values[key] = unquote(trimmed.slice(separator + 1).trim());
  }
  return values;
}

function unquote(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}

function stripSqlComments(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*(?:--|#).*$/gm, ' ');
}

function isMissingMigrationTable(error) {
  return Boolean(error && typeof error === 'object' && (error.code === 'ER_NO_SUCH_TABLE' || error.errno === 1146));
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  try {
    const unsafe = await checkPendingMigrations();
    if (!unsafe.length) {
      console.log('Pending migrations are compatible with automatic rollback.');
    } else {
      console.error('Unsafe pending database migrations were found:');
      for (const migration of unsafe) console.error('- ' + migration.name + ': ' + migration.operations.join(', '));
      console.error('Automatic update stopped before database migration and service switching.');
      process.exitCode = 1;
    }
  } catch (error) {
    console.error('Unable to check pending database migrations: ' + (error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  }
}
