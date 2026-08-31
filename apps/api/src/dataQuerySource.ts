import type { DataQuerySource } from "@bim-studio/data-query-plugin";
import type { AppConfig } from "./config.js";
import { previewDataset } from "./dataIntegration.js";
import type { MetadataStore } from "./metadataStore.js";

/** 适配现有 Data Hub；问数插件只看数据集合同，不接触连接密码或数据库驱动。 */
export function createDataQuerySource(store: MetadataStore, config: AppConfig): DataQuerySource {
  return {
    listDatasets(projectId) {
      return store.listDatasets(projectId);
    },
    getDataset(projectId, datasetId) {
      return store.listDatasets(projectId).find((dataset) => dataset.id === datasetId);
    },
    async readDataset(projectId, datasetId, signal) {
      if (signal.aborted) throw new Error("问数读取已取消");
      const dataset = store.listDatasets(projectId).find((item) => item.id === datasetId);
      if (!dataset) throw new Error("数据集不存在或已删除");
      const connection = store.listDataConnections(projectId).find((item) => item.id === dataset.connectionId);
      if (!connection) throw new Error("数据集连接不存在或已删除");
      const result = await previewDataset(config, connection, dataset);
      if (signal.aborted) throw new Error("问数读取已取消");
      return result;
    },
  };
}
