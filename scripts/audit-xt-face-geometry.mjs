import { readFile, writeFile, realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mappedFaceGeometry, compareFaceWitness } from './lib/xtFaceGeometryAudit.mjs';

const [oracleArg, evidenceArg, corpusArg, outputArg] = process.argv.slice(2);
if (!oracleArg || !evidenceArg || !corpusArg || !outputArg) {
  throw new Error('Usage: audit-xt-face-geometry <raw-oracle.exe> <evidence.json> <corpus> <output.json>');
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const corpus = await realpath(corpusArg), outputRoot = await realpath(path.dirname(evidenceArg));
const oracle = await realpath(oracleArg), oracleHash = sha(await readFile(oracle));
const evidenceBytes = await readFile(evidenceArg), evidence = JSON.parse(evidenceBytes);
if (!Array.isArray(evidence.results) || !evidence.results.length) throw new Error('Empty corpus');
const { stdout } = await promisify(execFile)(oracle, [corpus], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const normalize = file => process.platform === 'win32' ? file.toLowerCase() : file;
async function contained(root, name) {
  const file = await realpath(path.resolve(root, name)), relative = path.relative(root, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Path escape');
  return file;
}
const raw = new Map();
for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
  const row = JSON.parse(line), file = await contained(corpus, row.source), key = normalize(file);
  if (raw.has(key) || row.space !== 'source-local-mm') throw new Error('Duplicate or invalid oracle source');
  raw.set(key, row);
}
if (raw.size !== evidence.results.length) throw new Error('Corpus mismatch');
const results = [], counts = { files: 0, faces: 0, matched: 0, mismatch: 0, unresolved: 0, repeatedWitnessFaces: 0 };
for (const row of evidence.results) {
  if (row.status !== 'preview-evidence') throw new Error('Failed conversion row');
  const file = await contained(corpus, row.source), key = normalize(file), source = raw.get(key);
  if (!source) throw new Error('Missing or repeated source');
  raw.delete(key);
  const bytes = await readFile(file), output = await readFile(await contained(outputRoot, row.output));
  if (sha(bytes) !== row.sourceSha256 || bytes.length !== source.sourceBytes || sha(output) !== row.outputSha256) throw new Error('Evidence bytes changed');
  const mapped = mappedFaceGeometry(output), faces = [], seen = new Set();
  const witnessHash = face => sha(JSON.stringify({ points: face.points, surface: face.surface }));
  const multiplicities = new Map();
  for (const face of source.faces) {
    const signature = `${face.body}/${witnessHash(face)}`;
    multiplicities.set(signature, (multiplicities.get(signature) ?? 0) + 1);
  }
  for (const face of source.faces) {
    const id = `${face.body}/${face.face}`;
    if (seen.has(id) || !mapped.has(id)) throw new Error('Source face missing or duplicate');
    seen.add(id);
    const geometry = mapped.get(id);
    const comparison = compareFaceWitness(face, geometry.points, geometry.triangles);
    const sourceWitnessSha256 = witnessHash(face);
    const witnessMultiplicity = multiplicities.get(`${face.body}/${sourceWitnessSha256}`);
    if (witnessMultiplicity > 1) counts.repeatedWitnessFaces++;
    const triangleFingerprint = geometry.triangles.map(triangle => triangle.map(point => JSON.stringify(point)).sort().join('|')).sort();
    counts.faces++;
    counts[comparison.status === 'witness-match' ? 'matched' : comparison.status]++;
    faces.push({ body: face.body, face: face.face, sourceWitnessSha256,
      observedTrianglesSha256: sha(triangleFingerprint.join('\n')), witnessMultiplicity, ...comparison });
  }
  if (seen.size !== mapped.size) throw new Error('Unexpected output face');
  counts.files++;
  results.push({ source: row.source, sourceSha256: row.sourceSha256, outputSha256: row.outputSha256, faces });
}
if (sha(await readFile(oracle)) !== oracleHash) throw new Error('Oracle changed during audit');
await writeFile(outputArg, JSON.stringify({ schemaVersion: 1,
  scope: 'source-local-boundary-vertex-circle-spline-and-analytic-surface-witnesses',
  tolerance: 'max(0.01 mm, max absolute coordinate * 2^-21)',
  oracleSha256: oracleHash, rawWitnessSha256: sha(stdout), evidenceSha256: sha(evidenceBytes),
  allFacesWitnessMatched: counts.mismatch === 0 && counts.unresolved === 0,
  productionProfilesCertified: 0, counts, results }, null, 2) + '\n');
console.log(JSON.stringify(counts));
process.exitCode = counts.mismatch > 0 ? 2 : counts.unresolved > 0 ? 3 : 0;
