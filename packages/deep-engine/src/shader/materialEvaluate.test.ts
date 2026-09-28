import { describe, expect, it } from "vitest";
import { dielectricF0 } from "../materialDielectric.js";
import { evaluateClearcoatReference } from "../shaderAuthoring/packageClearcoat.js";
import {
  evaluateExtendedMaterialDirect, STOCK_DIRECT_RADIANCE, type MaterialEvaluationGeometry,
  type StandardSurfaceInputs, type Vec3,
} from "./materialEvaluate.js";
import { DEFAULT_EXTENDED_MATERIAL_PARAMETERS } from "./materialParameters.js";
import { GOLDEN_EXPECTED, GOLDEN_RADIANCE, GOLDEN_SWATCHES, GOLDEN_VIEW_DIRECTIONS, goldenGeometry } from "./materialGoldens.js";

const PI = Math.PI;
const N: Vec3 = [0, 0, 1];
const normalize = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const LIGHT = normalize([0.45, 0.3, 0.84]);

/** 独立手写的 Cook-Torrance(与实现零共享),用于默认参数连续性锚点。 */
function inlineCookTorrance(surface: StandardSurfaceInputs, f0Scalar: number, view: Vec3, light: Vec3, radiance: Vec3): Vec3 {
  const h = normalize([view[0] + light[0], view[1] + light[1], view[2] + light[2]]);
  const nDotL = Math.max(0, light[2]), nDotV = Math.max(1e-4, view[2]);
  const nDotH = Math.min(1, Math.max(0, h[2])), vDotH = Math.min(1, Math.max(0, view[2] * h[2] + view[1] * h[1] + view[0] * h[0]));
  const rough = Math.min(1, Math.max(0.045, surface.roughness)), alpha = rough * rough;
  const metal = Math.min(1, Math.max(0, surface.metallic));
  const spec = 0;
  const f0 = surface.baseColor.map((c) => f0Scalar + (c - f0Scalar) * metal) as unknown as Vec3;
  const d = alpha * alpha / Math.max(PI * (nDotH * nDotH * (alpha * alpha - 1) + 1) ** 2, 1e-6);
  const k = (rough + 1) ** 2 / 8;
  const g = view[2] / Math.max(view[2] * (1 - k) + k, 1e-4) * (nDotL / Math.max(nDotL * (1 - k) + k, 1e-4));
  void spec;
  const fresnel = f0.map((f) => f + (1 - f) * (1 - vDotH) ** 5) as unknown as Vec3;
  const specLobe = fresnel.map((f) => d * g * f / Math.max(4 * nDotV * nDotL, 1e-4)) as unknown as Vec3;
  const diffuse = surface.baseColor.map((c, i) => (1 - fresnel[i]) * (1 - metal) * Math.max(0, c) / PI) as unknown as Vec3;
  return [0, 1, 2].map((i) => (diffuse[i] + specLobe[i]) * radiance[i] * nDotL) as unknown as Vec3;
}

/** 定向-半球反射率:单位 radiance 下 rgb 即 BRDF·cosθL,等立体角加权求和。 */
function hemisphereReflectance(
  surface: StandardSurfaceInputs, extended: Parameters<typeof evaluateExtendedMaterialDirect>[1], thetaView: number,
  nTheta = 48, nPhi = 96,
): number {
  const view: Vec3 = [Math.sin(thetaView), 0, Math.cos(thetaView)];
  let sum = 0;
  for (let i = 0; i < nTheta; i++) {
    const theta = (i + 0.5) * (PI / 2) / nTheta;
    const bandWeight = Math.cos(theta) * Math.sin(theta) * PI * PI / (nTheta * nPhi);
    for (let j = 0; j < nPhi; j++) {
      const phi = (j + 0.5) * 2 * PI / nPhi;
      const light: Vec3 = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
      const { rgb } = evaluateExtendedMaterialDirect(surface, extended, { normal: N, view, light }, [1, 1, 1]);
      sum += (rgb[0] + rgb[1] + rgb[2]) / 3 * bandWeight;
    }
  }
  return sum;
}

const GEOMETRY: MaterialEvaluationGeometry = { normal: N, view: [0, 0, 1], light: LIGHT, tangent: [1, 0, 0] };

