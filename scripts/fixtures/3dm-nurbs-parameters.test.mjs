import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { mapCurveParameter, mapSurfaceParameter, evaluateCurve, evaluateSurface } from './3dm-nurbs-parameters.mjs';

const root = resolve(import.meta.dirname, '../../test-output/3dm-source-audit');
const distance = (a, b) => Math.hypot(...a.map((x, i) => x - b[i]));
const evidence = [];
for (const name of ['blocks.3dm', 'sphereDecals.3dm']) {
  test(`${name}: independent parameter mapping and NURBS evaluation vs original openNURBS`, () => {
    const bytes = readFileSync(resolve(root, `${name}.json`));
    const model = JSON.parse(bytes);
    let count = 0, maxParameterError = 0, maxPointError = 0, unmappedPointError = 0;
    for (const object of model.objects.filter(o => o.cadIr)) {
      const ir = object.cadIr;
      for (const curve of [...ir.curves3d, ...ir.curves2d].filter(c => c.parameterization === 2)) {
        for (const sample of curve.parameterEvidence) {
          const mapped = mapCurveParameter(curve.parameterMap, sample.source, curve.domain);
          maxParameterError = Math.max(maxParameterError, Math.abs(mapped - sample.mapped));
          maxPointError = Math.max(maxPointError, distance(evaluateCurve(curve, mapped), sample.point));
          count++;
        }
      }
      for (const surface of ir.surfaces.filter(s => s.parameterization === 2)) {
        for (const sample of surface.parameterEvidence) {
          const mapped = mapSurfaceParameter(surface, sample.source);
          maxParameterError = Math.max(maxParameterError, distance(mapped, sample.mapped));
          maxPointError = Math.max(maxPointError, distance(evaluateSurface(surface, mapped), sample.point));
          unmappedPointError = Math.max(unmappedPointError, distance(evaluateSurface(surface, sample.source), sample.point));
          count++;
        }
      }
    }
    assert.equal(count, 290);
    assert(maxParameterError < 1e-9, `parameter residual ${maxParameterError}`);
    assert(maxPointError < 1e-9, `geometry residual ${maxPointError}`);
    assert(unmappedPointError > 0.01, 'negative control must expose original UV mismatch');
    evidence.push({ name, extractedSha256: createHash('sha256').update(bytes).digest('hex'), count,
      maxParameterError, maxPointErrorSourceUnits: maxPointError, maxPointErrorMeters: maxPointError * model.metersPerUnit, unmappedPointError });
  });
}
test('parameter contracts reject unsupported, malformed, out-of-domain and nonfinite input', () => {
  const map = { kind: 'arc-angle', angleRadians: Math.PI / 2, domain: [2, 5], breaks: [2, 5] };
  assert.equal(mapCurveParameter(map, 2, [2, 5]), 2);
  assert.equal(mapCurveParameter(map, 5, [2, 5]), 5);
  assert.equal(mapCurveParameter(map, 3.5, [2, 5]), 3.5);
  for (const value of [NaN, Infinity, 1, 6]) assert.throws(() => mapCurveParameter(map, value, [2, 5]));
  for (const invalid of [{ kind: 'unsupported' }, { ...map, breaks: [2, 2, 5] }, { ...map, angleRadians: 7 }]) {
    assert.throws(() => mapCurveParameter(invalid, 3, [2, 5]));
  }
  assert.throws(() => mapSurfaceParameter({ parameterMap: { kind: 'separable', axes: [] } }, [0, 0]));
  writeFileSync(resolve(root, 'parameter-evidence.json'), JSON.stringify({ schemaVersion: 1, results: evidence }, null, 2));
});

test('partial arcs preserve nonzero domains, span boundaries and rational geometry', () => {
  for (const angle of [0.1, Math.PI / 3, Math.PI * 0.8, Math.PI * 1.3, Math.PI * 2]) {
    const spans = Math.ceil(angle / (Math.PI / 2)), width = angle / spans;
    const breaks = Array.from({ length: spans + 1 }, (_, i) => 7 + i * 10 / spans);
    const map = { kind: 'arc-angle', angleRadians: angle, domain: [7, 17], breaks };
    const points = [], knots = [7];
    for (let i = 0; i < spans; i++) {
      const start = i * width, middle = start + width / 2;
      points.push([Math.cos(start), Math.sin(start), 1], [Math.cos(middle), Math.sin(middle), Math.cos(width / 2)]);
      knots.push(breaks[i], breaks[i]);
    }
    points.push([Math.cos(angle), Math.sin(angle), 1]); knots.push(17, 17, 17);
    const curve = { degree: 2, dimension: 2, rational: true, controlPoints: points, knots };
    for (let i = 0; i <= 101; i++) {
      const mapped = mapCurveParameter(map, 7 + 10 * i / 101, [7, 17]);
      assert(distance(evaluateCurve(curve, mapped), [Math.cos(angle * i / 101), Math.sin(angle * i / 101)]) < 1e-13);
    }
    for (const boundary of breaks) assert(Math.abs(mapCurveParameter(map, boundary, [7, 17]) - boundary) < 1e-14);
  }
});

test('transposed separable sphere mapping preserves axis and control-point order', () => {
  const model = JSON.parse(readFileSync(resolve(root, 'sphereDecals.3dm.json')));
  const source = model.objects[0].cadIr.surfaces[0];
  const [nu, nv] = source.controlPointCount;
  const transposed = { ...source, domain: [...source.domain].reverse(), degree: [...source.degree].reverse(),
    knots: [...source.knots].reverse(), controlPointCount: [nv, nu],
    parameterMap: { kind: 'separable', axes: [...source.parameterMap.axes].reverse() },
    controlPoints: Array.from({ length: nu }, (_, u) => Array.from({ length: nv }, (_, v) => source.controlPoints[v * nu + u])).flat() };
  for (const sample of source.parameterEvidence) {
    const mapped = mapSurfaceParameter(transposed, [...sample.source].reverse());
    assert(distance(evaluateSurface(transposed, mapped), sample.point) < 1e-10);
  }
});
