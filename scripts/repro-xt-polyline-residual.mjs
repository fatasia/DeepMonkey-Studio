import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { compareFaceWitness } from './lib/xtFaceGeometryAudit.mjs';

const [corpus, oracle, causal, rawProbe, output] = process.argv.slice(2);
if (!output) throw new Error('Usage: repro-xt-polyline-residual corpus oracle causal-probe raw-probe output.json');
const cases = [
  { name: 'AA-0222B.x_t', faces: ['5108', '10980'], roots: ['5183', '5212', '12494', '12435'] },
  { name: 'AS, AT-2810L.x_t', faces: ['1524'], roots: ['1564'] },
  { name: 'AS, AT-2810R.x_t', faces: ['1641', '360'], roots: ['1681', '675'] },
];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
let discovered = 0;
function inside(root, candidate) {
  const relative = path.relative(root, candidate);
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`)) throw new Error('Corpus path escape');
}
async function files(root, dir = root, depth = 0) {
  if (depth > 16) throw new Error('Corpus directory depth exceeded');
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    if (++discovered > 100000) throw new Error('Corpus entry budget exceeded');
    const full = await realpath(path.join(dir, e.name)); inside(root, full);
    if (e.isDirectory()) out.push(...await files(root, full, depth + 1));
    else out.push(full);
  }
  return out;
}
async function run(binary, args, trace = false) {
  const r = await promisify(execFile)(binary, args, { windowsHide: true,
    timeout: 60000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, ...(trace ? { XT_EDGE_TRACE: '1', XT_WALK_TRACE: '1', XT_WALK_PROBE: '1', XT_POLY_TRACE: '1' } : {}) },
  });
  return { rows: r.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse), trace: r.stderr };
}
const corpusRoot = await realpath(corpus);
const all = await files(corpusRoot), results = [];
for (const c of cases) {
  const matches = all.filter(p => path.basename(p) === c.name);
  if (matches.length !== 1) throw new Error(`Expected one ${c.name}`);
  const source = matches[0];
  const [raw, direct, chain] = await Promise.all([
    run(oracle, [source]), run(causal, [source, ...c.faces], true), run(rawProbe, [source, ...c.roots]),
  ]);
  for (const face of c.faces) {
    const candidates = direct.rows.filter(r => String(r.sourceFace) === face);
    if (candidates.length !== 1) throw new Error(`Ambiguous face ${face}`);
    const stage = candidates[0];
    const witness = raw.rows[0].faces.find(r => r.face === face && r.body === String(stage.body));
    if (!witness?.surface) throw new Error('Missing independent analytic witness');
    const residuals = stage.edgeSamples.map(edge => ({ edgeId: edge.edgeId,
      kind: edge.curve.split(/[ {]/)[0],
      residualMm: compareFaceWitness({ points: [], surface: witness.surface }, edge.points).surfaceMaxMm,
    }));
    results.push({ source: path.relative(corpusRoot, source), sourceSha256: hash(await readFile(source)),
      body: stage.body, face, toleranceMm: 0.01, residuals,
      pass: residuals.every(r => Number.isFinite(r.residualMm) && r.residualMm <= 0.01),
      rawEntities: chain.rows, routeTrace: direct.trace.split(/\r?\n/).filter(line =>
        c.roots.some(root => new RegExp(`(?:entity=|curve |spc#|pcurve | \\b)${root}\\b`).test(line))),
    });
  }
}
await writeFile(output, JSON.stringify({ schemaVersion: 1, scope: 'five-face-cached-boundary-regression',
  binaries: Object.fromEntries(await Promise.all([oracle, causal, rawProbe].map(async p => [p, hash(await readFile(p))]))),
  results }, null, 2) + '\n');
console.log(JSON.stringify(results.map(r => ({ face: r.face, pass: r.pass,
  worstMm: Math.max(...r.residuals.map(e => e.residualMm)) }))));
process.exitCode = results.every(r => r.pass) ? 0 : 2;
