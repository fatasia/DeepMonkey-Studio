import type {
  IndustrialValidationStudyRecord,
  JsonValue,
  SaveIndustrialValidationStudyInput,
  SceneSnapshot,
  VirtualDebugScenario,
  VirtualDebugSignalBinding,
  VirtualDebugSuite,
} from "@bim-studio/contracts";
import { buildIndustrialStudyContext } from "./industrialStudyFingerprints";

const ENGINE_VERSION = "1.0.0";

export function buildVirtualCommissioningStudyInput({
  scene,
  bindings,
  latest,
  scenarioInput,
  engineId,
  baseline,
  completedAt = new Date().toISOString(),
}: {
  scene: SceneSnapshot;
  bindings: VirtualDebugSignalBinding[];
  latest: {
    status: "passed" | "failed";
    scenarioId: string;
    evidenceFingerprint: string;
    failureCount: number;
  };
  scenarioInput: VirtualDebugScenario | VirtualDebugSuite;
  engineId: "simulation.virtual-debug.run" | "simulation.virtual-debug.run-suite";
  baseline?: IndustrialValidationStudyRecord;
  completedAt?: string;
}): SaveIndustrialValidationStudyInput {
  const previous = matchingVirtualCommissioningStudy(baseline);
  return {
    ...(previous
      ? {
          title: previous.title,
          sourceKind: previous.sourceKind,
          sourceRefs: [...previous.sourceRefs, latest.evidenceFingerprint],
          objective: previous.objective,
          acceptanceCriteria: previous.acceptanceCriteria,
          baselineStudyId: previous.id,
          reproductionOf: previous.id,
        }
      : {
          title: `虚拟验收：${scene.name}`,
          sourceKind: "manual" as const,
          sourceRefs: [latest.evidenceFingerprint],
          objective: "验证设备控制、故障锁存、复位与异常检出逻辑",
          acceptanceCriteria: ["正常启动可复现", "故障正确锁存", "复位恢复", "错误逻辑可检出"],
        }),
    studyType: "virtual-commissioning",
    sceneId: scene.id,
    objectIds: [...new Set(bindings.map((binding) => binding.target.objectId))],
    scenarioInput: structuredClone(scenarioInput) as unknown as JsonValue,
    execution: { engineId, engineVersion: ENGINE_VERSION, deterministic: true },
    context: buildIndustrialStudyContext(scene, engineId, ENGINE_VERSION),
    latestResult: { ...latest, completedAt },
  };
}

export function matchingVirtualCommissioningStudy(
  study: IndustrialValidationStudyRecord | undefined,
): IndustrialValidationStudyRecord | undefined {
  if (study?.studyType === "virtual-commissioning") return study;
  if (study?.sourceKind && study.sourceKind !== "workcell-audit") return study;
  return undefined;
}
