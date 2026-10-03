import { expect, it } from "vitest";
import { createReferenceRng } from "../lighting/probeReferenceScene.js";
import { evaluateMetalReflectionDirect } from "./materialMetalReflectionEvaluate.js";
import type { Vec3 } from "./materialEvaluate.js";
const unit = (v: readonly number[]): Vec3 => v.map(x => x / Math.hypot(...v)) as unknown as Vec3;
const dot = (a: Vec3, b: Vec3) => a.reduce((sum, x, i) => sum + x * b[i]!, 0);
const surface = { baseColor: [.8, .4, .1] as const, metallic: 1, roughness: .35 };
const view = unit([.4, .2, .9]), angle = Math.fround(.4), alpha = surface.roughness ** 2;
const ax = 2 * alpha, ay = alpha, tr: Vec3 = [Math.cos(angle), Math.sin(angle), 0], br: Vec3 = [-tr[1], tr[0], 0];
// NDF + cosine mixture is intentionally independent test integration, not an added renderer.
function sample(rng: () => number): Vec3 | undefined {
  const branch = rng() < .5, u = rng(), phi = 2 * Math.PI * rng();
  if (branch) {
    const r = Math.sqrt(u / (1 - u));
    const h = unit([tr[0] * ax * r * Math.cos(phi) + br[0] * ay * r * Math.sin(phi),
      tr[1] * ax * r * Math.cos(phi) + br[1] * ay * r * Math.sin(phi), 1]);
    const vh = dot(view, h); if (vh <= 0) return undefined;
    const light = view.map((v, i) => 2 * vh * h[i]! - v) as unknown as Vec3;
    return light[2] <= 0 ? undefined : light;
  }
  const r = Math.sqrt(u);
  return [r * Math.cos(phi), r * Math.sin(phi), Math.sqrt(1 - u)];
}
it("replays 65536 joint-PDF samples and converges against independent dOmega integration", () => {
  const rng = createReferenceRng(1976), replay = createReferenceRng(1976), sum = [0, 0, 0], squares = [0, 0, 0];
  let nulls = 0;
  for (let i = 0; i < 65536; i++) {
    const light = sample(rng); expect(light).toEqual(sample(replay));
    if (!light) { nulls++; continue; } // Null reflections contribute zero; no re-sampling.
    const h = unit(view.map((v, c) => v + light[c]!));
    const localH = [dot(tr, h), dot(br, h), h[2]], vh = dot(view, h);
    const ndf = 1 / (Math.PI * ax * ay * ((localH[0]! / ax) ** 2 + (localH[1]! / ay) ** 2 + localH[2]! ** 2) ** 2);
    const pdf = .5 * light[2] / Math.PI + .5 * ndf * h[2] / (4 * vh);
    expect(pdf).toBeGreaterThan(0);
    const rgb = evaluateMetalReflectionDirect(surface, { anisotropy: { strength: 1, rotation: angle } },
      { normal: [0, 0, 1], tangent: [1, 0, 0], view, light }).rgb;
    rgb.forEach((x, c) => { const weight = x / pdf; expect(Number.isFinite(weight)).toBe(true); sum[c]! += weight; squares[c]! += weight * weight; });
  }
  expect(nulls).toBeGreaterThan(0);
  const dense = [0, 0, 0], nz = 128, np = 256, dw = 2 * Math.PI / (nz * np);
  for (let z = 0; z < nz; z++) for (let phi = 0; phi < np; phi++) {
    const u = (z + .5) / nz, r = Math.sqrt(1 - u * u), p = 2 * Math.PI * (phi + .5) / np;
    const rgb = evaluateMetalReflectionDirect(surface, { anisotropy: { strength: 1, rotation: angle } },
      { normal: [0, 0, 1], tangent: [1, 0, 0], view, light: [r * Math.cos(p), r * Math.sin(p), u] }).rgb;
    rgb.forEach((x, c) => { dense[c]! += x * dw; });
  }
  sum.forEach((x, c) => {
    const mean = x / 65536, se = Math.sqrt(Math.max(0, squares[c]! / 65536 - mean * mean) / 65536);
    expect(Math.abs(mean - dense[c]!)).toBeLessThan(6 * se + 1e-4);
    expect(dense[c]).toBeLessThan(1);
  });
});
