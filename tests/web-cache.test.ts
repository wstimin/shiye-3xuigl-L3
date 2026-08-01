import test from 'node:test';
import assert from 'node:assert/strict';
import { hashedAssetCacheControl, htmlCacheControl, isHashedAssetPath, setHtmlNoStore, setStaticAssetHeaders } from '../apps/api/src/web-cache.js';

function responseHeaders() {
  const values = new Map<string, string>();
  return {
    response: { setHeader: (name: string, value: string) => values.set(name.toLowerCase(), value) } as any,
    values
  };
}

test('hashed frontend assets use immutable long-term caching', () => {
  assert.equal(isHashedAssetPath('/opt/shiye/dist/admin-web/assets/index-ABC123.js'), true);
  assert.equal(isHashedAssetPath('C:\\shiye\\dist\\admin-web\\assets\\index-ABC123.js'), true);
  const { response, values } = responseHeaders();
  setStaticAssetHeaders(response, '/opt/shiye/dist/user-web/assets/index-ABC123.css');
  assert.equal(values.get('cache-control'), hashedAssetCacheControl);
});

test('non-hashed frontend files are revalidated', () => {
  assert.equal(isHashedAssetPath('/opt/shiye/dist/user-web/favicon.ico'), false);
  const { response, values } = responseHeaders();
  setStaticAssetHeaders(response, '/opt/shiye/dist/user-web/favicon.ico');
  assert.equal(values.get('cache-control'), 'no-cache');
});

test('direct index files also receive no-store headers', () => {
  const { response, values } = responseHeaders();
  setStaticAssetHeaders(response, '/opt/shiye/dist/admin-web/index.html');
  assert.equal(values.get('cache-control'), htmlCacheControl);
});

test('frontend HTML is never served from a stale cache', () => {
  const { response, values } = responseHeaders();
  setHtmlNoStore(response);
  assert.equal(values.get('cache-control'), htmlCacheControl);
  assert.equal(values.get('pragma'), 'no-cache');
  assert.equal(values.get('expires'), '0');
});
