export interface BenchmarkImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray<ArrayBuffer>;
  readonly sha256: string;
  readonly meanLuminance: number;
  readonly geometryDetailFraction: number;
}

const SAMPLE_WIDTH = 96, SAMPLE_HEIGHT = 54;
const EDGE_THRESHOLD = 24;
export const BENCHMARK_VISUAL_ROI = Object.freeze({ left: 0.08, top: 0.08, right: 0.92, bottom: 0.92 });
export const BENCHMARK_VISUAL_METHOD = Object.freeze({
  roi: BENCHMARK_VISUAL_ROI, mask: "union-of-one-pixel-dilated-luma-edges", edgeThreshold: EDGE_THRESHOLD,
  score: "55% masked RGB RMSE + 25% tolerant edge agreement + 15% exposure + 5% detail coverage",
  minimum: 0.92,
});

/** Acquires the current presentable texture synchronously, then waits for an explicit GPU copy. */
export async function captureWebGpuBenchmarkImage(device: GPUDevice, context: GPUCanvasContext,
  format: GPUTextureFormat, width: number, height: number): Promise<BenchmarkImage> {
  if (width < 1 || height < 1) throw new Error("Benchmark canvas is empty.");
  const texture = context.getCurrentTexture(), bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const readback = device.createBuffer({ label: "Competitive benchmark surface readback",
    size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder({ label: "Competitive benchmark surface copy" });
    encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow, rowsPerImage: height }, [width, height]);
    device.queue.submit([encoder.finish()]); await readback.mapAsync(GPUMapMode.READ);
    const source = new Uint8Array(readback.getMappedRange()), rgba = new Uint8ClampedArray(SAMPLE_WIDTH * SAMPLE_HEIGHT * 4);
    const bgra = format.startsWith("bgra");
    for (let y = 0; y < SAMPLE_HEIGHT; y++) for (let x = 0; x < SAMPLE_WIDTH; x++) {
      const sourceX = Math.min(width - 1, Math.floor((x + 0.5) * width / SAMPLE_WIDTH));
      const sourceY = Math.min(height - 1, Math.floor((y + 0.5) * height / SAMPLE_HEIGHT));
      const from = sourceY * bytesPerRow + sourceX * 4, to = (y * SAMPLE_WIDTH + x) * 4;
      rgba[to] = source[from + (bgra ? 2 : 0)]!; rgba[to + 1] = source[from + 1]!;
      rgba[to + 2] = source[from + (bgra ? 0 : 2)]!; rgba[to + 3] = source[from + 3]!;
    }
    readback.unmap(); return summarizeBenchmarkImage(SAMPLE_WIDTH, SAMPLE_HEIGHT, rgba);
  } finally {
    if (readback.mapState === "mapped") readback.unmap(); readback.destroy();
  }
}

export async function summarizeBenchmarkImage(width: number, height: number,
  rgba: Uint8ClampedArray<ArrayBuffer>): Promise<BenchmarkImage> {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || rgba.length !== width * height * 4) throw new Error("Benchmark image dimensions are invalid.");
  const luma = luminancePlane(rgba), bounds = roiBounds(width, height);
  let luminance = 0;
  for (let y = bounds.top; y < bounds.bottom; y++) for (let x = bounds.left; x < bounds.right; x++) {
    luminance += luma[y * width + x]!;
  }
  const edges = edgeMask(luma, width, height, bounds);
  const details = edges.reduce((total, active) => total + active, 0);
  const pixels = Math.max(1, (bounds.right - bounds.left) * (bounds.bottom - bounds.top));
  const digest = await crypto.subtle.digest("SHA-256", rgba);
  return Object.freeze({ width, height, rgba, sha256: hex(digest),
    meanLuminance: luminance / (pixels * 255), geometryDetailFraction: details / pixels });
}

