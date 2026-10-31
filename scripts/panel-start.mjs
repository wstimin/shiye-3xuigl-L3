import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve } from 'node:path';

const root = process.cwd();
const envPath = resolve(root, '.env');
const installedMarkerPath = resolve(root, '.panel-installed');
const criticalSecrets = ['SESSION_SECRET', 'JWT_SECRET', 'ENCRYPTION_KEY', 'CARD_HASH_SECRET'];
const installerVersion = '1.12.6';
const requiredFiles = [
  'apps/api/dist/main.js',
  'dist/user-web/index.html',
  'dist/admin-web/index.html'
];

const state = {
  installing: false,
  installed: false,
  exitCode: null,
  startedAt: null,
  endedAt: null,
  logs: []
};

const env = loadEnv();

if (isReady(env)) {
  console.log('已完成安装，正在启动正式网站。');
  await runApi();
} else {
  startInstaller(env);
}

function isReady(values) {
  return existsSync(installedMarkerPath) && requiredFiles.every((file) => existsSync(resolve(root, file))) && envIsUsable(values).ok;
}

function envIsUsable(values) {
  const errors = [];
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 20 || major === 20 && minor < 19) errors.push('需要 Node.js 20.19 或更新版本，请在宝塔 / 1Panel 中切换运行环境。');
  if (!existsSync(envPath)) errors.push('.env 文件不存在。');
  if (!values.DATABASE_URL || isPlaceholder(values.DATABASE_URL)) errors.push('DATABASE_URL 缺失或仍是占位值。');
  for (const name of criticalSecrets) {
    const value = values[name] || '';
    if (!value || isPlaceholder(value)) errors.push(`${name} 缺失或仍是占位值。`);
    if (secretByteLength(value) < 32) errors.push(`${name} 至少需要 32 字节。`);
  }
  return { ok: errors.length === 0, errors };
}

function startInstaller(initialEnv) {
  const port = Number(process.env.PORT || initialEnv.PORT || 3388);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);

      if (request.method === 'GET' && (url.pathname === '/' || url.pathname === '/panel-install')) {
        return sendHtml(response, flashFromUrl(url));
      }
      if (request.method === 'GET' && url.pathname === '/panel-install.js') return sendJs(response);
      if (request.method === 'GET' && url.pathname === '/api/panel-install/status') return sendJson(response, getStatus());

      if (request.method === 'POST' && url.pathname === '/api/panel-install/config') return saveConfigApi(request, response);
      if (request.method === 'POST' && url.pathname === '/api/panel-install/run') return runInstallApi(response);
      if (request.method === 'POST' && url.pathname === '/panel-install/config') return saveConfigPage(request, response);
      if (request.method === 'POST' && url.pathname === '/panel-install/run') return runInstallPage(request, response);

      if (wantsHtml(request)) return sendHtml(response, { type: 'error', message: '访问路径不存在。' }, 404);
      response.writeHead(404, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ message: 'Not found' }));
    } catch (error) {
      if (wantsHtml(request)) return sendHtml(response, { type: 'error', message: errorMessage(error) }, 500);
      sendJson(response, { ok: false, message: errorMessage(error) }, 500);
    }
  });

  server.listen(port, process.env.HOST || initialEnv.HOST || '0.0.0.0', () => {
    console.log(`宝塔 / 1Panel 安装向导已启动，端口 ${port}。`);
    console.log(`请访问 http://服务器地址:${port} 完成安装。`);
  });
}

function getStatus() {
  const currentEnv = loadEnv();
  const envStatus = envIsUsable(currentEnv);
  const missingFiles = requiredFiles.filter((file) => !existsSync(resolve(root, file)));
  const status = {
    version: installerVersion,
    nodeVersion: process.versions.node,
    envExists: existsSync(envPath),
    ready: isReady(currentEnv),
    installedMarker: existsSync(installedMarkerPath),
    envOk: envStatus.ok,
    envErrors: envStatus.errors,
    missingFiles,
    installing: state.installing,
    installed: state.installed,
    exitCode: state.exitCode,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    logs: state.logs.slice(-240),
    defaults: {
      port: process.env.PORT || currentEnv.PORT || '3388',
      publicWebUrl: isPlaceholder(currentEnv.PUBLIC_WEB_URL) ? '' : currentEnv.PUBLIC_WEB_URL || '',
      database: { ...parseDatabaseConfig(currentEnv.DATABASE_URL || ''), password: '' },
      adminPath: currentEnv.ADMIN_PATH || '/admin',
      adminUsername: currentEnv.DEFAULT_ADMIN_USERNAME || 'admin'
    }
  };
  return { ...status, checks: statusChecks(status) };
}

