import { AsyncLocalStorage } from 'node:async_hooks';
import { BadGatewayException, BadRequestException, Injectable } from '@nestjs/common';
import { createConnection, type RowDataPacket } from 'mysql2/promise';

@Injectable()
export class DatabaseLockService {
  private readonly activeLocks = new AsyncLocalStorage<Set<string>>();

  customerNodeKey(customerNodeId: string) {
    return `customer-node:${customerNodeId}`;
  }

  serviceNodeKey(serviceNodeId: string) {
    return `service-node:${serviceNodeId}`;
  }

  xrayConfigKey(serverId: string) {
    return `xray-config:${serverId}`;
  }

  panelOperationKey(serverId: string) {
    return `panel-operation:${serverId}`;
  }

  async withLock<T>(key: string, operation: () => Promise<T>, timeoutSeconds = 30): Promise<T> {
    const lockName = `shiye:${key}`.slice(0, 64);
    const active = this.activeLocks.getStore();
    if (active?.has(lockName)) return operation();

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new BadGatewayException('DATABASE_URL 未配置，无法执行并发互斥');
    const connection = await createConnection(databaseUrl);
    let acquired = false;
    try {
      const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [lockName, timeoutSeconds]);
      acquired = Number(rows[0]?.acquired) === 1;
      if (!acquired) throw new BadRequestException('当前资源正在执行其他操作，请稍后重试');
      const next = new Set(active || []);
      next.add(lockName);
      return await this.activeLocks.run(next, operation);
    } finally {
      if (acquired) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
      await connection.end().catch(() => undefined);
    }
  }

  async withLocks<T>(keys: string[], operation: () => Promise<T>, timeoutSeconds = 30): Promise<T> {
    const active = this.activeLocks.getStore();
    const lockNames = [...new Set(keys.map((key) => `shiye:${key}`.slice(0, 64)))]
      .filter((lockName) => !active?.has(lockName))
      .sort();
    if (!lockNames.length) return operation();

    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new BadGatewayException('DATABASE_URL 未配置，无法执行并发互斥');
    const connection = await createConnection(databaseUrl);
    const acquired: string[] = [];
    try {
      for (const lockName of lockNames) {
        const [rows] = await connection.query<RowDataPacket[]>('SELECT GET_LOCK(?, ?) AS acquired', [lockName, timeoutSeconds]);
        if (Number(rows[0]?.acquired) !== 1) throw new BadRequestException('当前资源正在执行其他操作，请稍后重试');
        acquired.push(lockName);
      }
      const next = new Set(active || []);
      for (const lockName of acquired) next.add(lockName);
      return await this.activeLocks.run(next, operation);
    } finally {
      for (const lockName of [...acquired].reverse()) {
        await connection.query('SELECT RELEASE_LOCK(?)', [lockName]).catch(() => undefined);
      }
      await connection.end().catch(() => undefined);
    }
  }
}
