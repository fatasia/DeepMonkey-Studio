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
  for (const o of objects.values()) {
    const meshes = o.kind === 'mesh' ? [o.mesh] : (o.storedRenderMeshes ?? []).map(m => m.mesh);
    if (o.kind === 'brep') missingBrepFaces += o.faceCount - o.storedRenderMeshes.length;
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
  if (name === 'blocks.3dm') { assert.equal(defs.size, 1); assert.equal(instances, 2); assert.equal(missingBrepFaces, 1); }
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
  }
  writeFileSync(resolve(out, `${name}.json`), run.stdout);
  const truncated = resolve(out, `${name}.truncated`);
  writeFileSync(truncated, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const bad = spawnSync(exe, [truncated], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0, 'truncated file accepted');
  assert.equal(bad.stdout, '');
  results.push({ name, source: path, sourceUrl: `https://github.com/mcneel/rhino3dm/blob/v8.32.0/tests/models/${name}`, sourceSha256: expectedSha,
    outputSha256: sha(run.stdout), archiveVersion: data.archiveVersion, objects: objects.size,
    definitions: defs.size, instances, vertices, triangles, quads, missingBrepFaces, normals, uv, stderr: run.stderr });
}
const absent = spawnSync(exe, [resolve(out, 'does-not-exist.3dm')], { encoding: 'utf8' });
assert.notEqual(absent.status, 0);
assert.equal(absent.stdout, '');
const evidence = { schemaVersion: 1, exeSha256: sha(readFileSync(exe)), upstreamReaderSha256: sha(readFileSync(reader)), results };
writeFileSync(resolve(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify(evidence, null, 2));
