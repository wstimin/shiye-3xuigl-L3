import { decodePanelValue, type PanelRecord } from './panel-fields';

export type PanelConnection = { id: string; name: string; provider?: string; enabled: boolean };
export type LinkedInbound = { id: string; serverId: string; inboundId?: number | null; config?: { suiClientId?: number } | null };
export type PanelInbound = { id: number; name: string; protocol: string; port: number; enabled: boolean; linked?: LinkedInbound; reason: string };
const businessProtocols = new Set(['vless', 'vmess', 'trojan', 'shadowsocks', 'hysteria', 'hysteria2']);

export function panelInbounds(value: unknown, panel: PanelConnection, linked: LinkedInbound[]): PanelInbound[] {
  const decoded = decodePanelValue(value) as PanelRecord;
  const rows = Array.isArray(decoded) ? decoded : decoded?.inbounds;
  if (!Array.isArray(rows)) throw new Error('面板未返回完整入站列表，请刷新重试');
  return rows.map((row: PanelRecord) => {
    const id = Number(row.id), protocol = String(row.protocol || row.type || '');
    return { id, name: String(row.remark || row.tag || `入站 ${id}`), protocol, port: Number(row.port || row.listen_port || 0), enabled: (row.enable ?? row.enabled) !== false,
      linked: linked.find(node => node.serverId === panel.id && node.inboundId === id),
      reason: panel.provider !== 'sui' && !businessProtocols.has(protocol) ? '该协议可配置管理，暂不支持本系统的按用户计费；请使用管理入口。' : '' };
  });
}

export function suiClientReason(client: PanelRecord, inboundId: number, linked: LinkedInbound[], serverId: string) {
  if (linked.some(node => node.serverId === serverId && node.config?.suiClientId === Number(client.id))) return '客户端已接入业务';
  if (!Array.isArray(client.inbounds) || client.inbounds.length !== 1 || Number(client.inbounds[0]) !== inboundId) return '须仅授权当前入站，避免共享额度互相影响';
  if (client.delayStart === true || Number(client.expiry) < 0) return '请先关闭首次使用计时';
  return '';
}

export function inboundManager(panel: PanelConnection, inboundId?: number, create = false) {
  return panel.provider === 'sui'
    ? { path: '/sui-servers', query: { serverId: panel.id, resource: 'inbounds', from: 'services', ...(create ? { create: '1' } : {}), ...(inboundId ? { inboundId: String(inboundId) } : {}) } }
    : { path: '/xui-native', query: { serverId: panel.id, section: 'inbounds', from: 'services', ...(create ? { create: '1' } : {}), ...(inboundId ? { inboundId: String(inboundId) } : {}) } };
}
