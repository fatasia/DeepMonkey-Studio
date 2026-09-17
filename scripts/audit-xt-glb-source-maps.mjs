import { readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { auditXtGlbSourceMap } from './lib/xtGlbSourceMap.mjs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Usage: audit-xt-glb-source-maps <native-evidence.json> <output.json>');
const bytes = await readFile(input);
const evidence = JSON.parse(bytes.toString('utf8'));
const root = await realpath(path.dirname(input));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (!Array.isArray(evidence.results) || evidence.results.length === 0) throw new Error('Empty evidence');
const results = [];
for (const row of evidence.results) {
  if (row.status !== 'preview-evidence') throw new Error(`Failed conversion: ${row.source}`);
  const file = await realpath(path.resolve(root, row.output));
  const relative = path.relative(root, file);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Output escapes evidence root');
  const glb = await readFile(file);
  if (hash(glb) !== row.outputSha256) throw new Error(`Changed output: ${row.source}`);
  const counts = auditXtGlbSourceMap(glb);
  if (counts.triangles !== row.geometry.triangleCount || counts.bodies !== row.reported.bodies
    || counts.uniqueFaces !== row.reported.meshedFaces) throw new Error(`Source map count mismatch: ${row.source}`);
  results.push({ source: row.source, sourceSha256: row.sourceSha256, outputSha256: row.outputSha256, ...counts });
}
await writeFile(output, JSON.stringify({ schemaVersion: 1, evidenceSha256: hash(bytes),
  scope: 'source-map-triangle-coverage-only', total: results.length, results }, null, 2) + '\n');
console.log(`Validated ${results.length} GLB source maps`);
