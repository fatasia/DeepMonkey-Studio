import type { BenchmarkImage } from "./benchmarkImage.js";
import type { BenchmarkFidelitySnapshot, BenchmarkProfile } from "./benchmarkProfile.js";

export interface BenchmarkCpuStages {
  readonly renderCallMs: number;
  readonly statisticsReadMs: number;
}

export interface BenchmarkFrameStats {
  readonly drawCalls: number;
  readonly triangles: number;
  readonly resources: number;
  readonly cpuStages: BenchmarkCpuStages;
}

export interface BenchmarkBackend {
  readonly id: "deep-webgpu" | "three-webgpu";
  readonly version: string;
  readonly profile: BenchmarkProfile;
  readonly fidelity: BenchmarkFidelitySnapshot;
  readonly timestampSupported: boolean;
  readonly adapter: Readonly<Record<string, unknown>> | null;
  render(): BenchmarkFrameStats;
  setGpuInstrumentation(enabled: boolean): void;
  settle(): Promise<void>;
  measureGpuFrame(): Promise<number | null>;
  capture(): Promise<BenchmarkImage>;
  errors(): readonly string[];
  dispose(): void;
}
