import { describe, expect, it } from "vitest";
import { megaLightsExhaustiveReferenceCpu, megaLightsFrameCpu, rmse } from "./megaLightsRisCpu.js";

const W = 8, H = 8, PIXELS = W * H;
function scene(frame: number, count: number, moving: number) {
  const lights = Array.from({ length: count }, (_, index) => {
    const angle = index * 2.399963229728653;
    const radius = 2 + (index % 7) * 0.9;
    const isMoving = index < moving;
    const orbit = isMoving ? angle + frame * 0.04 : angle;
    return { kind: "point" as const,
      positionView: [Math.cos(orbit) * radius, Math.sin(orbit) * radius, 2 + (index % 3)],
      range: 0, color: [1, 0.95 - (index % 4) * 0.1, 0.9 - (index % 3) * 0.15],
      intensity: 0.6 + (index % 5) * 0.5, decay: 2 };
  });
  const surfaces = Array.from({ length: PIXELS }, (_, pixel) => {
    const x = pixel % W, y = Math.floor(pixel / W);
    return [[(x - (W - 1) / 2) * 0.4, (y - (H - 1) / 2) * 0.4, -3.5, 0], [0, 0, 1, 0.5], [0.8, 0.8, 0.8, 0]];
  });
  return { lights, surfaces };
}
function means(color: Float32Array) {
  const out: number[] = [];
  for (let p = 0; p < PIXELS; p++) out.push((color[p * 3]! + color[p * 3 + 1]! + color[p * 3 + 2]!) / 3);
  return out;
}

describe("bisect", () => {
  it("multi-seed bias separation", () => {
    for (const config of [
      { temporal: false, spatial: false },
      { temporal: false, spatial: true },
      { temporal: true, spatial: true },
    ]) {
      const rels: number[] = [];
      for (let seedFrame = 0; seedFrame < 6; seedFrame++) {
        const sc = scene(7 + seedFrame * 100, 5000, 0);
        const reference = megaLightsExhaustiveReferenceCpu(sc.lights, sc.surfaces, W, H);
        const refMeans = means(reference);
        const energy = refMeans.reduce((a, b) => a + b, 0) / PIXELS;
        let previous: ReturnType<typeof megaLightsFrameCpu> | undefined;
        let output = previous;
        for (let frame = 0; frame < 64; frame++) {
          output = megaLightsFrameCpu({ lights: sc.lights, surfaces: sc.surfaces, frame,
            previous: previous?.reservoirs, previousColor: previous?.color,
            config: { width: W, height: H, ...config, alphaBlend: frame === 0 ? 1 : 1 / 32 } });
          previous = output;
        }
        rels.push(rmse(means(output!.color), refMeans) / energy * 100);
      }
      const mean = rels.reduce((a, b) => a + b, 0) / rels.length;
      console.log(`config=${JSON.stringify(config)} relRMSE per-seed=[${rels.map(v => v.toFixed(2)).join(",")}] mean=${mean.toFixed(2)}%`);
    }
    expect(1).toBe(1);
  });
});
