import { z } from 'zod';

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

export const suiSaveSchema = z.object({
  object: z.enum(['clients', 'inbounds', 'outbounds', 'endpoints', 'services', 'tls', 'config', 'settings']),
  action: z.enum(['new', 'edit', 'del', 'set']),
  data: z.record(z.unknown())
}).superRefine((value, ctx) => {
  if (['config', 'settings'].includes(value.object)) {
    if (!['edit', 'set'].includes(value.action)) ctx.addIssue({ code: 'custom', message: '配置只能整体保存' });
  } else {
    if (value.action === 'set') ctx.addIssue({ code: 'custom', message: '资源不支持 set 操作' });
    if (['edit', 'del'].includes(value.action) && (!Number.isInteger(value.data.id) || Number(value.data.id) <= 0)) {
      ctx.addIssue({ code: 'custom', message: '修改或删除资源需要有效的 ID' });
    }
    if (value.object === 'clients' && value.action !== 'del') {
      const client = z.object({ name: z.string().trim().min(1).max(160), enable: z.boolean(), volume: z.number().int().nonnegative().safe(), expiry: z.number().int().safe(), inbounds: z.array(z.number().int().positive()).min(1), config: z.record(z.unknown()) }).safeParse(value.data);
      if (!client.success) ctx.addIssue({ code: 'custom', message: '客户端需要标识、有效配额、协议凭据及至少一个授权入站' });
    }
  }
});
export const suiControlSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('restartSb') }),
  z.object({ action: z.literal('maintenance'), enable: z.boolean() }),
  z.object({ action: z.literal('closeSessions'), u: z.string().trim().min(1).max(160) })
]);
