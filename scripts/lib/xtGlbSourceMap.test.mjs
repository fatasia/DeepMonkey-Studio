import test from 'node:test';
import assert from 'node:assert/strict';
import { auditXtSourceMapJson, auditXtGlbSourceMap } from './xtGlbSourceMap.mjs';
const fixture = () => ({ accessors: [{ count: 6 }], meshes: [{ primitives: [{ indices: 0, mode: 4,
  extras: { bimSourceMap: { schemaVersion: 1, scope: 'source-file-local', format: 'X_T', body: '7',
    faceRanges: [[0, 1, '42'], [1, 1, '99']] } } }] }] });
test('counts identities across chunk splits without double counting faces', () => {
  const json = fixture();
  json.meshes[0].primitives.push(structuredClone(json.meshes[0].primitives[0]));
  assert.deepEqual(auditXtSourceMapJson(json), { bodies: 1, uniqueFaces: 2, primitiveCount: 2, triangles: 4 });
});
test('rejects missing, overlapping, unknown and cross-body identity', () => {
  for (const ranges of [[], [[0, 1, '42']], [[0, 1, '42'], [0, 1, '99']], [[0, 3, '42']], [[0, 2, '0']]]) {
    const json = fixture();
    json.meshes[0].primitives[0].extras.bimSourceMap.faceRanges = ranges;
    assert.throws(() => auditXtSourceMapJson(json));
  }
  const json = fixture();
  const other = structuredClone(json.meshes[0].primitives[0]);
  other.extras.bimSourceMap.body = '8';
  json.meshes[0].primitives.push(other);
  assert.throws(() => auditXtSourceMapJson(json), /multiple bodies/);
});
test('rejects malformed GLB framing', () => {
  assert.throws(() => auditXtGlbSourceMap(Buffer.alloc(20)), /framing/);
});
