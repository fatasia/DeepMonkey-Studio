import { expect, it } from "vitest";
import { evaluateMetalReflectionDirect } from "./materialMetalReflectionEvaluate.js";
import type { Vec3 } from "./materialEvaluate.js";
const n: Vec3 = [0, 0, 1], t: Vec3 = [1, 0, 0];
const direction = (degrees: number, azimuth = 0): Vec3 => {
  const theta = degrees * Math.PI / 180;
  return [Math.sin(theta) * Math.cos(azimuth), Math.sin(theta) * Math.sin(azimuth), Math.cos(theta)];
};
/** Independent local-coordinate NDF + Lambda G2 reference, unlike the production stable visibility expression. */
function oracle(roughness: number, strength: number, rotation: number, view: Vec3, light: Vec3) {
  const alpha = Math.max(.045, roughness) ** 2, ax = alpha * (1 + Math.fround(strength)), ay = alpha;
  const c = Math.cos(Math.fround(rotation)), s = Math.sin(Math.fround(rotation));
  const local = (w: Vec3): Vec3 => [c * w[0] + s * w[1], -s * w[0] + c * w[1], w[2]];
  const sum = view.map((x, i) => x + light[i]!) as unknown as Vec3, length = Math.hypot(...sum);
  const h = local(sum.map(x => x / length) as unknown as Vec3), v = local(view), l = local(light);
  const distribution = 1 / (Math.PI * ax * ay * ((h[0] / ax) ** 2 + (h[1] / ay) ** 2 + h[2] ** 2) ** 2);
  const lambda = (w: Vec3) => (Math.sqrt(1 + ((ax * w[0]) ** 2 + (ay * w[1]) ** 2) / w[2] ** 2) - 1) / 2;
  const g = 1 / (1 + lambda(v) + lambda(l));
  const vh = view.reduce((a, x, i) => a + x * sum[i]! / length, 0);
  return [.8, .4, .1].map(f0 => (f0 + (1 - f0) * (1 - vh) ** 5) * distribution * g / (4 * view[2]));
}
it("matches independent NDF/Lambda at 675 geometry/roughness/strength cases", () => {
  let count = 0;
  for (const roughness of [.045, .1, .35, .7, 1]) for (const strength of [0, 1e-7, 1])
    for (const angle of [0, 30, 60, 85, 89]) for (const la of [0, 40, 80]) for (const az of [0, .8, 2.3]) {
      const view = direction(angle), light = direction(la, az);
      const rgb = evaluateMetalReflectionDirect({ baseColor: [.8, .4, .1], metallic: 1, roughness },
        { anisotropy: { strength, rotation: .4 } }, { normal: n, tangent: t, view, light }).rgb;
      oracle(roughness, strength, .4, view, light).forEach((value, i) => expect(Math.abs(rgb[i]! - value) / Math.max(1, Math.abs(value))).toBeLessThan(2e-12)); count++;
    }
  expect(count).toBe(675);
});
it("is continuous at strength zero within the explicit model and reciprocal at grazing angles", () => {
  for (const roughness of [.045, .35, 1]) for (const angle of [0, 60, 85, 89]) {
    const surface = { baseColor: [.8, .4, .1] as const, metallic: 1, roughness };
    const view = direction(angle), light = direction(70, 1.2), geometry = { normal: n, tangent: t, view, light };
    const zero = evaluateMetalReflectionDirect(surface, {}, geometry).rgb;
    const epsilon = evaluateMetalReflectionDirect(surface, { anisotropy: { strength: 1e-7 } }, geometry).rgb;
    const reverse = evaluateMetalReflectionDirect(surface, {}, { ...geometry, view: light, light: view }).rgb;
    zero.forEach((value, i) => {
      expect(Math.abs(epsilon[i]! - value) / Math.max(1, value)).toBeLessThan(1e-6);
      expect(Math.abs(value / light[2] - reverse[i]! / view[2]) / Math.max(1, value / light[2])).toBeLessThan(1e-12);
    });
  }
});
it("uses the correct dOmega integral, including the negative extra-cos control", () => {
  const view = direction(85); let correct = 0, wrong = 0;
  const nu = 128, np = 256, dOmega = 2 * Math.PI / (nu * np);
  for (let u = 0; u < nu; u++) for (let p = 0; p < np; p++) {
    const z = (u + .5) / nu, r = Math.sqrt(1 - z * z), phi = 2 * Math.PI * (p + .5) / np;
    const rgb = evaluateMetalReflectionDirect({ baseColor: [1, 1, 1], metallic: 1, roughness: .35 },
      { anisotropy: { strength: 1, rotation: .4 } }, { normal: n, tangent: t, view, light: [r * Math.cos(phi), r * Math.sin(phi), z] }).rgb;
    correct += rgb[0] * dOmega; wrong += rgb[0] * z * dOmega;
  }
  expect(correct).toBeGreaterThan(.65); expect(correct).toBeLessThan(1);
  expect(wrong).toBeLessThan(correct * .65);
});
