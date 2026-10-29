import { BadGatewayException } from '@nestjs/common';

/** One mapping for native edits, business edits and remote reconciliation. */
export function suiAuthorization(client: Record<string, unknown>) {
  if (
    typeof client.enable !== 'boolean' ||
    !Number.isSafeInteger(client.expiry) ||
    Number(client.expiry) < 0 ||
    !Number.isSafeInteger(client.volume) ||
    Number(client.volume) < 0
  ) {
    throw new BadGatewayException(
      'S-UI 客户端授权数据无效，请检查远端到期时间与额度'
    );
  }
  const expireAt =
    Number(client.expiry) > 0 ? new Date(Number(client.expiry) * 1000) : null;
  if (expireAt && !Number.isFinite(expireAt.getTime()))
    throw new BadGatewayException('S-UI 到期时间超出有效范围');
  const expired = Boolean(expireAt && expireAt <= new Date());
  const active = client.enable && !expired;
  return {
    expireAt,
    trafficLimitGb: Number(client.volume) / 1024 ** 3,
    status: active ? ('active' as const) : ('disabled' as const),
    disabledReason: active
      ? null
      : expired
        ? ('expired' as const)
        : ('admin' as const)
  };
}