/** Scores only the frozen ROI and a geometry-edge mask; a one-pixel dilation tolerates raster rounding. */
export function perceptualSimilarity(left: BenchmarkImage, right: BenchmarkImage): number {
  if (left.width !== right.width || left.height !== right.height || left.rgba.length !== right.rgba.length) return 0;
  if (left.geometryDetailFraction < 0.002 || right.geometryDetailFraction < 0.002) return 0;
  const detailRatio = Math.min(left.geometryDetailFraction, right.geometryDetailFraction)
    / Math.max(left.geometryDetailFraction, right.geometryDetailFraction);
  if (detailRatio < 0.65) return 0;
  const bounds = roiBounds(left.width, left.height);
  const leftEdges = edgeMask(luminancePlane(left.rgba), left.width, left.height, bounds);
  const rightEdges = edgeMask(luminancePlane(right.rgba), right.width, right.height, bounds);
  const leftNear = dilate(leftEdges, left.width, left.height, bounds);
  const rightNear = dilate(rightEdges, right.width, right.height, bounds);
  const edgeAgreement = (directionalEdgeAgreement(leftEdges, rightNear)
    + directionalEdgeAgreement(rightEdges, leftNear)) / 2;
  let squared = 0, channels = 0;
  for (let y = bounds.top; y < bounds.bottom; y++) for (let x = bounds.left; x < bounds.right; x++) {
    const pixel = y * left.width + x;
    if (!leftNear[pixel] && !rightNear[pixel]) continue;
    const offset = pixel * 4;
    for (let channel = 0; channel < 3; channel++) {
      const delta = left.rgba[offset + channel]! - right.rgba[offset + channel]!;
      squared += delta * delta; channels++;
    }
  }
  if (!channels) return 0;
  const pixelScore = 1 - Math.sqrt(squared / channels) / 255;
  const exposureStops = Math.abs(Math.log2((left.meanLuminance + 1e-6) / (right.meanLuminance + 1e-6)));
  const exposureScore = Math.max(0, 1 - exposureStops);
  return clamp01(pixelScore * 0.55 + edgeAgreement * 0.25 + exposureScore * 0.15 + detailRatio * 0.05);
}

export function assertBenchmarkImage(image: BenchmarkImage, engine: string): void {
  if (image.meanLuminance < 0.002 || image.geometryDetailFraction < 0.002) {
    throw new Error(`${engine} produced a blank benchmark capture.`);
  }
  const luma = luminancePlane(image.rgba), bounds = roiBounds(image.width, image.height);
  let horizontalDetails = 0, verticalDetails = 0;
  for (let y = Math.max(1, bounds.top); y < Math.min(image.height - 1, bounds.bottom); y++) {
    for (let x = Math.max(1, bounds.left); x < Math.min(image.width - 1, bounds.right); x++) {
      const index = y * image.width + x;
      if (Math.abs(luma[index + 1]! - luma[index - 1]!) > EDGE_THRESHOLD) horizontalDetails++;
      if (Math.abs(luma[index + image.width]! - luma[index - image.width]!) > EDGE_THRESHOLD) verticalDetails++;
    }
  }
  const minimumDetails = Math.max(4, (bounds.right - bounds.left) * (bounds.bottom - bounds.top) * 0.002);
  if (horizontalDetails < minimumDetails || verticalDetails < minimumDetails) {
    throw new Error(`${engine} produced a horizon-only or insufficiently framed benchmark capture.`);
  }
}

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), value => value.toString(16).padStart(2, "0")).join("");
}

interface RoiBounds { readonly left: number; readonly top: number; readonly right: number; readonly bottom: number }
function roiBounds(width: number, height: number): RoiBounds {
  return { left: Math.floor(width * BENCHMARK_VISUAL_ROI.left), top: Math.floor(height * BENCHMARK_VISUAL_ROI.top),
    right: Math.ceil(width * BENCHMARK_VISUAL_ROI.right), bottom: Math.ceil(height * BENCHMARK_VISUAL_ROI.bottom) };
}
function luminancePlane(rgba: Uint8ClampedArray<ArrayBuffer>): Float32Array<ArrayBuffer> {
  const luma = new Float32Array(rgba.length / 4);
  for (let offset = 0; offset < rgba.length; offset += 4) luma[offset / 4] = 0.2126 * rgba[offset]!
    + 0.7152 * rgba[offset + 1]! + 0.0722 * rgba[offset + 2]!;
  return luma;
}
function edgeMask(luma: Float32Array, width: number, height: number, bounds: RoiBounds): Uint8Array<ArrayBuffer> {
  const mask = new Uint8Array(width * height);
  const top = Math.max(1, bounds.top), bottom = Math.min(height - 1, bounds.bottom);
  const left = Math.max(1, bounds.left), right = Math.min(width - 1, bounds.right);
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const index = y * width + x;
    const gradient = Math.abs(luma[index + 1]! - luma[index - 1]!)
      + Math.abs(luma[index + width]! - luma[index - width]!);
    if (gradient > EDGE_THRESHOLD) mask[index] = 1;
  }
  return mask;
}
function dilate(source: Uint8Array, width: number, height: number, bounds: RoiBounds): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(source.length);
  for (let y = bounds.top; y < bounds.bottom; y++) for (let x = bounds.left; x < bounds.right; x++) {
    const index = y * width + x;
    if (!source[index]) continue;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const targetX = x + dx, targetY = y + dy;
      if (targetX >= bounds.left && targetX < bounds.right && targetY >= bounds.top && targetY < bounds.bottom) {
        result[targetY * width + targetX] = 1;
      }
    }
  }
  return result;
}
function directionalEdgeAgreement(source: Uint8Array, near: Uint8Array): number {
  let count = 0, matched = 0;
  source.forEach((active, index) => { if (active) { count++; if (near[index]) matched++; } });
  return count ? matched / count : 0;
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
