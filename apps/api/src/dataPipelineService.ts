import type { DataPipelineDefinition, DataPipelinePreview } from "@bim-studio/contracts";
import { DataPipelineError, executeDataPipeline } from "@bim-studio/data-runtime/pipeline";
import type { AppConfig } from "./config.js";
import { previewDataset } from "./dataIntegration.js";
import type { MetadataStore } from "./store.js";

export async function previewPipeline(
  config: AppConfig,
  store: MetadataStore,
  definition: DataPipelineDefinition,
  throughNodeId?: string,
): Promise<DataPipelinePreview> {
  try {
    return await executeDataPipeline(definition, async (datasetId) => {
      const dataset = store.listDatasets(definition.projectId).find((item) => item.id === datasetId);
      if (!dataset) throw new Error("数据集不存在或已删除");
      const connection = store.listDataConnections(definition.projectId).find((item) => item.id === dataset.connectionId);
      if (!connection) throw new Error("数据连接不存在或已删除");
      return (await previewDataset(config, connection, dataset)).rows;
    }, throughNodeId ? { throughNodeId } : {});
  } catch (reason) {
    if (reason instanceof DataPipelineError) {
      return {
        pipeline: definition,
        status: "error",
        fields: [],
        rows: [],
        durationMs: reason.diagnostics.reduce((sum, item) => sum + item.durationMs, 0),
        diagnostics: reason.diagnostics,
        ...(throughNodeId ? { executedThroughNodeId: throughNodeId } : {}),
        ...(reason.nodeId ? { failedNodeId: reason.nodeId } : {}),
        error: reason.message
      };
    }
    throw reason;
  }
}
