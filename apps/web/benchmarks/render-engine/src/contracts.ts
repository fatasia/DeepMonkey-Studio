export type BenchmarkEngine = "three-webgl" | "three-webgpu";
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

export interface RenderBenchmarkRuntime {
  rebuild(cycle: number): Promise<void>;
  snapshot(): RenderBenchmarkSnapshot;
  dispose(): void;
}

export interface RenderBenchmarkControl {
  ready: boolean;
  error?: string;
  snapshot?: RenderBenchmarkSnapshot;
  rebuild(cycle: number): Promise<RenderBenchmarkSnapshot>;
}

declare global {
  interface Window { __renderEngineBenchmark?: RenderBenchmarkControl; }
}
