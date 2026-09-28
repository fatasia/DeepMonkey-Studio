import { describe, expect, it } from "vitest";
import {
  DEFAULT_PBR_AUTO_EXPOSURE, MAX_PBR_AUTO_EXPOSURE_EV_ENVELOPE, PbrAutoExposureRuntime,
  estimateEnvironmentLuminance, resolvePbrAutoExposureOptions, targetExposureFromLuminance,
  type PbrAutoExposureOptions,
} from "./pbrAutoExposure.js";
import type { PbrEnvironmentSource } from "./pbrEnvironmentSource.js";
import type { RadianceHdrImage } from "../textures/radianceHdr.js";
import type { RuntimePrefilteredIbl, RuntimeIblMip } from "../runtimePackage/environmentTypes.js";

/** f32 → f16(bit pattern);夹具亮度都在 [2^-14, 65504] 或精确 0,无次正规。 */
function encodeHalf(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value);
  const bits = view.getUint32(0), sign = (bits >>> 16) & 0x8000;
  const exponentBits = (bits >>> 23) & 0xff, fraction = bits & 0x7fffff;
  if (exponentBits === 0xff) return sign | 0x7c00;
  const unbiased = exponentBits - 127;
  if (unbiased > 15) return sign | 0x7c00;
  if (unbiased >= -14) return sign | ((unbiased + 15) << 10) | (fraction >>> 13);
  return sign;
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

/** rgba16float 立方体贴图 mip:faces(px..nz)×size×size,rgb 通道取同值灰度,alpha=1。 */
function grayCubeMipBase64(size: number, gray: number): string {
  const bytes = new Uint8Array(size * size * 6 * 8);
  const words = new Uint16Array(bytes.buffer);
  for (let index = 0; index < words.length; index += 4) {
    words[index] = encodeHalf(gray); words[index + 1] = encodeHalf(gray);
    words[index + 2] = encodeHalf(gray); words[index + 3] = encodeHalf(1);
  }
  return toBase64(bytes);
}

const prefilteredIbl = (mips: readonly RuntimeIblMip[]): PbrEnvironmentSource => ({
  kind: "prefiltered-ibl", environment: {
    schema: "deep-engine.ibl-prefiltered", schemaVersion: 1, id: "fixture", revision: 1,
    kind: "prefiltered-hdri", format: "rgba16float", encoding: "base64-le",
    faceOrder: "px-nx-py-ny-pz-nz",
    source: { contentHash: { algorithm: "sha256", hash: "0".repeat(64) }, license: "test" },
    specular: { mips }, diffuse: { mips: [mips[0]!] }, brdfLut: { width: 4, height: 4, dataBase64: "" },
  } satisfies RuntimePrefilteredIbl,
});

const hdrImage = (width: number, height: number, fill: (x: number, y: number) => readonly [number, number, number]): RadianceHdrImage => {
  const data = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b] = fill(x, y);
    const offset = (y * width + x) * 3;
    data[offset] = r; data[offset + 1] = g; data[offset + 2] = b;
  }
  return { width, height, data };
};

/** 等距柱状纬度权重下,下半球常亮 c 的平均亮度精确 = c/2(行权重上下对称)。 */
function halfSphereImage(height = 8, width = 16, gray = 1): RadianceHdrImage {
  return hdrImage(width, height, (_x, y) => y >= height / 2 ? [gray, gray, gray] : [0, 0, 0]);
}

const FRAME_MS = 1000 / 60;
const advanceFrames = (runtime: PbrAutoExposureRuntime, count: number, startMs = 0,
  snap = false): readonly number[] => {
  const exposures: number[] = [];
  for (let index = 0; index < count; index++) {
    const frame = runtime.advance(startMs + index * FRAME_MS, snap);
    if (frame === undefined) throw new Error("fixture environment must yield an estimate");
    exposures.push(frame.exposure);
  }
  return exposures;
};

describe("PBR auto exposure configuration gate", () => {
  it("keeps shipped defaults when unconfigured", () => {
    expect(resolvePbrAutoExposureOptions()).toEqual({
      adaptationTimeConstantSeconds: 0.35, maxEvPerSecond: 4, evEnvelope: 2,
      middleGrey: 0.18, sceneExposureBias: 1,
    });
  });
  it.each([-1, 0, NaN, Infinity, "0.5" as unknown as number])(
    "fails closed to defaults for invalid option %s", invalid => {
      const options: PbrAutoExposureOptions = {
        adaptationTimeConstantSeconds: invalid, maxEvPerSecond: invalid,
        evEnvelope: invalid, middleGrey: invalid, sceneExposureBias: invalid,
      };
      expect(resolvePbrAutoExposureOptions(options)).toEqual(resolvePbrAutoExposureOptions());
    });
  it(`caps the EV envelope at ${MAX_PBR_AUTO_EXPOSURE_EV_ENVELOPE} and accepts values within it`, () => {
    expect(resolvePbrAutoExposureOptions({ evEnvelope: 9 }).evEnvelope).toBe(2);
    expect(resolvePbrAutoExposureOptions({ evEnvelope: 4 }).evEnvelope).toBe(4);
  });
});

