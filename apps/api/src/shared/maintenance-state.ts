import { existsSync } from 'node:fs';
import { join } from 'node:path';

let operations = 0;
export const maintenanceDirectory = () => process.env.SHIYE_MAINTENANCE_DIR || '/var/lib/shiye-maintenance/shiye-api';
export const maintenanceActive = () => existsSync(join(maintenanceDirectory(), 'gate.json'));
export const maintenanceOperations = () => operations;
export function beginMaintenanceOperation() {
  operations++;
  let ended = false;
  return () => { if (!ended) { ended = true; operations--; } };
}
export async function maintenanceBackground<T>(operation: () => Promise<T>) {
  if (maintenanceActive()) return;
  const end = beginMaintenanceOperation();
  try { return await operation(); } finally { end(); }
}
