import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { read3dmTextureResource } from './3dm-texture-resource.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const root = await mkdtemp(path.join(tmpdir(), '3dm-resource-test-'));
const bytes = Buffer.from('resource contract test; not an image');
await writeFile(path.join(root, 'fixture.bin'), bytes);
await writeFile(path.join(root, 'LICENSE'), 'test-license');
const record = () => ({ relativePath: 'fixture.bin', sha256: sha(bytes), sourceUrl: 'https://example.test/fixture',
  distribution: 'reviewed-allowed', licenseId: 'test-only', licensePath: 'LICENSE', licenseSha256: sha('test-license') });
test('bounded hash-bound bytes preserve identity without claiming image validity', async () => {
  const result = await read3dmTextureResource(root, record());
  assert.deepEqual(result.bytes, bytes); assert.equal(result.status, 'verified-resource-bytes-not-render-mapping');
});
test('absolute, traversal, ADS, encoded and Windows ambiguous paths rejected', async () => {
  for (const value of ['/Applications/Rhino/bump_grit.png', 'C:/secret.png', '//server/share/a', '../a', 'a/../b', 'a\\b', 'a:stream', '%2e%2e/a', 'CON.png', 'a.', 'a ', 'a//b', ''])
    await assert.rejects(read3dmTextureResource(root, { ...record(), relativePath: value }), /path-unsafe/);
});
test('missing, digest, license and size failures rejected', async () => {
  await assert.rejects(read3dmTextureResource(root, { ...record(), relativePath: 'missing.png' }), /missing/);
  await assert.rejects(read3dmTextureResource(root, { ...record(), sha256: '0'.repeat(64) }), /hash-mismatch/);
  await assert.rejects(read3dmTextureResource(root, { ...record(), distribution: 'unknown' }), /distribution/);
  await assert.rejects(read3dmTextureResource(root, { ...record(), licenseSha256: '0'.repeat(64) }), /license-hash/);
  await assert.rejects(read3dmTextureResource(root, { ...record(), sourceUrl: 'http://example.test/a' }), /source-invalid/);
  await assert.rejects(read3dmTextureResource(root, { ...record(), sourceUrl: 'https://user@example.test/a' }), /source-invalid/);
  await assert.rejects(read3dmTextureResource(root, { ...record(), licenseId: '../unknown' }), /distribution/);
  await assert.rejects(read3dmTextureResource(root, record(), { maxBytes: 2 }), /byte-budget/);
});
test('directory link escaping resource root rejected', async () => {
  const outside = await mkdtemp(path.join(tmpdir(), '3dm-resource-outside-'));
  await writeFile(path.join(outside, 'image.bin'), bytes);
  await symlink(outside, path.join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(read3dmTextureResource(root, { ...record(), relativePath: 'link/image.bin' }), /path-escape/);
});