describe("PBR auto exposure target from environment luminance", () => {
  // ACES 拟合前 /0.6:middle grey 0.18 → exposure = 0.108 / L。
  it("maps the middle-grey luminance to unity exposure", () => {
    expect(targetExposureFromLuminance(0.108)).toBeCloseTo(1, 7);
  });
  it("clamps to the ±2 EV envelope on both ends", () => {
    expect(targetExposureFromLuminance(0.108 / 8)).toBe(4);
    expect(targetExposureFromLuminance(0.108 * 8)).toBe(0.25);
    expect(targetExposureFromLuminance(0.108 / 4)).toBeCloseTo(4, 12);
    expect(targetExposureFromLuminance(0.108 * 4)).toBeCloseTo(0.25, 12);
    expect(targetExposureFromLuminance(0.108 / 2)).toBeCloseTo(2, 7);
  });
  it("applies the scene exposure bias inside the envelope", () => {
    expect(targetExposureFromLuminance(0.108, { sceneExposureBias: 2 })).toBeCloseTo(2, 7);
    expect(targetExposureFromLuminance(0.108 / 4, { sceneExposureBias: 2 })).toBe(4);
  });
});

describe("PBR auto exposure environment luminance estimation", () => {
  it("fails closed without a source and for the GPU-procedural studio environment", () => {
    expect(estimateEnvironmentLuminance(undefined)).toEqual({
      status: "unavailable", reason: "no-environment-source" });
    expect(estimateEnvironmentLuminance({ kind: "studio" })).toEqual({
      status: "unavailable", reason: "studio-environment-is-gpu-procedural" });
  });
  it("estimates a uniform equirectangular HDR at its constant luminance", () => {
    const outcome = estimateEnvironmentLuminance({
      kind: "radiance-hdr", image: hdrImage(300, 200, () => [0.25, 0.5, 0.25]) });
    expect(outcome.status).toBe("estimated");
    if (outcome.status !== "estimated") return;
    expect(outcome.estimate.provenance).toBe("radiance-hdr");
    expect(outcome.estimate.luminance).toBeCloseTo(0.2126 * 0.25 + 0.7152 * 0.5 + 0.0722 * 0.25, 12);
  });
  it("weights equirectangular rows by solid angle (half-lit sphere reads half)", () => {
    const outcome = estimateEnvironmentLuminance({ kind: "radiance-hdr", image: halfSphereImage() });
    expect(outcome.status).toBe("estimated");
    if (outcome.status !== "estimated") return;
    expect(outcome.estimate.luminance).toBeCloseTo(0.5, 10);
  });
  it.each([
    { name: "shape-invalid", image: { width: 0, height: 8, data: new Float32Array(24) } },
    { name: "shape-invalid", image: { width: 8, height: 8, data: new Float32Array(8) } },
    { name: "texel-invalid", image: { width: 2, height: 2,
      data: new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, -1, 0, 0]) } },
  ])("rejects $name radiance HDR fixtures", ({ image }) => {
    const outcome = estimateEnvironmentLuminance({ kind: "radiance-hdr", image: image as RadianceHdrImage });
    expect(outcome.status).toBe("unavailable");
  });
  it("estimates the coarsest prefiltered specular mip (static average proxy)", () => {
    const outcome = estimateEnvironmentLuminance(prefilteredIbl([
      { size: 2, dataBase64: grayCubeMipBase64(2, 1) },
      { size: 1, dataBase64: grayCubeMipBase64(1, 0.25) },
    ]));
    expect(outcome.status).toBe("estimated");
    if (outcome.status !== "estimated") return;
    expect(outcome.estimate.provenance).toBe("prefiltered-ibl-mip");
    expect(outcome.estimate.luminance).toBeCloseTo(0.25, 10);
  });
  it("fails closed on undecodable mip bytes and empty mip chains", () => {
    const broken = estimateEnvironmentLuminance(prefilteredIbl([
      { size: 1, dataBase64: "!!not-base64!!" }]));
    expect(broken.status).toBe("unavailable");
    if (broken.status !== "unavailable") return;
    expect(broken.reason).toContain("mip-decode-failed");
    expect(estimateEnvironmentLuminance(prefilteredIbl([])).status).toBe("unavailable");
  });
});

