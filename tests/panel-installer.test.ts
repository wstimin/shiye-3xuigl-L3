import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { parse } from 'dotenv';

const wizard = resolve('scripts/panel-start.mjs');
const pipeline = resolve('scripts/install.mjs');
const wizardSource = readFileSync(wizard, 'utf8');
const runtimeFiles = ['apps/api/dist/main.js', 'dist/admin-web/index.html', 'dist/user-web/index.html'];

async function until<T>(read: () => Promise<T>, accepts: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    try { const value = await read(); if (accepts(value)) return value; } catch {}
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw Error('Fixture did not reach expected state');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'shiye-wizard-'));
  const bin = join(root, 'bin'); await mkdir(bin);
  const runner = join(bin, 'npm-fixture.cjs');
  const apiFixture = "require('node:fs').writeFileSync('.api-started','yes')";
  await writeFile(runner, `const fs=require('node:fs'),path=require('node:path');const args=process.argv.slice(2);fs.appendFileSync('commands.jsonl',JSON.stringify({args,updatedDatabase:process.env.DATABASE_URL?.includes('new-db.invalid'),production:process.env.NODE_ENV==='production'})+'\\n');if(fs.existsSync('.fail')&&args.includes(fs.readFileSync('.fail','utf8').trim()))process.exit(1);if(args[0]==='run'&&args[1]==='install:prod'){for(const file of ${JSON.stringify(runtimeFiles)}){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,file==='apps/api/dist/main.js'?${JSON.stringify(apiFixture)}:'fixture');}}setTimeout(()=>process.exit(0),100);`);
  const launcher = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await writeFile(join(bin, launcher), process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${runner}" %*\r\n`
    : `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${runner}' "$@"\n`, { mode: 0o755 });
  const socket = createServer(); await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, PORT: String(port), NODE_ENV: 'production', DATABASE_URL: 'mysql://old:fixture@old-db.invalid:3306/old', SHIYE_PREBUILT: '' };
  const processes: ChildProcess[] = [];
  return {
    root, port, url: `http://127.0.0.1:${port}`, env,
    start(script = wizard) { const child = spawn(process.execPath, [script], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] }); processes.push(child); return child; },
    async runtime() { for (const file of runtimeFiles) { await mkdir(join(root, file, '..'), { recursive: true }); await writeFile(join(root, file), 'fixture'); } },
    async commands() { return (await readFile(join(root, 'commands.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line)); },
    async close() { for (const child of processes) if (child.exitCode === null && child.signalCode === null) { const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped; } await rm(root, { recursive: true, force: true }); }
  };
}

function config(port: number) {
  return { port: String(port), dbHost: 'new-db.invalid', dbPort: '3306', dbName: 'fixture', dbUser: 'fixture', dbPassword: 'Fixture-db#password', adminUsername: 'fixture-admin', adminPassword: 'Fixture-admin#password', adminPath: '/control-area', publicWebUrl: 'https://fixture.invalid' };
}

test('wizard validates configuration, preserves saved secrets and never publishes passwords in HTML or status', async () => {
  const f = await fixture();
  try {
    f.start(); await until(() => fetch(f.url), r => r.ok);
    const payload = config(f.port);
    for (const patch of [{ port: '65536' }, { port: String(f.port + 1) }, { dbPort: '0' }, { adminPath: '/api/private' }, { adminPath: '/a//b' }, { adminPath: '/a?b' }, { adminPassword: 'short' }, { publicWebUrl: 'https://fixture.invalid/path' }]) {
      const r = await fetch(f.url + '/api/panel-install/config', { method: 'POST', body: JSON.stringify({ ...payload, ...patch }), headers: { 'content-type': 'application/json' } });
      assert.equal(r.status, 400, JSON.stringify(patch));
    }
    for (const body of [payload, { ...payload, dbPassword: '', adminPassword: '' }]) {
      const r = await fetch(f.url + '/api/panel-install/config', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }); assert.equal(r.status, 200);
    }
    const env = parse(await readFile(join(f.root, '.env')));
    assert.equal(env.DEFAULT_ADMIN_PASSWORD, payload.adminPassword);
    assert.equal(new URL(env.DATABASE_URL!).password, encodeURIComponent(payload.dbPassword));
    assert.equal(env.PUBLIC_WEB_URL, payload.publicWebUrl);
    assert.equal(env.ADMIN_PATH, payload.adminPath);
    const status = await (await fetch(f.url + '/api/panel-install/status')).text(), html = await (await fetch(f.url)).text();
    for (const value of [payload.dbPassword, payload.adminPassword]) { assert(!status.includes(value)); assert(!html.includes(value)); }
    assert(html.includes('宝塔 / 1Panel')); assert(html.includes('20.19')); assert(html.includes('shiye:theme:installer'));
  } finally { await f.close(); }
});

test('wizard installation uses development tools and saved environment, blocks concurrent changes and starts the API after restart', async () => {
  const f = await fixture();
  try {
    const child = f.start(); await until(() => fetch(f.url), r => r.ok);
    await fetch(f.url + '/api/panel-install/config', { method: 'POST', body: new URLSearchParams(config(f.port)) });
    assert.equal((await fetch(f.url + '/api/panel-install/run', { method: 'POST' })).status, 200);
    assert.equal((await fetch(f.url + '/api/panel-install/config', { method: 'POST', body: new URLSearchParams(config(f.port)) })).status, 409);
    assert.equal((await fetch(f.url + '/api/panel-install/run', { method: 'POST' })).status, 409);
    assert.equal((await fetch(f.url + '/api/panel-install/run', { method: 'POST' })).status, 409);
    await until(async () => (await (await fetch(f.url + '/api/panel-install/status')).json()), x => x.installed);
    const commands = await f.commands(); assert.deepEqual(commands.map(x => x.args), [['ci', '--include=dev'], ['run', 'install:prod'], ['prune', '--omit=dev']]);
    assert(commands.every(x => x.updatedDatabase && x.production));
    assert.equal((await fetch(f.url + '/api/panel-install/config', { method: 'POST', body: new URLSearchParams(config(f.port)) })).status, 409);
    const stopped = new Promise(resolve => child.once('exit', resolve)); child.kill(); await stopped;
    const started = f.start(); await until(() => readFile(join(f.root, '.api-started'), 'utf8'), x => x === 'yes');
    await new Promise(resolve => started.exitCode !== null ? resolve(null) : started.once('exit', resolve));
    assert.equal(started.exitCode, 0);
  } finally { await f.close(); }
});

test('failed wizard installation remains retryable without an installed marker', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, '.fail'), 'install:prod'); f.start(); await until(() => fetch(f.url), r => r.ok);
    await fetch(f.url + '/panel-install/config', { method: 'POST', body: new URLSearchParams(config(f.port)), redirect: 'manual' });
    await fetch(f.url + '/api/panel-install/run', { method: 'POST' });
    await until(async () => (await (await fetch(f.url + '/api/panel-install/status')).json()), x => x.exitCode === 1 && !x.installing);
    await assert.rejects(access(join(f.root, '.panel-installed')));
    assert.equal((await fetch(f.url + '/api/panel-install/config', { method: 'POST', body: new URLSearchParams(config(f.port)) })).status, 200);
  } finally { await f.close(); }
});

