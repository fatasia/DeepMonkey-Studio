import assert from 'node:assert/strict';
import test from 'node:test';
import { exportSldprtPreview } from './sldprt-glb-preview.mts';
const fixture = () => ({ ir_version: '6', units: { length: 'millimeter' }, model: {
  configurations: [{ id: 'default', active: true, bodies: ['body'] }], bodies: [{ id: 'body' }], faces: [{ id: 'face' }], appearances: [], appearance_bindings: [],
  tessellations: [{ id: 'mesh', body: 'body', faces: ['face'], vertices: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }],
    triangles: [[0, 1, 2]], normals: Array.from({ length: 3 }, () => ({ x: 0, y: 0, z: 1 })) }],
} });
const report = { decode_report: { format: 'sldprt', geometry_transferred: true, container_only: false, losses: [{ code: 'retained-diagnostic' }] } };
test('preserves unowned display geometry without fabricating topology', async () => {
  const input: any = fixture(); delete input.model.tessellations[0].body; delete input.model.tessellations[0].faces;
  const output = await exportSldprtPreview(input, report, 'a'.repeat(64));
  assert.equal(output.sidecar.triangles, 1); assert.equal(output.sidecar.sourceMap[0].sourceBodyId, null);
  assert.equal(output.sidecar.status, 'partial-geometry-preview'); assert.equal(output.sidecar.diagnostics.length, 2);
});
test('refuses malformed geometry, identities and ambiguous configuration', async () => {
  const cases: Array<(x: any) => void> = [x => x.units.length = 'unknown', x => x.model.configurations.push({ id: 'other', active: true }),
    x => x.model.configurations[0].bodies = ['missing'],
    x => x.model.tessellations[0].vertices[0].x = Infinity, x => x.model.tessellations[0].triangles[0][0] = 999,
    x => x.model.tessellations[0].body = 'missing', x => x.model.tessellations[0].faces = ['missing'],
    x => x.model.tessellations.push(structuredClone(x.model.tessellations[0])), x => x.model.tessellations[0].normals = [],
    x => x.model.occurrences = [{ id: 'assembly' }]];
  for (const mutate of cases) { const input = fixture(); mutate(input); await assert.rejects(exportSldprtPreview(input, report, 'a'.repeat(64))); }
  await assert.rejects(exportSldprtPreview(fixture(), { decode_report: { ...report.decode_report, container_only: true } }, 'a'.repeat(64)));
});
test('retains source validation failures and selects only the active configuration', async () => {
  const input: any = fixture();
  input.model.configurations.push({ id: 'inactive', active: false });
  const finding = { severity: 'error', check: 'referential_integrity', message: 'missing configuration parameter' };
  const output = await exportSldprtPreview(input, { ...report, check_report: { findings: [finding] } }, 'a'.repeat(64));
  assert.equal(output.sidecar.configuration.id, 'default');
  assert.equal(output.sidecar.status, 'partial-geometry-preview');
  assert.deepEqual(output.sidecar.diagnostics.at(-1), finding);
});

test('rejects ambiguous bindings and malformed collections before geometry allocation', async () => {
  const cases: Array<(x: any) => void> = [
    x => x.model.configurations = null,
    x => x.model.configurations[0].bodies = ['body', 'body'],
    x => x.model.bodies = [null],
    x => x.model.appearance_bindings = {},
    x => x.model.appearance_bindings = [{ target: { kind: 'tessellation', id: 'missing' }, appearance: 'a' }],
    x => { x.model.appearances = [{id:'a'}]; x.model.appearance_bindings = Array(2).fill({target:{kind:'tessellation',id:'mesh'},appearance:'a'}); },
  ];
  for(const mutate of cases){const input=fixture();mutate(input);await assert.rejects(exportSldprtPreview(input,report,'a'.repeat(64)));}
  await assert.rejects(exportSldprtPreview(null,report,'a'.repeat(64)), /unsupported CADIR/);
  await assert.rejects(exportSldprtPreview(fixture(),{...report,check_report:{findings:{}}},'a'.repeat(64)), /invalid check diagnostics/);
});
