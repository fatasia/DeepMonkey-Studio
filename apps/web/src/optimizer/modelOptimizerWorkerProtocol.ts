import type { ModelFileStatistics, ModelOptimizationOptions, ModelOptimizationResult } from "./modelOptimizer";

export type ModelOptimizerWorkerRequest =
  | { id: number; action: "inspect"; name: string; buffer: ArrayBuffer }
  | { id: number; action: "optimize"; name: string; buffer: ArrayBuffer; options: ModelOptimizationOptions; copyright?: string };

export type ModelOptimizerWorkerResponse =
  | { id: number; type: "progress"; message: string }
  | { id: number; type: "inspect-result"; result: ModelFileStatistics }
  | { id: number; type: "optimize-result"; result: ModelOptimizationResult }
  | { id: number; type: "error"; message: string; stack?: string };
