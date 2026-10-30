import { decodePanelValue, fieldLabel, optionLabels, type PanelRecord } from './panel-fields';

export function templateParts(value: string) {
  return value.split(/(\{\{[^{}]+\}\})/g).filter(Boolean).map(value => ({ value, field: /^\{\{[^{}]+\}\}$/.test(value) }));
}
export function templateText(parts: { value: string }[]) { return parts.map(part => part.value).join(''); }

export function detailText(value: unknown, field = '', parent = ''): string {
  if (value === null || value === undefined || value === '') return '未设置';
  if (typeof value === 'boolean') return value ? '是' : '否';
  if (field === 'remarkTemplate' && typeof value === 'string') {
    const labels: Record<string, string> = { '{{INBOUND}}': '入站名称', '{{EMAIL}}': '客户端用户名', '{{TRAFFIC_LEFT}}': '剩余流量', '{{DAYS_LEFT}}': '剩余天数' };
    return templateParts(value).map(part => part.field ? `【${labels[part.value] || '扩展信息'}】` : part.value).join('');
  }
  if (typeof value === 'number') {
    if (/port$/i.test(field) || field === 'id' || /Id$/.test(field)) return String(value);
    if (['expiryTime', 'expiry', 'expiresAt'].includes(field)) return value > 0 ? new Date(value * (field === 'expiry' ? 1000 : 1)).toLocaleString('zh-CN') : '不限期';
    if (field === 'cpu' || field.endsWith('Pct')) return `${value.toFixed(1)}%`;
    if (field === 'uptime') {
      const seconds = Math.max(0, Math.floor(value));
      return `${Math.floor(seconds / 86400)} 天 ${Math.floor(seconds % 86400 / 3600)} 小时 ${Math.floor(seconds % 3600 / 60)} 分钟`;
    }
    if (['up', 'down', 'upload', 'download', 'sent', 'recv', 'mem'].includes(field) || ['mem', 'swap', 'disk', 'diskIO', 'diskTraffic', 'netIO', 'netTraffic'].includes(parent) && !field.startsWith('pkt')) {
      const unit = value === 0 ? 0 : Math.min(4, Math.max(0, Math.floor(Math.log(Math.abs(value)) / Math.log(1024))));
      return `${(value / 1024 ** unit).toLocaleString('zh-CN', { maximumFractionDigits: 2 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}${['netIO', 'diskIO'].includes(parent) ? '/s' : ''}`;
    }
    return value.toLocaleString('zh-CN', { maximumFractionDigits: 3 });
  }
  return optionLabels[String(value)] || String(value);
}

export function detailSummary(value: unknown): string {
  const decoded = decodePanelValue(value);
  if (Array.isArray(decoded)) return decoded.length ? `${decoded.length} 条记录，点击查看详情` : '暂无记录';
  if (decoded && typeof decoded === 'object') {
    const entries = Object.entries(decoded as PanelRecord);
    if (!entries.length) return '暂无详情';
    return entries.slice(0, 4).map(([key, item]) => `${fieldLabel(key)}：${item && typeof item === 'object' ? Array.isArray(item) ? `${item.length} 项` : '已记录' : detailText(item, key)}`).join('，');
  }
  return detailText(decoded);
}

export type ConfigGroup = { id: string; label: string; description: string; keys: string[] };
export function configGroups(value: PanelRecord, mode: 'settings' | 'core'): ConfigGroup[] {
  const definitions = mode === 'settings' ? [
    ['access', '访问与安全', '管理面板地址、证书、会话与访问控制。', /^(web|session|trusted|twoFactor|hasTwoFactor|hasApi|ipLimit)/i],
    ['subscription', '订阅服务', '订阅地址、展示内容与通用选项。', /^(sub(?!Happ|Incy|Clash|Json)|externalSub|externalTraffic|happ)/i],
    ['json', '通用订阅', '通用订阅的识别、连接与解析选项。', /^subJson/i],
    ['clash', 'Clash 客户端', 'Clash 订阅地址、分流与解析选项。', /^subClash/i],
    ['happ', 'Happ 客户端', 'Happ 界面展示、设备与连接选项。', /^subHapp/i],
    ['incy', 'Incy 客户端', 'Incy 界面展示、分流与连接选项。', /^subIncy/i],
    ['notification', '通知与告警', '消息渠道、发送时间与资源告警。', /^(tg|smtp|discord|hasTg|hasSmtp|hasDiscord|outboundDown|nodeDown)/i],
    ['directory', '账号目录', '外部账号目录、同步规则与默认额度。', /^(ldap|hasLdap)/i],
    ['general', '常规设置', '页面显示、时区与其他运行选项。', /.*/],
  ] as const : [
    ['inbounds', '入站服务', '接收连接的协议、监听地址与客户端。', /^(inbounds|endpoints)$/],
    ['outbounds', '出站连接', '出口名称、上游代理与连接方式。', /^(outbounds|outboundTestUrl)$/],
    ['routing', '流量路由', '匹配条件、分流顺序与目标出站。', /^(routing|route)$/],
    ['dns', '域名解析', '解析服务器、域名策略与本地域名。', /^(dns|hosts|fakedns)$/],
    ['logging', '日志与监控', '日志级别、运行统计与连接探测。', /^(log|stats|metrics|observatory|burstObservatory)$/],
    ['advanced', '运行选项', '安全策略、传输与其他核心设置。', /.*/],
  ] as const;
  const remaining = new Set(Object.keys(value));
  return definitions.map(([id, label, description, pattern]) => {
    const keys = [...remaining].filter(key => pattern.test(key));
    keys.forEach(key => remaining.delete(key));
    return { id, label, description, keys };
  }).filter(group => group.keys.length);
}