async function saveConfigApi(request, response) {
  try {
    const body = await readPayload(request);
    saveConfigFromPayload(body);
    sendJson(response, { ok: true, status: getStatus() });
  } catch (error) {
    sendJson(response, { ok: false, message: errorMessage(error) }, error.statusCode || 400);
  }
}

async function saveConfigPage(request, response) {
  try {
    const body = await readPayload(request);
    saveConfigFromPayload(body);
    sendRedirect(response, '/?type=ok&message=' + encodeURIComponent('配置已保存。'));
  } catch (error) {
    sendHtml(response, { type: 'error', message: errorMessage(error) }, 400);
  }
}

async function runInstallPage(request, response) {
  try {
    const body = await readPayload(request);
    saveConfigFromPayload(body);
    startInstall();
    sendRedirect(response, '/?type=ok&message=' + encodeURIComponent('安装任务已开始，请等待日志完成后回到宝塔 / 1Panel 重启 Node.js 项目。'));
  } catch (error) {
    sendHtml(response, { type: 'error', message: errorMessage(error) }, error.statusCode || 400);
  }
}

function runInstallApi(response) {
  try {
    startInstall();
    sendJson(response, { ok: true, status: getStatus() });
  } catch (error) {
    sendJson(response, { ok: false, message: errorMessage(error) }, error.statusCode || 400);
  }
}

function saveConfigFromPayload(payload) {
  if (state.installing || state.installed) throw Object.assign(new Error('安装进行中或已完成，请勿重复修改配置；完成后请重启 Node.js 项目。'), { statusCode: 409 });
  const existing = loadEnv();
  delete existing.REDIS_URL;
  const data = normalizeConfig(payload, existing);
  const merged = mergeEnv(loadEnvFileOnly(), data);
  writeFileSync(envPath, renderEnv(merged), { encoding: 'utf8', mode: 0o600 });
  chmodSync(envPath, 0o600);
  appendLog('配置已保存到 .env。');
}

function normalizeConfig(body, existing) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('请提交有效的安装配置。');
  const port = String(body.port || '3388').trim();
  const dbHost = String(body.dbHost || '').trim();
  const dbPort = String(body.dbPort || '3306').trim();
  const dbName = String(body.dbName || '').trim();
  const dbUser = String(body.dbUser || '').trim();
  const previousDatabase = parseDatabaseConfig(isPlaceholder(existing.DATABASE_URL) ? '' : existing.DATABASE_URL || '');
  const dbPassword = String(body.dbPassword || previousDatabase.password || '');
  const adminUsername = String(body.adminUsername || 'admin').trim();
  const adminPassword = String(body.adminPassword || existing.DEFAULT_ADMIN_PASSWORD || '');
  const adminPath = normalizeAdminPath(body.adminPath || '/admin');
  const publicWebUrl = String(body.publicWebUrl ?? (isPlaceholder(existing.PUBLIC_WEB_URL) ? '' : existing.PUBLIC_WEB_URL) ?? '').trim().replace(/\/+$/, '');
  const errors = [];

  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) errors.push('网站端口必须在 1 到 65535 之间。');
  if (process.env.PORT && Number(port) !== Number(process.env.PORT)) errors.push(`网站端口须与运行环境端口 ${process.env.PORT} 一致，请先在宝塔 / 1Panel 修改运行环境。`);
  if (!dbHost) errors.push('数据库地址不能为空。');
  if (!/^\d+$/.test(dbPort) || Number(dbPort) < 1 || Number(dbPort) > 65535) errors.push('数据库端口必须在 1 到 65535 之间。');
  if (!dbName) errors.push('数据库名不能为空。');
  if (!dbUser) errors.push('数据库用户名不能为空。');
  if (!dbPassword) errors.push('数据库密码不能为空。');
  if (!adminUsername) errors.push('管理员账号不能为空。');
  if (!adminPassword) errors.push('管理员密码不能为空。');
  if (body.adminPassword && adminPassword.length < 8) errors.push('管理员密码至少需要 8 个字符。');
  if ([dbHost, dbName, dbUser, dbPassword, adminUsername, adminPassword].some(value => /[\r\n]/.test(value))) errors.push('配置信息不能包含换行。');
  if (publicWebUrl) {
    try { const url = new URL(publicWebUrl); if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') errors.push('网站地址应为完整的 http(s) 域名或 IP 与端口，不包含路径或账号信息。'); }
    catch { errors.push('请输入完整的网站地址，例如 https://你的域名。'); }
  }
  if (errors.length) throw new Error(errors.join('\n'));

  const databaseUrl = buildDatabaseUrl({ dbHost, dbPort, dbName, dbUser, dbPassword });

  return {
    NODE_ENV: 'production',
    PORT: port,
    PUBLIC_WEB_URL: publicWebUrl,
    ADMIN_PATH: adminPath,
    DATABASE_URL: databaseUrl,
    JWT_SECRET: usableSecret(existing.JWT_SECRET) ? existing.JWT_SECRET : randomSecret(),
    SESSION_SECRET: usableSecret(existing.SESSION_SECRET) ? existing.SESSION_SECRET : randomSecret(),
    ENCRYPTION_KEY: usableSecret(existing.ENCRYPTION_KEY) ? existing.ENCRYPTION_KEY : randomBytes(32).toString('base64'),
    CARD_HASH_SECRET: usableSecret(existing.CARD_HASH_SECRET) ? existing.CARD_HASH_SECRET : randomSecret(),
    DEFAULT_ADMIN_USERNAME: adminUsername,
    DEFAULT_ADMIN_PASSWORD: adminPassword
  };
}

