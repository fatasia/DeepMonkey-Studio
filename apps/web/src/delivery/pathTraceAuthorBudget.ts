import type { RenderPacket } from "@bim-studio/deep-engine";

export const PATH_TRACE_RESOLUTIONS = [160, 320, 640, 1280, 1920] as const;
export const PATH_TRACE_MAX_WORKERS = 8;
const MIB = 1024 * 1024;
/** Fixed per-worker allowance: band planes, preview rgba, JS heap of the traced kernel. */
const WORKER_OVERHEAD_BYTES = 16 * MIB;
/** Worker kernel = structured-clone copy of the packet plus its BVH/triangle tables. */
const KERNEL_PACKET_FACTOR = 3;
/** Fallback throughput (pixel·spp / s / worker) for scenes not yet measured; replaced by the last real measurement. */
const DEFAULT_PIXEL_SAMPLES_PER_SECOND = 90_000;
let measuredPixelSamplesPerSecond: number | undefined;

export const pathTraceHeight = (width: number): number => Math.round(width * 9 / 16);

/** Leave one logical core to the UI thread; cap keeps packet copies and merge traffic bounded. */
export function pathTraceWorkerCap(hardwareConcurrency: number | undefined): number {
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency! >= 1 ? Math.floor(hardwareConcurrency!) : 2;
  return Math.max(1, Math.min(PATH_TRACE_MAX_WORKERS, cores - 1));
}

/** Quarter of device memory, clamped; Chrome reports at most 8 GB so the ceiling is 2 GiB. */
export function pathTraceMemoryBudgetBytes(deviceMemoryGb: number | undefined): number {
  const gb = Number.isFinite(deviceMemoryGb) && deviceMemoryGb! > 0 ? deviceMemoryGb! : 4;
  return Math.round(Math.max(384 * MIB, Math.min(2048 * MIB, gb * 1024 * MIB / 4)));
}

/** Resident typed-array bytes of the packet geometry/textures (the part that is copied per worker). */
export function pathTracePacketBytes(packet: RenderPacket): number {
  let bytes = 0;
  for (const geometry of packet.geometries) {
    for (const stream of [geometry.vertices, geometry.uv0, geometry.uv1, geometry.tangents, geometry.colors, geometry.indices]) {
      bytes += stream?.byteLength ?? 0;
    }
  }
  for (const texture of packet.textures ?? []) {
    bytes += texture.data.byteLength + (texture.mipmaps ?? []).reduce((sum, level) => sum + level.data.byteLength, 0);
  }
  return bytes;
}

export interface PathTraceMemoryEstimate { readonly accumulationBytes: number; readonly mainBytes: number;
  readonly workerBytes: number; readonly totalBytes: number }

/** accumulation = mean+m2 planes across all bands; main = rgba merge + float gather + HDR encode + canvas copy. */
export function estimatePathTraceMemory(width: number, workers: number, packetBytes: number): PathTraceMemoryEstimate {
  const pixels = width * pathTraceHeight(width), accumulationBytes = pixels * 24, mainBytes = pixels * 24;
  const workerBytes = Math.max(1, workers) * (packetBytes * KERNEL_PACKET_FACTOR + WORKER_OVERHEAD_BYTES);
  return { accumulationBytes, mainBytes, workerBytes, totalBytes: accumulationBytes + mainBytes + workerBytes + packetBytes };
}

/** Largest worker count (≤ requested) that fits the budget; 0 means even a single worker does not. */
export function fitPathTraceWorkers(width: number, requested: number, packetBytes: number, budgetBytes: number): number {
  for (let workers = Math.max(1, requested); workers >= 1; workers--) {
    if (estimatePathTraceMemory(width, workers, packetBytes).totalBytes <= budgetBytes) return workers;
  }
  return 0;
}

export interface PathTraceTierState { readonly available: boolean; readonly workers: number; readonly estimate: PathTraceMemoryEstimate }
export function pathTraceTierState(width: number, requestedWorkers: number, packetBytes: number, budgetBytes: number): PathTraceTierState {
  const workers = fitPathTraceWorkers(width, requestedWorkers, packetBytes, budgetBytes);
  return { available: workers > 0, workers, estimate: estimatePathTraceMemory(width, workers || 1, packetBytes) };
}

export function pathTraceThroughput(): number { return measuredPixelSamplesPerSecond ?? DEFAULT_PIXEL_SAMPLES_PER_SECOND; }
/** Keeps the latest real per-worker rate so later hints reflect this machine and scene complexity. */
export function recordPathTraceThroughput(width: number, workers: number, samples: number, elapsedMs: number): void {
  if (samples < 2 || elapsedMs < 500 || workers < 1) return;
  measuredPixelSamplesPerSecond = width * pathTraceHeight(width) * samples * 1000 / elapsedMs / workers;
}
export function estimatePathTraceSeconds(width: number, samples: number, workers: number): number {
  return width * pathTraceHeight(width) * samples / (pathTraceThroughput() * Math.max(1, workers));
}
export function formatPathTraceDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}
export const formatPathTraceMiB = (bytes: number): string => `${Math.round(bytes / MIB)} MiB`;
