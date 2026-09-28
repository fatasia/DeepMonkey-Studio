import type { IndustrialValidationStudyRecord, SceneSnapshot } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { runRobotSyncScenario } from "@bim-studio/workcell-validation-plugin";
import { buildRobotSyncScenario, buildRobotSyncStudyInput, defaultRobotSyncSettings, matchingRobotSyncStudy, robotSyncEvidenceFromStudy } from "./robotSyncStudy";

const scene: SceneSnapshot = {
  schemaVersion: 1, id: "workcell-1", projectId: "project-1", name: "双机装配", camera: { position: { x: 2, y: 2, z: 2 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
  models: ["robot-a", "robot-b"].map((modelId) => ({
    modelId, name: modelId, visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
    rig: { bones: [], ik: [], robot: { enabled: true, baseBonePath: "root", joints: [] } },
  })), primitives: [], measurements: [], createdAt: "2026-09-28T00:00:00.000Z", updatedAt: "2026-09-28T00:00:00.000Z",
};

function runWithSettings(change: (settings: NonNullable<ReturnType<typeof defaultRobotSyncSettings>>) => void = () => {}) {
  const settings = defaultRobotSyncSettings(scene)!;
  settings.durations = [2, 2];
  change(settings);
  const scenario = buildRobotSyncScenario(scene, settings);
  return { settings, scenario, result: runRobotSyncScenario(scenario) };
}

describe("robot sync production Study consumer", () => {
  it("reuses robotSync handshake with explicit durations and saves a reopenable report", () => {
    const { settings, scenario, result } = runWithSettings();
    expect(result).toMatchObject({ status: "completed", cycleSeconds: 4, violations: [] });
    expect(result.timeline.map((item) => item.event)).toContain("signal-acquired");
    const input = buildRobotSyncStudyInput(scene, settings, scenario, result);
    const record: IndustrialValidationStudyRecord = {
      ...input, id: "study-1", projectId: "project-1", revision: 1,
      title: input.title!, sourceKind: "workcell-audit", studyType: "workcell-audit", sceneId: scene.id,
      objectIds: input.objectIds!, sourceRefs: input.sourceRefs!, objective: input.objective!, acceptanceCriteria: input.acceptanceCriteria!,
      execution: { ...input.execution!, inputFingerprint: "input-1" },
      status: "passed", createdAt: scene.createdAt, updatedAt: scene.updatedAt,
    };
    expect(matchingRobotSyncStudy(record, scene.id)).toBeDefined();
    expect(robotSyncEvidenceFromStudy(record)).toMatchObject({ settings, scenario, result });
    expect(robotSyncEvidenceFromStudy({ ...record, latestResult: { ...input.latestResult!, evidenceFingerprint: "tampered" } })).toBeUndefined();
    const repeat = buildRobotSyncStudyInput(scene, settings, scenario, result, record);
    expect(repeat).toMatchObject({ id: "study-1", expectedRevision: 1 });
    expect(repeat.latestResult?.evidenceFingerprint).toBe(input.latestResult?.evidenceFingerprint);
  });

  it("exposes deadlock and timeout as failed but retains full diagnostic timeline", () => {
    const deadlock = runWithSettings((settings) => { settings.waits = ["missing-a", "missing-b"]; settings.sets = ["", ""]; settings.timeoutSeconds = 10; });
    expect(deadlock.result.status).toBe("signal-timeout");
    expect(deadlock.result.timeline.filter((item) => item.event === "signal-timeout")).toHaveLength(2);
    const withoutTimeout = runRobotSyncScenario({ ...deadlock.scenario, programs: deadlock.scenario.programs.map((program) => ({ ...program, steps: program.steps.map(({ timeoutSeconds: _ignored, ...step }) => step) })) });
    expect(withoutTimeout.status).toBe("deadlock");
    expect(buildRobotSyncStudyInput(scene, deadlock.settings, deadlock.scenario, deadlock.result).latestResult?.status).toBe("failed");
  });

  it("records conservative activity-window deferral, not actual TCP clearance", () => {
    const { settings, scenario, result } = runWithSettings((draft) => { draft.waits = ["", ""]; draft.sets = ["", ""]; draft.clearMeters = .5; });
    expect(result).toMatchObject({ status: "completed", cycleSeconds: 4 });
    expect(result.violations).toHaveLength(1);
    expect(result.timeline.some((event) => event.event === "deferred-clearance")).toBe(true);
    expect(buildRobotSyncStudyInput(scene, settings, scenario, result).latestResult?.status).toBe("failed");
  });

  it("rejects missing robots, duplicate selection, invalid durations and bad signal names", () => {
    expect(defaultRobotSyncSettings({ ...scene, models: scene.models.slice(0, 1) })).toBeUndefined();
    const settings = defaultRobotSyncSettings(scene)!;
    expect(() => buildRobotSyncScenario(scene, { ...settings, robotIds: ["robot-a", "robot-a"] })).toThrow(/两台不同/);
    expect(() => buildRobotSyncScenario(scene, { ...settings, durations: [NaN, 1] })).toThrow(/运动时长/);
    expect(() => buildRobotSyncScenario(scene, { ...settings, waits: ["", "bad signal"], durations: [2, 2] })).toThrow(/信号名/);
  });
});
