import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { exportSldprtPreview } from './sldprt-glb-preview.mts';
const { NodeIO } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('@gltf-transform/core');
const cli = path.resolve(process.argv[2] ?? 'C:/Users/rain/AppData/Local/Temp/bim-cadmpeg-20260918-target/archive-isolated/release/cadmpeg.exe');
const sourceRoot = path.resolve('data/external-assets/industrial-format-plan/samples/solidworks-sheetmetal-20260918');
const output = path.resolve(process.argv[3] ?? 'test-output/industrial-solidworks/geometry-20260918/full');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
assert.equal(sha(await readFile(cli)), '14de5287e42a27569e0fab333a99522a455c92502fbfd62cde26d1d0e31d4568');
const manifest = JSON.parse(await readFile(path.join(sourceRoot, 'manifest.json'), 'utf8'));
await mkdir(output, { recursive: true });
const results = [];
for (const record of manifest.records) {
  const source = path.join(sourceRoot, record.relativePath);
  assert.equal(sha(await readFile(source)), record.sha256);
  const base = path.join(output, record.id);
  const reportPath = `${base}.decode.json`, irPath = `${base}.cadir.json`;
  const run = spawnSync(cli, ['dump', source, '--limits', 'service', '--force', '-o', irPath, '--report', reportPath], {
    timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.ifError(run.error);
  assert.equal(run.status, 0, run.stderr);
  const ir = JSON.parse(await readFile(irPath, 'utf8')), report = JSON.parse(await readFile(reportPath, 'utf8'));
  const check = spawnSync(cli, ['check', irPath, '--limits', 'service', '--force', '--report', `${base}.check.json`], {
    timeout: 60000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024,
  });
  assert.ifError(check.error);
  assert.ok(check.status === 0 || check.status === 1, `unexpected check exit: ${check.status}`);
  const checked = JSON.parse(await readFile(`${base}.check.json`, 'utf8'));
  assert.ok(Array.isArray(checked.check_report?.findings), 'missing geometry check report');
  report.check_report = checked.check_report;
  const generated = await exportSldprtPreview(ir, report, record.sha256);
  const repeated = await exportSldprtPreview(ir, report, record.sha256);
  assert.equal(sha(generated.bytes), sha(repeated.bytes), 'deterministic GLB');
  const decoded = await new NodeIO().readBinary(generated.bytes);
  const primitives = decoded.getRoot().listMeshes().flatMap(mesh => mesh.listPrimitives());
  assert.equal(primitives.length, ir.model.tessellations.length);
  for (let index = 0; index < primitives.length; index++) {
    const sourceMesh = ir.model.tessellations[index], primitive = primitives[index];
    assert.equal(primitive.getExtras().sourceTessellationId, sourceMesh.id);
    assert.deepEqual(Array.from(primitive.getAttribute('POSITION').getArray()), sourceMesh.vertices.flatMap(p => [p.x, p.y, p.z].map(Math.fround)));
    assert.deepEqual(Array.from(primitive.getIndices().getArray()), sourceMesh.triangles.flat());
    assert.deepEqual(Array.from(primitive.getAttribute('NORMAL').getArray()), sourceMesh.normals.flatMap(p => [p.x, p.y, p.z].map(Math.fround)));
  }
  assert.deepEqual(decoded.getRoot().listScenes()[0].listChildren()[0].getScale(), [0.001, 0.001, 0.001]);
  await writeFile(`${base}.glb`, generated.bytes);
  await writeFile(`${base}.preview.json`, JSON.stringify(generated.sidecar, null, 2));
  results.push({ id: record.id, sourceSha256: record.sha256, irSha256: sha(await readFile(irPath)),
    glbSha256: sha(generated.bytes), bytes: generated.bytes.length, bodies: ir.model.bodies.length, faces: ir.model.faces.length,
    meshes: primitives.length, vertices: generated.sidecar.vertices, triangles: generated.sidecar.triangles,
    maximumFloat32ErrorMm: generated.sidecar.maximumFloat32ErrorMm, checkExitCode: check.status,
    checkFindings: checked.check_report.findings,
    unresolvedMeshOwnership: generated.sidecar.sourceMap.filter(item => !item.sourceBodyId || !item.sourceFaceIds.length).length,
    status: generated.sidecar.status, glb: `${base}.glb` });
}
await writeFile(path.join(output, 'evidence.json'), JSON.stringify({ schemaVersion: 1, productionReady: false, results }, null, 2));
console.log(JSON.stringify(results));
