import { datasetSchemaFingerprint, type DataDatasetRecord, type OntologyPublishContext } from "@bim-studio/contracts";

/**
 * 发布上下文组装：九条门禁的 fail-closed 前提是"有真凭据可校验"。
 * - 数据源指纹：contracts.datasetSchemaFingerprint（客户端与服务端同一口径）；
 * - 能力目录：由宿主注入 registry.listCapabilities() 的轻量投影；未注入 = 门禁 3 失败。
 */

export interface OntologyContextSource {
  listDatasets(projectId: string): Array<Pick<DataDatasetRecord, "id" | "fields" | "computedFields">>;
}

export function buildOntologyPublishContext(
  ctx: OntologyContextSource,
  projectId: string,
  listCapabilities?: () => Array<{ id: string; version: string; kind: string }>,
): OntologyPublishContext {
  const datasetSchemas: Record<string, string> = {};
  for (const dataset of ctx.listDatasets(projectId)) {
    datasetSchemas[dataset.id] = datasetSchemaFingerprint(dataset);
  }
  return {
    datasetSchemas,
    ...(listCapabilities ? { capabilities: listCapabilities() } : {}),
  };
}

export { datasetSchemaFingerprint };
