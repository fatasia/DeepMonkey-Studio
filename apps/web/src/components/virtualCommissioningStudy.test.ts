import { describe, expect, it } from "vitest";
import type { IndustrialValidationStudyRecord, SceneSnapshot, VirtualDebugSignalBinding } from "@bim-studio/contracts";
import { buildVirtualCommissioningStudyInput, matchingVirtualCommissioningStudy } from "./virtualCommissioningStudy";

const scene = {
  schemaVersion: 1,
  id: "scene-1",
  projectId: "project-1",
  name: "装配工位",
  models: [],
  primitives: [],
  measurements: [],
  updatedAt: "2026-08-31T08:00:00.000Z",
} as unknown as SceneSnapshot;
const bindings: VirtualDebugSignalBinding[] = [{
  id: "binding-1",
  signal: "motorRunning",
  presentation: "running",
  target: { sceneId: scene.id, objectId: "robot-1", objectKind: "model" },
}];

describe("virtual commissioning Study evidence", () => {
  it("saves exact scenario, execution and scene evidence", () => {
    const scenario = { id: "scenario-1", durationMs: 1000, commands: [{ atMs: 0, type: "start" as const }] };
    const input = buildVirtualCommissioningStudyInput({
      scene,
      bindings,
      scenarioInput: scenario,
      engineId: "simulation.virtual-debug.run",
      latest: { status: "passed", scenarioId: scenario.id, evidenceFingerprint: "evidence-1", failureCount: 0 },
      completedAt: "2026-08-31T08:01:00.000Z",
    });

    expect(input).toMatchObject({
      studyType: "virtual-commissioning",
      sceneId: scene.id,
      objectIds: ["robot-1"],
      scenarioInput: scenario,
      execution: { engineId: "simulation.virtual-debug.run", engineVersion: "1.0.0", deterministic: true },
      context: { sceneFingerprint: expect.any(String), modelFingerprint: expect.any(String), versionFingerprint: expect.any(String) },
      latestResult: { status: "passed", completedAt: "2026-08-31T08:01:00.000Z" },
    });
  });

  it("creates a new linked result instead of overwriting the baseline", () => {
    const baseline = {
      id: "study-1",
      title: "虚拟验收：装配工位",
      sourceKind: "manual",
      studyType: "virtual-commissioning",
      sourceRefs: ["evidence-1"],
      objective: "验证控制逻辑",
      acceptanceCriteria: ["联锁正确"],
    } as IndustrialValidationStudyRecord;
    const input = buildVirtualCommissioningStudyInput({
      scene,
      bindings,
      baseline,
      scenarioInput: { id: "suite-1", label: "黄金矩阵", cases: [] },
      engineId: "simulation.virtual-debug.run-suite",
      latest: { status: "failed", scenarioId: "suite-1", evidenceFingerprint: "evidence-2", failureCount: 1 },
    });

    expect(input).not.toHaveProperty("id");
    expect(input).toMatchObject({
      baselineStudyId: baseline.id,
      reproductionOf: baseline.id,
      sourceRefs: ["evidence-1", "evidence-2"],
    });
    expect(matchingVirtualCommissioningStudy(baseline)).toBe(baseline);
    expect(matchingVirtualCommissioningStudy({ sourceKind: "workcell-audit" } as IndustrialValidationStudyRecord)).toBeUndefined();
  });
});
