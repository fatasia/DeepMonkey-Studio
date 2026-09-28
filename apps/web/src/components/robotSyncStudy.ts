import type { IndustrialValidationStudyRecord, JsonValue, RobotSyncResult, RobotSyncScenario, SaveIndustrialValidationStudyInput, SceneSnapshot } from "@bim-studio/contracts";
import { createEvidenceFingerprint } from "@bim-studio/studio-core";
import { buildIndustrialStudyContext } from "./industrialStudyFingerprints";

export const ROBOT_SYNC_ENGINE = "manufacturing.robot-sync.emulated";
const ENGINE_VERSION = "1.0.0";

export interface RobotSyncSettings {
  robotIds: [string, string];
  durations: [number, number];
  waits: [string, string];
  sets: [string, string];
  timeoutSeconds: number;
  clearMeters: number;
}

export function defaultRobotSyncSettings(scene: SceneSnapshot): RobotSyncSettings | undefined {
  const ids = [...new Set(scene.models.filter((model) => model.rig?.robot?.enabled).map((model) => model.modelId))];
  if (ids.length < 2) return undefined;
  return { robotIds: [ids[0]!, ids[1]!], durations: [0, 0], waits: ["", "robot-1-done"], sets: ["robot-1-done", "robot-2-done"], timeoutSeconds: 10, clearMeters: 0 };
}

export function buildRobotSyncScenario(scene: SceneSnapshot, settings: RobotSyncSettings): RobotSyncScenario {
  const validRobotIds = new Set(scene.models.filter((model) => model.rig?.robot?.enabled).map((model) => model.modelId));
  if (settings.robotIds[0] === settings.robotIds[1] || settings.robotIds.some((id) => !validRobotIds.has(id))) {
    throw new Error("请选择当前工位内两台不同的已配置机器人");
  }
  if (settings.durations.some((value) => !Number.isFinite(value) || value <= 0 || value > 3600)
    || !Number.isFinite(settings.timeoutSeconds) || settings.timeoutSeconds <= 0 || settings.timeoutSeconds > 3600
    || !Number.isFinite(settings.clearMeters) || settings.clearMeters < 0 || settings.clearMeters > 100) {
    throw new Error("运动时长与超时须在 0–3600 s 内，活动窗口互斥阈值须在 0–100 m 内");
  }
  const signals = [...settings.waits, ...settings.sets];
  if (signals.some((value) => value.length > 64 || value.trim() !== value || (value && !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(value)))) {
    throw new Error("信号名须为 1–64 位英文字母、数字、下划线或连字符，且以字母开头；留空表示不使用");
  }
  return {
    scenarioId: `robot-sync:${scene.id}`,
    ...(settings.clearMeters > 0 ? { clearMeters: settings.clearMeters } : {}),
    programs: settings.robotIds.map((robotStableId, index) => ({
      programId: `program-${index + 1}`,
      robotStableId,
      steps: [
        ...(settings.waits[index] ? [{ stepId: `wait-${index + 1}`, robotStableId, waitSignal: settings.waits[index], timeoutSeconds: settings.timeoutSeconds }] : []),
        { stepId: `move-${index + 1}`, robotStableId, durationSeconds: settings.durations[index]! },
        ...(settings.sets[index] ? [{ stepId: `set-${index + 1}`, robotStableId, setSignal: settings.sets[index] }] : []),
      ],
    })),
  };
}

export function matchingRobotSyncStudy(study: IndustrialValidationStudyRecord | undefined, sceneId: string) {
  return study?.sourceKind === "workcell-audit" && study.sceneId === sceneId && study.execution?.engineId === ROBOT_SYNC_ENGINE ? study : undefined;
}

export function robotSyncEvidenceFromStudy(study: IndustrialValidationStudyRecord | undefined): {
  scenario: RobotSyncScenario; result: RobotSyncResult; settings: RobotSyncSettings;
} | undefined {
  if (study?.execution?.engineId !== ROBOT_SYNC_ENGINE || !study.scenarioInput || typeof study.scenarioInput !== "object" || Array.isArray(study.scenarioInput)) return undefined;
  const input = study.scenarioInput as Record<string, unknown>;
  if (input.kind !== "robot-sync-v1" || !input.scenario || !input.result || !input.settings) return undefined;
  const scenario = input.scenario as Partial<RobotSyncScenario>;
  const result = input.result as Partial<RobotSyncResult>;
  const settings = input.settings as Partial<RobotSyncSettings>;
  if (scenario.scenarioId !== study.latestResult?.scenarioId || !Array.isArray(scenario.programs) || scenario.programs.length !== 2
    || scenario.programs.some((program) => !program || !Array.isArray(program.steps))
    || !Array.isArray(result.timeline) || !Array.isArray(result.violations)
    || !["completed", "deadlock", "signal-timeout"].includes(result.status ?? "")
    || !Number.isFinite(result.cycleSeconds) || !Array.isArray(settings.robotIds) || settings.robotIds.length !== 2
    || !Array.isArray(settings.durations) || settings.durations.length !== 2
    || !Array.isArray(settings.waits) || settings.waits.length !== 2 || !Array.isArray(settings.sets) || settings.sets.length !== 2) return undefined;
  const evidenceFingerprint = createEvidenceFingerprint({ scenario: input.scenario, result: input.result });
  if (evidenceFingerprint !== study.latestResult?.evidenceFingerprint) return undefined;
  return { scenario: input.scenario as unknown as RobotSyncScenario, result: input.result as unknown as RobotSyncResult, settings: input.settings as unknown as RobotSyncSettings };
}

export function buildRobotSyncStudyInput(scene: SceneSnapshot, settings: RobotSyncSettings, scenario: RobotSyncScenario, result: RobotSyncResult, existing?: IndustrialValidationStudyRecord): SaveIndustrialValidationStudyInput {
  const fingerprint = createEvidenceFingerprint({ scenario, result });
  const failureCount = (result.status === "completed" ? 0 : 1) + result.violations.length;
  return {
    ...(existing ? { id: existing.id, expectedRevision: existing.revision } : {}),
    title: `多机器人信号互锁：${scene.name}`,
    sourceKind: "workcell-audit", studyType: "workcell-audit", sceneId: scene.id,
    objectIds: [...settings.robotIds],
    sourceRefs: [...(existing?.sourceRefs ?? []), fingerprint],
    objective: "验证仿真控制器级信号等待、置位、超时与活动窗口互斥顺序",
    acceptanceCriteria: ["全部信号等待解除且无死锁/超时", "活动窗口无潜在间隙推迟事件", "几何干涉与真实控制器认证另行验收"],
    scenarioInput: structuredClone({ kind: "robot-sync-v1", settings, scenario, result }) as unknown as JsonValue,
    execution: { engineId: ROBOT_SYNC_ENGINE, engineVersion: ENGINE_VERSION, deterministic: true },
    context: buildIndustrialStudyContext(scene, ROBOT_SYNC_ENGINE, ENGINE_VERSION),
    latestResult: { status: failureCount === 0 ? "passed" : "failed", scenarioId: scenario.scenarioId, evidenceFingerprint: fingerprint, failureCount, completedAt: new Date().toISOString() },
  };
}
