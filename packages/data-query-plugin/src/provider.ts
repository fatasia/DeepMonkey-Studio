import type {
  AskDataQueryPlan,
  AskDataQueryPlanInput,
  DataDatasetPreview,
  DataDatasetRecord,
} from "@bim-studio/contracts";
import type { CapabilityProvider } from "@bim-studio/plugin-runtime";
import { createDataQueryPlan, executeDataQuery, validateDataQueryPlan } from "./queryEngine.js";
import { DATA_QUERY_SCHEMAS } from "./schemas.js";

export interface DataQuerySource {
  listDatasets(projectId: string): DataDatasetRecord[];
  getDataset(projectId: string, datasetId: string): DataDatasetRecord | undefined;
  readDataset(projectId: string, datasetId: string, signal: AbortSignal): Promise<DataDatasetPreview>;
}

export function createDataQueryProviders(source: DataQuerySource): CapabilityProvider[] {
  return [
    {
      descriptor: {
        id: "data.query.plan", version: "1.0.0", label: "校验问数计划", kind: "query", execution: "in-process",
        permissions: ["data.read"], timeoutMs: 5_000, inputSchemaVersion: "1.0", outputSchemaVersion: "1.0",
        inputSchema: DATA_QUERY_SCHEMAS.plan.input, outputSchema: DATA_QUERY_SCHEMAS.plan.output,
      },
      async invoke(request) {
        const input = request.input as AskDataQueryPlanInput;
        const result = createDataQueryPlan(input, source.getDataset(request.projectId, input.datasetId));
        return {
          status: result.status === "ready" ? "completed" : "needs-input",
          decisionStatus: result.status === "ready" ? "production" : "insufficient-data",
          output: result,
          evidence: result.plan ? [datasetEvidence(result.plan.datasetId, result.plan.datasetName, result.plan.datasetRevision)] : [],
          warnings: result.issues.map((item) => item.message),
        };
      },
    },
    {
      descriptor: {
        id: "data.query.read", version: "1.0.0", label: "执行受控问数", kind: "query", execution: "in-process",
        permissions: ["data.read"], timeoutMs: 15_000, inputSchemaVersion: "1.0", outputSchemaVersion: "1.0",
        inputSchema: DATA_QUERY_SCHEMAS.read.input, outputSchema: DATA_QUERY_SCHEMAS.read.output,
      },
      async invoke(request, context) {
        const plan = (request.input as { plan: AskDataQueryPlan }).plan;
        const current = source.getDataset(request.projectId, plan.datasetId);
        const validation = validateDataQueryPlan(plan, current);
        if (!validation.plan) return {
          status: "needs-input", decisionStatus: "insufficient-data", output: validation,
          warnings: validation.issues.map((item) => item.message),
        };
        const preview = await source.readDataset(request.projectId, plan.datasetId, context.signal);
        const output = executeDataQuery(validation.plan, preview);
        return {
          status: "completed", decisionStatus: "production", output,
          evidence: [{ ...datasetEvidence(plan.datasetId, plan.datasetName, plan.datasetRevision), fingerprint: output.evidenceFingerprint }],
        };
      },
    },
  ];
}

function datasetEvidence(datasetId: string, datasetName: string, revision: string) {
  return { id: `${datasetId}:${revision}`, kind: "data" as const, label: datasetName, source: `dataset:${datasetId}`, detail: `schema-revision:${revision}` };
}
