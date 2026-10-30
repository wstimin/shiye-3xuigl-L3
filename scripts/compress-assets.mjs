import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliCompressSync, gzipSync } from 'node:zlib';

export function compressAssets(directory) {
  let count = 0;
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) count += compressAssets(path);
    else if (/\.(js|css|svg)$/.test(entry.name)) {
      const data = readFileSync(path);
      if (data.length < 1024) continue;
      writeFileSync(path + '.gz', gzipSync(data, { level: 9 }));
      writeFileSync(path + '.br', brotliCompressSync(data));
      count++;
    }
  }
  return count;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = ['admin-web', 'user-web'].reduce((sum, app) => sum + compressAssets(resolve('dist', app, 'assets')), 0);
  console.log(`Precompressed ${count} frontend assets (gzip and Brotli).`);
}
