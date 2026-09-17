import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'xt-identity-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = 'synthetic source identity fixture';
  const json = { accessors: [{ count: 3 }], meshes: [{ primitives: [{ indices: 0, mode: 4,
    extras: { bimSourceMap: { schemaVersion: 1, scope: 'source-file-local', format: 'X_T',
      body: '7', faceRanges: [[0, 1, '42']] } } }] }] };
  // This synthetic container tests only identity evidence plumbing, not geometry.
  const text = JSON.stringify(json);
  const payload = Buffer.from(text.padEnd(Math.ceil(Buffer.byteLength(text) / 4) * 4));
  const glb = Buffer.alloc(20 + payload.length);
  [0x46546c67, 2, glb.length, payload.length, 0x4e4f534a].forEach((value, i) => glb.writeUInt32LE(value, i * 4));
  payload.copy(glb, 20);
  await writeFile(path.join(root, 'source.x_t'), source);
  await writeFile(path.join(root, 'mesh.glb'), glb);
  const raw = { schemaVersion: 1, source: path.join(root, 'source.x_t'), sourceBytes: Buffer.byteLength(source),
    bodies: [{ body: '7', faces: ['42'] }] };
  const row = { source: 'source.x_t', sourceSha256: sha(source), status: 'preview-evidence',
    countsAgree: true, output: 'mesh.glb', outputSha256: sha(glb), geometry: { triangleCount: 1 } };
  async function run(rows = [row], rawRows = [raw]) {
    await writeFile(path.join(root, 'raw.jsonl'), rawRows.map(value => JSON.stringify(value)).join('\n'));
    await writeFile(path.join(root, 'evidence.json'), JSON.stringify({ results: rows }));
    return execute(process.execPath, ['scripts/audit-xt-glb-source-identities.mjs', path.join(root, 'raw.jsonl'),
      path.join(root, 'evidence.json'), root, path.join(root, 'result.json')], { timeout: 10000, windowsHide: true });
  }
  return { root, row, raw, run };
}

test('binds a one-to-one source and output identity record', async t => {
  const f = await fixture(t);
  await f.run();
  const report = JSON.parse(await readFile(path.join(f.root, 'result.json'), 'utf8'));
  assert.equal(report.total, 1);
  assert.equal(report.results[0].uniqueFaces, 1);
});
test('rejects duplicate and empty evidence', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([f.row, f.row]), /one-to-one/);
  await assert.rejects(f.run([f.row], [f.raw, f.raw]), /Duplicate raw/);
  await assert.rejects(f.run([], []), /one-to-one/);
});
test('rejects changed source, output and same-count identity substitution', async t => {
  const f = await fixture(t);
  await assert.rejects(f.run([{ ...f.row, sourceSha256: '0'.repeat(64) }]), /Source bytes changed/);
  await assert.rejects(f.run([{ ...f.row, outputSha256: '0'.repeat(64) }]), /Output bytes changed/);
  await assert.rejects(f.run([f.row], [{ ...f.raw, bodies: [{ body: '7', faces: ['99'] }] }]), /Unknown FACE/);
});
