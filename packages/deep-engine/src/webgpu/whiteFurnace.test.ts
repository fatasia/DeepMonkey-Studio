import { describe, expect, it } from "vitest";
import { analyzeFurnaceFrame, decodeFurnaceColor, evaluateFurnaceChecks, evaluateSsrToggleChecks,
  furnaceSphereSegmentation, packFurnaceSphere, predictedFurnaceOvershoot, uniformFurnaceEquirect,
  FURNACE_TOLERANCES, WHITE_FURNACE_ENVIRONMENT_RADIANCE } from "./whiteFurnace.js";

const E = WHITE_FURNACE_ENVIRONMENT_RADIANCE;

function rgba16FloatFrame(width: number, height: number,
  sample: (x: number, y: number) => readonly [number, number, number]): {
  readonly width: number; readonly height: number; readonly bytesPerRow: number;
  readonly format: "rgba16float"; readonly bytes: Uint8Array } {
  const half = (value: number): number => {
    const buffer = new ArrayBuffer(2);
    new DataView(buffer).setFloat16(0, value, true);
    return new Uint16Array(buffer)[0]!;
  };
  const bytesPerRow = width * 8;
  const bytes = new Uint8Array(bytesPerRow * height);
  const words = new Uint16Array(bytes.buffer);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = sample(x, y), base = y * bytesPerRow / 2 + x * 4;
    words[base] = half(r); words[base + 1] = half(g); words[base + 2] = half(b); words[base + 3] = 1;
  }
  return { width, height, bytesPerRow, format: "rgba16float", bytes };
}

describe("uniformFurnaceEquirect", () => {
  it("produces a uniform gray equirect at the requested radiance", () => {
    const image = uniformFurnaceEquirect(0.25, 16, 8);
    expect(image.width).toBe(16);
    expect(image.data.length).toBe(16 * 8 * 3);
    expect(image.data.every(value => value === 0.25)).toBe(true);
  });

  it("rejects non-finite or non-positive radiance", () => {
    expect(() => uniformFurnaceEquirect(0)).toThrow(RangeError);
    expect(() => uniformFurnaceEquirect(Number.NaN)).toThrow(RangeError);
  });
});

describe("packFurnaceSphere", () => {
  it("packs the 12-float sphere layout with white lambertian defaults", () => {
    const data = packFurnaceSphere([{ position: [1, 2, 3], radius: 0.5 }]);
    expect(data).toEqual(new Float32Array([1, 2, 3, 0.5, 1, 1, 1, 0, 1, 0, 0, 0]));
  });

  it("rejects non-positive radii", () => {
    expect(() => packFurnaceSphere([{ position: [0, 0, 0], radius: 0 }])).toThrow(RangeError);
  });
});

describe("furnaceSphereSegmentation", () => {
  it("classifies center as geometry, corners as background, and guards a hard-edge ring", () => {
    const regionOf = furnaceSphereSegmentation(64, 64, 5, 1.7, Math.PI / 4);
    expect(regionOf[32 * 64 + 32]).toBe(0);
    expect(regionOf[0]).toBe(1);
    const ring = regionOf.filter(value => value === 2).length;
    expect(ring).toBeGreaterThan(0);
  });
});

