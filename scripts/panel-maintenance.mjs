import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { readJson, writeJson, parseEnv, JOB_ID } from './maintenance-core.mjs';

// The hosting panel owns this supervisor; only its API child is restarted during maintenance.
export async function servePanel(base, inherited = process.env) {
  const dataDir = join(base, '.shiye-maintenance');
  for (const name of ['', 'jobs', 'uploads', 'requests', 'releases']) mkdirSync(join(dataDir, name), { recursive: true, mode: 0o700 });
  const pointer = join(dataDir, 'active.json'), configPath = join(dataDir, 'host.json'), ready = join(dataDir, 'ready.json');
  const token = pid => { try { return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return ''; } };
  try { const old = readJson(configPath); if (old.pid && old.token && token(old.pid) === old.token) throw Error('此项目已有维护主进程，请先停止重复的 Node.js 项目'); } catch (error) { if (error.message.includes('已有维护主进程')) throw error; }
  let app = existsSync(pointer) ? readJson(pointer).appDir : base;
  function validate(path) {
    if (path !== base && (!relative(join(dataDir, 'releases'), path) || relative(join(dataDir, 'releases'), path).startsWith('..') || resolve(path) !== path)) throw Error('运行版本路径无效');
    for (const file of ['apps/api/dist/main.js', '.env', 'build-info.json']) if (!existsSync(join(path, file))) throw Error('运行版本文件不完整');
  }
  validate(app);
  let api, worker, stopping = false, changing = false, operation = Promise.resolve();
  const config = () => ({ provider: 'panel', appDir: app, baseDir: base, dataDir, port: inherited.PORT, uid: process.getuid(), gid: process.getgid(), pid: process.pid, token: token(process.pid) });
  function heartbeat() { writeJson(ready, { protocol: 1, provider: 'panel', updatedAt: new Date().toISOString() }); }
  function start() {
    validate(app); writeJson(configPath, config());
    if (app !== base) copyFileSync(join(app, '.env'), join(base, '.env'));
    const values = parseEnv(readFileSync(join(app, '.env'), 'utf8'));
    api = spawn(process.execPath, [join(app, 'apps/api/dist/main.js')], { cwd: app, env: { ...inherited, ...values, ...(inherited.PORT ? { PORT: inherited.PORT } : {}), ...(inherited.HOST ? { HOST: inherited.HOST } : {}), SHIYE_MAINTENANCE_DIR: dataDir }, stdio: 'inherit' });
    api.once('error', () => shutdown(1));
    api.once('exit', code => { api = undefined; if (!changing && !stopping && !worker) shutdown(code ?? 1); });
  }
  async function stop() {
    if (!api) return;
    const child = api;
    await new Promise(ok => { const timer = setTimeout(() => child.kill('SIGKILL'), 20_000); child.once('exit', () => { clearTimeout(timer); ok(); }); child.kill('SIGTERM'); });
  }
  async function shutdown(code) {
    if (stopping) return; stopping = true; clearInterval(timer);
    try { unlinkSync(ready); } catch {}
    worker?.kill('SIGTERM'); await stop();
    try { unlinkSync(configPath); } catch {}
    process.exitCode = code;
  }
  function tick() {
    if (stopping) return;
    heartbeat();
    if (worker || !readdirSync(join(dataDir, 'requests')).some(name => JOB_ID.test(name.slice(0, -5)) && name.endsWith('.json'))) return;
    writeJson(configPath, config());
    worker = spawn(process.execPath, [join(app, 'scripts/maintenance-worker.mjs'), configPath], { cwd: app, env: { ...inherited, ...parseEnv(readFileSync(join(app, '.env'), 'utf8')) }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    worker.on('message', message => {
      operation = operation.then(async () => {
        if (stopping) return;
        if (!['stop', 'start', 'switch'].includes(message?.action)) return;
        try {
          changing = true;
          if (message.action === 'stop') await stop();
          if (message.action === 'switch') { if (api) throw Error('请先停止网站再切换版本'); validate(message.appDir); app = message.appDir; writeJson(pointer, { appDir: app }); writeJson(configPath, config()); }
          if (message.action === 'start') { if (api) throw Error('网站进程仍在运行'); start(); changing = false; }
          worker?.send({ requestId: message.requestId, ok: true });
        } catch (error) { worker?.send({ requestId: message.requestId, ok: false, message: error.message }); }
      });
    });
    worker.once('error', error => console.error('维护任务无法启动：', error.message));
    worker.once('close', () => { worker = undefined; if (!stopping && !api) { changing = false; start(); } });
  }
  const timer = setInterval(tick, 1000);
  process.once('SIGTERM', () => shutdown(0)); process.once('SIGINT', () => shutdown(0));
  heartbeat(); start(); tick();
}