function normalizeAdminPath(value) {
  const trimmed = String(value || '/admin').trim().replace(/\/+$/, '') || '/admin';
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (path === '/' || /^\/api(?:\/|$)/i.test(path)) throw new Error('管理路径不能为 / 或 /api。');
  if (path.length > 80 || !/^\/[A-Za-z0-9._~/-]+$/.test(path) || path.includes('//')) throw new Error('管理路径最长 80 个字符，只能包含字母、数字、横线、下划线、点和斜杠，不能包含连续斜杠。');
  return path;
}

function startInstall() {
  if (state.installing || state.installed) {
    const error = new Error(state.installed ? '安装已完成，请重启 Node.js 项目进入网站。' : '安装正在进行中。');
    error.statusCode = 409;
    throw error;
  }

  const envStatus = envIsUsable(loadEnv());
  if (!envStatus.ok) {
    const error = new Error(envStatus.errors.join('\n'));
    error.statusCode = 400;
    throw error;
  }

  state.installing = true;
  state.installed = false;
  state.exitCode = null;
  state.startedAt = new Date().toISOString();
  state.endedAt = null;
  state.logs = [];

  const usePrebuilt = shouldUsePrebuiltInstall();
  if (usePrebuilt) appendLog('检测到预构建运行包，安装时跳过前后端构建。');

  const steps = [
    ['npm', ['ci', '--include=dev']],
    ['npm', ['run', 'install:prod']],
    ['npm', ['prune', '--omit=dev']]
  ];

  runSteps(steps).catch((error) => {
    appendLog(errorMessage(error));
    state.exitCode = 1;
    state.installed = false;
  }).finally(() => {
    state.installing = false;
    state.endedAt = new Date().toISOString();
    state.installed = state.exitCode === 0 && isReady(loadEnv());
    if (state.exitCode === 0 && requiredFiles.every((file) => existsSync(resolve(root, file))) && envIsUsable(loadEnv()).ok) {
      writeFileSync(installedMarkerPath, `${new Date().toISOString()}\n`, 'utf8');
      state.installed = true;
      appendLog('安装完成。请在宝塔 / 1Panel 重启 Node.js 项目，随后访问网站首页和配置的管理路径。');
    }
  });
}

async function runSteps(steps) {
  for (const [command, args] of steps) {
    appendLog(`$ ${command} ${args.join(' ')}`);
    await runCommand(command, args);
  }
  state.exitCode = 0;
}

function runCommand(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { cwd: root, shell: process.platform === 'win32', env: commandEnv() });
    child.stdout.on('data', (chunk) => appendLog(chunk.toString()));
    child.stderr.on('data', (chunk) => appendLog(chunk.toString()));
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

function shouldUsePrebuiltInstall() {
  const runtimeReady = requiredFiles.every((file) => existsSync(resolve(root, file)));
  const buildSourcesMissing = !existsSync(resolve(root, 'packages/shared/tsconfig.json')) || !existsSync(resolve(root, 'apps/admin-web/src'));
  return process.env.SHIYE_PREBUILT === '1' || (runtimeReady && buildSourcesMissing);
}

function commandEnv() {
  return {
    ...loadEnv(),
    SHIYE_PREBUILT: shouldUsePrebuiltInstall() ? '1' : process.env.SHIYE_PREBUILT || ''
  };
}

async function runApi() {
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [resolve(root, 'apps/api/dist/main.js')], { cwd: root, stdio: 'inherit', env: commandEnv() });
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
      resolvePromise();
    });
  });
}