describe("analyzeFurnaceFrame", () => {
  it("reports zero error for an exactly uniform furnace frame", () => {
    const snapshot = rgba16FloatFrame(8, 8, () => [E, E, E]);
    const analysis = analyzeFurnaceFrame(decodeFurnaceColor(snapshot), E, undefined, "background");
    expect(analysis.background.meanRelativeError).toBe(0);
    expect(analysis.background.pixels).toBe(64);
    expect(evaluateFurnaceChecks(analysis).every(check => check.passed)).toBe(true);
  });

  it("separates geometry and background domains and skips the excluded ring", () => {
    const regionOf = furnaceSphereSegmentation(8, 8, 5, 1.5, Math.PI / 4);
    const snapshot = rgba16FloatFrame(8, 8, (x, y) => regionOf[y * 8 + x] === 1 ? [E, E, E] : [E * 1.3, E * 1.3, E * 1.3]);
    const analysis = analyzeFurnaceFrame(decodeFurnaceColor(snapshot), E, regionOf, "geometry");
    expect(analysis.background.meanRadiance).toBeCloseTo(E, 5);
    expect(analysis.geometry!.meanRelativeError).toBeGreaterThan(0.2);
    expect(analysis.geometry!.pixels).toBeGreaterThan(0);
  });

  it("detects chroma drift through channel gains", () => {
    const snapshot = rgba16FloatFrame(4, 4, () => [E * 1.1, E, E]);
    const analysis = analyzeFurnaceFrame(decodeFurnaceColor(snapshot), E, undefined, "background");
    expect(analysis.background.channelGain[0]).toBeGreaterThan(1.05);
    const chromaCheck = evaluateFurnaceChecks(analysis).find(check => check.name === "furnace-background-no-chroma-drift");
    expect(chromaCheck?.passed).toBe(false);
  });

  it("fails closed when every region is excluded (empty frame)", () => {
    const regionOf = new Array<number>(16 * 16).fill(2);
    const snapshot = rgba16FloatFrame(16, 16, () => [E, E, E]);
    const analysis = analyzeFurnaceFrame(decodeFurnaceColor(snapshot), E, regionOf, "geometry");
    const nonempty = evaluateFurnaceChecks(analysis).find(check => check.name === "furnace-frame-nonempty");
    expect(nonempty?.passed).toBe(false);
  });

  it("asserts only the domains a leg declares", () => {
    const snapshot = rgba16FloatFrame(4, 4, () => [E, E, E]);
    const backgroundAnalysis = analyzeFurnaceFrame(decodeFurnaceColor(snapshot), E, undefined, "background");
    expect(evaluateFurnaceChecks(backgroundAnalysis).every(check => check.passed)).toBe(true);
    const boxAnalysis = analyzeFurnaceFrame(decodeFurnaceColor(snapshot), E, undefined, "geometry");
    expect(evaluateFurnaceChecks(boxAnalysis).every(check => check.passed)).toBe(true);
  });
});

describe("evaluateSsrToggleChecks", () => {
  it("passes for identical frames and honors the excluded ring", () => {
    const regionOf = furnaceSphereSegmentation(4, 4, 5, 2.5, Math.PI / 4);
    const frame = rgba16FloatFrame(4, 4, () => [E, E, E]);
    const pixels = decodeFurnaceColor(frame);
    const checks = evaluateSsrToggleChecks(pixels, pixels, E, regionOf);
    expect(checks[0]!.passed).toBe(true);
  });

  it("fails when the toggle shifts pixel energy beyond tolerance", () => {
    const on = rgba16FloatFrame(4, 4, () => [E * 1.05, E * 1.05, E * 1.05]);
    const off = rgba16FloatFrame(4, 4, () => [E, E, E]);
    const checks = evaluateSsrToggleChecks(decodeFurnaceColor(on), decodeFurnaceColor(off), E, undefined);
    expect(checks[0]!.passed).toBe(false);
  });

  it("requires identical frame sizes", () => {
    const small = rgba16FloatFrame(4, 4, () => [E, E, E]);
    const large = rgba16FloatFrame(8, 4, () => [E, E, E]);
    expect(() => evaluateSsrToggleChecks(decodeFurnaceColor(small), decodeFurnaceColor(large), E, undefined)).toThrow();
  });
});

describe("predictedFurnaceOvershoot", () => {
  it("predicts a large overshoot for rough dielectrics (the defect C12 hunts)", () => {
    const overshoot = predictedFurnaceOvershoot(0.04, 1, 0.7, [0.35, 0.25]);
    expect(overshoot).toBeGreaterThan(0.1);
  });

  it("predicts near-zero overshoot for smooth mirrors at normal incidence", () => {
    const overshoot = predictedFurnaceOvershoot(0.04, 0.001, 1, [1, 0]);
    expect(Math.abs(overshoot)).toBeLessThan(FURNACE_TOLERANCES.channelGainDrift);
  });

  it("validates its inputs", () => {
    expect(() => predictedFurnaceOvershoot(Number.NaN, 1, 0.5, [0, 0])).toThrow(RangeError);
  });
});
