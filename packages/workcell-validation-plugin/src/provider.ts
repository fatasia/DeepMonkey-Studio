import type { WorkcellAuditInput, WorkcellAuditResult } from "@bim-studio/contracts";
import type { CapabilityProvider } from "@bim-studio/plugin-runtime";
import { auditWorkcell } from "./engine.js";
import { workcellAuditInputSchema, workcellAuditOutputSchema } from "./workcellSchemas.js";

export function createWorkcellAuditProvider(): CapabilityProvider<WorkcellAuditInput, WorkcellAuditResult> {
  return {
    descriptor: {
      id: "manufacturing.workcell.audit",
      version: "1.4.0",
      label: "工位空间、机器人与人工作业体检",
      kind: "analysis",
      execution: "in-process",
      permissions: ["manufacturing.read"],
      timeoutMs: 5_000,
      inputSchemaVersion: "1.4",
      outputSchemaVersion: "1.4",
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
          ...(output.loadChecks.some((item) => item.status === "needs-data") ? ["机器人负载、TCP 或组合重心证据不完整"] : []),
          ...(output.loadChecks.some((item) => item.status === "exceeds-planning-envelope") ? ["机器人负载超出规划包络"] : []),
          ...(output.planningEvidence?.status === "needs-data" ? ["安全间隙或场景候选轨迹的规划基准尚未确认/声明"] : []),
          ...(output.ergonomicsChecks?.some((item) => item.status === "needs-data") ? ["人工作业人体、作业点或筛查策略证据不完整"] : []),
          ...(output.ergonomicsChecks?.some((item) => item.status === "fail") ? ["人工作业超出规划筛查阈值"] : []),
        ],
        suggestedActions: [{ id: "create-validation-study", label: "创建验证任务", commandType: "validation-study.create", input: { sceneId: output.sceneId, fingerprint: output.evidenceFingerprint }, risk: "low", requiresConfirmation: false }],
      };
    },
  };
}
