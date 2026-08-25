export function testLocks() {
  return {
    customerNodeKey: (id: string) => `customer-node:${id}`,
    serviceNodeKey: (id: string) => `service-node:${id}`,
    xrayConfigKey: (id: string) => `xray-config:${id}`,
    withLock: async <T>(_key: string, operation: () => Promise<T>) => operation()
  } as any;
}
