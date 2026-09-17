import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '../..');
const out = resolve(root, 'test-output/3dm-source-audit');
const source = resolve(root, 'data/external-assets/industrial-format-plan/dependencies/extracted/rhino3dm-v8.32.0/tests/models');
const exe = resolve(out, '3dm-source-audit.exe');
const reader = resolve(root, 'data/external-assets/industrial-format-plan/dependencies/extracted/opennurbs-v8.35.26251.13001/bin/x64/Release/example_read.exe');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const finiteArray = (value, width) => Array.isArray(value) && value.length === width && value.every(Number.isFinite);
function auditNurbs(nurbs, dimensions) {
  const degree = dimensions === 1 ? [nurbs.degree] : nurbs.degree;
  const counts = dimensions === 1 ? [nurbs.controlPoints.length] : nurbs.controlPointCount;
  assert.equal(nurbs.knotConvention, 'full-openNURBS-end-duplicated');
  assert.equal(nurbs.controlPointEncoding, nurbs.rational ? 'homogeneous' : 'euclidean');
  assert([1, 2].includes(nurbs.parameterization), 'unclassified NURBS parameterization');
  assert.equal(degree.length, dimensions); assert.equal(counts.length, dimensions);
  const knots = dimensions === 1 ? [nurbs.knots] : nurbs.knots;
  const domains = dimensions === 1 ? [nurbs.domain] : nurbs.domain;
  const closed = dimensions === 1 ? [nurbs.closed] : nurbs.closed;
  const periodic = dimensions === 1 ? [nurbs.periodic] : nurbs.periodic;
  assert.equal(closed.length, dimensions); assert.equal(periodic.length, dimensions);
  assert(closed.every(value => typeof value === 'boolean')); assert(periodic.every(value => typeof value === 'boolean'));
  for (let axis = 0; axis < dimensions; axis++) {
    assert(Number.isInteger(degree[axis]) && degree[axis] >= 1);
    assert(Number.isInteger(counts[axis]) && counts[axis] > degree[axis]);
    assert.equal(knots[axis].length, counts[axis] + degree[axis] + 1);
    assert(knots[axis].every(Number.isFinite));
    assert(knots[axis].every((k, i) => i === 0 || k >= knots[axis][i - 1]), 'decreasing knot vector');
    assert(finiteArray(domains[axis], 2) && domains[axis][0] < domains[axis][1]);
    assert.equal(knots[axis][degree[axis]], domains[axis][0]);
    assert.equal(knots[axis][counts[axis]], domains[axis][1]);
  }
  const expected = dimensions === 1 ? counts[0] : counts[0] * counts[1];
  assert.equal(nurbs.controlPoints.length, expected);
  const width = nurbs.dimension + (nurbs.rational ? 1 : 0);
  assert(nurbs.controlPoints.every(cv => finiteArray(cv, width)));
  if (nurbs.rational) assert(nurbs.controlPoints.every(cv => cv.at(-1) !== 0), 'zero NURBS weight');
}
function auditCadIr(ir, faceCount) {
  assert.equal(ir.schemaVersion, 1); assert.equal(ir.representation, 'trimmed-nurbs-brep');
  assert.equal(ir.faces.length, faceCount);
  const tolerance = value => value === null || (Number.isFinite(value) && value >= 0);
  assert(ir.vertices.every(vertex => finiteArray(vertex.point, 3) && tolerance(vertex.tolerance)));
  ir.curves3d.forEach(curve => auditNurbs(curve, 1));
  ir.curves2d.forEach(curve => { auditNurbs(curve, 1); assert.equal(curve.dimension, 2); });
  ir.surfaces.forEach(surface => { auditNurbs(surface, 2); assert.equal(surface.dimension, 3); });
  ir.edges.forEach(edge => {
    assert(Number.isInteger(edge.curve3d) && ir.curves3d[edge.curve3d]);
    assert.equal(edge.vertices.length, 2); edge.vertices.forEach(index => assert(ir.vertices[index]));
    assert(finiteArray(edge.domain, 2) && edge.domain[0] < edge.domain[1]);
    assert(finiteArray(edge.sourceSubdomain, 2) && edge.sourceSubdomain[0] < edge.sourceSubdomain[1]);
    assert.equal(typeof edge.curveReversed, 'boolean'); assert(tolerance(edge.tolerance));
  });
  ir.trims.forEach((trim, index) => {
    assert(ir.curves2d[trim.curve2d]); assert(ir.loops[trim.loop]);
    assert(trim.edge === -1 || ir.edges[trim.edge]);
    assert.equal(ir.loops[trim.loop].trims.includes(index), true);
    assert(finiteArray(trim.domain, 2) && trim.domain[0] < trim.domain[1]);
    assert(finiteArray(trim.sourceSubdomain, 2) && trim.sourceSubdomain[0] < trim.sourceSubdomain[1]);
    assert.equal(typeof trim.curveReversed, 'boolean'); assert.equal(typeof trim.reverse3d, 'boolean');
    assert.equal(trim.tolerance.length, 2); assert(trim.tolerance.every(tolerance));
  });
  ir.loops.forEach((loop, index) => {
    assert(ir.faces[loop.face]); assert(loop.trims.length > 0);
    loop.trims.forEach(trim => assert.equal(ir.trims[trim].loop, index));
  });
  ir.faces.forEach((face, index) => {
    assert(ir.surfaces[face.surface]); assert(face.loops.length > 0);
    face.loops.forEach(loop => assert.equal(ir.loops[loop].face, index));
  });
  return { vertices: ir.vertices.length, curves3d: ir.curves3d.length, curves2d: ir.curves2d.length,
    surfaces: ir.surfaces.length, edges: ir.edges.length, trims: ir.trims.length, loops: ir.loops.length,
    faces: ir.faces.length, parameterizationExact: [...ir.curves3d, ...ir.curves2d, ...ir.surfaces].filter(x => x.parameterization === 1).length,
    parameterizationMapped: [...ir.curves3d, ...ir.curves2d, ...ir.surfaces].filter(x => x.parameterization === 2).length };
}
const samples = {
  'mesh.3dm': '59e78629c5c19a5e04a195d746cd6b3981c504fcdcd76423ba507ec9e58e69b7',
  'blocks.3dm': '1e428317489c7c22ee68fb93e119079c718a0ba44efa7c89efb10cf0d8491cb8',
  'meshWithTexture.3dm': '6d0f789c626990784171758d29e6e616ba7a7e36e0018f9f45bc22bd011a9cb1',
  'sphereDecals.3dm': '2f4f218e2b5952da1ba280ae4db4ec5a08947c9f5b012d4194be9171eebccc93',
  'file3dm_stuff.3dm': 'e78ca005c86130953a5b4c0c44d068ae1d00665f4c0f6028edd3911a01d4ff88',
};
mkdirSync(out, { recursive: true });
const results = [];
for (const [name, expectedSha] of Object.entries(samples)) {
  const path = resolve(source, name);
  const bytes = readFileSync(path);
  assert.equal(sha(bytes), expectedSha);
  const run = spawnSync(exe, [path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assert.equal(sha(readFileSync(path)), expectedSha);
  const data = JSON.parse(run.stdout);
  assert.equal(data.schemaVersion, 1);
  assert(Number.isInteger(data.archiveVersion) && data.archiveVersion > 0);
  assert(Number.isInteger(data.unitSystem));
  assert(Number.isFinite(data.metersPerUnit) && data.metersPerUnit > 0);
  const repeat = spawnSync(exe, [path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(repeat.status, 0);
  assert.equal(repeat.stdout, run.stdout, 'non-deterministic extraction');
  const original = spawnSync(reader, [path], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  assert.equal(original.status, 0, original.stderr);
  assert.match(original.stdout, /Successfully read\./);
  writeFileSync(resolve(out, `${name}.upstream.txt`), original.stdout);
  const objects = new Map(data.objects.map(o => [o.id, o]));
  const defs = new Map(data.definitions.map(d => [d.id, d]));
  const layers = new Map(data.layers.map(layer => [layer.index, layer]));
  assert.equal(objects.size, data.objects.length);
  assert.equal(defs.size, data.definitions.length);
  assert.equal(layers.size, data.layers.length);
  let vertices = 0, triangles = 0, quads = 0, instances = 0, missingBrepFaces = 0, normals = 0, uv = 0;
  const cadIr = [];
  for (const o of objects.values()) {
    const meshes = o.kind === 'mesh' ? [o.mesh] : (o.storedRenderMeshes ?? []).map(m => m.mesh);
    if (o.kind === 'brep') {
      missingBrepFaces += o.faceCount - o.storedRenderMeshes.length;
      cadIr.push({ objectId: o.id, ...auditCadIr(o.cadIr, o.faceCount) });
    }
    for (const m of meshes) {
      assert.equal(m.triangles.length, m.sourceFaceCount + m.quadCount);
      assert(m.positions.every(p => p.length === 3 && p.every(Number.isFinite)));
      assert(m.triangles.every(t => t.length === 3 && t.every(i => Number.isInteger(i) && i >= 0 && i < m.positions.length)));
      assert(m.triangles.every(t => new Set(t).size === 3), 'repeated triangle corner');
      for (const [values, width] of [[m.normals, 3], [m.textureCoordinates, 2]]) {
        assert.equal(values.length === 0 || values.length === m.positions.length, true);
        assert(values.every(v => v.length === width && v.every(Number.isFinite)));
      }
      normals += m.normals.length; uv += m.textureCoordinates.length;
      vertices += m.positions.length; triangles += m.triangles.length; quads += m.quadCount;
    }
    assert(layers.has(o.layerIndex));
    if (o.kind === 'instance') {
      instances++;
      assert(defs.has(o.definitionId));
      assert.equal(o.matrixRowMajor.length, 16);
      assert(o.matrixRowMajor.every(Number.isFinite));
    }
  }
  const visit = (defId, ancestors = new Set()) => {
    assert(!ancestors.has(defId), 'instance-cycle');
    const next = new Set([...ancestors, defId]);
    for (const id of defs.get(defId).members) {
      const o = objects.get(id); assert(o, 'missing-member');
      assert(o.definitionMember);
      if (o.kind === 'instance') visit(o.definitionId, next);
    }
  };
  for (const id of defs.keys()) visit(id);
  if (name === 'mesh.3dm') { assert.equal(vertices, 420); assert.equal(triangles, 276); }
  if (name === 'blocks.3dm') {
    assert.equal(defs.size, 1); assert.equal(instances, 2); assert.equal(missingBrepFaces, 1);
    assert.deepEqual(cadIr.map(({ objectId, ...counts }) => counts), [{ vertices: 2, curves3d: 1, curves2d: 4,
      surfaces: 1, edges: 1, trims: 4, loops: 1, faces: 1, parameterizationExact: 4, parameterizationMapped: 2 }]);
  }
  if (name === 'meshWithTexture.3dm') {
    assert.equal(quads, 80); assert.equal(triangles, 180); assert.equal(normals, 92); assert.equal(uv, 92);
    assert.equal(data.materials[0].textures[0].id, '0af451f3-18cf-4b6b-a7a8-27368ad7ba45');
    assert.equal(data.materials[0].textures[0].relativePath, '');
    assert.equal(data.materials[0].textures[0].mappingChannelId, 0xfffffff3);
  }
  if (name === 'sphereDecals.3dm') {
    assert.equal(objects.size, 1); assert.equal(vertices, 9895); assert.equal(triangles, 18752);
    assert.equal(missingBrepFaces, 0); assert.equal(normals, 9895); assert.equal(uv, 9895);
  }
  if (name === 'file3dm_stuff.3dm') {
    assert.equal(defs.size, 1); assert.equal(instances, 2); assert.equal(vertices, 4); assert.equal(triangles, 2);
    assert.equal(missingBrepFaces, 12); assert.equal(normals, 4); assert.equal(uv, 4);
    assert.equal(data.materials[1].textures[0].relativePath, '');
    assert.equal(cadIr.length, 5);
    assert.deepEqual(cadIr.reduce((sum, item) => {
      for (const key of ['vertices','curves3d','curves2d','surfaces','edges','trims','loops','faces','parameterizationExact','parameterizationMapped']) sum[key] += item[key];
      return sum;
    }, { vertices: 0, curves3d: 0, curves2d: 0, surfaces: 0, edges: 0, trims: 0, loops: 0, faces: 0, parameterizationExact: 0, parameterizationMapped: 0 }),
    { vertices: 32, curves3d: 42, curves2d: 52, surfaces: 13, edges: 42, trims: 52, loops: 13, faces: 13, parameterizationExact: 107, parameterizationMapped: 0 });
  }
  writeFileSync(resolve(out, `${name}.json`), run.stdout);
  const truncated = resolve(out, `${name}.truncated`);
  writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const bad = spawnSync(exe, [truncated], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'truncated file accepted');
  assert.equal(bad.stdout, '');
  results.push({ name, source: path, sourceUrl: `https://github.com/mcneel/rhino3dm/blob/v8.32.0/tests/models/${name}`, sourceSha256: expectedSha,
    outputSha256: sha(run.stdout), archiveVersion: data.archiveVersion, objects: objects.size,
    definitions: defs.size, instances, vertices, triangles, quads, missingBrepFaces, normals, uv, cadIr, stderr: run.stderr });
}
const absent = spawnSync(exe, [resolve(out, 'does-not-exist.3dm')], { encoding: 'utf8' });
assert.notEqual(absent.status, 0);
assert.equal(absent.stdout, '');
const evidence = { schemaVersion: 1, exeSha256: sha(readFileSync(exe)), upstreamReaderSha256: sha(readFileSync(reader)), results };
writeFileSync(resolve(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
