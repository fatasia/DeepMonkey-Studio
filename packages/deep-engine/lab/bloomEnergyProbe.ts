/// <reference types="@webgpu/types" />
import { extractBloomColor } from "@bim-studio/deep-engine/postprocess";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";
import { DEFAULT_PBR_BLOOM_OPTIONS } from "../src/webgpu/pbrPostProcessChain.js";
import { readBloomEnergyCase, type BloomEnergyReadback } from "./bloomEnergyReadback.js";

const HDR_COLOR = [4, 2, 1] as const;
const HALF_FLOAT_TOLERANCE = 0.004;
const CASES = [[1, 4, 1], [64, 4, 4], [64, 8, 6], [128, 4, 4], [128, 8, 7]] as const;

interface ConstantMetric {
  readonly size: number;
  readonly maxLevels: number;
  readonly actualLevels: number;
  readonly passCount: number;
  readonly meanRgb: readonly number[];
  readonly meanLuminance: number;
  readonly maxAbsoluteError: number;
}

export interface BloomEnergyProbeResult {
  readonly action: "bloom-energy";
  readonly success: boolean;
  readonly checks: Readonly<{
    constantRadianceInvariant: boolean;
    constantCpuAgreement: boolean;
    requestedPyramidCoverage: boolean;
    sdrWhiteUnchanged: boolean;
    hdrHalo: boolean;
    alphaPreserved: boolean;
    resourcesReleased: boolean;
    gpuHealthy: boolean;
  }>;
  readonly metrics: Readonly<{
    options: typeof DEFAULT_PBR_BLOOM_OPTIONS;
    inputRgb: readonly number[];
    expectedConstantRgb: readonly number[];
    constants: readonly ConstantMetric[];
    maxConstantError: number;
    luminanceSpread: number;
    sdrMaxError: number;
    haloPixels: number;
    haloPeakLuminance: number;
    haloRingMinimum: number;
    ownedResourcesBefore: number;
    ownedResourcesAfter: number;
  }>;
  readonly deviceError?: string;
}

function luminance(r: number, g: number, b: number): number { return r * 0.2126 + g * 0.7152 + b * 0.0722; }
function alphaPreserved(frame: BloomEnergyReadback): boolean {
  return frame.pixels.every((value, index) => Number.isFinite(value) && (index % 4 !== 3 || value === 1));
}
function constantMetric(frame: BloomEnergyReadback, expected: readonly number[]): ConstantMetric {
  const sum = [0, 0, 0]; let maxAbsoluteError = 0;
  for (let offset = 0; offset < frame.pixels.length; offset += 4) for (let channel = 0; channel < 3; channel++) {
    const value = frame.pixels[offset + channel]!;
    sum[channel]! += value;
    maxAbsoluteError = Math.max(maxAbsoluteError, Math.abs(value - expected[channel]!));
  }
  const meanRgb = sum.map(value => value / (frame.size * frame.size));
  return { size: frame.size, maxLevels: frame.maxLevels, actualLevels: frame.levels, passCount: frame.passCount,
    meanRgb: Object.freeze(meanRgb), meanLuminance: luminance(meanRgb[0]!, meanRgb[1]!, meanRgb[2]!), maxAbsoluteError };
}

