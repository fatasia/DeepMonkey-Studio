import path from 'node:path';
import { realpath, open } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function reject(code) { throw new Error(code); }
function safeRelative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || /[:%\x00-\x1f\x7f]/.test(value)
    || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) reject('resource-path-unsafe');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) reject('resource-path-unsafe');
  return value;
}
async function boundedRead(root, relative, maxBytes) {
  const candidate = path.resolve(root, safeRelative(relative));
  let actual;
  try { actual = await realpath(candidate); } catch { reject('resource-missing'); }
  const rel = path.relative(root, actual);
  if (path.isAbsolute(rel) || rel === '..' || rel.startsWith(`..${path.sep}`)) reject('resource-path-escape');
  const handle = await open(actual, 'r');
  try {
    const before = await handle.stat();
    if (await realpath(candidate) !== actual || await realpath(actual) !== actual) reject('resource-changed');
    if (!before.isFile()) reject('resource-not-file');
    if (before.size <= 0 || before.size > maxBytes) reject('resource-byte-budget');
    const bytes = Buffer.alloc(before.size); let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) reject('resource-changed'); offset += read.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, bytes.length);
    const after = await handle.stat();
    if (extra.bytesRead || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || await realpath(candidate) !== actual) reject('resource-changed');
    return bytes;
  } finally { await handle.close(); }
}

/** Reads only explicit, reviewed root-relative resources. Does not decode or embed images. */
export async function read3dmTextureResource(rootPath, record, { maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 64 * 1024 * 1024) reject('resource-byte-budget');
  if (!record || typeof record !== 'object') reject('resource-record-invalid');
  // Source paths never act as a basename search or authorization to fetch a URL.
  safeRelative(record.relativePath);
  if (!/^[a-f0-9]{64}$/.test(record.sha256 ?? '')) reject('resource-hash-required');
  let source;
  try { source = new URL(record.sourceUrl); } catch { reject('resource-source-invalid'); }
  if (source.protocol !== 'https:' || source.username || source.password || source.hash
    || source.href.length > 2048) reject('resource-source-invalid');
  if (record.distribution !== 'reviewed-allowed' || !/^[A-Za-z0-9][A-Za-z0-9.+-]{0,127}$/.test(record.licenseId ?? '')
    || !/^[a-f0-9]{64}$/.test(record.licenseSha256 ?? '')) reject('resource-distribution-unproven');
  const root = await realpath(rootPath);
  const license = await boundedRead(root, record.licensePath, 256 * 1024);
  if (hash(license) !== record.licenseSha256) reject('resource-license-hash-mismatch');
  const bytes = await boundedRead(root, record.relativePath, maxBytes);
  if (hash(bytes) !== record.sha256) reject('resource-hash-mismatch');
  return { bytes, sha256: record.sha256, relativePath: record.relativePath,
    sourceUrl: record.sourceUrl, licenseId: record.licenseId, licenseSha256: record.licenseSha256,
    status: 'verified-resource-bytes-not-render-mapping' };
}
