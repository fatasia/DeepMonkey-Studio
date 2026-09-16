import type {
  AmbientOcclusionCompositeCpuInput,
  AmbientOcclusionCompositeOptions,
} from "./ambientOcclusionCompositeTypes.js";

const MAX_DEPTH_SIGMA = 1_000_000;
const MAX_STRENGTH = 8;

export function validateAmbientOcclusionCompositeOptions(options: AmbientOcclusionCompositeOptions): void {
  if (!options || !Number.isFinite(options.depthSigma) || options.depthSigma <= 0 || options.depthSigma > MAX_DEPTH_SIGMA) {
    throw new Error(`AO composite depthSigma must be finite and in (0, ${MAX_DEPTH_SIGMA}].`);
  }
  if (!Number.isFinite(options.strength) || options.strength < 0 || options.strength > MAX_STRENGTH) {
    throw new Error(`AO composite strength must be finite and in [0, ${MAX_STRENGTH}].`);
  }
}

function expectedHalfSize(value: number): number { return Math.ceil(value / 2); }
function clamp(value: number, maximum: number): number { return Math.max(0, Math.min(value, maximum)); }
function finiteValues(values: readonly number[]): boolean {
  for (const value of values) if (!Number.isFinite(value)) return false;
  return true;
}

function validateCpuInput(input: AmbientOcclusionCompositeCpuInput): void {
  if (!Number.isSafeInteger(input.width) || !Number.isSafeInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new Error("AO composite CPU dimensions must be positive safe integers.");
  }
  if (input.ambientOcclusionWidth !== expectedHalfSize(input.width)
    || input.ambientOcclusionHeight !== expectedHalfSize(input.height)) {
    throw new Error("AO composite CPU input requires exact ceil-half AO dimensions.");
  }
  const pixels = input.width * input.height, aoPixels = input.ambientOcclusionWidth * input.ambientOcclusionHeight;
  if (input.unlitMask && (input.unlitMask.length !== pixels
    || !finiteValues(input.unlitMask) || !input.unlitMask.every(value => value >= 0 && value <= 1))) {
    throw new Error("AO composite unlit mask must contain one finite 0..1 value per pixel.");
  }
  if (input.color.length !== pixels * 4 || input.depth.length !== pixels || input.ambientOcclusion.length !== aoPixels) {
    throw new Error("AO composite CPU input array lengths do not match their dimensions.");
  }
  if (!finiteValues(input.color) || !finiteValues(input.depth) || !finiteValues(input.ambientOcclusion)) {
    throw new Error("AO composite CPU input must contain only finite values.");
  }
}

function bilateralVisibility(
  input: AmbientOcclusionCompositeCpuInput,
  x: number,
  y: number,
  depthSigma: number,
): number {
  const centerDepth = input.depth[y * input.width + x]!;
  if (centerDepth <= 0) return 1;
  const aoPositionX = (x - 1) * 0.5, aoPositionY = (y - 1) * 0.5;
  const baseX = Math.floor(aoPositionX), baseY = Math.floor(aoPositionY);
  const fractionX = aoPositionX - baseX, fractionY = aoPositionY - baseY;
  let weighted = 0, totalWeight = 0;
  for (let offsetY = 0; offsetY <= 1; offsetY += 1) {
    for (let offsetX = 0; offsetX <= 1; offsetX += 1) {
      const aoX = clamp(baseX + offsetX, input.ambientOcclusionWidth - 1);
      const aoY = clamp(baseY + offsetY, input.ambientOcclusionHeight - 1);
      const sourceX = Math.min(aoX * 2 + 1, input.width - 1);
      const sourceY = Math.min(aoY * 2 + 1, input.height - 1);
      const sampleDepth = input.depth[sourceY * input.width + sourceX]!;
      if (sampleDepth <= 0) continue;
      const spatialX = offsetX === 1 ? fractionX : 1 - fractionX;
      const spatialY = offsetY === 1 ? fractionY : 1 - fractionY;
      const weight = spatialX * spatialY * Math.exp(-Math.abs(sampleDepth - centerDepth) / depthSigma);
      weighted += Math.min(1, Math.max(0, input.ambientOcclusion[aoY * input.ambientOcclusionWidth + aoX]!)) * weight;
      totalWeight += weight;
    }
  }
  const fallbackX = Math.min(Math.floor((x + 1) / 2), input.ambientOcclusionWidth - 1);
  const fallbackY = Math.min(Math.floor((y + 1) / 2), input.ambientOcclusionHeight - 1);
  const fallback = input.ambientOcclusion[fallbackY * input.ambientOcclusionWidth + fallbackX]!;
  return totalWeight > 0.000001 ? weighted / totalWeight : Math.min(1, Math.max(0, fallback));
}

/** Deterministic reference for the GPU bilateral upsample and HDR modulation. */
export function compositeAmbientOcclusionCpu(
  input: AmbientOcclusionCompositeCpuInput,
  options: AmbientOcclusionCompositeOptions,
): Float32Array {
  validateCpuInput(input); validateAmbientOcclusionCompositeOptions(options);
  const output = new Float32Array(input.color.length);
  for (let y = 0; y < input.height; y += 1) {
    for (let x = 0; x < input.width; x += 1) {
      const pixel = y * input.width + x, colorOffset = pixel * 4;
      const visibility = (input.unlitMask?.[pixel] ?? 0) > 0.5 ? 1
        : Math.pow(bilateralVisibility(input, x, y, options.depthSigma), options.strength);
      output[colorOffset] = Math.fround(input.color[colorOffset]! * visibility);
      output[colorOffset + 1] = Math.fround(input.color[colorOffset + 1]! * visibility);
      output[colorOffset + 2] = Math.fround(input.color[colorOffset + 2]! * visibility);
      output[colorOffset + 3] = Math.fround(input.color[colorOffset + 3]!);
    }
  }
  return output;
}
