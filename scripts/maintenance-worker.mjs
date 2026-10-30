import { createWriteStream, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, chmodSync, chownSync, copyFileSync, lstatSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { JOB_ID, compareVersions, readJson, writeJson, updateProgress, latestRelease, fileHash, snapshotUpload, packBackup, unpackBackup, parseEnv, migrationEnv, serializeEnv } from './maintenance-core.mjs';

const config = readJson(process.argv[2] || '/etc/shiye-maintenance.json');
const root = config.dataDir;
const app = config.appDir;
let statePath, log;
function progress(stage, value, message) { return updateProgress(statePath, { stage, progress: value, message }); }
function env() { return parseEnv(readFileSync(join(app, '.env'), 'utf8')); }
function build() { return readJson(join(app, 'build-info.json')); }
function run(command, args, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: app, env: { ...process.env, ...(options.appUser ? { HOME: app } : {}), ...options.env }, detached: true, uid: options.appUser ? config.uid : undefined, gid: options.appUser ? config.gid : undefined, stdio: ['pipe', 'pipe', 'pipe'] });
    let interrupted = false;
    const interrupt = () => { interrupted = true; try { process.kill(-child.pid, 'SIGTERM'); } catch {} };
    const chunks = []; let size = 0;
    if (options.output) child.stdout.pipe(options.output);
    else child.stdout.on('data', part => { if ((size += part.length) < 1024 * 1024) chunks.push(part); });
    child.stderr.on('data', part => log?.write(part));
    const timer = setTimeout(() => { interrupt(); setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5000).unref(); }, options.timeout || 15 * 60_000);
    child.on('error', () => { clearTimeout(timer); reject(new Error(options.error || '维护命令无法启动')); });
    child.on('close', code => { clearTimeout(timer); code === 0 && !interrupted ? resolveRun(Buffer.concat(chunks).toString().trim()) : reject(new Error(options.error || '维护命令执行失败')); });
    if (options.output) options.output.once('error', interrupt);
    if (options.input) { options.input.on('error', interrupt); options.input.pipe(child.stdin); }
    else child.stdin.end();
    child.stdin.on('error', () => {});
  });
}
async function mysqlArgs(values) {
  const url = new URL(values.DATABASE_URL);
  if (url.protocol !== 'mysql:' || !/^\/[A-Za-z0-9_$-]+$/.test(url.pathname)) throw new Error('不支持的数据库连接配置');
  return { args: ['--protocol=TCP', '--host=' + url.hostname, '--port=' + (url.port || '3306'), '--user=' + decodeURIComponent(url.username), '--default-character-set=utf8mb4', url.pathname.slice(1)], env: { MYSQL_PWD: decodeURIComponent(url.password) } };
}
async function database(sql, values = env()) {
  const options = await mysqlArgs(values);
  return run(config.mysql, [...options.args, '--batch', '--skip-column-names', '--binary-mode=1', '--local-infile=0', '--execute', sql], { env: options.env, appUser: true, error: '无法检查数据库状态' });
}
async function dump(path, values = env()) {
  const options = await mysqlArgs(values);
  const output = createWriteStream(path, { flags: 'wx', mode: 0o600 });
  const finished = new Promise((ok, bad) => { output.on('finish', ok); output.on('error', bad); });
  try { await Promise.all([run(config.dump, [...options.args.slice(0, -1), '--single-transaction', '--quick', '--hex-blob', '--no-tablespaces', '--skip-add-locks', '--skip-comments', options.args.at(-1)], { env: options.env, output, appUser: true, error: '数据库备份失败' }), finished]); }
  catch (error) { output.destroy(); throw error; }
}
async function importSql(path, values) {
  const options = await mysqlArgs(values);
  const tables = JSON.parse(await database("SELECT COALESCE(JSON_ARRAYAGG(TABLE_NAME),JSON_ARRAY()) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE'", values));
  if (!Array.isArray(tables) || !tables.every(name => typeof name === 'string')) throw new Error('无法检查目标数据库表');
  if (tables.length) await database('SET FOREIGN_KEY_CHECKS=0; DROP TABLE ' + tables.map(name => '`' + name.replaceAll('`', '``') + '`').join(',') + '; SET FOREIGN_KEY_CHECKS=1;', values);
  await run(config.mysql, [...options.args, '--binary-mode=1', '--local-infile=0'], { env: options.env, input: createReadStream(path), appUser: true, error: '数据库恢复失败' });
}
async function assertSettled() {
  const count = await database("SELECT (SELECT COUNT(*) FROM renewal_logs WHERE status='pending') + (SELECT COUNT(*) FROM external_card_redemptions WHERE status IN ('processing','activated','unknown'))");
  if (Number(count) !== 0) throw new Error('仍有未完成的续费或卡密核销，请先处理后再维护');
}
async function drain() {
  writeJson(join(root, 'gate.json'), { id: readJson(statePath).id });
  for (let i = 0; i < 120; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${env().PORT || 3388}/api/health`, { signal: AbortSignal.timeout(2500) });
      const result = await response.json();
      if (result.data?.maintenanceOperations === 0) return;
    } catch {}
    await new Promise(ok => setTimeout(ok, 1000));
  }
  throw new Error('现有业务操作尚未完成，已停止维护，请稍后重试');
}
async function health(expected = build()) {
  const values = env();
  for (let i = 0; i < 40; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${values.PORT || 3388}/api/health`, { signal: AbortSignal.timeout(2000) });
      const result = await response.json();
      if (response.ok && result.data?.version === expected.version && result.data?.commit === expected.commit) {
        for (const path of ['/', (values.ADMIN_PATH || '/admin') + '/']) {
          const page = await fetch(`http://127.0.0.1:${values.PORT || 3388}${path}`, { signal: AbortSignal.timeout(3000) });
          if (!page.ok || !(await page.text()).includes(`content="${expected.version}"`)) throw new Error('网页版本未就绪');
        }
        return;
      }
    } catch {}
    await new Promise(ok => setTimeout(ok, 1000));
  }
  throw new Error('网站健康检查未通过');
}
async function backup(dir) {
  await drain(); await assertSettled();
  progress('database', 30, '正在一致性备份数据库');
  await dump(join(dir, 'database.sql'));
  progress('archive', 75, '正在打包站点数据和解密密钥');
  const info = build(), values = env();
  const result = await packBackup(join(dir, 'database.sql'), join(dir, 'backup.shiye'), { ...info, createdAt: new Date().toISOString(), env: values, siteUrl: values.PUBLIC_WEB_URL || '', pendingOperations: 0 });
  chmodSync(join(dir, 'backup.shiye'), 0o640); unlinkSync(join(dir, 'database.sql'));
  return { version: result.version, createdAt: result.createdAt, bytes: lstatSync(join(dir, 'backup.shiye')).size, downloadReady: true };
}
async function inspect(dir, id) {
  const source = join(root, 'uploads', id);
  // Keep an immutable private copy before validation; the web process owns uploads.
  await snapshotUpload(source, join(dir, 'upload.shiye')); unlinkSync(source);
  progress('verify', 40, '正在校验备份完整性');
  const header = await unpackBackup(join(dir, 'upload.shiye'), join(dir, 'source.sql'));
  migrationEnv(header.env, env());
  if (header.pendingOperations !== 0) throw new Error('此备份包含未完成的业务操作，不能迁移');
  if (compareVersions(header.version, build().version) > 0) throw new Error('备份版本高于当前系统，请先更新本站再上传');
  writeJson(join(dir, 'source.json'), header); chmodSync(join(dir, 'source.json'), 0o600);
  return { version: header.version, createdAt: header.createdAt, siteUrl: header.siteUrl, bytes: header.sqlSize, inspectionId: id };
}
async function restore(dir, request) {
  if (!JOB_ID.test(request.inspectionId || '')) throw new Error('请先上传并校验备份');
  const source = join(root, 'jobs', request.inspectionId), status = readJson(join(source, 'status.json'));
  if (status.kind !== 'inspect' || status.state !== 'succeeded' || Date.now() - Date.parse(status.createdAt) > 86400000) throw new Error('备份校验已失效，请重新上传');
  const header = readJson(join(source, 'source.json')), oldEnv = env(), oldEnvText = readFileSync(join(app, '.env'), 'utf8'), expected = build();
  const next = migrationEnv(header.env, oldEnv);
  if (compareVersions(header.version, expected.version) > 0) throw new Error('请先更新本站版本');
  await drain(); await assertSettled();
  progress('safety-backup', 15, '正在保留本站恢复前的数据');
  await dump(join(dir, 'before.sql')); writeFileSync(join(dir, 'before.env'), oldEnvText, { mode: 0o600 });
  let changed = false;
  try {
    progress('restore', 40, '正在恢复数据库和站点密钥');
    await run('systemctl', ['stop', config.service]); changed = true;
    await importSql(join(source, 'source.sql'), oldEnv);
    writeFileSync(join(app, '.env'), serializeEnv(next), { mode: 0o600 }); chownSync(join(app, '.env'), config.uid, config.gid);
    progress('migrate', 65, '正在适配当前版本和新服务器地址');
    await run(process.execPath, [join(app, 'node_modules/prisma/build/index.js'), 'migrate', 'deploy', '--schema', join(app, 'prisma/schema.prisma')], { appUser: true, env: next, error: '数据库版本适配失败' });
    const adminPath = String(oldEnv.ADMIN_PATH || '/admin').replaceAll("'", "''");
    await database(`UPDATE system_settings SET value=JSON_OBJECT('adminPath','${adminPath}') WHERE \`key\`='runtime'`, next);
    progress('restart', 85, '正在启动迁移后的网站');
    await run('systemctl', ['start', config.service]); await health(expected);
    return { loginRequired: true, adminPath: oldEnv.ADMIN_PATH || '/admin', version: expected.version };
  } catch (error) {
    if (changed) {
      updateProgress(statePath, { state: 'failed', message: '迁移失败', recovery: { state: 'running', message: '正在独立恢复迁移前的数据' } });
      try {
        await run('systemctl', ['stop', config.service]); await importSql(join(dir, 'before.sql'), oldEnv);
        writeFileSync(join(app, '.env'), oldEnvText, { mode: 0o600 }); chownSync(join(app, '.env'), config.uid, config.gid);
        await run('systemctl', ['start', config.service]); await health(expected);
        updateProgress(statePath, { recovery: { state: 'succeeded', message: '已恢复迁移前的网站和数据' } });
      } catch { updateProgress(statePath, { recovery: { state: 'failed', message: '自动恢复未通过检查，恢复前备份已保留，请联系管理员' } }); }
    }
    throw error;
  }
}
async function update(dir, request) {
  const previous = build(), release = await latestRelease(previous.version);
  if (!release.hasUpdate || release.version !== request.version || release.sha256 !== request.sha256) throw new Error('检测结果已变化，请重新检测最新版后再更新');
  await drain(); await assertSettled();
  progress('safety-backup', 8, '正在保存更新前的数据库和配置');
  await dump(join(dir, 'before.sql')); copyFileSync(join(app, '.env'), join(dir, 'before.env')); chmodSync(join(dir, 'before.env'), 0o600);
  progress('download', 12, '正在下载已检测的官方发布包');
  const response = await fetch(release.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw new Error('发布包下载失败');
  let bytes = 0, last = 12;
  async function* download() { for await (const part of Readable.fromWeb(response.body)) { bytes += part.length; if (bytes > release.size) throw new Error('发布包大小不符'); const value = 12 + Math.floor(bytes / release.size * 20); if (value > last) { last = value; progress('download', value, '正在下载官方发布包'); } yield part; } }
  const zip = join(dir, 'release.zip'); await pipeline(Readable.from(download()), createWriteStream(zip, { flags: 'wx', mode: 0o600 }));
  if (bytes !== release.size || await fileHash(zip) !== release.sha256) throw new Error('发布包完整性校验失败，未修改网站');
  progress('verify', 36, '校验完成，正在准备更新文件');
  const entries = await run('unzip', ['-Z1', zip]);
  if (entries.split('\n').some(name => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) throw new Error('发布包目录无效');
  const target = join(dir, 'release'); mkdirSync(target); await run('unzip', ['-q', zip, '-d', target]);
  const identity = readJson(join(target, 'build-info.json'));
  if (identity.version !== release.version || !/^[a-f0-9]{40}$/.test(identity.commit)) throw new Error('发布包版本身份不符');
  try {
    const values = env();
    await run('bash', [join(target, 'install.sh')], { env: { APP_DIR: app, APP_NAME: config.service, INSTALL_SOURCE: 'prebuilt', KEEP_PREVIOUS_RELEASE: 'yes', ENABLE_NGINX: 'no', ENABLE_HTTPS: 'no', PORT: values.PORT || '3388', MAINTENANCE_STATUS_FILE: statePath, MAINTENANCE_PROGRESS_SCRIPT: join(config.helperDir, 'maintenance-progress.mjs'), MAINTENANCE_RUNTIME_BACKUP: `${app}.maintenance-${readJson(statePath).id}` }, error: '更新未完成，请查看恢复状态' });
    await health(identity);
    return { version: identity.version, commit: identity.commit };
  } catch (error) {
    const current = readJson(statePath);
    if (!current.recovery) {
      // The installer switches files atomically; pre-switch failures leave the old site intact.
      updateProgress(statePath, { state: 'failed', recovery: { state: 'running', message: '正在独立检查并恢复原版本' } });
      try { await health(previous); updateProgress(statePath, { recovery: { state: 'succeeded', message: '原版本仍正常运行' } }); }
      catch {
        updateProgress(statePath, { state: 'failed', recovery: { state: 'running', message: '正在独立恢复原版本' } });
        try {
          const candidates = [`${app}.maintenance-${readJson(statePath).id}`, `${app}.previous`];
          const saved = candidates.find(path => { try { const value = readJson(join(path, 'build-info.json')); return value.version === previous.version && value.commit === previous.commit; } catch { return false; } });
          if (!saved) throw new Error('原运行目录不可用');
          await run('systemctl', ['stop', config.service]);
          if (existsSync(app)) renameSync(app, `${app}.failed-${readJson(statePath).id}`);
          renameSync(saved, app); await run('systemctl', ['start', config.service]); await health(previous);
          updateProgress(statePath, { recovery: { state: 'succeeded', message: '已恢复原版本，网站运行正常' } });
        } catch { updateProgress(statePath, { recovery: { state: 'failed', message: '原站健康检查失败，更新前备份已保留' } }); }
      }
    }
    throw error;
  }
}
async function processRequest(file) {
  const id = file.slice(0, -5);
  if (!JOB_ID.test(id)) { unlinkSync(join(root, 'requests', file)); return; }
  const dir = join(root, 'jobs', id);
  if (existsSync(dir)) {
    const path = join(dir, 'status.json');
    if (existsSync(path)) updateProgress(path, { state: 'failed', message: '维护进程意外中断，请检查原站状态', recovery: { state: 'failed', message: '原备份已保留，不会自动重复导入或扣款' } });
    unlinkSync(join(root, 'requests', file));
    if (existsSync(join(root, 'gate.json'))) unlinkSync(join(root, 'gate.json'));
    return;
  }
  mkdirSync(dir, { mode: 0o2750 }); chownSync(dir, 0, config.gid); chmodSync(dir, 0o2750);
  statePath = join(dir, 'status.json'); log = createWriteStream(join(dir, 'private.log'), { mode: 0o600 });
  try {
    const path = join(root, 'requests', file), info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('维护请求无效');
    const request = readJson(path);
    if (!['update', 'backup', 'inspect', 'restore'].includes(request.kind)) throw new Error('维护操作无效');
    if (['update', 'restore'].includes(request.kind) && request.confirmed !== true) throw new Error('维护操作尚未确认');
    writeJson(statePath, { id, kind: request.kind, state: 'running', stage: 'prepare', progress: 2, message: '正在准备', createdAt: new Date().toISOString() });
    const result = request.kind === 'backup' ? await backup(dir) : request.kind === 'inspect' ? await inspect(dir, id) : request.kind === 'restore' ? await restore(dir, request) : await update(dir, request);
    updateProgress(statePath, { state: 'succeeded', stage: 'complete', progress: 100, message: '已完成', result });
  } catch (error) {
    log.write(String(error?.stack || error));
    if (!existsSync(statePath)) writeJson(statePath, { id, state: 'failed', progress: 0, createdAt: new Date().toISOString() });
    updateProgress(statePath, { state: 'failed', message: String(error?.message || '维护失败').slice(0, 400) });
  } finally {
    if (existsSync(join(root, 'gate.json'))) unlinkSync(join(root, 'gate.json'));
    if (existsSync(join(root, 'requests', file))) unlinkSync(join(root, 'requests', file));
    log.end();
  }
}
if (process.getuid?.() !== 0) throw new Error('维护服务必须由 systemd 运行');
if (!resolve(app).startsWith('/') || resolve(app) === '/' || !/^[a-zA-Z0-9_-]+$/.test(config.service)) throw new Error('维护安装配置无效');
for (const id of readdirSync(join(root, 'jobs')).filter(name => JOB_ID.test(name))) {
  const dir = join(root, 'jobs', id);
  try { const job = readJson(join(dir, 'status.json')); if (['succeeded', 'failed'].includes(job.state) && job.recovery?.state !== 'running' && Date.now() - Date.parse(job.createdAt) > 7 * 86400000) rmSync(dir, { recursive: true }); } catch {}
}
for (const file of readdirSync(join(root, 'requests')).filter(name => name.endsWith('.json')).sort()) await processRequest(file);
