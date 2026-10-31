import { z } from 'zod';
import { randomUuid } from './random-uuid.js';

export const suiServerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  baseUrl: z.string().trim().url().max(500).refine(value => {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    } catch { return false; }
  }, '请输入完整的 HTTP(S) 面板地址，包含面板路径'),
  token: z.string().trim().max(4096).optional(),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(2000).default('')
});
export const suiClientProtocols = ['vless', 'vmess', 'trojan', 'shadowsocks', 'socks', 'http', 'mixed', 'hysteria', 'hysteria2', 'tuic', 'anytls', 'naive', 'shadowtls', 'snell'];

export function suiClientConfigKey(protocol: string, inbound: { method?: unknown } = {}) {
  return protocol === 'shadowsocks' && inbound.method === '2022-blake3-aes-128-gcm' ? 'shadowsocks16' : protocol;
}

export function suiClientCredentials(protocol: string, name: string, inbound: { method?: unknown } = {}): Record<string, string> {
  if (!suiClientProtocols.includes(protocol)) throw new Error('此入站协议不使用客户端账号');
  const random = (size: number) => globalThis.crypto.getRandomValues(new Uint8Array(size));
  const base64 = (size: number) => btoa(String.fromCharCode(...random(size)));
  const password = () => base64(24).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const identity: Record<string, string> = ['socks', 'http', 'mixed', 'naive'].includes(protocol) ? { username: name } : { name };
  if (['vless', 'vmess', 'tuic'].includes(protocol)) return { ...identity, uuid: randomUuid(), ...(protocol === 'tuic' ? { password: password() } : {}) };
  if (protocol === 'snell') return { ...identity, userkey: Array.from(random(16), byte => byte.toString(16).padStart(2, '0')).join('') };
  if (protocol === 'hysteria') return { ...identity, auth_str: password() };
  return { ...identity, password: protocol === 'shadowsocks' ? base64(inbound.method === '2022-blake3-aes-128-gcm' ? 16 : 32) : password() };
}

export const suiSaveSchema = z.object({
  object: z.enum(['clients', 'inbounds', 'outbounds', 'endpoints', 'services', 'tls', 'config', 'settings']),
  action: z.enum(['new', 'edit', 'del', 'set']),
  data: z.record(z.string(), z.unknown())
}).superRefine((value, ctx) => {
  if (['config', 'settings'].includes(value.object)) {
    if (!['edit', 'set'].includes(value.action)) ctx.addIssue({ code: 'custom', message: '配置只能整体保存' });
  } else {
    if (value.action === 'set') ctx.addIssue({ code: 'custom', message: '资源不支持 set 操作' });
    if (['edit', 'del'].includes(value.action) && (!Number.isInteger(value.data.id) || Number(value.data.id) <= 0)) {
      ctx.addIssue({ code: 'custom', message: '修改或删除资源需要有效的 ID' });
    }
    if (value.object === 'clients' && value.action !== 'del') {
      const client = z.object({ name: z.string().trim().min(1).max(160), enable: z.boolean(), volume: z.number().int().nonnegative().safe(), expiry: z.number().int().safe(), inbounds: z.array(z.number().int().positive()).min(1), config: z.record(z.string(), z.unknown()) }).safeParse(value.data);
      if (!client.success) ctx.addIssue({ code: 'custom', message: '客户端需要标识、有效配额、协议凭据及至少一个授权入站' });
    }
  }
});
export const suiControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('restartSb') }),
  z.object({ action: z.literal('maintenance'), enable: z.boolean() }),
  z.object({ action: z.literal('closeSessions'), u: z.string().trim().min(1).max(160) })
]);