test('ordinary form installation remains functional without browser JavaScript', async () => {
  const f = await fixture();
  try {
    f.start(); await until(() => fetch(f.url), r => r.ok);
    const r = await fetch(f.url + '/panel-install/run', { method: 'POST', body: new URLSearchParams(config(f.port)), redirect: 'manual' });
    assert.equal(r.status, 303);
    await until(async () => (await (await fetch(f.url + '/api/panel-install/status')).json()), x => x.installed);
    const html = await (await fetch(f.url)).text();
    assert(html.includes('安装完成，请重启项目')); assert(!html.includes(config(f.port).adminPassword));
  } finally { await f.close(); }
});

test('manual release installation detects prebuilt files, skips source build and marks completion only after checks', async () => {
  for (const prebuilt of [true, false]) {
    const f = await fixture();
    try {
      if (prebuilt) await f.runtime(); else await mkdir(join(f.root, 'apps/admin-web/src'), { recursive: true });
      const child = f.start(pipeline); await new Promise(resolve => child.once('exit', resolve)); assert.equal(child.exitCode, 0);
      const commands = await f.commands(); assert.equal(commands.some(x => x.args.includes('build')), !prebuilt); assert.equal(commands.some(x => x.args.includes('typecheck')), !prebuilt);
      assert(commands.some(x => x.args.includes('--create-only'))); await access(join(f.root, '.panel-installed'));
    } finally { await f.close(); }
  }
  const f = await fixture();
  try { await f.runtime(); await writeFile(join(f.root, '.fail'), 'deploy:check'); const child = f.start(pipeline); await new Promise(resolve => child.once('exit', resolve)); assert.notEqual(child.exitCode, 0); await assert.rejects(access(join(f.root, '.panel-installed'))); }
  finally { await f.close(); }
});

test('wizard serializes common password punctuation without changing dotenv values', () => {
  const start = wizardSource.indexOf('function escapeEnv('), end = wizardSource.indexOf('function isPlaceholder(');
  const helpers = runInNewContext(wizardSource.slice(start, end) + '; ({escapeEnv, unquote})');
  for (const value of ['a"#b\\path', "a'#b\\path", "a'b\"c#tag", 'a\\nb', ' space password ']) {
    const serialized = helpers.escapeEnv(value); assert.equal(parse('VALUE=' + serialized).VALUE, value); assert.equal(helpers.unquote(serialized), value);
  }
  assert.throws(() => helpers.escapeEnv('injected\nSESSION_SECRET=bad'));
});

test('wizard rejects Node 20 below the current build minimum', () => {
  const start = wizardSource.indexOf('function envIsUsable('), end = wizardSource.indexOf('function startInstaller(');
  for (const [version, ok] of [['20.18.0', false], ['20.19.0', true], ['22.0.0', true]] as const) {
    const result = runInNewContext(wizardSource.slice(start, end) + '; envIsUsable({})', { process: { versions: { node: version } }, existsSync: () => true, envPath: '', criticalSecrets: [], isPlaceholder: () => false });
    assert.equal(result.errors.some((x: string) => x.includes('20.19')), !ok);
  }
});
