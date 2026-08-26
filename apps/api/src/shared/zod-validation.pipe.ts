import { BadRequestException, Injectable, PipeTransform } from '@nestjs/common';
import type { ZodIssue, ZodSchema } from 'zod';

const fieldLabels: Record<string, string> = {
  serviceNodeId: '服务节点',
  xuiEmail: '官方客户端名称',
  email: '官方客户端名称',
  uuid: '客户端密钥',
  subId: '订阅标识',
  expireAt: '到期时间',
  trafficLimitGb: '流量额度',
  remoteControl: '托管模式',
  remoteAction: '远端操作',
  takeover: '接管确认',
  enabled: '启用状态'
};

@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown) {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException(result.error.issues.map(formatValidationIssue));
    }
    return result.data;
  }
}

export function formatValidationIssue(issue: ZodIssue) {
  const field = validationField(issue.path);
  const prefix = field ? `${field}：` : '';

  switch (issue.code) {
    case 'invalid_date':
      return `${prefix}日期格式无效，请重新选择`;
    case 'invalid_enum_value':
      return `${prefix}选项无效`;
    case 'invalid_type':
      if (issue.received === 'undefined' || issue.received === 'null') return `${prefix}不能为空`;
      if (issue.expected === 'number') return `${prefix}必须填写有效数字`;
      if (issue.expected === 'boolean') return `${prefix}必须选择有效状态`;
      if (issue.expected === 'string') return `${prefix}必须填写有效文本`;
      return `${prefix}数据类型无效`;
    case 'too_small':
      if (issue.type === 'number') return `${prefix}不能小于 ${issue.minimum}`;
      return `${prefix}${Number(issue.minimum) > 0 ? '不能为空或长度不足' : '长度不足'}`;
    case 'too_big':
      if (issue.type === 'number') return `${prefix}不能大于 ${issue.maximum}`;
      return `${prefix}内容过长，最多 ${issue.maximum} 个字符`;
    case 'unrecognized_keys':
      return `${prefix}包含不支持的字段：${issue.keys.join('、')}`;
    case 'custom':
      return `${prefix}${containsChinese(issue.message) ? issue.message : '内容不符合要求'}`;
    default:
      return `${prefix}${containsChinese(issue.message) ? issue.message : '内容格式无效'}`;
  }
}

function validationField(path: Array<string | number>) {
  if (!path.length) return '';
  return path.map((part) => typeof part === 'number' ? `第 ${part + 1} 项` : fieldLabels[part] || part).join(' / ');
}

function containsChinese(value: string) {
  return /[\u3400-\u9fff]/.test(value);
}
