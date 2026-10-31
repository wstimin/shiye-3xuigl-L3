import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { compressAssets } from '../scripts/compress-assets.mjs';
import { serveStaticAssets } from '../apps/api/src/web-assets.js';

test('compressed static assets work inside hidden release directories, preserve negotiation and never expose dotfiles', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'shiye-web-'));
  const root = join(workspace, '.shiye-maintenance', 'releases', 'runtime', 'dist', 'user-web');
  const assets = join(root, 'assets');
  mkdirSync(assets, { recursive: true });
  const content = 'console.log("verified");\n'.repeat(1000), file = join(assets, 'app-ABC.js');
  writeFileSync(file, content);
  assert.equal(compressAssets(assets), 1);
  writeFileSync(join(assets, '.private.js'), 'private');
  writeFileSync(join(root, '.env'), 'private');
  assert.equal(gunzipSync(readFileSync(file + '.gz')).toString(), content);
  assert.equal(brotliDecompressSync(readFileSync(file + '.br')).toString(), content);
  const app = express(); app.use(serveStaticAssets(root));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as { port: number }).port;
  try {
    for (const encoding of ['gzip', 'br', 'identity']) {
      const response = await fetch(base + '/assets/app-ABC.js', { headers: { 'accept-encoding': encoding } });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('content-encoding'), encoding === 'identity' ? null : encoding);
      assert.match(response.headers.get('content-type') || '', /javascript/);
      assert.match(response.headers.get('vary') || '', /Accept-Encoding/i);
      assert.match(response.headers.get('cache-control') || '', /immutable/);
      assert.equal(await response.text(), content);
    }
    const head = await fetch(base + '/assets/app-ABC.js', { method: 'HEAD', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(head.headers.get('content-encoding'), 'gzip');
    assert.equal(await head.text(), '');
    const identity = await fetch(base + '/assets/app-ABC.js', { headers: { 'accept-encoding': 'gzip;q=0,br;q=0,identity;q=1' } });
    assert.equal(identity.headers.get('content-encoding'), null);
    assert.equal((await fetch(base + '/assets/%2e%2e%2foutside.js')).status, 404);
    assert.equal((await fetch(base + '/assets/.private.js')).status, 404);
    assert.equal((await fetch(base + '/.env')).status, 404);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(workspace, { recursive: true, force: true });
  }
});
