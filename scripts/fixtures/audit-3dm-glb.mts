import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { export3dmGlb } from './3dm-glb-export.mts';
import { completeBrepParts } from './3dm-brep-tessellation.mts';
import { auditGlbGeometry } from '../../apps/api/src/converterOutputAudit.ts';
const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'test-output/3dm-source-audit');
const hash = (b: any) => createHash('sha256').update(b).digest('hex');
const evidence = JSON.parse(readFileSync(resolve(out, 'evidence.json'), 'utf8'));
const results = [];
for (const row of evidence.results) {
  const input = readFileSync(resolve(out, `${row.name}.json`));
  assert.equal(hash(input), row.outputSha256);
  assert.equal(hash(readFileSync(row.source)), row.sourceSha256);
  const source = JSON.parse(input.toString());
  const partsById = new Map<string, any[]>(source.objects.map((object: any) => [object.id, completeBrepParts(object).parts]));
  const generated = [...partsById.values()].flat().filter((part: any) => part.geometrySource);
  const generatedTriangles = generated.reduce((sum: number, part: any) => sum + part.mesh.triangles.length, 0);
  const generatedVertices = generated.reduce((sum: number, part: any) => sum + part.mesh.positions.length, 0);
  const result = await export3dmGlb(source, row.sourceSha256);
  const sidecar = JSON.stringify(result.sidecar, null, 2), sidecarSha256 = hash(sidecar);
  writeFileSync(resolve(out, `${row.name}.sidecar.json`), sidecar);
  if (!result.bytes) { assert.equal(row.triangles, 0); assert(!existsSync(resolve(out, `${row.name}.glb`)), 'stale GLB exists'); results.push({ name: row.name, status: result.sidecar.status, sidecarSha256, diagnostics: result.sidecar.diagnostics }); continue; }
  const path = resolve(out, `${row.name}.glb`); writeFileSync(path, result.bytes);
  const audit = await auditGlbGeometry(path);
  assert.equal(audit.triangleCount, row.triangles + generatedTriangles); assert.equal(audit.vertexCount, row.vertices + generatedVertices);
  // Independently compare serialized binary arrays, not just counts/extras.
  const b = Buffer.from(result.bytes), length = b.readUInt32LE(12);
  const j = JSON.parse(b.subarray(20, 20 + length).toString());
  const bin = b.subarray(28 + length);
  assert.deepEqual(j.nodes[j.scenes[0].nodes[0]].extras.sourceMaterials, source.materials);
  assert(!j.images && !j.textures && !j.materials, 'source identity must not invent texture or PBR appearance');
  let normalCount = 0, uvCount = 0;
  for (const mesh of j.meshes) {
    const object = source.objects.find((o: any) => o.id === mesh.extras.objectId); assert(object);
    for (const primitive of mesh.primitives) {
      const original = object.kind === 'mesh' ? object.mesh : partsById.get(object.id).find((m: any) => m.face === primitive.extras.brepFaceIndex).mesh;
      const streams = [[primitive.attributes.POSITION, original.positions.flat(), true], [primitive.indices, original.triangles.flat(), false]];
      if (original.normals?.length) { streams.push([primitive.attributes.NORMAL, original.normals.flat(), true]); normalCount += original.normals.length; }
      else assert.equal(primitive.attributes.NORMAL, undefined);
      if (original.textureCoordinates?.length) { streams.push([primitive.attributes.TEXCOORD_0, original.textureCoordinates.flat(), true]); uvCount += original.textureCoordinates.length; }
      else assert.equal(primitive.attributes.TEXCOORD_0, undefined);
      for (const [accessorIndex, expected, position] of streams) {
        const accessor = j.accessors[accessorIndex], view = j.bufferViews[accessor.bufferView];
        const offset = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
        assert.equal(accessor.componentType, position ? 5126 : 5125);
        const width = { SCALAR: 1, VEC2: 2, VEC3: 3 }[accessor.type]; assert(width);
        assert.equal(accessor.count * width, expected.length);
        const stride = view.byteStride ?? width * 4;
        expected.forEach((v: number, i: number) => {
          const at = offset + Math.floor(i / width) * stride + (i % width) * 4;
          assert.equal(position ? bin.readFloatLE(at) : bin.readUInt32LE(at), position ? Math.fround(v) : v);
        });
      }
    }
  }
  assert.equal(hash(readFileSync(row.source)), row.sourceSha256);
  results.push({ name: row.name, status: result.sidecar.status, sidecarSha256, glbSha256: hash(result.bytes), bytes: result.bytes.length, generatedFaces: generated.length, generatedTriangles, normalCount, uvCount, audit });
}
writeFileSync(resolve(out, 'glb-evidence.json'), JSON.stringify({ schemaVersion: 1, sourceEvidenceSha256: hash(readFileSync(resolve(out, 'evidence.json'))), results }, null, 2));
console.log(JSON.stringify(results, null, 2));
