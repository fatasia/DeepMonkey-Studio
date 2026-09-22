import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTilesProperties } from './industrialTilesProperties.mjs';
const hash = 'ab'.repeat(32);
test('stable source identity, unreferenced features and exact properties', () => {
  const table = { id: ['external', 'external'], Height: [1.25, 9], data: [{ a: 1 }, null] };
  const result = buildTilesProperties(hash, 2, table, [1, 1]);
  assert.equal(Object.keys(result.elements).length, 2);
  assert.equal(result.model.referencedFeatureCount, 1);
  assert.equal(result.elements[`b3dm:${hash}:0`].geometryReferenced, false);
  assert.deepEqual(result.elements[`b3dm:${hash}:1`].properties, { id: 'external', Height: 9, data: null });
  assert.deepEqual(result, buildTilesProperties(hash, 2, table, [1]));
});
test('mismatched/binary metadata and bad feature references cannot disappear silently', () => {
  for (const table of [{ id: [0] }, { id: { byteOffset: 0 } }, { extensions: {} }]) {
    assert.throws(() => buildTilesProperties(hash, 2, table, [0]));
  }
  for (const id of [-1, 2, 0.5, NaN]) assert.throws(() => buildTilesProperties(hash, 2, {}, [id]));
  assert.throws(() => buildTilesProperties(hash, 100_001, {}, []));
  assert.throws(() => buildTilesProperties('bad', 0, {}, []));
});
test('rejects JSON numeric overflow instead of serializing Infinity as null', () => {
  assert.throws(() => buildTilesProperties(hash, 1, JSON.parse('{"Height":[1e400]}'), [0]), /finite JSON/);
  for (const value of [undefined, NaN, new Date(), 1n]) {
    assert.throws(() => buildTilesProperties(hash, 1, { value: [value] }, [0]));
  }
  const circular = {}; circular.self = circular;
  assert.throws(() => buildTilesProperties(hash, 1, { value: [circular] }, [0]));
});
test('nested properties are frozen snapshots and depth is bounded', () => {
  const table = { data: [{ values: [1, 2] }] };
  const result = buildTilesProperties(hash, 1, table, [0]);
  table.data[0].values[0] = 999;
  assert.deepEqual(result.elements[`b3dm:${hash}:0`].properties.data.values, [1, 2]);
  let nested = 1;
  for (let i = 0; i < 65; i++) nested = { nested };
  assert.throws(() => buildTilesProperties(hash, 1, { data: [nested] }, [0]), /budget/);
});
