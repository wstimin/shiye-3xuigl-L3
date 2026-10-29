import type { FieldSchema, PanelRecord } from './panel-fields';

export function suiTagChoices(rows: PanelRecord[]) {
  return rows.filter(row => typeof row.tag === 'string' && row.tag).map(row => ({
    value: String(row.tag),
    label: `${String(row.tag)} · ${String(row.type || '')}`
  }));
}

export const suiRouteRule = { action: 'route', inbound: [], domain_suffix: [], ip_cidr: [], outbound: '' };
export const suiRouteSchema: FieldSchema = {
  type: 'object',
  properties: {
    final: { type: 'string' },
    rules: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          action: { enum: ['route', 'reject', 'sniff', 'resolve', 'hijack-dns'] },
          inbound: { type: 'array', items: { type: 'string' } },
          domain_suffix: { type: 'array', items: { type: 'string' } },
          ip_cidr: { type: 'array', items: { type: 'string' } },
          outbound: { type: 'string' }
        }
      }
    }
  }
};
