import test from 'node:test';
import assert from 'node:assert/strict';
import { compareFaceWitness, mappedFaceGeometry } from './lib/xtFaceGeometryAudit.mjs';

const triangle = [[0, 0, 0], [10, 0, 0], [0, 10, 0]];
const face = { points: triangle, surface: { kind: 'plane', origin: [0, 0, 0], axis: [0, 0, 1] } };
test('same-body coplanar face-label swap fails boundary geometry witness', () => {
  const other = triangle.map(p => [p[0] + 30, p[1], p[2]]);
  assert.equal(compareFaceWitness(face, triangle).status, 'witness-match');
  assert.equal(compareFaceWitness(face, other).status, 'mismatch');
  assert.equal(compareFaceWitness({ ...face, points: other }, triangle).status, 'mismatch');
});
test('same boundary plus wrong interior vertex fails analytic surface', () => {
  assert.equal(compareFaceWitness(face, [...triangle, [2, 2, 1]]).status, 'mismatch');
});
test('ring-only analytic faces distinguish cylinder and sphere radius', () => {
  for (const kind of ['sphere', 'cylinder']) {
    const source = { points: [], surface: { kind, origin: [0, 0, 0], axis: [0, 0, 1], radius: 5 } };
    assert.equal(compareFaceWitness(source, [[5, 0, 0], [0, 5, 0]]).status, 'witness-match');
    assert.equal(compareFaceWitness(source, [[6, 0, 0]]).status, 'mismatch');
  }
});
test('absent witnesses remain unresolved, invalid geometry fails, f32 noise tolerated', () => {
  assert.equal(compareFaceWitness({ points: [], surface: null }, triangle).status, 'unresolved');
  assert.throws(() => compareFaceWitness(face, [[NaN, 0, 0]]));
  assert.throws(() => compareFaceWitness(face, []));
  assert.equal(compareFaceWitness(face, triangle.map(p => p.map(x => x + 0.001))).status, 'witness-match');
});
test('vertex-free ring torus uses both source radii and rejects a filled hole', () => {
  const source = { points: [], surface: { kind: 'torus', origin: [10, 20, 30], axis: [0, 0, -2], majorRadius: 5, radius: 1 } };
  const points = [[16, 20, 30], [14, 20, 30], [15, 20, 31], [10, 15, 29]];
  assert.equal(compareFaceWitness(source, points).status, 'witness-match');
  assert.equal(compareFaceWitness(source, [...points, [10, 20, 30]]).status, 'mismatch');
  assert.equal(compareFaceWitness(source, [[16.011, 20, 30]]).status, 'mismatch');
  assert.equal(compareFaceWitness(source, [[16.009, 20, 30]]).status, 'witness-match');
  assert.equal(compareFaceWitness({ ...source, surface: { ...source.surface, majorRadius: 6 } }, points).status, 'mismatch');
});
test('torus rejects degenerate axes, invalid radii and unsupported horn/spindle forms', () => {
  const surface = { kind: 'torus', origin: [0, 0, 0], axis: [1, 0, 0], majorRadius: 5, radius: 1 };
  assert.equal(compareFaceWitness({ points: [], surface }, [[0, 6, 0], [1, 5, 0]]).status, 'witness-match');
  for (const fields of [{ axis: [0, 0, 0] }, { radius: 0 }, { majorRadius: Infinity }, { majorRadius: 1 }, { majorRadius: 0.5 }]) {
    assert.throws(() => compareFaceWitness({ points: [], surface: { ...surface, ...fields } }, [[0, 6, 0]]));
  }
});
test('coincident geometry is an explicit blind spot: witness match is not unique identity', () => {
  assert.equal(compareFaceWitness({ ...face, face: '999' }, triangle).status, 'witness-match');
});

function fixture(swapped = false, badIndex = false) {
  const positions = [...triangle, ...triangle.map(p => [p[0] + 30, p[1], p[2]])];
  const bin = Buffer.alloc(positions.length * 12 + 12);
  positions.flat().forEach((x, i) => bin.writeFloatLE(x, i * 4));
  for (let i = 0; i < 6; i++) bin.writeUInt16LE(badIndex && i === 5 ? 99 : i, 72 + i * 2);
  const json = { buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 72 }, { buffer: 0, byteOffset: 72, byteLength: 12 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 6, type: 'VEC3' }, { bufferView: 1, componentType: 5123, count: 6, type: 'SCALAR' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, mode: 4,
      extras: { bimSourceMap: { schemaVersion: 1, format: 'X_T', scope: 'source-file-local', body: '1',
        faceRanges: [[0, 1, swapped ? '2' : '1'], [1, 1, swapped ? '1' : '2']] } } }] }] };
  const text = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(text.length / 4) * 4, 0x20);
  text.copy(padded);
  const bytes = Buffer.alloc(28 + padded.length + bin.length);
  [0x46546c67, 2, bytes.length, padded.length, 0x4e4f534a].forEach((x, i) => bytes.writeUInt32LE(x, i * 4));
  padded.copy(bytes, 20); bytes.writeUInt32LE(bin.length, 20 + padded.length);
  bytes.writeUInt32LE(0x004e4942, 24 + padded.length); bin.copy(bytes, 28 + padded.length);
  return bytes;
}
test('actual GLB labels swapped within one body pass membership but fail geometric evidence', () => {
  for (const swapped of [false, true]) {
    const mapped = mappedFaceGeometry(fixture(swapped)), geometry = mapped.get('1/1');
    assert.deepEqual([...mapped.keys()].sort(), ['1/1', '1/2']);
    assert.equal(compareFaceWitness(face, geometry.points, geometry.triangles).status, swapped ? 'mismatch' : 'witness-match');
  }
  assert.throws(() => mappedFaceGeometry(fixture(false, true)), /Index outside POSITION/);
  assert.throws(() => mappedFaceGeometry(fixture().subarray(0, 30)), /framing/);
});
test('source point on a triangle interior need not survive as an explicit mesh vertex', () => {
  const source = { points: [[1, 1, 0]], surface: null };
  assert.equal(compareFaceWitness(source, triangle, [triangle]).status, 'witness-match');
  assert.equal(compareFaceWitness({ ...source, points: [[1, 1, 1]] }, triangle, [triangle]).status, 'mismatch');
});
