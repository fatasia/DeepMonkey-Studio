import { pipelineCompileCacheForDevice, type PipelineCompileRecord } from "./pipelineCache.js";

/** On-demand copy: the existing compile ledger contains only primitive fields. */
export function snapshotPipelineCompileRecords(device: GPUDevice): readonly PipelineCompileRecord[] {
  return Object.freeze(pipelineCompileCacheForDevice(device).records.map(record => Object.freeze({ ...record })));
}
