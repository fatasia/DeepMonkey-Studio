import test from 'node:test';
import assert from 'node:assert/strict';
import { compareXtSourceCounts } from './xtSourceCountAudit.mjs';

const report = (counts = { bodies: 1, faces: 3, uniqueFaces: 3 }) =>
  `incomplete\t"part.x_t"\t"shell diagnostic"\t${JSON.stringify(counts)}\nTOTAL\t{}`;
const evidence = (faces = 3) => ({ results: [{ source: 'part.x_t', status: 'preview-evidence',
  countsAgree: true, reported: { bodies: 1, faces, meshedFaces: faces } }] });

test('independent source denominator catches internally consistent partial geometry', () => {
  assert.equal(compareXtSourceCounts(report(), evidence(2)).summary.sourceCountsAgree, 0);
  const result = compareXtSourceCounts(report(), evidence());
  assert.equal(result.summary.sourceCountsAgree, 1);
  assert.equal(result.summary.productionProfilesCertified, 0);
});
test('parse failure, duplicate faces and failed conversion cannot pass', () => {
  assert.equal(compareXtSourceCounts(report(null), evidence()).summary.sourceCountsAgree, 0);
  assert.equal(compareXtSourceCounts(report({ bodies: 1, faces: 3, uniqueFaces: 2 }), evidence()).summary.sourceCountsAgree, 0);
  const failed = evidence();
  failed.results[0].status = 'failed';
  assert.equal(compareXtSourceCounts(report(), failed).summary.sourceCountsAgree, 0);
});
test('rejects missing, duplicate and malformed sample records', () => {
  assert.throws(() => compareXtSourceCounts('incomplete\t"part.x_t"\t""', evidence()), /raw-count/);
  assert.throws(() => compareXtSourceCounts(report() + '\n' + report(), evidence()), /Duplicate source/);
  const duplicate = evidence();
  duplicate.results.push(duplicate.results[0]);
  assert.throws(() => compareXtSourceCounts(report(), duplicate), /Duplicate converter/);
  assert.throws(() => compareXtSourceCounts(report().replace('part.x_t', 'other.x_t'), evidence()), /Missing source/);
  assert.throws(() => compareXtSourceCounts(report({ bodies: -1, faces: 3, uniqueFaces: 3 }), evidence()), /Invalid counts/);
});