function appendLog(message) {
  const lines = String(message).replace(/\r/g, '').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    state.logs.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}`);
  }
  if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
}

function loadEnv() {
  return { ...process.env, ...loadEnvFileOnly() };
}

function loadEnvFileOnly() {
  const values = {};
  if (!existsSync(envPath)) return values;
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values[trimmed.slice(0, index).trim()] = unquote(trimmed.slice(index + 1).trim());
  }
  return values;
}

function mergeEnv(existing, next) {
  return {
    ...existing,
    ...next
  };
}

function renderEnv(values) {
  const order = [
    'NODE_ENV', 'PORT', 'PUBLIC_WEB_URL', 'ADMIN_PATH',
    'DATABASE_URL',
    'JWT_SECRET', 'SESSION_SECRET', 'ENCRYPTION_KEY', 'CARD_HASH_SECRET',
    'DEFAULT_ADMIN_USERNAME', 'DEFAULT_ADMIN_PASSWORD'
  ];
  const keys = [...order, ...Object.keys(values).filter((key) => !order.includes(key)).sort()];
  const blocks = [];
  const seen = new Set();
  for (const key of keys) {
    if (seen.has(key)) continue;
    seen.add(key);
    if (values[key] === undefined || values[key] === null || values[key] === '') continue;
    blocks.push(`${key}=${escapeEnv(String(values[key]))}`);
  }
  return `${blocks.join('\n')}\n`;
}

function escapeEnv(value) {
  if (/^[A-Za-z0-9_./:@%+\-=]*$/.test(value)) return value;
  if (/[\r\n]/.test(value)) throw new Error('配置值不能包含换行。');
  for (const quote of ["'", '`', '"']) {
    if (!value.includes(quote) && (quote !== '"' || !/\\[nr]/.test(value))) return quote + value + quote;
  }
  throw new Error('配置值包含无法保存的引号组合，请勿同时使用单引号、双引号和反引号。');
}

function unquote(value) {
  if (['"', "'", '`'].some(quote => value.startsWith(quote) && value.endsWith(quote))) return value.slice(1, -1);
  return value;
}

function isPlaceholder(value) {
  return /replace-with|change-me|dev-only|example\.com/i.test(value || '');
}

function usableSecret(value) {
  return Boolean(value) && !isPlaceholder(value) && secretByteLength(value) >= 32;
}

function secretByteLength(value) {
  if (!value) return 0;
  return Math.max(Buffer.from(value, 'utf8').length, Buffer.from(value, 'base64').length, Buffer.from(value, 'hex').length);
}

function randomSecret() {
  return randomBytes(48).toString('hex');
}

function buildDatabaseUrl({ dbHost, dbPort, dbName, dbUser, dbPassword }) {
  const host = dbHost.includes(':') && !dbHost.startsWith('[') ? `[${dbHost}]` : dbHost;
  return `mysql://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPassword)}@${host}:${dbPort}/${encodeURIComponent(dbName)}`;
}

function parseDatabaseConfig(value) {
  const fallback = { host: '', port: '3306', name: '', user: '', password: '' };
  if (!value) return fallback;
  try {
    const parsed = new URL(value);
    return {
      host: parsed.hostname || '',
      port: parsed.port || '3306',
      name: decodeURIComponent(parsed.pathname.replace(/^\//, '')),
      user: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || '')
    };
  } catch {
    return fallback;
  }
}

function readPayload(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        request.destroy(new Error('请求内容过大。'));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const contentType = String(request.headers['content-type'] || '').toLowerCase();
        if (contentType.includes('application/json')) return resolvePromise(JSON.parse(raw || '{}'));
        const params = new URLSearchParams(raw);
        resolvePromise(Object.fromEntries(params.entries()));
      } catch (error) {
        rejectPromise(error);
      }
    });
    request.on('error', rejectPromise);
  });
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(payload));
}

function sendHtml(response, flash = {}, status = 200) {
  response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  response.end(installerHtml(flash));
}

function sendRedirect(response, location) {
  response.writeHead(303, { location, 'cache-control': 'no-store' });
  response.end();
}

function sendJs(response) {
  response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-store' });
  response.end(installerClientScript());
}

function flashFromUrl(url) {
  return {
    type: url.searchParams.get('type') || '',
    message: url.searchParams.get('message') || ''
  };
}

