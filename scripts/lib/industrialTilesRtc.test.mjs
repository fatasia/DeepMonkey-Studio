import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTilesRtc } from './industrialTilesRtc.mjs';
const source = () => ({ asset: { version: '2.0' }, nodes: [{ mesh: 0, translation: [1, 2, 3] }],
  scenes: [{ nodes: [0] }, { nodes: [0] }], scene: 0,
  extensions: { CESIUM_RTC: { center: [6378137.25, 21, -32] }, custom: { retained: true } },
  extensionsUsed: ['CESIUM_RTC', 'custom'], extensionsRequired: ['CESIUM_RTC'] });
for (const [axis, expected] of [['Y', [6378137.25, -32, -21]], ['X', [21, 32, -6378137.25]], ['Z', [6378137.25, 21, -32]]]) {
  test(`preserves child transforms and shared scene roots (${axis})`, () => {
    const original = source(); const snapshot = structuredClone(original);
    const result = normalizeTilesRtc(original, axis);
    assert.deepEqual(original, snapshot);
    assert.deepEqual(result.nodes[0], original.nodes[0]);
    assert.deepEqual(result.nodes[1].translation, expected);
    assert.deepEqual(result.nodes[2].translation, expected);
    assert.deepEqual(result.scenes.map(scene => scene.nodes), [[1], [2]]);
    assert.deepEqual(result.extensions, { custom: { retained: true } });
    assert.equal(result.extensionsRequired, undefined);
    assert.deepEqual(normalizeTilesRtc(result), result);
  });
}
test('missing/nonfinite/malformed center and roots reject before mutation', () => {
  for (const mutate of [d => { d.extensions.CESIUM_RTC.center = [0, NaN, 0]; },
    d => { d.extensions.CESIUM_RTC.center = [0, 1]; },
    d => { d.scenes[1].nodes = [99]; }, d => { d.scenes = []; },
    d => { delete d.extensions.CESIUM_RTC; }]) {
    const value = source(); mutate(value); const before = structuredClone(value);
    assert.throws(() => normalizeTilesRtc(value)); assert.deepEqual(value, before);
  }
  assert.throws(() => normalizeTilesRtc(source(), 'bad'), /axis/);
});
