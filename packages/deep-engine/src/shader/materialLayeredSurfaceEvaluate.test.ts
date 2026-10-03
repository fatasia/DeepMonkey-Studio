import { expect, it } from "vitest";
import { evaluateLayeredSurfaceDirect } from "./materialLayeredSurfaceEvaluate.js";
import { evaluateLayeredMaterialDirect } from "./materialLayeredEvaluate.js";
import { evaluateExtendedMaterialDirect, type MaterialEvaluationGeometry,
  type MaterialEvaluationResult, type StandardSurfaceInputs, type Vec3 } from "./materialEvaluate.js";
import { evaluateMetalReflectionDirect } from "./materialMetalReflectionEvaluate.js";
import { normalizeLayeredSurfaceParameters, resolveLayerSurface, type LayeredSurfaceOverrides } from "./materialLayeredSurface.js";

const base: StandardSurfaceInputs = { baseColor: [.7, .35, .12], metallic: .3, roughness: .5 };
const coat = { coverage: .6, params: { clearcoat: { factor: .7, roughness: .4 } },
  surface: { baseColor: [.8, .6, .4] as Vec3, metallic: 0, roughness: .7 } };
const metal = { coverage: .7, responseModel: "microfacet-metal-reflection" as const,
  params: { anisotropy: { strength: .8, rotation: .4 } },
  surface: { baseColor: [.9, .5, .2] as Vec3, metallic: 1, roughness: .6 } };
const lobes = ["diffuse", "specular", "clearcoat", "transmission"] as const;
const geometry: MaterialEvaluationGeometry = { normal: [0, 0, 1], view: [.6, 0, .8], light: [0, .6, .8] };

/** Independent parent-response oracle; normalization is the public input contract. */
function parents(input: LayeredSurfaceOverrides, geom: MaterialEvaluationGeometry, radiance: Vec3) {
  const normalized = normalizeLayeredSurfaceParameters(input);
  return [evaluateExtendedMaterialDirect(base, normalized.base, geom, radiance),
    ...normalized.layers.map((row, i) => {
      const surface = resolveLayerSurface(base, normalized.surfaces[i]);
      return row.responseModel === "microfacet-metal-reflection"
        ? evaluateMetalReflectionDirect(surface, row.params, geom, radiance)
        : evaluateExtendedMaterialDirect(surface, row.params, geom, radiance);
    })];
}
function oracle(input: LayeredSurfaceOverrides, values: readonly Vec3[], responses = values): Vec3 {
  let output = values[0]!;
  for (const [index, row] of (input.layers ?? []).entries()) {
    const layer = values[index + 1]!, coverage = Math.fround(row.coverage ?? 0);
    output = output.map((under, channel) => {
      const weight = coverage * (row.mode === "overlay" ? Math.min(1, Math.max(0, responses[index + 1]![channel]!)) : 1);
      return (1 - weight) * under + weight * layer[channel]!;
    }) as unknown as Vec3;
  }
  return output;
}

it("matches independent parent response composition at 288 coat/metal geometry, radiance and ordering cases", () => {
  let count = 0, orderDelta = 0;
  for (const vd of [0, 30, 60, 85]) for (const ld of [0, 20, 65])
    for (const radiance of [[1, 1, 1], [.2, .5, .8], [3.2, 3, 2.8]] as const)
      for (const firstMode of ["replace", "overlay"] as const)
        for (const secondMode of ["replace", "overlay"] as const) for (const reverse of [false, true]) {
          const geom: MaterialEvaluationGeometry = { normal: [0, 0, 1], tangent: [1, 0, 0],
            view: [Math.sin(vd * Math.PI / 180), 0, Math.cos(vd * Math.PI / 180)],
            light: [0, Math.sin(ld * Math.PI / 180), Math.cos(ld * Math.PI / 180)] };
          const rows = reverse ? [metal, coat] : [coat, metal];
          const layers = rows.map((row, i) => ({ ...row, mode: i ? secondMode : firstMode }));
          const input = { layers }, actual = evaluateLayeredSurfaceDirect(base, input, geom, radiance);
          const parent = parents(input, geom, radiance);
          expect(actual.rgb).toEqual(oracle(input, parent.map(row => row.rgb)));
          for (const lobe of lobes) expect(actual.components[lobe]).toEqual(oracle(input,
            parent.map(row => row.components[lobe]), parent.map(row => row.rgb)));
          for (let c = 0; c < 3; c++) {
            expect(Number.isFinite(actual.rgb[c]!)).toBe(true);
            expect(actual.rgb[c]!).toBeGreaterThanOrEqual(0);
            expect(actual.rgb[c]!).toBeLessThanOrEqual(Math.max(...parent.map(row => row.rgb[c]!)));
            const sum = lobes.reduce((total, key) => total + actual.components[key][c]!, 0);
            expect(Math.abs(sum - actual.rgb[c]!)).toBeLessThanOrEqual(1e-12 * (1 + Math.abs(actual.rgb[c]!)));
          }
          const switched = evaluateLayeredSurfaceDirect(base, { layers: [...layers].reverse() }, geom, radiance);
          orderDelta = Math.max(orderDelta, ...actual.rgb.map((value, c) => Math.abs(value - switched.rgb[c]!)));
          expect(evaluateLayeredSurfaceDirect(base, { layers: layers.map(row => ({ ...row, coverage: 0 })) }, geom, radiance)).toEqual(parent[0]);
          count++;
        }
  expect(count).toBe(288);
  expect(orderDelta).toBeGreaterThan(.001);
});

