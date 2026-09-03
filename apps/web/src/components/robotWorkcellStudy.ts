import type {
  IndustrialValidationStudyRecord,
  JsonValue,
  SaveIndustrialValidationStudyInput,
  SceneSnapshot,
} from "@bim-studio/contracts";
import { buildIndustrialStudyContext } from "./industrialStudyFingerprints";
import { buildRobotWorkcellAuditInput } from "./robotWorkcellAssistant";
import type { RobotWorkcellAssistantInput, RobotWorkcellAssistantResult } from "./robotWorkcellAssistantTypes";

const ENGINE_ID = "manufacturing.robot-workcell.screening";
const ENGINE_VERSION = "1.1.0";

/**
 * 保存的是任务草稿与快速初筛证据，不把控制逻辑验收或精确机器人校核伪装成已完成。
 */
export function buildRobotWorkcellStudyInput({
  scene,
  input,
  result,
  existing,
  completedAt = new Date().toISOString(),
}: {
  scene: SceneSnapshot;
  input: RobotWorkcellAssistantInput;
  result: RobotWorkcellAssistantResult;
  existing?: IndustrialValidationStudyRecord;
  completedAt?: string;
}): SaveIndustrialValidationStudyInput {
  const passedQuickScreen = result.status === "ready-for-control-validation";
  const blockingCount = result.status === "blocked"
    ? Math.max(1, blockedEvidenceCount(result))
    : result.status === "needs-data"
      ? Math.max(1, result.missingEvidence.length)
      : 0;
  const objectIds = unique([
    result.taskDraft.robotId,
    ...(result.loadScreening.toolObjectId ? [result.loadScreening.toolObjectId] : []),
    ...result.taskDraft.steps.map((step) => step.targetId),
    ...result.collisionScreening.pairs.flatMap((pair) => pair.objectIds),
  ]);
  const sourceRefs = unique([
    ...(existing?.sourceRefs ?? []),
    result.workcellAudit.evidenceFingerprint,
    result.evidenceFingerprint,
  ]);

  return {
    title: `机器人快速初筛：${result.taskDraft.name}`,
    sourceKind: "workcell-audit",
    studyType: "workcell-audit",
    sourceRefs,
    sceneId: scene.id,
    objectIds,
    objective: "记录机器人任务草稿、负载/TCP规划筛查与空间初筛证据，再进入独立的控制逻辑虚拟验收",
    acceptanceCriteria: [
      "任务目标、目标点和关节约束已形成可追溯草稿",
      "额定负载、工具/工件质量、TCP 与组合重心规划筛查已留证且未越界",
      "控制逻辑 I/O、故障、复位与断言在虚拟调试中单独留证",
      "完整 IK、网格级连续扫掠碰撞与真实控制器时序另行完成工程校核",
    ],
    scenarioInput: structuredClone({
      kind: "robot-workcell-quick-screen-v1",
      auditInput: buildRobotWorkcellAuditInput(input),
      taskDraft: result.taskDraft,
      quickScreening: {
        status: result.status,
        audit: result.workcellAudit,
        collision: result.collisionScreening,
        reachability: result.reachability,
        jointLimits: result.jointLimits,
        loadScreening: result.loadScreening,
        cycleBudget: result.cycleBudget,
        missingEvidence: result.missingEvidence,
        remainingEngineeringChecks: result.remainingEngineeringChecks,
        evidenceFingerprint: result.evidenceFingerprint,
      },
    }) as unknown as JsonValue,
    execution: { engineId: ENGINE_ID, engineVersion: ENGINE_VERSION, deterministic: true },
    context: buildIndustrialStudyContext(scene, ENGINE_ID, ENGINE_VERSION),
    ...(existing ? { baselineStudyId: existing.id, reproductionOf: existing.id } : {}),
    latestResult: {
      status: passedQuickScreen ? "passed" : "failed",
      scenarioId: `robot-workcell-screen:${scene.id}:${result.taskDraft.robotId}`,
      evidenceFingerprint: result.evidenceFingerprint,
      failureCount: blockingCount,
      completedAt,
    },
  };
}

function blockedEvidenceCount(result: RobotWorkcellAssistantResult): number {
  const unreachable = result.reachability.filter((item) => item.status === "outside" || item.status === "inner-dead-zone").length;
  const jointViolations = result.jointLimits.filter((item) => item.status === "outside-limit").length;
  const broadPhaseHits = result.collisionScreening.pairs.filter((item) => item.intersects).length;
  const loadViolations = result.loadScreening.status === "exceeds-planning-envelope"
    ? Math.max(1, result.loadScreening.violations.length)
    : 0;
  return unreachable + jointViolations + broadPhaseHits + loadViolations;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function matchingRobotWorkcellStudy(
  study: IndustrialValidationStudyRecord | undefined,
  sceneId: string,
  robotId?: string,
): IndustrialValidationStudyRecord | undefined {
  if (study?.sourceKind !== "workcell-audit" || study.sceneId !== sceneId || study.execution?.engineId !== ENGINE_ID) return undefined;
  return !robotId || study.objectIds.includes(robotId) ? study : undefined;
}
