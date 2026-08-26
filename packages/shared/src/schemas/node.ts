import { z } from 'zod';

export const serviceNodeProtocolValues = [
  'vless',
  'vmess',
  'trojan',
  'shadowsocks',
  'hysteria',
  'socks',
  'http',
  'mixed',
  'wireguard',
  'dokodemo',
  'tunnel'
] as const;

export const serviceNodeProtocolSchema = z.enum(serviceNodeProtocolValues);

export const serviceNodeEncryptionValues = [
  'none',
  'tls',
  'reality'
] as const;

export const serviceNodeEncryptionSchema = z.enum(serviceNodeEncryptionValues);

export const serviceNodeTransportValues = [
  'tcp',
  'ws',
  'grpc',
  'httpupgrade',
  'xhttp'
] as const;

export const serviceNodeTransportSchema = z.enum(serviceNodeTransportValues);

export const serviceNodeTcpHeaderValues = ['none', 'http'] as const;
export const serviceNodeTcpHeaderSchema = z.enum(serviceNodeTcpHeaderValues);

export const serviceNodeXhttpModeValues = ['auto', 'packet-up', 'stream-up', 'stream-one'] as const;
export const serviceNodeXhttpModeSchema = z.enum(serviceNodeXhttpModeValues);

export const xuiServerUpsertSchema = z.object({
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string().url(),
  basePath: z.string().trim().max(120).optional(),
  username: z.string().trim().min(1).max(100).optional(),
  password: z.string().max(256).optional(),
  token: z.string().max(2048).optional(),
  shareHost: z.string().trim().max(255).optional().or(z.literal('')),
  tlsServerName: z.string().trim().max(255).optional().or(z.literal('')),
  tlsCertFile: z.string().trim().max(500).optional().or(z.literal('')),
  tlsKeyFile: z.string().trim().max(500).optional().or(z.literal('')),
  realityTarget: z.string().trim().max(255).optional().or(z.literal('')),
  realityServerName: z.string().trim().max(255).optional().or(z.literal('')),
  realityFingerprint: z.string().trim().max(40).optional().or(z.literal('')),
  realitySpiderX: z.string().trim().max(120).optional().or(z.literal('')),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional()
});

export const serviceNodeUpsertSchema = z.object({
  name: z.string().trim().min(1).max(100),
  serverId: z.string().min(1),
  remoteMode: z.enum(['create', 'bind']).default('create'),
  takeover: z.boolean().default(false),
  inboundId: z.coerce.number().int().optional(),
  inboundPort: z.coerce.number().int().min(1).max(65535).optional(),
  protocol: serviceNodeProtocolSchema.default('vless'),
  encryption: serviceNodeEncryptionSchema.default('none'),
  transport: serviceNodeTransportSchema.default('tcp'),
  tcpHeaderType: serviceNodeTcpHeaderSchema.default('none'),
  transportHost: z.string().trim().max(255).optional().or(z.literal('')),
  transportPath: z.string().trim().max(500).optional().or(z.literal('')),
  grpcServiceName: z.string().trim().max(255).optional().or(z.literal('')),
  grpcAuthority: z.string().trim().max(255).optional().or(z.literal('')),
  grpcMultiMode: z.boolean().default(false),
  xhttpMode: serviceNodeXhttpModeSchema.default('auto'),
  realityTarget: z.string().trim().max(255).optional().or(z.literal('')),
  realityServerName: z.string().trim().max(255).optional().or(z.literal('')),
  realityMinClientVersion: z.string().trim().max(40).regex(/^\d+\.\d+\.\d+$/, '最小客户端版本格式应为 1.0.0').optional().or(z.literal('')),
  socksRelayEnabled: z.boolean().default(false),
  socksNodeId: z.string().trim().optional().or(z.literal('')),
  priceMonthly: z.coerce.number().finite().min(0).default(0),
  trafficLimitGb: z.coerce.number().finite().min(0).default(0),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional()
});

export const resourceOwnershipValues = ['managed', 'referenced', 'shared'] as const;
export const resourceOwnershipSchema = z.enum(resourceOwnershipValues);

export const clientControlModeValues = ['reference', 'subscription_managed', 'fully_managed'] as const;
export const clientControlModeSchema = z.enum(clientControlModeValues);

export const socksNodeUpsertSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(255),
  port: z.coerce.number().int().min(1).max(65535),
  username: z.string().trim().max(120).optional(),
  password: z.string().max(256).optional(),
  enabled: z.boolean().default(true),
  remark: z.string().trim().max(500).optional()
});

export const customerNodeCreateSchema = z.object({
  serviceNodeId: z.string().min(1),
  xuiEmail: z.string().trim().min(1).max(160).optional().or(z.literal('')),
  uuid: z.string().trim().max(80).optional(),
  expireAt: z.coerce.date().optional().nullable(),
  trafficLimitGb: z.coerce.number().finite().min(0).optional(),
  remoteControl: clientControlModeSchema.default('reference'),
  remoteAction: z.enum(['bind', 'create']).default('bind'),
  takeover: z.boolean().default(false)
});

export const outboundImportFormatValues = [
  'auto',
  'xray_json',
  'socks',
  'http',
  'shadowsocks',
  'vmess',
  'vless',
  'trojan',
  'wireguard',
  'subscription'
] as const;

export const outboundImportFormatSchema = z.enum(outboundImportFormatValues);

export const outboundImportPreviewSchema = z.object({
  input: z.string().trim().min(1).max(1024 * 1024),
  format: outboundImportFormatSchema.default('auto'),
  name: z.string().trim().min(1).max(120).optional()
});

export const outboundImportSchema = outboundImportPreviewSchema.extend({
  serverId: z.string().min(1),
  ownership: resourceOwnershipSchema.default('managed'),
  strategy: z.enum(['local_only', 'target_panel']).default('target_panel'),
  conflict: z.enum(['reject', 'rename', 'replace_managed', 'takeover']).default('reject'),
  createRoute: z.boolean().default(false),
  inboundTags: z.array(z.string().trim().min(1).max(160)).max(100).default([])
});

export const networkRouteUpsertSchema = z.object({
  serverId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  serviceNodeId: z.string().min(1).optional().nullable(),
  outboundId: z.string().min(1).optional().nullable(),
  ownership: resourceOwnershipSchema.default('managed'),
  rule: z.record(z.unknown()).refine((rule) => rule.type === undefined || rule.type === 'field', '目前仅支持 field 路由规则'),
  pushRemote: z.boolean().default(true),
  conflict: z.enum(['reject', 'replace_managed', 'takeover']).default('reject')
});

export const remoteClientCreateSchema = z.object({
  email: z.string().trim().min(1).max(160),
  uuid: z.string().trim().max(80).optional(),
  subId: z.string().trim().max(80).optional(),
  expireAt: z.coerce.date().optional().nullable(),
  trafficLimitGb: z.coerce.number().finite().min(0).default(0),
  enabled: z.boolean().default(true)
});

export const remoteClientPatchSchema = z.object({
  email: z.string().trim().min(1).max(160).optional(),
  expireAt: z.coerce.date().optional().nullable(),
  trafficLimitGb: z.coerce.number().finite().min(0).optional(),
  enabled: z.boolean().optional()
}).refine((value) => Object.values(value).some((item) => item !== undefined), '至少填写一个要更新的字段');

export const renewalSchema = z.object({
  months: z.coerce.number().int().min(1).max(36),
  requestId: z.string().trim().uuid()
});

export const userRenewalSchema = renewalSchema.extend({
  nodeId: z.string().min(1)
});