describe("PBR auto exposure smoothing runtime", () => {
  it("fails closed to the caller exposure when no luminance source exists", () => {
    const runtime = new PbrAutoExposureRuntime({}, { kind: "studio" });
    expect(runtime.advance(0, false)).toBeUndefined();
    expect(runtime.metrics()).toMatchObject({ active: false,
      fallbackReason: "studio-environment-is-gpu-procedural" });
  });
  it("seeds the first frame directly at the target exposure", () => {
    const runtime = new PbrAutoExposureRuntime({}, { kind: "radiance-hdr",
      image: hdrImage(4, 4, () => [0.108, 0.108, 0.108]) });
    const frame = runtime.advance(0, false);
    expect(frame?.exposure).toBeCloseTo(1, 7);
    expect(frame?.targetExposure).toBeCloseTo(1, 7);
  });
  it("converges monotonically without overshoot or oscillation", () => {
    const runtime = new PbrAutoExposureRuntime({ adaptationTimeConstantSeconds: 0.35 }, {
      kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.108, 0.108, 0.108]) });
    expect(advanceFrames(runtime, 1)[0]).toBeCloseTo(1, 7);
    runtime.observeSource({ kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.054, 0.054, 0.054]) });
    let previous = 1;
    for (const exposure of advanceFrames(runtime, 240, FRAME_MS)) {
      expect(exposure).toBeGreaterThan(previous - 1e-12);
      expect(exposure).toBeLessThanOrEqual(2 + 1e-12);
      previous = exposure;
    }
    expect(previous).toBeCloseTo(2, 3);
  });
  it("caps the per-frame EV change rate to prevent flicker", () => {
    const runtime = new PbrAutoExposureRuntime({ adaptationTimeConstantSeconds: 0.001, maxEvPerSecond: 4 }, {
      kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.108, 0.108, 0.108]) });
    expect(advanceFrames(runtime, 1)[0]).toBeCloseTo(1, 7);
    runtime.observeSource({ kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.054, 0.054, 0.054]) });
    const stepMs = 10;
    let previous = 1;
    for (let index = 0; index < 50; index++) {
      const exposure = runtime.advance(index * stepMs + stepMs, false)!.exposure;
      const evDelta = Math.abs(Math.log2(exposure) - Math.log2(previous));
      expect(evDelta).toBeLessThanOrEqual(4 * stepMs / 1000 + 1e-9);
      previous = exposure;
    }
    expect(previous).toBeCloseTo(2, 2);
  });
  it("snaps to the target after a camera cut and stays put when time stalls", () => {
    const runtime = new PbrAutoExposureRuntime({}, {
      kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.216, 0.216, 0.216]) });
    expect(runtime.advance(0, false)!.exposure).toBeCloseTo(0.5, 7);
    runtime.observeSource({ kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.054, 0.054, 0.054]) });
    expect(runtime.advance(16, true)!.exposure).toBeCloseTo(2, 6);
    expect(runtime.advance(4, false)!.exposure).toBeCloseTo(2, 6);
    expect(Number.isFinite(runtime.advance(Number.NaN, false)!.exposure)).toBe(true);
  });
  it("recovers to active after a fail-closed source and republishes telemetry", () => {
    const runtime = new PbrAutoExposureRuntime({}, { kind: "studio" });
    runtime.observeSource({ kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.108, 0.108, 0.108]) });
    const frame = runtime.advance(0, false);
    expect(frame).toBeDefined();
    expect(runtime.metrics()).toMatchObject({ active: true, provenance: "radiance-hdr",
      evEnvelope: [0.25, 4], adaptationTimeConstantSeconds: DEFAULT_PBR_AUTO_EXPOSURE.adaptationTimeConstantSeconds });
  });
  it("keeps smoothing across a staged environment change instead of snapping", () => {
    const runtime = new PbrAutoExposureRuntime({ adaptationTimeConstantSeconds: 0.35 }, {
      kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.108, 0.108, 0.108]) });
    expect(advanceFrames(runtime, 1)[0]).toBeCloseTo(1, 7);
    runtime.observeSource({ kind: "radiance-hdr", image: hdrImage(4, 4, () => [0.216, 0.216, 0.216]) });
    const exposures = advanceFrames(runtime, 1, FRAME_MS);
    expect(exposures[0]).toBeLessThan(1);
    expect(exposures[0]).toBeGreaterThan(0.5);
  });
});
