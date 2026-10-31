import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { sqlStatements } from '../scripts/maintenance-database.mjs';
import { extractRelease } from '../scripts/maintenance-archive.mjs';

async function fixture(fn: (root: string) => Promise<void>) { const root = await mkdtemp(join(tmpdir(), 'shiye-panel-')); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function until(fn: () => Promise<any>, accepts: (result: any) => boolean) { for (let i = 0; i < 200; i++) { try { const result = await fn(); if (accepts(result)) return result; } catch {} await new Promise(ok => setTimeout(ok, 50)); } throw Error('Panel fixture timed out'); }
async function stop(child: ChildProcess) { if (child.exitCode !== null || child.signalCode !== null) return; const done = new Promise(ok => child.once('exit', ok)); child.kill(); await done; }

test('SQL parser preserves quoted semicolons, escaped quotes and mysqldump comments across chunks', async () => fixture(async root => {
  const path = join(root, 'dump.sql');
  const statements = ["-- prefix ; ignored\nSET NAMES utf8mb4;", "\n/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE */;", "\nINSERT INTO `a;b` VALUES ('quote\\\';data', 'double'';quote', X'00ff');", '\n/* block ; */ SELECT 2;'];
  await writeFile(path, statements.join(''));
  const result = []; for await (const sql of sqlStatements(path)) result.push(sql);
  assert.deepEqual(result, statements);
  await writeFile(path, "SELECT '" + 'x'.repeat(65535) + ";still quoted';\nSELECT 2;");
  const split = []; for await (const sql of sqlStatements(path)) split.push(sql); assert.equal(split.length, 2);
  await writeFile(path, "INSERT INTO a VALUES ('truncated"); await assert.rejects(async () => { for await (const _ of sqlStatements(path)) {} }, /不完整/);
}));

function zipEntry(name: string, data = 'hello', mode = 0o100600) {
  const bytes = Buffer.from(data), filename = Buffer.from(name);
  let crc = 0xffffffff; for (const value of bytes) { crc ^= value; for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1; } crc = (crc ^ 0xffffffff) >>> 0;
  const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt32LE(crc, 14); header.writeUInt32LE(bytes.length, 18); header.writeUInt32LE(bytes.length, 22); header.writeUInt16LE(filename.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt32LE(crc, 16); central.writeUInt32LE(bytes.length, 20); central.writeUInt32LE(bytes.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((mode << 16) >>> 0, 38);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(central.length + filename.length, 12); end.writeUInt32LE(header.length + filename.length + bytes.length, 16);
  return Buffer.concat([header, filename, bytes, central, filename, end]);
}
test('release extraction works without unzip and rejects traversal, links and overwrites', async () => fixture(async root => {
  const zip = join(root, 'test.zip'), target = join(root, 'out'); await mkdir(target);
  await writeFile(zip, zipEntry('nested/file')); await extractRelease(zip, target); assert.equal(await readFile(join(target, 'nested/file'), 'utf8'), 'hello'); await assert.rejects(extractRelease(zip, target));
  for (const [name, mode] of [['../escape', 0o100600], ['/absolute', 0o100600], ['link', 0o120777], ['C:/drive', 0o100600]] as const) { await writeFile(zip, zipEntry(name, 'payload', mode)); await assert.rejects(extractRelease(zip, target)); }
}));

test('Linux hosting supervisor restarts its API and retains the selected release after a hosting restart', { skip: process.platform !== 'linux' }, async () => fixture(async root => {
  const socket = createServer(); await new Promise<void>(ok => socket.listen(0, '127.0.0.1', ok)); const port = (socket.address() as any).port; await new Promise<void>(ok => socket.close(() => ok()));
  const data = join(root, '.shiye-maintenance'), requestId = '22222222-2222-4222-8222-222222222222', release = join(data, 'releases', requestId);
  const api = `const http=require('node:http');http.createServer((q,s)=>s.end(JSON.stringify({cwd:process.cwd(),maintenance:process.env.SHIYE_MAINTENANCE_DIR}))).listen(${port},'127.0.0.1');`;
  for (const app of [root, release]) { await mkdir(join(app, 'apps/api/dist'), { recursive: true }); await mkdir(join(app, 'scripts'), { recursive: true }); await writeFile(join(app, 'apps/api/dist/main.js'), api); await writeFile(join(app, '.env'), 'PORT=' + port); await writeFile(join(app, 'build-info.json'), '{}'); }
  await writeFile(join(root, 'scripts/maintenance-worker.mjs'), `import {unlinkSync} from 'node:fs';for(const action of ['stop','switch','start']){await new Promise(ok=>{process.once('message',m=>{if(!m.ok)throw Error(m.message);ok()});process.send({requestId:action,action,appDir:${JSON.stringify(release)}})})}unlinkSync(${JSON.stringify(join(data, 'requests', requestId + '.json'))});process.disconnect();`);
  await writeFile(join(root, 'package.json'), '{"type":"module"}'); // API fixtures use CommonJS in their own scope.
  for (const app of [root, release]) await writeFile(join(app, 'apps/api/dist/package.json'), '{"type":"commonjs"}');
  const host = resolve('scripts/panel-maintenance.mjs');
  const launch = () => spawn(process.execPath, ['--input-type=module', '-e', `import {servePanel} from ${JSON.stringify('file://' + host)};await servePanel(${JSON.stringify(root)});`], { stdio: 'pipe' });
  let child = launch();
  try {
    await until(async () => (await fetch(`http://127.0.0.1:${port}`)).json(), value => value.cwd === root);
    const duplicate = launch(); await new Promise(ok => duplicate.once('exit', ok)); assert.equal(duplicate.exitCode, 1);
    await writeFile(join(data, 'requests', requestId + '.json'), '{}');
    await until(async () => (await fetch(`http://127.0.0.1:${port}`)).json(), value => value.cwd === release && value.maintenance === data);
    await stop(child); child = launch();
    await until(async () => (await fetch(`http://127.0.0.1:${port}`)).json(), value => value.cwd === release);
  } finally { await stop(child); }
}));