/** Real production BloomPass readback; a constant field must not gain energy with pyramid depth. */
export async function verifyBloomEnergy(session: DeviceSession): Promise<BloomEnergyProbeResult> {
  if (session.state !== "ready") throw new Error("Bloom energy probe requires a ready device session.");
  const before = session.resourceCount, diagnosticsBefore = session.diagnostics.length;
  const extracted = extractBloomColor(HDR_COLOR, DEFAULT_PBR_BLOOM_OPTIONS);
  const expected = HDR_COLOR.map((value, index) => value + extracted[index]! * DEFAULT_PBR_BLOOM_OPTIONS.intensity);
  const checks = { constantRadianceInvariant: false, constantCpuAgreement: false, requestedPyramidCoverage: false,
    sdrWhiteUnchanged: false, hdrHalo: false, alphaPreserved: true, resourcesReleased: false, gpuHealthy: false };
  const constants: ConstantMetric[] = [];
  let maxConstantError = 0, luminanceSpread = 0, sdrMaxError = 0, haloPixels = 0, haloPeakLuminance = 0, haloRingMinimum = Infinity;
  let deviceError: string | undefined;
  try {
    for (const [size, maxLevels] of CASES) {
      const frame = await readBloomEnergyCase(session, size, maxLevels, () => [...HDR_COLOR, 1]);
      checks.alphaPreserved &&= alphaPreserved(frame);
      constants.push(constantMetric(frame, expected));
    }
    maxConstantError = Math.max(...constants.map(value => value.maxAbsoluteError));
    const luminances = constants.map(value => value.meanLuminance);
    luminanceSpread = Math.max(...luminances) - Math.min(...luminances);
    checks.constantRadianceInvariant = Number.isFinite(luminanceSpread) && luminanceSpread <= HALF_FLOAT_TOLERANCE;
    checks.constantCpuAgreement = Number.isFinite(maxConstantError) && maxConstantError <= HALF_FLOAT_TOLERANCE;
    checks.requestedPyramidCoverage = constants.every((value, index) => value.actualLevels === CASES[index]![2]);
    const white = await readBloomEnergyCase(session, 64, DEFAULT_PBR_BLOOM_OPTIONS.maxLevels, () => [1, 1, 1, 1]);
    checks.alphaPreserved &&= alphaPreserved(white);
    for (const value of white.pixels) sdrMaxError = Math.max(sdrMaxError, Math.abs(value - 1));
    checks.sdrWhiteUnchanged = sdrMaxError === 0;
    const isBright = (x: number, y: number) => x >= 30 && x < 34 && y >= 30 && y < 34;
    const spot = await readBloomEnergyCase(session, 64, DEFAULT_PBR_BLOOM_OPTIONS.maxLevels,
      (x, y) => isBright(x, y) ? [16, 8, 4, 1] : [0, 0, 0, 1]);
    checks.alphaPreserved &&= alphaPreserved(spot);
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      if (isBright(x, y)) continue;
      const offset = (y * 64 + x) * 4;
      const value = luminance(spot.pixels[offset]!, spot.pixels[offset + 1]!, spot.pixels[offset + 2]!);
      if (value > 0.0001) haloPixels++;
      haloPeakLuminance = Math.max(haloPeakLuminance, value);
      if (x >= 28 && x < 36 && y >= 28 && y < 36) haloRingMinimum = Math.min(haloRingMinimum, value);
    }
    checks.hdrHalo = haloPixels >= 16 && haloPeakLuminance > 0.001 && haloRingMinimum > 0.0001;
  } catch (error) {
    deviceError = error instanceof Error ? error.message : String(error);
  }
  checks.resourcesReleased = session.resourceCount === before;
  const diagnostics = session.diagnostics.slice(diagnosticsBefore);
  checks.gpuHealthy = session.state === "ready" && diagnostics.length === 0 && !deviceError;
  if (diagnostics.length) deviceError = diagnostics.map(value => value.message).join("; ");
  return Object.freeze({ action: "bloom-energy", success: Object.values(checks).every(Boolean), checks: Object.freeze(checks),
    metrics: Object.freeze({ options: DEFAULT_PBR_BLOOM_OPTIONS, inputRgb: HDR_COLOR, expectedConstantRgb: Object.freeze(expected),
      constants: Object.freeze(constants), maxConstantError, luminanceSpread, sdrMaxError, haloPixels, haloPeakLuminance,
      haloRingMinimum: Number.isFinite(haloRingMinimum) ? haloRingMinimum : 0,
      ownedResourcesBefore: before, ownedResourcesAfter: session.resourceCount }),
    ...(deviceError ? { deviceError } : {}) });
}
