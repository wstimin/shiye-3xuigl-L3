import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { open } from 'yauzl';

export async function extractRelease(file, target) {
  const zip = await new Promise((ok, bad) => open(file, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, value) => error ? bad(error) : ok(value)));
  await new Promise((ok, bad) => {
    let count = 0, bytes = 0;
    const fail = error => { zip.close(); bad(error); };
    zip.once('error', fail); zip.once('end', ok);
    zip.on('entry', async entry => {
      try {
        const name = entry.fileName, mode = (entry.externalFileAttributes >>> 16) & 0xf000;
        if (++count > 30000 || (bytes += entry.uncompressedSize) > 1024 ** 3 || name.startsWith('/') || name.includes('\\') || name.includes(':') || name.split('/').some(part => part === '..' || part === '.') || mode === 0xa000 || entry.isEncrypted()) throw Error('发布包包含无效目录或超过限制');
        const path = join(target, name);
        if (name.endsWith('/')) mkdirSync(path, { recursive: true });
        else { mkdirSync(dirname(path), { recursive: true }); const stream = await new Promise((ok, bad) => zip.openReadStream(entry, (error, value) => error ? bad(error) : ok(value))); await pipeline(stream, createWriteStream(path, { flags: 'wx', mode: 0o600 })); }
        zip.readEntry();
      } catch (error) { fail(error); }
    });
    zip.readEntry();
  });
}
