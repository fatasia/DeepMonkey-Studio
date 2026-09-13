import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { AiSampleKind, AiSampleResult } from "@bim-studio/contracts";
import type { MetadataStore } from "../store.js";
import { analyzeEnergy, buildMaintenanceAssessment, prepareMaintenanceWindow, scoreNativeArtifact } from "../operationsEngine.js";
import { energySampleRows, maintenanceSample } from "./aiSampleFixtures.js";
import { runVisionInferenceSample } from "./visionInferenceSample.js";
import { runQuerySample } from "./queryInferenceSample.js";

/** 样例只执行固定输入，不导入业务资源，不接触其它项目或后台部署。 */
export async function registerAiSampleRoutes(app: FastifyInstance, dependencies: { store: Pick<MetadataStore, "getProject"> }) {
  app.post<{ Params: { projectId: string; kind: string } }>("/api/projects/:projectId/ai/samples/:kind/run", async (request, reply) => {
    if (!dependencies.store.getProject(request.params.projectId)) return reply.code(404).send({ message: "项目不存在" });
    const kind = request.params.kind;
    if (kind !== "maintenance" && kind !== "vision" && kind !== "energy" && kind !== "query") return reply.code(404).send({ message: "样例不存在" });
    reply.header("cache-control", "no-store");
    return executeAiSample(request.params.projectId, kind);
  });
}

export async function executeAiSample(projectId: string, kind: AiSampleKind): Promise<AiSampleResult> {
  const startedAt = new Date().toISOString();
  const result = kind === "maintenance" ? runMaintenance(projectId) : kind === "vision" ? await runVisionInferenceSample() : kind === "query" ? runQuerySample(projectId) : runEnergy(projectId);
  return {
    schemaVersion: 1, runId: randomUUID(), projectId, kind, execution: "local-sample", startedAt,
    completedAt: new Date().toISOString(),
    inputFingerprint: createHash("sha256").update(JSON.stringify(result.input)).digest("hex"), ...result,
  };
}

function runMaintenance(projectId: string) {
  const { model, deployment, rows } = maintenanceSample(projectId);
  const window = prepareMaintenanceWindow(model, deployment, rows);
  const assessment = buildMaintenanceAssessment({ projectId, model, deployment, window, score: scoreNativeArtifact(model.artifact, rows.at(-1)!) });
  return {
    engine: "maintenance-native-json",
    input: { artifact: model.artifact, gates: model.gates, rows }, output: assessment,
    metrics: [
      { label: "采样数", labelEn: "Samples", value: String(rows.length) },
      { label: "风险评分", labelEn: "Risk score", value: `${((assessment.score ?? 0) * 100).toFixed(1)}%` },
      { label: "数据质量", labelEn: "Data quality", value: `${(assessment.dataQuality * 100).toFixed(1)}%` },
    ],
  };
}

function runEnergy(projectId: string) {
  const output = analyzeEnergy(projectId, energySampleRows);
  return { engine: "energy-baseline-analysis", input: energySampleRows, output,
    metrics: [
      { label: "基线单耗", labelEn: "Baseline intensity", value: `${output.baselineKwhPerUnit.toFixed(2)} kWh/件` },
      { label: "当前单耗", labelEn: "Current intensity", value: `${output.currentKwhPerUnit.toFixed(2)} kWh/件` },
      { label: "能耗偏差", labelEn: "Energy deviation", value: `+${output.deviationPercent.toFixed(1)}%` },
    ] };
}
