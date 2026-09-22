import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectB3dmContainer } from './industrialB3dmPreflight.mjs';

function fixture({ version = 2, padding = 0 } = {}) {
  const table = Buffer.from('{"BATCH_LENGTH":0}  ');
  const glb = Buffer.alloc(24);
  glb.write('glTF'); glb.writeUInt32LE(version, 4); glb.writeUInt32LE(24, 8);
  glb.writeUInt32LE(4, 12); glb.writeUInt32LE(version === 1 ? 0 : 0x4e4f534a, 16);
  glb.write('{}  ', 20);
  const bytes = Buffer.alloc(28 + table.length + glb.length + padding);
  bytes.write('b3dm'); bytes.writeUInt32LE(1, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(table.length, 12); table.copy(bytes, 28); glb.copy(bytes, 28 + table.length);
  return bytes;
}

test('modern container, zero padding and typed-array offset', () => {
  const bytes = fixture({ padding: 3 });
  const surrounded = Buffer.concat([Buffer.from([123]), bytes, Buffer.from([99])]);
  const result = inspectB3dmContainer(surrounded.subarray(1, -1));
  assert.equal(result.batchLength, 0); assert.equal(result.glbBytes, 24);
  assert.equal(result.glbVersion, 2);
});
test('legacy GLB is explicitly diagnosed, not promoted to current profile', () => {
  assert.ok(inspectB3dmContainer(fixture({ version: 1 })).diagnostics.includes('legacy-glb-1-needs-conversion'));
});
for (const [name, mutate, expected] of [
  ['magic', (b) => b.write('xxxx'), /magic/],
  ['high-bit magic', (b) => { b[0] |= 0x80; }, /magic/],
  ['version', (b) => b.writeUInt32LE(99, 4), /version/],
  ['declared length', (b) => b.writeUInt32LE(b.length - 1, 8), /length/],
  ['table overflow', (b) => b.writeUInt32LE(0xffffffff, 12), /table lengths/],
  ['feature JSON', (b) => { b[28] = 0xff; }, /JSON/],
  ['batch count', (b) => b.write('{"BATCH_LENGTH":-1} ', 28), /BATCH_LENGTH/],
  ['GLB magic', (b) => b.write('xxxx', 48), /GLB magic/],
  ['GLB version', (b) => b.writeUInt32LE(3, 52), /GLB version/],
  ['GLB length', (b) => b.writeUInt32LE(0xffffffff, 56), /GLB length/],
  ['GLB JSON length', (b) => b.writeUInt32LE(0xffffffff, 60), /JSON length/],
  ['GLB JSON type', (b) => b.writeUInt32LE(0, 64), /JSON type/],
]) test(`rejects ${name}`, () => {
  const bytes = fixture(); mutate(bytes);
  assert.throws(() => inspectB3dmContainer(bytes), expected);
});
test('rejects truncation, budgets and nonzero/excess padding', () => {
  assert.throws(() => inspectB3dmContainer(fixture().subarray(0, 12)), /truncated/);
  assert.throws(() => inspectB3dmContainer(fixture(), { maxBytes: 32 }), /budget/);
  assert.throws(() => inspectB3dmContainer(fixture(), { maxBytes: NaN }), /budget/);
  assert.throws(() => inspectB3dmContainer(fixture({ padding: 8 })), /padding/);
  const bytes = fixture({ padding: 1 }); bytes[bytes.length - 1] = 1;
  assert.throws(() => inspectB3dmContainer(bytes), /padding/);
});
