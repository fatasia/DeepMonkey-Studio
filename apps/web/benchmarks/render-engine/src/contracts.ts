export type BenchmarkEngine = "three-webgl" | "three-webgpu" | "babylon-webgpu";
export type BenchmarkWorkload = "static" | "dynamic";

export interface FrameMetrics {
  samples: number;
  averageMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maximumMs: number;
}

export interface RenderBenchmarkSnapshot {
  engine: BenchmarkEngine;
  workload: BenchmarkWorkload;
  objectCount: number;
  initializedMs: number;
  firstFrameMs: number;
  lastRebuildMs: number;
  frames: FrameMetrics;
  gpuFrames?: FrameMetrics;
  drawCalls: number;
  triangles: number;
  geometries?: number;
  textures?: number;
}

/** Stable, JSON-safe envelope shared by browser runners and offline gates. */
export interface RenderBenchmarkResult {
  schemaVersion: 1;
  capturedAt: string;
  snapshot: RenderBenchmarkSnapshot;
  adapter?: { available: boolean; reason?: string; package?: string };
}

export function exportBenchmarkResult(snapshot: RenderBenchmarkSnapshot, capturedAt = new Date().toISOString()): RenderBenchmarkResult {
  return {
    schemaVersion: 1,
    capturedAt,
    snapshot: JSON.parse(JSON.stringify(snapshot)) as RenderBenchmarkSnapshot,
  };
}

export interface BenchmarkEngineAdapter {
  readonly engine: BenchmarkEngine;
  readonly available: boolean;
  readonly reason?: string;
  create(canvas: HTMLCanvasElement, objectCount: number, startedAt: number, workload: BenchmarkWorkload): Promise<RenderBenchmarkRuntime>;
}

export interface RenderBenchmarkRuntime {
  rebuild(cycle: number): Promise<void>;
  snapshot(): RenderBenchmarkSnapshot;
  dispose(): void;
}

export interface RenderBenchmarkControl {
  ready: boolean;
  error?: string;
  snapshot?: RenderBenchmarkSnapshot;
  result?: RenderBenchmarkResult;
  rebuild(cycle: number): Promise<RenderBenchmarkSnapshot>;
}

declare global {
  interface Window { __renderEngineBenchmark?: RenderBenchmarkControl; }
}
