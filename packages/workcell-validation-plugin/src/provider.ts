import type { WorkcellAuditInput, WorkcellAuditResult } from "@bim-studio/contracts";
import type { CapabilityProvider } from "@bim-studio/plugin-runtime";
import { auditWorkcell } from "./engine.js";
import { workcellAuditInputSchema, workcellAuditOutputSchema } from "./workcellSchemas.js";

export function createWorkcellAuditProvider(): CapabilityProvider<WorkcellAuditInput, WorkcellAuditResult> {
  return {
    descriptor: {
      id: "manufacturing.workcell.audit",
      version: "1.1.0",
      label: "工位空间与机器人体检",
      kind: "analysis",
      execution: "in-process",
      permissions: ["manufacturing.read"],
      timeoutMs: 5_000,
      inputSchemaVersion: "1.1",
      outputSchemaVersion: "1.1",
      inputSchema: workcellAuditInputSchema,
      outputSchema: workcellAuditOutputSchema,
    },
    async invoke(request) {
      const output = auditWorkcell(request.input);
      const trajectoryPotential = output.trajectoryAnalysis?.segmentChecks.reduce(
        (total, item) => total + item.potentialObstacleIds.length,
        0,
      ) ?? 0;
      return {
        status: "completed",
        decisionStatus: output.status === "needs-data" ? "insufficient-data" : "production",
        confidence: output.evidenceCoverage,
        output,
        evidence: [{ id: output.evidenceFingerprint, kind: "simulation", label: "工位确定性体检", source: `scene:${output.sceneId}`, fingerprint: output.evidenceFingerprint }],
        warnings: [
          ...(output.incompleteObjectIds.length ? [`${output.incompleteObjectIds.length} 个对象缺少世界包围盒`] : []),
          ...(trajectoryPotential ? [`${trajectoryPotential} 个轨迹/障碍广相位潜在冲突，需网格级复核`] : []),
          ...(output.trajectoryAnalysis?.scheduleConflicts.length ? [`${output.trajectoryAnalysis.scheduleConflicts.length} 个多机器人时段冲突`] : []),
        ],
        suggestedActions: [{ id: "create-validation-study", label: "创建验证任务", commandType: "validation-study.create", input: { sceneId: output.sceneId, fingerprint: output.evidenceFingerprint }, risk: "low", requiresConfirmation: false }],
      };
    },
  };
}
