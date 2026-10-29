import { BadGatewayException, BadRequestException } from '@nestjs/common';

type Row = Record<string, unknown>;
export function suiConfig(payload: Row): Row {
  const value = payload.config;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadGatewayException('S-UI 路由配置格式无效，请刷新面板');
  return value as Row;
}

function visit(value: unknown, check: (key: string, value: unknown, row: Row) => void) {
  if (Array.isArray(value)) for (const item of value) visit(item, check);
  else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
    check(key, item, value as Row);
    visit(item, check);
  }
}
function tags(value: unknown): string[] {
  if (value === undefined || value === null || value === '') return [];
  const list = Array.isArray(value) ? value : [value];
  if (list.some(item => typeof item !== 'string' || !item))
    throw new BadRequestException('关联入站或出站必须选择有效的名称');
  return list as string[];
}

export function assertSuiNetwork(config: Row, inbounds: Row[], outbounds: Row[], endpoints: Row[]) {
  const inboundTags = new Set(inbounds.map(row => row.tag));
  const outboundTags = new Set([...outbounds, ...endpoints].map(row => row.tag));
  const check = (value: unknown, known: Set<unknown>, label: string) => {
    for (const tag of tags(value)) if (!known.has(tag))
      throw new BadRequestException(`${label}「${tag}」不存在于当前面板，请重新选择`);
  };
  visit(config.route, (key, value, row) => {
    if (key === 'action' && value === 'route' && !tags(row.outbound).length)
      throw new BadRequestException('转发规则必须选择目标出站');
    if (key === 'inbound') check(value, inboundTags, '入站');
    if (key === 'outbound') check(value, outboundTags, '出站');
  });
  check((config.route as Row | undefined)?.final, outboundTags, '默认出站');
  visit([config, outbounds, endpoints], (key, value) => {
    if (key === 'detour' || key === 'outbounds') check(value, outboundTags, '出站');
  });
}

export function assertSuiResourceUnused(kind: string, tag: string, config: Row, outbounds: Row[], endpoints: Row[]) {
  let used = false;
  visit(config.route, (key, value) => {
    if (key === (kind === 'inbounds' ? 'inbound' : 'outbound') && tags(value).includes(tag)) used = true;
  });
  if (kind !== 'inbounds') {
    if ((config.route as Row | undefined)?.final === tag) used = true;
    visit([config, ...outbounds, ...endpoints], (key, value) => {
      if (['detour', 'outbounds', 'default'].includes(key) && tags(value).includes(tag)) used = true;
    });
  }
  if (used) throw new BadRequestException('该资源仍被路由或其他出站引用，请先解除关联后再删除或更名');
}
