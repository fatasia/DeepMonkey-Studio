import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifySolidWorksInspect } from './industrial-sw-inspect-profile.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, 'test-output/industrial-solidworks/qualification-20260918');
const evidence = JSON.parse(await readFile(path.join(directory, 'qualification.json'), 'utf8'));
const rows = [];
for (const run of evidence.results) {
  assert.equal(run.timedOut, false, run.id);
  const bytes = await readFile(path.join(directory, run.stdoutFile));
  const report = bytes.length ? JSON.parse(bytes.toString('utf8')) : null;
  if (report) assert.equal(report.generator, 'cadmpeg 0.6.0+gunknown', 'Archive builds must not inherit the enclosing product repository revision');
  const classification = classifySolidWorksInspect(run.exitCode, report);
  assert.equal(classification.status === 'container-inspect-only', run.kind === 'real-source', run.id);
  rows.push({ id: run.id, ...classification, stdoutSha256: createHash('sha256').update(bytes).digest('hex'),
    entries: report?.summary?.entries?.length ?? 0, declaredSwVersion: report?.summary?.dialects?.primary?.declared?.sw_version ?? null,
    notes: report?.summary?.notes ?? [], lossCodes: report?.summary?.losses?.map(loss => loss.code) ?? [], elapsedMs: run.elapsedMs,
    peakWorkingSetBytesSampled: run.peakWorkingSetBytesSampled });
}
const summary = { schemaVersion: 1, profileId: 'solidworks-v16000-framed-container-inspection', executableSha256: evidence.executableSha256,
  scope: '5 fixed real parts plus 8 negative auto/forced-input inspections; not geometry qualification', rows };
await writeFile(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
