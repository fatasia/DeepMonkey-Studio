import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditXtGlbSourceMap } from './lib/xtGlbSourceMap.mjs';
import { auditXtSourceIdentity } from './lib/xtSourceIdentityAudit.mjs';

const [rawArg, evidenceArg, corpusArg, outputArg] = process.argv.slice(2);
if (!rawArg || !evidenceArg || !corpusArg || !outputArg) {
  throw new Error('Usage: audit-xt-glb-source-identities <raw.jsonl> <native-evidence.json> <corpus> <output.json>');
}
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const corpus = await realpath(corpusArg);
const outputRoot = await realpath(path.dirname(evidenceArg));
const rawBytes = await readFile(rawArg);
const evidenceBytes = await readFile(evidenceArg);
const evidence = JSON.parse(evidenceBytes.toString('utf8'));
const rawBySource = new Map();
const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
async function contained(root, candidate) {
  const file = await realpath(path.resolve(root, candidate));
  const relative = path.relative(root, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) {
    throw new Error('Audit path escapes its root');
  }
  return file;
}
for (const line of rawBytes.toString('utf8').split(/\r?\n/).filter(line => line.trim())) {
  const raw = JSON.parse(line);
  const file = await contained(corpus, raw.source);
  if (rawBySource.has(key(file))) throw new Error(`Duplicate raw source: ${file}`);
  rawBySource.set(key(file), raw);
}
if (!Array.isArray(evidence.results) || evidence.results.length === 0
  || rawBySource.size !== evidence.results.length) throw new Error('Source inventory is not one-to-one');
const results = [];
const seenOutputs = new Set();
for (const row of evidence.results) {
  if (row.status !== 'preview-evidence' || row.countsAgree !== true) throw new Error('Conversion evidence failed');
  const file = await contained(corpus, row.source);
  const raw = rawBySource.get(key(file));
  if (!raw) throw new Error(`Missing or duplicate source: ${row.source}`);
  rawBySource.delete(key(file));
  const source = await readFile(file);
  if (source.length !== raw.sourceBytes || hash(source) !== row.sourceSha256) throw new Error('Source bytes changed');
  const output = await contained(outputRoot, row.output);
  if (seenOutputs.has(key(output))) throw new Error('Duplicate GLB output');
  seenOutputs.add(key(output));
  const glb = await readFile(output);
  if (hash(glb) !== row.outputSha256) throw new Error('Output bytes changed');
  const coverage = auditXtGlbSourceMap(glb);
  if (coverage.triangles !== row.geometry.triangleCount) throw new Error('Geometry evidence count changed');
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString('utf8'));
  const identity = auditXtSourceIdentity(json, raw);
  results.push({ source: row.source, sourceSha256: row.sourceSha256, outputSha256: row.outputSha256, ...identity });
}
await writeFile(outputArg, JSON.stringify({ schemaVersion: 1,
  scope: 'raw-body-face-membership-only', rawSha256: hash(rawBytes), evidenceSha256: hash(evidenceBytes),
  total: results.length, results }, null, 2) + '\n');
console.log(`Validated ${results.length} source BODY/FACE identity sets`);
