import { BadRequestException, Injectable, InternalServerErrorException } from '@nestjs/common';
import { settingsUpdateSchema } from '@shiye/shared';
import { Prisma } from '@prisma/client';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service.js';

type BrandSettings = {
  brandName: string;
  logoDataUrl: string;
};

type BusinessSettings = {
  cardPurchaseUrl: string;
};

type SettingsUpdateInput = z.infer<typeof settingsUpdateSchema>;

@Injectable()
export class SettingsService {
  constructor(private readonly prisma: PrismaService) {}

  async publicBranding(): Promise<BrandSettings> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'brand' } });
    const value = row?.value && typeof row.value === 'object' ? row.value as Partial<BrandSettings> : {};
    return {
      brandName: value.brandName || process.env.APP_NAME || '十夜管理系统',
      logoDataUrl: value.logoDataUrl || ''
    };
  }

  async publicBusiness(): Promise<BusinessSettings> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: 'business' } });
    const value = row?.value && typeof row.value === 'object' ? row.value as Partial<BusinessSettings> : {};
    return { cardPurchaseUrl: value.cardPurchaseUrl || '' };
  }

  async publicSettings() {
    const [brand, business] = await Promise.all([this.publicBranding(), this.publicBusiness()]);
    return { ...brand, ...business };
  }

  async adminSettings() {
    const [brand, business] = await Promise.all([this.publicBranding(), this.publicBusiness()]);
    return { brand, business, runtime: this.runtimeSettings() };
  }

  async updateSettings(input: SettingsUpdateInput) {
    if (input.brand) {
      await this.prisma.systemSetting.upsert({
        where: { key: 'brand' },
        create: { key: 'brand', value: toJsonValue(input.brand) },
        update: { value: toJsonValue(input.brand) }
      });
    }

    if (input.business) {
      await this.prisma.systemSetting.upsert({
        where: { key: 'business' },
        create: { key: 'business', value: toJsonValue(input.business) },
        update: { value: toJsonValue(input.business) }
      });
    }

    if (input.runtime) {
      this.updateRuntimeSettings(input.runtime);
    }

    return this.adminSettings();
  }

  private runtimeSettings() {
    const adminPath = normalizeAdminPath(process.env.ADMIN_PATH || '/admin');
    return {
      adminPath,
      activeAdminPath: adminPath,
      restartRequired: false
    };
  }

  private updateRuntimeSettings(input: { adminPath: string }) {
    const adminPath = normalizeAdminPath(input.adminPath);
    const envPath = findEnvPath();
    if (!envPath) throw new InternalServerErrorException('未找到 .env 文件，无法保存管理路径');
    setEnvValue(envPath, 'ADMIN_PATH', adminPath);
    process.env.ADMIN_PATH = adminPath;
  }
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

function normalizeAdminPath(value: string) {
  const trimmed = String(value || '/admin').trim().replace(/\/+$/, '') || '/admin';
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
  if (path === '/' || /^\/api(?:\/|$)/i.test(path)) throw new BadRequestException('管理路径不能为 / 或 /api');
  if (!/^\/[A-Za-z0-9._~/-]+$/.test(path)) throw new BadRequestException('管理路径只能包含字母、数字、横线、下划线、点和斜杠');
  if (path.includes('//')) throw new BadRequestException('管理路径不能包含连续斜杠');
  return path;
}

function findEnvPath() {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  return candidates.find((path) => existsSync(path));
}

function setEnvValue(envPath: string, key: string, value: string) {
  const current = readFileSync(envPath, 'utf8');
  const lines = current.split(/\r?\n/);
  let updated = false;
  const next = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      updated = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!updated) {
    if (next.length && next[next.length - 1] !== '') next.push('');
    next.push(`${key}=${value}`);
  }
  writeFileSync(envPath, next.join('\n').replace(/\n*$/, '\n'), 'utf8');
}
