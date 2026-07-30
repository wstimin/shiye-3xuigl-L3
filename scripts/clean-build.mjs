import { readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const buildDirectories = [
  'dist',
  'apps/api/dist',
  'apps/admin-web/dist',
  'apps/user-web/dist',
  'packages/shared/dist',
  'packages/xui-client/dist',
  'packages/payment-core/dist',
  '.release'
];

for (const path of buildDirectories) remove(resolve(root, path));
remove(resolve(root, 'shiye-3xuigl.zip'));
removeTsBuildInfo(root);

console.log('Previous build outputs, release staging files and TypeScript build caches were removed.');

function remove(path) {
  rmSync(path, { recursive: true, force: true });
}

function removeTsBuildInfo(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) removeTsBuildInfo(path);
    else if (entry.name.endsWith('.tsbuildinfo')) remove(path);
  }
}