it("preserves empty, zero and legacy shared-surface responses including default radiance", () => {
  for (const mode of ["replace", "overlay"] as const) {
    for (const coverage of [0, .6, 1]) {
      const input = { layers: [{ params: coat.params, coverage, mode }] };
      expect(evaluateLayeredSurfaceDirect(base, input, geometry)).toEqual(evaluateLayeredMaterialDirect(base, input, geometry));
    }
  }
  expect(evaluateLayeredSurfaceDirect(base, {}, geometry)).toEqual(evaluateExtendedMaterialDirect(base, {}, geometry));
});

it("takes over the complete chosen parent at replace coverage one without inheriting base surface", () => {
  for (const row of [coat, metal]) {
    const input = { layers: [{ ...row, coverage: 1 }] };
    const expected = parents(input, geometry, [1, 1, 1])[1]!;
    expect(evaluateLayeredSurfaceDirect(base, input, geometry, [1, 1, 1])).toEqual(expected);
  }
});

it("rejects unresolved active texture slots while pruning zero coverage without sampling", () => {
  for (const field of ["baseColorTexture", "metallicRoughnessTexture"] as const) {
    const surface = { ...coat.surface, [field]: { texture: "unresolved", texCoord: 1 as const } };
    expect(() => evaluateLayeredSurfaceDirect(base, { layers: [{ ...coat, surface }] }, geometry)).toThrow(/Resolve layer texture samples/);
    expect(evaluateLayeredSurfaceDirect(base, { layers: [{ ...coat, surface, coverage: 0 }] }, geometry))
      .toEqual(evaluateExtendedMaterialDirect(base, {}, geometry));
  }
});

it("preserves validation of model boundaries and invalid values even on pruned rows", () => {
  expect(() => evaluateLayeredSurfaceDirect(base, { layers: [{ ...metal, params: { clearcoat: { factor: .01 } } }] }, geometry)).toThrow(/does not support/);
  expect(() => evaluateLayeredSurfaceDirect(base, { layers: [{ ...metal, surface: { metallic: .5 } }] }, geometry)).toThrow(/metallic=1/);
  expect(() => evaluateLayeredSurfaceDirect(base, { layers: [{ ...coat, coverage: 0, surface: { roughness: NaN } }] }, geometry)).toThrow(/roughness/);
  expect(() => evaluateLayeredSurfaceDirect(base, { layers: [{ ...coat, coverage: 1.1 }] }, geometry)).toThrow(/coverage/);
});

it("keeps caller parameters unchanged and freezes produced channels", () => {
  const input = { layers: [{ ...coat, mode: "overlay" as const }, { ...metal, mode: "replace" as const }] };
  const before = JSON.stringify(input), actual: MaterialEvaluationResult = evaluateLayeredSurfaceDirect(base, input, geometry);
  expect(JSON.stringify(input)).toBe(before);
  expect(Object.isFrozen(actual.rgb)).toBe(true);
  expect(Object.isFrozen(actual.components)).toBe(true);
  for (const lobe of lobes) expect(Object.isFrozen(actual.components[lobe])).toBe(true);
});
