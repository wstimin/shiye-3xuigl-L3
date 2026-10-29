import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import type { Request } from 'express';
import type { Role } from '@shiye/shared';
import { ROLES_KEY } from './roles.decorator.js';
import type { SessionUser } from './auth.types.js';
import { createHash } from 'node:crypto';
import { PrismaService } from '../modules/prisma/prisma.service.js';

const COOKIE_NAMES: Record<Role, string> = {
  admin: 'shiye_admin_session',
  user: 'shiye_user_session'
};

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    const expectedRole = this.expectedRole(request, roles);
    const token = this.sessionToken(request, expectedRole) || bearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException('Please login first');

    let payload: SessionUser;
    try { payload = jwt.verify(token, sessionSecret()) as SessionUser; }
    catch { throw new UnauthorizedException('Session expired, please login again'); }
    if (roles?.length && !roles.includes(payload.role)) throw new UnauthorizedException('Permission denied');
    const account = payload.role === 'admin' && payload.userId
      ? await this.prisma.adminUser.findUnique({ where: { id: payload.userId }, select: { status: true, passwordHash: true } })
      : payload.role === 'user' && payload.customerId
        ? await this.prisma.customer.findUnique({ where: { id: payload.customerId }, select: { status: true, loginPasswordHash: true } })
        : null;
    const hash = account && ('passwordHash' in account ? account.passwordHash : account.loginPasswordHash);
    if (!account || account.status !== 'active' || !hash || payload.credentialVersion !== credentialVersion(hash))
      throw new UnauthorizedException('Session revoked, please login again');
    request.user = payload;
    return true;
  }

  private sessionToken(request: Request, role?: Role) {
    if (role) return request.cookies?.[COOKIE_NAMES[role]] || '';
    return request.cookies?.[COOKIE_NAMES.admin] || request.cookies?.[COOKIE_NAMES.user] || request.cookies?.shiye_session || '';
  }

  private expectedRole(request: Request, roles?: Role[]) {
    if (roles?.length === 1) return roles[0];
    const body = request.body as { entry?: unknown } | undefined;
    const entry = String(request.query.entry || body?.entry || '').trim();
    if (entry === 'admin' || entry === 'user') return entry;
    const path = request.path || request.originalUrl || '';
    if (path.startsWith('/admin/')) return 'admin';
    if (path.startsWith('/user/')) return 'user';
    return undefined;
  }
}

export function credentialVersion(passwordHash: string) {
  return createHash('sha256').update(passwordHash).digest('hex');
}

export function signSession(user: SessionUser) {
  return jwt.sign(user, sessionSecret(), { expiresIn: sessionTtl() });
}

export function sessionCookie(token: string, role: Role, maxAgeSeconds = 7 * 24 * 60 * 60) {
  return `${COOKIE_NAMES[role]}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secureCookieFlag()}`;
}

export function clearSessionCookie(role?: Role) {
  const names = role ? [COOKIE_NAMES[role]] : [...Object.values(COOKIE_NAMES), 'shiye_session'];
  return names.map((name) => `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secureCookieFlag()}`);
}

function secureCookieFlag() {
  const publicUrl = process.env.PUBLIC_WEB_URL || process.env.APP_URL || process.env.PUBLIC_SITE_URL || '';
  return /^https:\/\//i.test(publicUrl) ? '; Secure' : '';
}

function bearerToken(value: string | undefined) {
  if (!value?.startsWith('Bearer ')) return '';
  return value.slice('Bearer '.length).trim();
}

function sessionSecret() {
  return process.env.SESSION_SECRET || process.env.JWT_SECRET || 'dev-only-change-me';
}

function sessionTtl(): SignOptions['expiresIn'] {
  return (process.env.SESSION_TTL || '7d') as SignOptions['expiresIn'];
}
