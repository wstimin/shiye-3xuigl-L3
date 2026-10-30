import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, constants, readFileSync, writeFileSync, renameSync, statSync, openSync, closeSync, fstatSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { createGzip, createGunzip } from 'node:zlib';

export const MAX_BACKUP_BYTES = 2 * 1024 ** 3;
export const JOB_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const activeJob = job => job?.state === 'running' || job?.state === 'queued' || job?.recovery?.state === 'running';
export function readJson(path) { return JSON.parse(readFileSync(path, 'utf8')); }
export function writeJson(path, data) {
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(data), { mode: 0o640, flag: 'wx' });
  renameSync(temp, path);
}
export function compareVersions(left, right) {
  const parse = value => { if (!/^v?\d+\.\d+\.\d+$/.test(value)) throw new Error('版本格式无效'); return value.replace(/^v/, '').split('.').map(Number); };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}
export function parseEnv(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) { try { value = JSON.parse(value); } catch { value = value.slice(1, -1); } }
    else if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}
export function migrationEnv(source, target) {
  const result = { ...target };
  // Only application secrets travel; connection, host and process settings stay local.
  for (const key of ['ENCRYPTION_KEY', 'CARD_HASH_SECRET', 'JWT_SECRET', 'SESSION_SECRET', 'DEFAULT_ADMIN_USERNAME', 'DEFAULT_ADMIN_PASSWORD']) {
    if (typeof source[key] !== 'string' || !source[key] || /[\r\n\0]/.test(source[key])) throw new Error('备份缺少必要的站点密钥');
    result[key] = source[key];
  }
  return result;
}
export function serializeEnv(values) {
  return Object.entries(values).map(([key, value]) => `${key}=${/^[^\s"'#\\]*$/.test(value) ? value : JSON.stringify(value)}`).join('\n') + '\n';
}
export function validateRelease(release, currentVersion) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) throw new Error('没有可用的稳定版本');
  const asset = release.assets?.find(item => item.name === 'shiye-3xuigl.zip');
  const expected = `https://github.com/wstimin/shiye-3xuigl-L3/releases/download/${release.tag_name}/shiye-3xuigl.zip`;
  if (!asset || asset.browser_download_url !== expected || !/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > 250 * 1024 ** 2) throw new Error('发布包缺少有效的完整性校验，不能更新');
  return { version: release.tag_name.slice(1), tag: release.tag_name, hasUpdate: compareVersions(release.tag_name, currentVersion) > 0, url: expected, sha256: asset.digest.slice(7), size: asset.size, publishedAt: release.published_at, notes: String(release.body || '').slice(0, 12000), releaseUrl: `https://github.com/wstimin/shiye-3xuigl-L3/releases/tag/${release.tag_name}` };
}
export async function latestRelease(currentVersion) {
  const response = await fetch('https://api.github.com/repos/wstimin/shiye-3xuigl-L3/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'shiye-maintenance' }, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`版本检测失败（${response.status}），请稍后重试`);
  return validateRelease(await response.json(), currentVersion);
}
export async function fileHash(path) {
  const hash = createHash('sha256');
  for await (const part of createReadStream(path)) hash.update(part);
  return hash.digest('hex');
}
export async function snapshotUpload(input, output) {
  const fd = openSync(input, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let source;
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size < 1 || info.size > MAX_BACKUP_BYTES) throw new Error('上传文件无效或过大');
    let bytes = 0;
    const limit = new Transform({ transform(part, _encoding, done) { bytes += part.length; done(bytes > MAX_BACKUP_BYTES ? new Error('上传文件过大') : null, part); } });
    source = createReadStream(input, { fd });
    await pipeline(source, limit, createWriteStream(output, { flags: 'wx', mode: 0o600 }));
  } finally { if (source) source.destroy(); else closeSync(fd); }
}
export async function packBackup(sqlPath, output, metadata) {
  const header = { ...metadata, format: 'shiye-backup-1', sqlSize: statSync(sqlPath).size, sqlSha256: await fileHash(sqlPath) };
  const json = Buffer.from(JSON.stringify(header));
  if (json.length > 65536 || header.sqlSize > MAX_BACKUP_BYTES) throw new Error('备份超过支持的大小');
  const length = Buffer.alloc(4); length.writeUInt32BE(json.length);
  async function* content() { yield Buffer.from('SHIYE001'); yield length; yield json; yield* createReadStream(sqlPath); }
  await pipeline(Readable.from(content()), createGzip(), createWriteStream(output, { flags: 'wx', mode: 0o600 }));
  return header;
}
export async function unpackBackup(input, sqlOutput) {
  let prefix = Buffer.alloc(0), header, bytes = 0;
  const hash = createHash('sha256');
  const decode = new Transform({ transform(part, _encoding, done) {
    try {
      if (!header) {
        prefix = Buffer.concat([prefix, part]);
        if (prefix.length < 12) return done();
        if (prefix.subarray(0, 8).toString() !== 'SHIYE001') throw new Error('不是本系统的迁移备份');
        const size = prefix.readUInt32BE(8);
        if (size < 2 || size > 65536) throw new Error('备份头损坏');
        if (prefix.length < size + 12) return done();
        header = JSON.parse(prefix.subarray(12, size + 12).toString());
        if (header.format !== 'shiye-backup-1' || !Number.isSafeInteger(header.sqlSize) || header.sqlSize < 1 || header.sqlSize > MAX_BACKUP_BYTES || !/^[a-f0-9]{64}$/.test(header.sqlSha256)) throw new Error('备份信息无效');
        compareVersions(header.version, header.version);
        part = prefix.subarray(size + 12); prefix = Buffer.alloc(0);
      }
      bytes += part.length;
      if (bytes > header.sqlSize) throw new Error('备份数据长度不符');
      hash.update(part); done(null, part);
    } catch (error) { done(error); }
  }, flush(done) { if (!header || bytes !== header.sqlSize || hash.digest('hex') !== header.sqlSha256) return done(new Error('备份校验失败或文件不完整')); done(); } });
  const fd = openSync(input, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let source;
  try {
    if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_BACKUP_BYTES) throw new Error('备份文件无效或过大');
    source = createReadStream(input, { fd });
    await pipeline(source, createGunzip(), decode, createWriteStream(sqlOutput, { flags: 'wx', mode: 0o600 }));
  } finally { if (source) source.destroy(); else closeSync(fd); }
  return header;
}
export function updateProgress(path, patch) {
  const previous = readJson(path);
  if (patch.progress !== undefined && (previous.state === 'failed' || previous.recovery)) delete patch.progress;
  const next = { ...previous, ...patch, updatedAt: new Date().toISOString() };
  if (next.progress < previous.progress) next.progress = previous.progress;
  writeJson(path, next);
  return next;
}