describe("extended material CPU evaluation reference (T08 slice 1)", () => {
  it("reduces exactly to an independent Cook-Torrance when extended params are default", () => {
    const surface: StandardSurfaceInputs = { baseColor: [0.8, 0.4, 0.2], metallic: 0.35, roughness: 0.5 };
    const result = evaluateExtendedMaterialDirect(surface, DEFAULT_EXTENDED_MATERIAL_PARAMETERS, GEOMETRY);
    const expected = inlineCookTorrance(surface, 0.04, [0, 0, 1], LIGHT, STOCK_DIRECT_RADIANCE);
    for (const channel of [0, 1, 2]) expect(Math.abs(result.rgb[channel] - expected[channel])).toBeLessThan(1e-12);
  });

  it("keeps dielectric F0 anchored: 1.5 → exact 0.04, higher IOR raises the lobe", () => {
    expect(dielectricF0(1.5)).toBe(0.04);
    const surface: StandardSurfaceInputs = { baseColor: [1, 1, 1], metallic: 0, roughness: 0.25 };
    const at15 = evaluateExtendedMaterialDirect(surface, {}, GEOMETRY, [1, 1, 1]).components.specular[0];
    const at20 = evaluateExtendedMaterialDirect(surface, { ior: 2 }, GEOMETRY, [1, 1, 1]).components.specular[0];
    expect(dielectricF0(2)).toBeCloseTo((1 - 2 / 3) ** 2, 15);
    expect(at20).toBeGreaterThan(at15);
  });

  it("degrades anisotropy continuously and responds to rotation", () => {
    const surface: StandardSurfaceInputs = { baseColor: [0.9, 0.87, 0.84], metallic: 1, roughness: 0.35 };
    const isotropic = evaluateExtendedMaterialDirect(surface, {}, GEOMETRY, [1, 1, 1]).components.specular;
    const zero = evaluateExtendedMaterialDirect(surface, { anisotropy: { strength: 0, rotation: 0.7 } }, GEOMETRY, [1, 1, 1]).components.specular;
    const aniso = evaluateExtendedMaterialDirect(surface, { anisotropy: { strength: 0.8, rotation: 0 } }, GEOMETRY, [1, 1, 1]).components.specular;
    const rotated = evaluateExtendedMaterialDirect(surface, { anisotropy: { strength: 0.8, rotation: 0.9 } }, GEOMETRY, [1, 1, 1]).components.specular;
    expect(zero).toEqual(isotropic);
    expect(aniso).not.toEqual(isotropic);
    expect(rotated).not.toEqual(aniso);
  });

  it("reuses the shipped clearcoat reference verbatim for the coat layer", () => {
    const surface: StandardSurfaceInputs = { baseColor: [0.8, 0.2, 0.1], metallic: 0.2, roughness: 0.4 };
    const view: Vec3 = normalize([0.6, 0, 0.8]);
    const geometry = { ...GEOMETRY, view };
    const result = evaluateExtendedMaterialDirect(surface, { clearcoat: { factor: 0.7, roughness: 0.3 } }, geometry, [1, 1, 1]);
    const h = normalize([view[0] + LIGHT[0], LIGHT[1], view[2] + LIGHT[2]]);
    const reference = evaluateClearcoatReference({
      factor: 0.7, roughness: 0.3, nDotL: LIGHT[2], nDotV: view[2], nDotH: h[2],
      vDotH: view[0] * h[0] + view[2] * h[2],
      dfg: [0, 0] as const,
    });
    const base = inlineCookTorrance(surface, 0.04, view, LIGHT, [1, 1, 1]);
    for (const channel of [0, 1, 2]) {
      const expected = base[channel] * reference.directBaseAttenuation + reference.directLobe * LIGHT[2];
      // float64 自由实现,乘法结合顺序不同;1e-9 已排除逻辑差异。
      expect(result.rgb[channel]).toBeCloseTo(expected, 9);
    }
  });

  it("models thin-wall transmission: dielectric-only lobe, monotonic in factor", () => {
    const glass: StandardSurfaceInputs = { baseColor: [0.92, 0.95, 0.97], metallic: 0, roughness: 0.35 };
    const metal: StandardSurfaceInputs = { ...glass, metallic: 1 };
    expect(evaluateExtendedMaterialDirect(glass, { transmission: { factor: 1 } }, GEOMETRY, [1, 1, 1]).components.transmission
      .every((value) => value > 0)).toBe(true);
    expect(evaluateExtendedMaterialDirect(metal, { transmission: { factor: 1 } }, GEOMETRY, [1, 1, 1]).components.transmission
      .every((value) => value === 0)).toBe(true);
    expect(evaluateExtendedMaterialDirect(glass, {}, GEOMETRY, [1, 1, 1]).components.transmission
      .every((value) => value === 0)).toBe(true);
    const weak = evaluateExtendedMaterialDirect(glass, { transmission: { factor: 0.25 } }, GEOMETRY, [1, 1, 1]).components.transmission[0];
    const strong = evaluateExtendedMaterialDirect(glass, { transmission: { factor: 0.75 } }, GEOMETRY, [1, 1, 1]).components.transmission[0];
    expect(strong).toBeGreaterThan(weak);
  });

  it("conserves energy: directional-hemispherical reflectance stays ≤1 across a view-angle grid", () => {
    const configs: readonly (readonly [string, Parameters<typeof evaluateExtendedMaterialDirect>[1], StandardSurfaceInputs])[] = [
      ["dielectric-r0.045", {}, { baseColor: [1, 1, 1], metallic: 0, roughness: 0.045 }],
      ["dielectric-r1.0", {}, { baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
      ["metal-r0.045", {}, { baseColor: [0.9, 0.87, 0.84], metallic: 1, roughness: 0.045 }],
      ["metal-r1.0", {}, { baseColor: [0.9, 0.87, 0.84], metallic: 1, roughness: 1 }],
      ["clearcoat", { clearcoat: { factor: 1, roughness: 0.5 } }, { baseColor: [0.8, 0.2, 0.1], metallic: 0.2, roughness: 0.4 }],
      ["anisotropy", { anisotropy: { strength: 1, rotation: 1.2 } }, { baseColor: [0.9, 0.87, 0.84], metallic: 1, roughness: 0.35 }],
      ["glass-half", { transmission: { factor: 0.5 } }, { baseColor: [1, 1, 1], metallic: 0, roughness: 0.35 }],
      ["glass-full", { transmission: { factor: 1 }, ior: 1.52 }, { baseColor: [1, 1, 1], metallic: 0, roughness: 0.35 }],
      ["full-stack", { clearcoat: { factor: 0.7, roughness: 0.3 }, anisotropy: { strength: 0.6, rotation: 0.4 }, transmission: { factor: 0.4 } },
        { baseColor: [0.9, 0.9, 0.9], metallic: 0.1, roughness: 0.3 }],
    ];
    for (const [name, extended, surface] of configs) {
      let max = 0;
      for (const degrees of [0, 15, 30, 45, 60, 75, 85]) {
        max = Math.max(max, hemisphereReflectance(surface, extended, degrees * PI / 180));
      }
      expect(max).toBeLessThanOrEqual(1 + 1e-3);
      if (name === "full-stack") expect(max).toBeLessThan(0.8);
    }
  }, 20_000);

  it("matches the frozen linear-swatch golden table within one 1/255 quantum", () => {
    expect(GOLDEN_EXPECTED).toHaveLength(GOLDEN_SWATCHES.length * GOLDEN_VIEW_DIRECTIONS.length);
    for (const row of GOLDEN_EXPECTED) {
      const swatch = GOLDEN_SWATCHES.find((entry) => entry.id === row.swatch)!;
      const view = GOLDEN_VIEW_DIRECTIONS.find((entry) => entry.label === row.view)!.view;
      const { components } = evaluateExtendedMaterialDirect(swatch.surface, swatch.extended, goldenGeometry(view), GOLDEN_RADIANCE);
      const quantized = [...components.diffuse, ...components.specular, ...components.clearcoat, ...components.transmission]
        .map((value) => Math.round(value * 255));
      quantized.forEach((value, index) => expect(Math.abs(value - row.quantized[index]!)).toBeLessThanOrEqual(1));
    }
  });

  it("keeps component decomposition exact: the four lobes sum to rgb", () => {
    const surface: StandardSurfaceInputs = { baseColor: [0.5, 0.6, 0.7], metallic: 0.3, roughness: 0.45 };
    const extended = { clearcoat: { factor: 0.6, roughness: 0.3 }, transmission: { factor: 0.5 }, anisotropy: { strength: 0.4, rotation: 0.2 } };
    const { rgb, components } = evaluateExtendedMaterialDirect(surface, extended, GEOMETRY);
    for (const channel of [0, 1, 2]) {
      const sum = components.diffuse[channel]! + components.specular[channel]! + components.clearcoat[channel]! + components.transmission[channel]!;
      expect(Math.abs(sum - rgb[channel]!)).toBeLessThan(1e-12);
    }
  });

  it("anchors analytic closed forms: Lambert band and normal-incidence specular", () => {
    const surface: StandardSurfaceInputs = { baseColor: [1, 1, 1], metallic: 0, roughness: 0.5 };
    const { components } = evaluateExtendedMaterialDirect(surface, {}, GEOMETRY, [1, 1, 1]);
    const h = normalize([LIGHT[0], LIGHT[1], 1 + LIGHT[2]]);
    const fresnel = 0.04 + 0.96 * (1 - h[2]) ** 5;
    expect(components.diffuse[0]).toBeCloseTo((1 - fresnel) / PI * LIGHT[2], 12);
    const alpha = 0.25;
    const d = alpha ** 2 / (PI * (h[2] ** 2 * (alpha ** 2 - 1) + 1) ** 2);
    const k = 1.5 ** 2 / 8;
    const g = 1 / Math.max(1 * (1 - k) + k, 1e-4) * (LIGHT[2] / Math.max(LIGHT[2] * (1 - k) + k, 1e-4));
    // components 已含 lit 因子 radiance·nDotL。
    expect(components.specular[0]).toBeCloseTo(d * g * fresnel * LIGHT[2] / Math.max(4 * 1 * LIGHT[2], 1e-4), 12);
  });
});