function wantsHtml(request) {
  const accept = String(request.headers.accept || '');
  return accept.includes('text/html') || !accept.includes('application/json');
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function installerClientScript() {
  return `(() => {
    const form = document.querySelector('#form');
    const toast = document.querySelector('#toast');
    const logs = document.querySelector('#logs');
    const ready = document.querySelector('#ready');
    const checks = document.querySelector('#checks');
    const installButton = document.querySelector('#install');
    const saveButton = document.querySelector('#save');
    const storageKey = 'shiye-panel-install-form';
    if (!form || !toast || !logs || !ready || !checks || !installButton || !saveButton) return;
    try { localStorage.removeItem(storageKey); } catch {}
    const themeButton = document.querySelector('#theme-toggle');
    const systemButton = document.querySelector('#theme-system');
    const media = matchMedia('(prefers-color-scheme: dark)');
    let theme = 'system';
    try { theme = localStorage.getItem('shiye:theme:installer') || 'system'; } catch {}
    function applyTheme() {
      const dark = theme === 'dark' || theme === 'system' && media.matches;
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
      themeButton.textContent = dark ? '亮色模式' : '暗色模式';
      systemButton.setAttribute('aria-pressed', String(theme === 'system'));
    }
    function saveTheme(value) { theme = value; try { localStorage.setItem('shiye:theme:installer', value); } catch {} applyTheme(); }
    themeButton.addEventListener('click', () => saveTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
    systemButton.addEventListener('click', () => saveTheme('system'));
    media.addEventListener('change', applyTheme);
    applyTheme();

    let userEditing = false;
    let operationBusy = false;
    ready.textContent = '正在连接';
    appendClientLog('页面脚本已加载，正在检查安装状态。');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      setBusy(saveButton, '正在保存...');
      setToast('正在保存配置...', '');
      appendClientLog('正在保存配置...');
      try {
        await saveConfig();
        setToast('配置已保存。', 'ok');
        appendClientLog('配置已保存。');
      } catch (error) {
        setToast(error.message, 'error');
        appendClientLog('保存失败：' + error.message);
      } finally {
        setIdle(saveButton, '保存配置');
        await refresh();
      }
    });

    installButton.addEventListener('click', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      setBusy(installButton, '正在安装...');
      setToast('正在保存配置并准备安装...', '');
      appendClientLog('正在保存配置并准备安装...');
      try {
        await saveConfig();
        await post('/api/panel-install/run', {});
        setToast('安装任务已开始，请等待日志完成。', 'ok');
        appendClientLog('安装任务已开始。');
      } catch (error) {
        setToast(error.message, 'error');
        appendClientLog('开始安装失败：' + error.message);
      } finally {
        setIdle(installButton, '开始安装');
        await refresh();
      }
    });

    form.addEventListener('input', () => {
      userEditing = true;
      saveDraft();
    });

    async function saveConfig() {
      const payload = Object.fromEntries(new FormData(form).entries());
      const data = await post('/api/panel-install/config', payload);
      saveDraft();
      return data;
    }

    async function post(url, body) {
      const response = await fetchWithTimeout(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 15000);
      const text = await response.text();
      let data;
      try { data = text ? JSON.parse(text) : {}; }
      catch { throw new Error(text || '服务返回格式不正确。'); }
      if (!response.ok || data.ok === false) throw new Error(data.message || '请求失败。');
      return data;
    }

    async function refresh() {
      try {
        const response = await fetchWithTimeout('/api/panel-install/status', { cache: 'no-store' }, 8000);
        const text = await response.text();
        let data;
        try { data = text ? JSON.parse(text) : {}; }
        catch { throw new Error(text ? '状态接口返回的不是 JSON，请检查整站反向代理是否转发到 Node.js 端口。' : '状态接口没有返回内容。'); }
        if (!response.ok) throw new Error(data.message || '状态接口请求失败：HTTP ' + response.status);
        if (!userEditing) fillDefaults(data.defaults || {});
        renderStatus(data);
      } catch (error) {
        ready.textContent = '连接失败';
        ready.className = 'pill bad';
        checks.innerHTML = '<li>' + escapeHtml(error.message) + '</li>';
        setToast(error.message, 'error');
        appendClientLog('状态检查失败：' + error.message);
      }
    }

    function renderStatus(data) {
      ready.textContent = data.ready ? '已安装，重启后进入正式服务' : data.installing ? '正在安装' : '等待安装';
      ready.className = data.exitCode !== null && data.exitCode !== 0 ? 'pill bad' : 'pill';
      const locked = data.installing || data.installed || operationBusy;
      for (const field of form.elements) field.disabled = locked;
      installButton.disabled = locked;
      saveButton.disabled = locked;
      installButton.textContent = data.installed ? '安装完成，请重启项目' : data.installing ? '正在安装...' : '开始安装';
      if (data.installed) { try { sessionStorage.removeItem(storageKey); } catch {} form.elements.namedItem('dbPassword').value = ''; form.elements.namedItem('adminPassword').value = ''; }
      const items = data.checks || [];
      checks.innerHTML = items.map((item) => '<li>' + escapeHtml(item) + '</li>').join('');
      if ((data.logs || []).length) logs.textContent = data.logs.join('\\n');
      else if (!logs.textContent.trim()) logs.textContent = '等待操作...';
      logs.scrollTop = logs.scrollHeight;
    }

    function fillDefaults(defaults) {
      const database = defaults.database || {};
      const draft = loadDraft();
      setFieldValue('port', draft.port || defaults.port || '3388');
      setFieldValue('adminPath', draft.adminPath || defaults.adminPath || '/admin');
      setFieldValue('publicWebUrl', draft.publicWebUrl ?? defaults.publicWebUrl ?? '');
      setFieldValue('dbHost', draft.dbHost || database.host || '');
      setFieldValue('dbPort', draft.dbPort || database.port || '3306');
      setFieldValue('dbName', draft.dbName || database.name || '');
      setFieldValue('dbUser', draft.dbUser || database.user || '');
      setFieldValue('adminUsername', draft.adminUsername || defaults.adminUsername || 'admin');
    }

    function setFieldValue(name, value) {
      const field = form.elements.namedItem(name);
      if (field) field.value = value;
    }

    function saveDraft() {
      try {
        const draft = Object.fromEntries(new FormData(form).entries());
        delete draft.dbPassword; delete draft.adminPassword;
        sessionStorage.setItem(storageKey, JSON.stringify(draft));
      }
      catch {}
    }

    function loadDraft() {
      try { return JSON.parse(sessionStorage.getItem(storageKey) || '{}'); }
      catch { return {}; }
    }

    function setToast(message, type) {
      toast.textContent = message;
      toast.className = 'toast ' + (type || '');
    }

    function appendClientLog(message) {
      const prefix = new Date().toLocaleTimeString('zh-CN', { hour12: false });
      const current = logs.textContent === '等待操作...' ? '' : logs.textContent + '\\n';
      logs.textContent = current + '[' + prefix + '] ' + message;
      logs.scrollTop = logs.scrollHeight;
    }

    function setBusy(button, text) {
      operationBusy = true;
      button.disabled = true;
      button.dataset.idleText = button.textContent;
      button.textContent = text;
    }

    function setIdle(button, text) {
      operationBusy = false;
      button.disabled = false;
      button.textContent = text || button.dataset.idleText || button.textContent;
    }

    async function fetchWithTimeout(url, options, timeoutMs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...(options || {}), signal: controller.signal });
      } catch (error) {
        if (error.name === 'AbortError') throw new Error('请求超时，请检查 Node.js 运行环境是否正常启动，以及反向代理是否整站转发到当前端口。');
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
    }

    try { fillDefaults({ port: '3388', adminPath: '/admin', database: {}, adminUsername: 'admin' }); }
    catch (error) { appendClientLog('默认值填充失败：' + error.message); }
    window.addEventListener('error', (event) => { setToast(event.message, 'error'); appendClientLog('页面错误：' + event.message); });
    setInterval(refresh, 2500);
    refresh();
  })();`;
}

function installerHtml(flash = {}) {
  const status = getStatus();
  const values = formValuesFromStatus(status);
  const checks = statusChecks(status);
  const readyText = status.ready ? '已安装，重启后进入正式服务' : status.installing ? '正在安装' : '等待安装';
  const readyClass = status.exitCode !== null && status.exitCode !== 0 ? 'pill bad' : 'pill';
  const logsText = status.logs.length ? status.logs.join('\n') : '等待操作...';
  const flashClass = flash.type === 'ok' ? 'toast ok' : flash.message ? 'toast error' : 'toast';
  const refreshMeta = status.installing ? '  <meta http-equiv="refresh" content="3" />\n' : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
${refreshMeta}  <title>十夜 · 安装向导</title>
  <meta name="color-scheme" content="light dark" />
  <script>try { const theme = localStorage.getItem('shiye:theme:installer'); document.documentElement.dataset.theme = theme === 'dark' || theme !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; } catch {}</script>
  <style>
    :root { color-scheme: light; --bg: #f7f8fa; --panel: #ffffff; --text: #242930; --muted: #606975; --line: #e0e4e9; --field: #8a94a2; --primary: #c9a227; --primary-dark: #806313; --on-primary: #211b0c; --soft: #f6efd9; --danger: #ac3934; --success: #356d55; --disabled: #f1f3f5; }
    :root[data-theme="dark"] { color-scheme: dark; --bg: #14171b; --panel: #1d2127; --text: #edf0f4; --muted: #afb8c5; --line: #343b45; --field: #778595; --primary: #e0b83a; --primary-dark: #e0b83a; --soft: #373122; --danger: #ed958a; --success: #8bc5a8; --disabled: #272d35; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif; color: var(--text); background: var(--bg); -webkit-font-smoothing: antialiased; }
    .shell { max-width: 1080px; margin: 0 auto; padding: 30px 18px 46px; }
    .hero { display: grid; gap: 10px; margin-bottom: 22px; }
    .hero-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .theme-controls { display: flex; gap: 8px; }
    .eyebrow { color: var(--primary-dark); font-weight: 700; font-size: 13px; }
    h1 { margin: 0; font-size: clamp(24px, 4vw, 30px); letter-spacing: -.02em; font-weight: 650; }
    .lead { max-width: 780px; color: var(--muted); line-height: 1.7; margin: 0; }
    .grid { display: grid; grid-template-columns: minmax(0, 1fr) 340px; gap: 18px; align-items: start; }
    .card { min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
    .section { padding: 20px; }
    .section + .section { border-top: 1px solid var(--line); }
    label { display: grid; align-content: start; gap: 7px; margin-bottom: 14px; font-size: 14px; font-weight: 600; }
    input { width: 100%; min-width: 0; min-height: 38px; border: 1px solid var(--field); border-radius: 6px; padding: 8px 10px; font: inherit; font-weight: 400; color: var(--text); background: var(--bg); }
    input::placeholder { color: var(--muted); opacity: 1; }
    input:focus-visible, button:focus-visible { outline: 2px solid var(--primary-dark); outline-offset: 2px; }
    .hint { color: var(--muted); font-size: 13px; font-weight: 400; line-height: 1.65; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .row.three { grid-template-columns: 1.4fr .7fr 1fr; }
    .row.admin { align-items: start; }
    .group-title { margin: 0 0 14px; font-size: 15px; font-weight: 600; color: var(--text); }
    .actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
    button { min-height: 36px; border: 1px solid var(--primary); border-radius: 6px; padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer; background: var(--primary); color: var(--on-primary); }
    button.secondary { border-color: var(--field); background: var(--panel); color: var(--text); }
    button:hover:not(:disabled) { filter: brightness(.97); }
    button:disabled { color: var(--muted); background: var(--disabled); border-color: var(--field); cursor: not-allowed; }
    input:disabled { color: var(--muted); }
    .status { display: grid; gap: 10px; }
    .pill { display: inline-flex; width: fit-content; align-items: center; gap: 8px; border-radius: 5px; padding: 4px 8px; font-size: 13px; font-weight: 600; background: var(--soft); color: var(--primary-dark); }
    .pill.bad { color: var(--danger); background: var(--disabled); }
    ul { margin: 0; padding-left: 18px; color: var(--muted); line-height: 1.65; }
    pre { margin: 0; min-height: 180px; max-height: 360px; overflow: auto; white-space: pre-wrap; word-break: break-word; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 6px; padding: 14px; font-size: 13px; line-height: 1.65; }
    .toast { margin-top: 12px; min-height: 22px; color: var(--muted); font-weight: 650; white-space: pre-wrap; }
    .toast.ok { color: var(--success); }
    .toast.error { color: var(--danger); }
    @media (max-width: 860px) { .grid { grid-template-columns: 1fr; } .row, .row.three { grid-template-columns: 1fr; } .shell { padding-top: 24px; } }
  </style>
</head>
<body>
  <main class="shell">
    <section class="hero">
      <div class="hero-top"><div class="eyebrow">宝塔 / 1Panel · 首次安装</div><div class="theme-controls"><button type="button" class="secondary" id="theme-toggle">暗色模式</button><button type="button" class="secondary" id="theme-system" aria-pressed="true">跟随系统</button></div></div>
      <h1>十夜 · 网站安装向导</h1>
      <p class="lead">填写数据库和管理员信息后即可开始安装。安全密钥会自动生成，无需手动填写；安装完成后重启项目即可使用网站。</p>
    </section>

    <section class="grid">
      <form class="card" id="form" method="post" action="/panel-install/config">
        <div class="section">
          <p class="group-title">运行设置</p>
          <div class="row">
            <label>端口
              <input name="port" value="${escapeHtml(values.port)}" inputmode="numeric" />
              <span class="hint">保持和宝塔 / 1Panel Node.js 项目端口一致。</span>
            </label>
            <label>管理路径
              <input name="adminPath" value="${escapeHtml(values.adminPath)}" autocomplete="off" />
              <span class="hint">默认即可，管理端使用这个路径访问。</span>
            </label>
          </div>
          <label>网站访问地址（可选）<input name="publicWebUrl" value="${escapeHtml(values.publicWebUrl)}" type="url" placeholder="https://你的域名 或 http://服务器IP:端口" autocomplete="url" /><span class="hint">用于支付回调等公开链接；尚未绑定域名时可以留空，之后再配置。</span></label>
        </div>
        <div class="section">
          <p class="group-title">数据库设置</p>
          <div class="row three">
            <label>数据库地址
              <input name="dbHost" value="${escapeHtml(values.dbHost)}" placeholder="例如 mysql 或 1panel-mysql" autocomplete="off" required />
            </label>
            <label>端口
              <input name="dbPort" value="${escapeHtml(values.dbPort)}" inputmode="numeric" required />
            </label>
            <label>数据库名
              <input name="dbName" value="${escapeHtml(values.dbName)}" placeholder="shiye_management" autocomplete="off" required />
            </label>
          </div>
          <div class="row">
            <label>数据库用户名
              <input name="dbUser" value="${escapeHtml(values.dbUser)}" placeholder="shiye" autocomplete="off" required />
            </label>
            <label>数据库密码
              <input name="dbPassword" type="password" autocomplete="off" />
              <span class="hint">首次安装请填写；配置已保存时留空沿用，不会回显密码。</span>
            </label>
          </div>
          <span class="hint">1Panel 容器部署请使用数据库内网地址或容器名；宝塔同机部署可使用 127.0.0.1。</span>
        </div>
        <div class="section">
          <p class="group-title">管理员设置</p>
          <div class="row admin">
            <label>管理员账号
              <input name="adminUsername" value="${escapeHtml(values.adminUsername)}" autocomplete="username" />
              <span class="hint">用于登录管理后台。</span>
            </label>
            <label>管理员密码
              <input name="adminPassword" type="password" autocomplete="new-password" />
              <span class="hint">首次安装至少 8 个字符；已保存后留空沿用。重新安装不会重置已修改的后台密码。</span>
            </label>
          </div>
          <div class="actions">
            <button type="submit" class="secondary" id="save"${status.installing || status.installed ? ' disabled' : ''}>保存配置</button>
            <button type="submit" id="install" formaction="/panel-install/run"${status.installing || status.installed ? ' disabled' : ''}>${status.installed ? '安装完成，请重启项目' : status.installing ? '正在安装...' : '开始安装'}</button>
          </div>
          <div class="${flashClass}" id="toast">${escapeHtml(flash.message || '')}</div>
        </div>
        <div class="section">
          <pre id="logs">${escapeHtml(logsText)}</pre>
        </div>
      </form>

      <aside class="card">
        <div class="section status">
          <span class="${readyClass}" id="ready">${escapeHtml(readyText)}</span>
          <span class="hint">向导版本：${installerVersion}</span>
          <span class="hint">当前 Node.js ${escapeHtml(status.nodeVersion)} · 要求 20.19 或更新版本</span>
          <span class="hint">${shouldUsePrebuiltInstall() ? '发布包安装：直接使用已构建程序' : '源码安装：安装过程会构建前后端'}</span>
          <div>
            <strong>当前状态</strong>
            <ul id="checks">${checks.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>
          </div>
        </div>
        <div class="section">
          <strong>安装完成后</strong>
          <ul>
            <li>回到宝塔 / 1Panel 重启 Node.js 项目。</li>
            <li>再次启动时，npm start 会自动进入正式网站，访问首页及你设置的管理路径。</li>
            <li>使用域名时，把整站反向代理到当前 Node.js 运行环境端口即可，例如 http://127.0.0.1:3388。</li>
          </ul>
          <p class="hint">网页更新与迁移需要独立维护服务。普通宝塔项目或 1Panel 容器不会自动安装该服务；这类部署可在面板中更新程序，迁移时同时备份数据库和 .env。</p>
        </div>
      </aside>
    </section>
  </main>
  <script defer src="/panel-install.js?v=${installerVersion}"></script>
</body>
</html>`;
}

function formValuesFromStatus(status) {
  const database = status.defaults.database || {};
  return {
    port: status.defaults.port || '3388',
    adminPath: status.defaults.adminPath || '/admin',
    publicWebUrl: status.defaults.publicWebUrl || '',
    dbHost: database.host || '',
    dbPort: database.port || '3306',
    dbName: database.name || '',
    dbUser: database.user || '',
    dbPassword: database.password || '',
    adminUsername: status.defaults.adminUsername || 'admin'
  };
}

function statusChecks(status) {
  const items = [];
  const runtimeError = status.envErrors.find(message => message.includes('Node.js'));
  if (runtimeError) items.push(runtimeError);
  if (!status.envOk) items.push(status.envExists ? '运行配置尚未就绪，请检查并保存数据库和管理员信息，安全密钥会自动补齐。' : '请先填写数据库和管理员信息，安全密钥将在保存时自动生成。');
  else items.push('数据库连接与网站配置已保存，安装时将检查数据库连通性。');
  if (status.missingFiles.length) items.push('当前为源码安装，安装过程会自动构建网站程序。');
  if (status.ready) items.push('安装已完成，请在宝塔 / 1Panel 重启 Node.js 项目进入网站。');
  else if (!status.installing) items.push('确认填写无误后，点击“开始安装”。');
  return items;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
