import type { DataDatasetField, DataDatasetPreview, DataDatasetRecord } from "@bim-studio/contracts";
import { datasetSchemaChanged } from "./datasetSchema";

interface PreviewTransport {
  read(): Promise<DataDatasetPreview>;
  save(dataset: DataDatasetRecord): Promise<DataDatasetRecord>;
}
/** 写后刷新和重试只读；正常“运行查询”才保留已有发现字段持久化行为。 */
export async function loadDataCenterPreview(transport: PreviewTransport, current: DataDatasetRecord | undefined, readOnly: boolean, isCurrent: () => boolean): Promise<DataDatasetPreview | undefined> {
  const result = await transport.read();
  if (!isCurrent()) return undefined;
  const fields: DataDatasetField[] = result.fields.length > 0 ? result.fields : current?.fields ?? [];
  const dataset = !readOnly && current && result.fields.length > 0 && datasetSchemaChanged(current.fields, fields)
    ? await transport.save({ ...result.dataset, fields }) : result.dataset;
  if (!isCurrent()) return undefined;
  const writeback = JSON.stringify(dataset.writeback) === JSON.stringify(current?.writeback) ? current?.writeback : dataset.writeback;
  return { ...result, dataset: { ...dataset, fields, ...(writeback ? { writeback } : {}) }, fields };
}
