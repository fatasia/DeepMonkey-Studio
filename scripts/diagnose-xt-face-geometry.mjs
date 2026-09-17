import { readFile, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { compareFaceWitness, mappedFaceGeometry } from './lib/xtFaceGeometryAudit.mjs';
const [oracle, probe, auditFile, evidenceFile, corpusArg, outputFile] = process.argv.slice(2);
if (!outputFile) throw new Error('Usage: diagnose-xt-face-geometry <oracle> <causal-probe> <face-audit.json> <native-evidence.json> <corpus> <output.json>');
const sha = value => createHash('sha256').update(value).digest('hex');
const auditBytes = await readFile(auditFile), audit = JSON.parse(auditBytes);
const evidenceBytes = await readFile(evidenceFile), evidence = JSON.parse(evidenceBytes);
if (sha(evidenceBytes) !== audit.evidenceSha256) throw new Error('Audit/evidence binding changed');
const corpus = await realpath(corpusArg), root = await realpath(path.dirname(evidenceFile));
const run = async (binary, args) => (await promisify(execFile)(binary, args, {
  windowsHide: true, timeout: 60000, maxBuffer: 32 * 1024 * 1024,
})).stdout.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
async function contained(base, name) {
  const file = await realpath(path.resolve(base, name)), relative = path.relative(base, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Path escape');
  return file;
}
const fingerprint = points => sha([...new Set(points.map(p => JSON.stringify(p)))].sort().join('\n'));
const results = [];
for (const entry of audit.results) {
  const faces = entry.faces.filter(face => face.status === 'mismatch');
  if (!faces.length) continue;
  const conversion = evidence.results.find(row => row.source === entry.source);
  const sourcePath = await contained(corpus, entry.source), glbPath = await contained(root, conversion.output);
  const sourceBytes = await readFile(sourcePath), glb = await readFile(glbPath);
  if (sha(sourceBytes) !== entry.sourceSha256 || sha(glb) !== entry.outputSha256) throw new Error('Evidence bytes changed');
  const [raw] = await run(oracle, [sourcePath]);
  const direct = await run(probe, [sourcePath, ...faces.map(face => face.face)]);
  const mapped = mappedFaceGeometry(glb);
  for (const face of faces) {
    const witness = raw.faces.find(row => row.face === face.face && row.body === face.body);
    const stage = direct.find(row => String(row.sourceFace) === face.face && String(row.body) === face.body);
    if (!stage || !witness) throw new Error('Missing causal face');
    const triangles = [];
    for (let i = 0; i < stage.indices.length; i += 3) triangles.push(stage.indices.slice(i, i + 3).map(id => stage.positions[id]));
    const points = stage.indices.map(i => stage.positions[i]);
    const geometry = mapped.get(`${face.body}/${face.face}`);
    const directCheck = compareFaceWitness(witness, points, triangles);
    const surfaceResidual = vertices => witness.surface && vertices.length
      ? compareFaceWitness({ points: [], surface: witness.surface }, vertices).surfaceMaxMm : null;
    const sourceWitnessResidualMm = surfaceResidual(witness.points);
    const boundaryResidualMm = surfaceResidual(stage.edgePoints);
    let worstPoint = null, worst = -1;
    if (witness.surface) for (const point of geometry.points) {
      const d = surfaceResidual([point]);
      if (d > worst) { worst = d; worstPoint = point; }
    }
    const boundaryDistanceMm = worstPoint && stage.edgePoints.length
      ? Math.min(...stage.edgePoints.map(point => Math.hypot(...point.map((x, i) => x - worstPoint[i])))) : null;
    results.push({ source: entry.source, body: face.body, face: face.face,
      rawSurface: witness.surface, loweredSurface: stage.surface.slice(0, 1500),
      directPatchMatchesGlbVertexSet: fingerprint(points) === fingerprint(geometry.points),
      directCheck, rebuilt: stage.rebuilt, crossings: stage.crossings, undrawn: stage.undrawn,
      resolvedSagMm: stage.resolvedSag, sourceWitnessResidualMm, cachedBoundaryResidualMm: boundaryResidualMm,
      modelToleranceMm: stage.modelTolerance,
      edgeResiduals: stage.edgeSamples.map(edge => ({ edgeId: edge.edgeId,
        curveKind: edge.curve.split(/[ {]/)[0], surfaceResidualMm: surfaceResidual(edge.points) })),
      worstGlbPoint: worstPoint, worstPointDistanceToCachedBoundaryMm: boundaryDistanceMm,
      curveKinds: stage.edgeCurves.map(curve => curve.split(/[ {]/)[0]),
      faceId: stage.faceId,
    });
  }
}
if (!results.length) throw new Error('No mismatches to diagnose');
await writeFile(outputFile, JSON.stringify({ schemaVersion: 1,
  scope: 'diagnostic-stage-localization-not-independent-truth', auditSha256: sha(auditBytes),
  probeSha256: sha(await readFile(probe)), oracleSha256: sha(await readFile(oracle)), results }, null, 2) + '\n');
console.log(JSON.stringify(results.map(r => ({ source: r.source, face: r.face, matches: r.directPatchMatchesGlbVertexSet,
  rebuilt: r.rebuilt, boundary: r.cachedBoundaryResidualMm, distanceToBoundary: r.worstPointDistanceToCachedBoundaryMm,
  directBoundary: r.directCheck.boundaryMaxMm, directSurface: r.directCheck.surfaceMaxMm }))));
