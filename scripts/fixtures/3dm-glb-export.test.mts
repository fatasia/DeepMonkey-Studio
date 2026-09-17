import test from 'node:test';
import assert from 'node:assert/strict';
import { export3dmGlb } from './3dm-glb-export.mts';

const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const identity = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
const source = () => ({ schemaVersion: 1, unitSystem: 2, metersPerUnit: 0.001, layers: [{ index: 0 }], materials: [], definitions: [], objects: [
  { id: id(1), layerIndex: 0, materialIndex: -1, materialSource: 0, definitionMember: false, kind: 'mesh', mesh: { positions: [[0,0,0],[1,0,0],[0,1,0]], triangles: [[0,1,2]], sourceFaceCount: 1, quadCount: 0 } },
] } as any);
const hash = 'a'.repeat(64);
const json = (bytes: Uint8Array) => { const b = Buffer.from(bytes); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()); };
function instances() {
  const s = source(); s.objects[0].definitionMember = true;
  s.definitions.push({ id: id(2), members: [id(1)] });
  for (let i = 3; i <= 4; i++) { const m = [...identity]; m[3] = i * 10;
    s.objects.push({ id: id(i), kind: 'instance', layerIndex: 0, definitionMember: false, definitionId: id(2), matrixRowMajor: m }); }
  return s;
}
test('two references reuse one mesh and preserve translation without baking', async () => {
  const result = await export3dmGlb(instances(), hash); const j = json(result.bytes!);
  assert.equal(j.meshes.length, 1);
  const meshNodes = j.nodes.filter((n: any) => n.mesh !== undefined);
  assert.equal(meshNodes.length, 2); assert.equal(meshNodes[0].mesh, meshNodes[1].mesh);
  assert.deepEqual(j.nodes.filter((n: any) => n.extras?.definitionId).map((n: any) => n.translation), [[30,0,0],[40,0,0]]);
  assert.equal(j.meshes[0].extras.objectId, id(1));
  const root = j.nodes[j.scenes[0].nodes[0]];
  assert.deepEqual(root.scale, [0.001,0.001,0.001]);
  assert.deepEqual(root.rotation, [-Math.SQRT1_2,0,0,Math.SQRT1_2]);
});
test('unreferenced definition mesh does not create a fake visible GLB', async () => {
  const s = source(); s.objects[0].definitionMember = true;
  s.definitions.push({ id: id(2), members: [id(1)] });
  assert.equal((await export3dmGlb(s, hash)).bytes, null);
});
test('source-only missing Brep returns diagnostic and no GLB', async () => {
  const s = source(); s.objects[0] = { ...s.objects[0], kind: 'brep', faceCount: 2, storedRenderMeshes: [] };
  const result = await export3dmGlb(s, hash);
  assert.equal(result.bytes, null); assert.equal(result.sidecar.diagnostics[0].count, 2);
});
test('partially cached Brep stays visibly partial instead of claiming a complete preview', async () => {
  const s = source(), mesh = s.objects[0].mesh;
  s.objects[0] = { ...s.objects[0], kind: 'brep', faceCount: 2, storedRenderMeshes: [{ face: 0, mesh }] };
  const partial = await export3dmGlb(s, hash);
  assert(partial.bytes); assert.equal(partial.sidecar.status, 'partial-geometry-preview');
  assert.deepEqual(partial.sidecar.diagnostics, [{ objectId: id(1), code: 'missing-brep-render-mesh', count: 1 }]);
  s.objects[0].faceCount = 1;
  const complete = await export3dmGlb(s, hash);
  assert(complete.bytes); assert.equal(complete.sidecar.status, 'geometry-preview');
  assert.deepEqual(complete.sidecar.diagnostics, []);
});
test('invalid coordinates and indices fail before serialization', async () => {
  const s = source(); s.objects[0].mesh.positions[0][0] = Infinity;
  await assert.rejects(export3dmGlb(s, hash), /positions/);
  const t = source(); t.objects[0].mesh.triangles[0][2] = 99;
  await assert.rejects(export3dmGlb(t, hash), /indices/);
});
test('missing definitions, member identity, cycles and shear fail', async () => {
  const a = instances(); a.definitions = []; await assert.rejects(export3dmGlb(a, hash), /definition/);
  const b = instances(); b.definitions[0].members = [id(99)]; await assert.rejects(export3dmGlb(b, hash), /member/);
  const c = instances(); c.objects[1].definitionMember = true; c.definitions[0].members = [id(3)];
  await assert.rejects(export3dmGlb(c, hash), /cycle/);
  const d = instances(); d.objects[1].matrixRowMajor[1] = 0.5;
  await assert.rejects(export3dmGlb(d, hash), /sheared/);
});
test('source normals and UV become attributes; textures stay identity-only extras', async () => {
  const s = source(), mesh = s.objects[0].mesh;
  mesh.normals = [[0,0,1],[0,0,1],[0,0,1]];
  mesh.textureCoordinates = [[0,0],[1,0],[0,1]]; mesh.textureCoordinateSource = 'ON_Mesh.m_T';
  s.materials = [{ id: id(9), textures: [{ id: id(10), fullPath: '/not-a-runtime-dependency.png', mappingChannelId: 0xfffffff3 }] }];
  const result = await export3dmGlb(s, hash); const j = json(result.bytes!);
  const attributes = j.meshes[0].primitives[0].attributes;
  assert.equal(j.accessors[attributes.NORMAL].count, 3);
  assert.equal(j.accessors[attributes.TEXCOORD_0].type, 'VEC2');
  assert.deepEqual(j.nodes[j.scenes[0].nodes[0]].extras.sourceMaterials, s.materials);
  assert.equal(j.images, undefined); assert.equal(j.textures, undefined); assert.equal(j.materials, undefined);
});
test('malformed or unproven normals/UV fail instead of being fabricated or dropped', async () => {
  for (const normals of [[[0,0,1]], [[0,0,0],[0,0,1],[0,0,1]], [[NaN,0,1],[0,0,1],[0,0,1]]]) {
    const s = source(); s.objects[0].mesh.normals = normals;
    await assert.rejects(export3dmGlb(s, hash), /normals/);
  }
  for (const uv of [[[0,0]], [[0,0],[Infinity,0],[0,1]]]) {
    const s = source(); s.objects[0].mesh.textureCoordinates = uv; s.objects[0].mesh.textureCoordinateSource = 'ON_Mesh.m_T';
    await assert.rejects(export3dmGlb(s, hash), /UV/);
  }
  const s = source(); s.objects[0].mesh.textureCoordinates = [[0,0],[1,0],[0,1]];
  s.objects[0].mesh.textureCoordinateSource = 'surface-parameters';
  await assert.rejects(export3dmGlb(s, hash), /UV/);
  const absent = json((await export3dmGlb(source(), hash)).bytes!);
  assert.equal(absent.meshes[0].primitives[0].attributes.NORMAL, undefined);
  assert.equal(absent.meshes[0].primitives[0].attributes.TEXCOORD_0, undefined);
});
