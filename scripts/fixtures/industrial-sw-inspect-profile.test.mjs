import test from 'node:test';
import assert from 'node:assert/strict';
import { classifySolidWorksInspect } from './industrial-sw-inspect-profile.mjs';
const valid = () => ({ command: 'inspect', status: 'ok', confidence: 'high', summary: { format: 'sldprt', container_kind: 'sldprt-blocks',
  entries: [{ name: 'Contents/Partition' }], notes: ['outer version word: 0x00000004; 39 CRC-validated block(s), 2 tail-directory entry/entries, 13 cache-cell(s)'],
  dialects: { primary: { admission: 'admitted', declared: { sw_version: '16000' } } }, losses: [] } });
test('admitted container stays inspect-only and does not certify geometry', () => {
  assert.deepEqual(classifySolidWorksInspect(0, valid()), { status: 'container-inspect-only', reasons: [], geometryCertified: false });
});
test('zero exit status cannot admit recovered, missing, warning or forged profiles', () => {
  for (const mutate of [r => r.confidence = null, r => r.summary.entries = [], r => r.summary.notes = [],
    r => r.summary.dialects.primary.admission = 'residual', r => r.summary.dialects.primary.declared.sw_version = '17000',
    r => r.summary.losses = [{ severity: 'warning' }], r => r.summary.container_kind = 'cfb', r => r.command = 'dump']) {
    const report = valid(); mutate(report);
    const result = classifySolidWorksInspect(0, report);
    assert.equal(result.status, 'recovered-inspect-not-qualified'); assert.equal(result.geometryCertified, false);
  }
  assert.equal(classifySolidWorksInspect(0, null).status, 'recovered-inspect-not-qualified');
  assert.equal(classifySolidWorksInspect(2, valid()).status, 'rejected-by-cli');
});
