import type { ModelFileStatistics, ModelOptimizationOptions, ModelOptimizationResult } from "./modelOptimizer";
import type { OptimizerLayerEdit, OptimizerLayerResult } from "./optimizerLayers";
import type { OptimizerLayerDraft } from "./optimizerLayerSession";

export type ModelOptimizerWorkerRequest =
  | { id:number;action:"layers-draft";key:string;name:string;buffer?:ArrayBuffer;edits:OptimizerLayerEdit[] }
  | { id:number;action:"layers-materialize";key:string;name:string;buffer?:ArrayBuffer;edits:OptimizerLayerEdit[] }
  | { id:number;action:"layers";name:string;buffer:ArrayBuffer;edits:OptimizerLayerEdit[] }
  | { id: number; action: "inspect"; name: string; buffer: ArrayBuffer }
  | { id: number; action: "optimize"; name: string; buffer: ArrayBuffer; options: ModelOptimizationOptions; copyright?: string };

export type ModelOptimizerWorkerResponse =
  | { id:number;type:"layers-draft-result";result:OptimizerLayerDraft }
  | { id:number;type:"layers-result";result:OptimizerLayerResult }
  | { id: number; type: "progress"; message: string }
  | { id: number; type: "inspect-result"; result: ModelFileStatistics }
  | { id: number; type: "optimize-result"; result: ModelOptimizationResult }
  | { id: number; type: "error"; message: string; stack?: string };
