import { BadRequestException, ConflictException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync, readdirSync, renameSync, writeFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request } from 'express';
import { readBuildInfo } from '../../shared/build-info.js';
import { maintenanceDirectory } from '../../shared/maintenance-state.js';

const validId = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
type Job = { id: string; kind: string; state: string; progress: number; message: string; createdAt: string; recovery?: { state: string }; result?: Record<string, unknown> };
@Injectable()
export class MaintenanceService {
  private checked?: { id: string; version: string; sha256: string; expires: number; hasUpdate: boolean };
  private uploading = false;
  private root() { return maintenanceDirectory(); }
  private available() { return process.platform === 'linux' && existsSync(join(this.root(), 'ready.json')); }
  private requireAvailable() { if (!this.available()) throw new ServiceUnavailableException('此部署尚未启用维护服务，请使用新版安装程序升级一次'); }
  private read(path: string) { return JSON.parse(readFileSync(path, 'utf8')); }
  private busy() { const job = this.latest(); return this.uploading || this.queued().length > 0 || job?.state === 'running' || job?.recovery?.state === 'running'; }
  private queued() { try { return readdirSync(join(this.root(), 'requests')).filter(name => validId.test(name.slice(0, -5)) && name.endsWith('.json')); } catch { return []; } }
  private latest(): Job | null {
    try {
      const jobs = readdirSync(join(this.root(), 'jobs')).filter(id => validId.test(id)).map(id => { try { return this.read(join(this.root(), 'jobs', id, 'status.json')) as Job; } catch { return null; } }).filter((job): job is Job => Boolean(job));
      return jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] || null;
    } catch { return null; }
  }
  status() {
    let job = this.latest(); const pending = this.queued();
    if (pending.length) {
      try { const value = this.read(join(this.root(), 'requests', pending[0]!)); if (job?.id !== value.id) job = { id: value.id, kind: value.kind, state: 'queued', progress: 0, message: '等待维护服务处理', createdAt: value.createdAt }; } catch {}
    }
    return { current: readBuildInfo(), available: this.available(), job, queued: pending.length > 0, maxUploadBytes: 2 * 1024 ** 3 };
  }
  async check() {
    this.requireAvailable();
    const response = await fetch('https://api.github.com/repos/wstimin/shiye-3xuigl-L3/releases/latest', { headers: { accept: 'application/vnd.github+json', 'user-agent': 'shiye-maintenance' }, signal: AbortSignal.timeout(20000) }).catch(() => { throw new ServiceUnavailableException('暂时无法连接版本服务器，请稍后重新检测'); });
    if (!response.ok) throw new ServiceUnavailableException('版本服务器暂时不可用，请稍后重试');
    const release = await response.json() as { tag_name: string; draft?: boolean; prerelease?: boolean; body?: string; published_at?: string; assets?: { name: string; digest?: string; browser_download_url?: string }[] };
    const asset = release.assets?.find(item => item.name === 'shiye-3xuigl.zip'), current = readBuildInfo();
    if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name) || !/^\d+\.\d+\.\d+$/.test(current.version) || !/^sha256:[a-f0-9]{64}$/.test(asset?.digest || '')) throw new BadRequestException('发布信息尚未完整就绪，不能更新');
    const parts = (value: string) => value.replace(/^v/, '').split('.').map(Number);
    const a = parts(release.tag_name), b = parts(current.version);
    const different = a.findIndex((value, i) => value !== b[i]);
    const hasUpdate = different >= 0 && a[different]! > b[different]!;
    const version = release.tag_name.slice(1), id = randomUUID();
    this.checked = { id, version, sha256: asset!.digest!.slice(7), expires: Date.now() + 10 * 60_000, hasUpdate };
    return { checkId: id, version, hasUpdate, checkedAt: new Date().toISOString(), publishedAt: release.published_at, notes: String(release.body || '').slice(0, 12000), releaseUrl: `https://github.com/wstimin/shiye-3xuigl-L3/releases/tag/v${version}` };
  }
  startUpdate(checkId: string) {
    const checked = this.checked;
    if (!checked || !checked.hasUpdate || checked.id !== checkId || checked.expires < Date.now() || checked.version === readBuildInfo().version) throw new BadRequestException('请先重新检测最新版');
    const job = this.enqueue('update', { version: checked.version, sha256: checked.sha256, confirmed: true });
    this.checked = undefined;
    return job;
  }
  enqueue(kind: string, extra: Record<string, unknown> = {}, id = randomUUID()) {
    this.requireAvailable(); if (this.busy()) throw new ConflictException('已有维护任务进行中，请等待完成');
    const request = { kind, ...extra, id, createdAt: new Date().toISOString() };
    const temp = join(this.root(), 'uploads', `${id}.request`), destination = join(this.root(), 'requests', `${id}.json`);
    writeFileSync(temp, JSON.stringify(request), { mode: 0o600, flag: 'wx' }); renameSync(temp, destination);
    return { ...request, state: 'queued', progress: 0, message: '等待维护服务处理' };
  }
  job(id: string): Job {
    if (!validId.test(id)) throw new BadRequestException('维护任务编号无效');
    try { return this.read(join(this.root(), 'jobs', id, 'status.json')); } catch { throw new NotFoundException('维护任务正在准备或已过期'); }
  }
  download(id: string) {
    const job = this.job(id);
    if (job.kind !== 'backup' || job.state !== 'succeeded') throw new BadRequestException('备份尚未完成');
    const path = join(this.root(), 'jobs', id, 'backup.shiye');
    if (!existsSync(path)) throw new NotFoundException('备份文件已过期，请重新生成');
    return { stream: createReadStream(path), size: statSync(path).size, name: `shiye-backup-${job.result?.version || 'site'}-${id.slice(0, 8)}.shiye` };
  }
  async upload(request: Request) {
    this.requireAvailable(); if (this.busy()) throw new ConflictException('已有维护任务进行中');
    if (!request.is('application/octet-stream')) throw new BadRequestException('请选择本系统生成的备份文件');
    this.uploading = true;
    const id = randomUUID(), path = join(this.root(), 'uploads', id); let bytes = 0;
    const limit = new Transform({ transform(part: Buffer, _encoding, next) { bytes += part.length; next(bytes > 2 * 1024 ** 3 ? new Error('备份文件超过 2 GB') : null, part); } });
    try {
      await pipeline(request, limit, createWriteStream(path, { mode: 0o600, flags: 'wx' }));
      if (bytes === 0) throw new Error('备份文件为空');
      this.uploading = false;
      return this.enqueue('inspect', {}, id);
    } catch (error) {
      if (existsSync(path)) unlinkSync(path);
      throw new BadRequestException(error instanceof Error ? error.message : '上传失败');
    } finally { this.uploading = false; }
  }
}
