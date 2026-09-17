import test from 'node:test';
import assert from 'node:assert/strict';
import { auditXtSourceIdentity } from './xtSourceIdentityAudit.mjs';
const raw = () => ({ schemaVersion: 1, bodies: [{ body: '7', faces: ['42', '99'] }, { body: '8', faces: ['100'] }] });
const primitive = (body, faces) => ({ extras: { bimSourceMap: { schemaVersion: 1,
  scope: 'source-file-local', format: 'X_T', body, faceRanges: faces.map((f, i) => [i, 1, f]) } } });
const glb = () => ({ meshes: [{ primitives: [primitive('7', ['42', '99']), primitive('8', ['100'])] }] });
test('allows one face across primitive/material splits', () => {
  const json = glb(); json.meshes[0].primitives.push(primitive('7', ['42']));
  assert.deepEqual(auditXtSourceIdentity(json, raw()), { bodies: 2, uniqueFaces: 3 });
});
test('rejects same counts with invented identities or swapped ownership', () => {
  for (const mutate of [
    (m) => { m.body = '999'; }, (m) => { m.faceRanges[0][2] = '888'; },
    (m) => { m.body = '8'; }, (m) => { m.faceRanges[0][2] = '100'; },
  ]) { const json = glb(); mutate(json.meshes[0].primitives[0].extras.bimSourceMap); assert.throws(() => auditXtSourceIdentity(json, raw())); }
});
test('rejects omitted faces/bodies, malformed and duplicated raw evidence', () => {
  const json = glb(); json.meshes[0].primitives.pop(); assert.throws(() => auditXtSourceIdentity(json, raw()));
  const json2 = glb(); json2.meshes[0].primitives[0].extras.bimSourceMap.faceRanges.pop(); assert.throws(() => auditXtSourceIdentity(json2, raw()));
  for (const r of [{}, { schemaVersion: 1, bodies: [] }, { schemaVersion: 1, bodies: [...raw().bodies, raw().bodies[0]] },
    { schemaVersion: 1, bodies: [{ body: '7', faces: ['42', '42'] }] }]) assert.throws(() => auditXtSourceIdentity(glb(), r));
});
test('states limitation: swapping two labels inside the same body preserves the set', () => {
  const json = glb(); const ranges = json.meshes[0].primitives[0].extras.bimSourceMap.faceRanges;
  [ranges[0][2], ranges[1][2]] = [ranges[1][2], ranges[0][2]];
  assert.deepEqual(auditXtSourceIdentity(json, raw()), { bodies: 2, uniqueFaces: 3 });
});
