import { describe, expect, it } from "vitest";
import type { IndustrialValidationStudyRecord } from "@bim-studio/contracts";
import { runPlantLiteStudy } from "./plantLiteStudy";
import { runWhatIfStudy } from "./whatIfStudy";
import { buildOperationsStudyIndex } from "./operationsStudyIndex";
import { buildValidationStudyRecord } from "./validationStudy";
import { evidenceFingerprint } from "./operationsEngine.js";

describe("unified operations Study index", () => {
  it("projects four authoritative result types without duplicating solver records", () => {
    const plant = runPlantLiteStudy("project-1", {
      name: "AGV 基线",
      seed: "fixed",
      replications: 2,
    }, "2026-08-31T08:00:00.000Z");
    const whatIf = runWhatIfStudy("project-1", {
      name: "节拍变化",
      input: {
        baselines: [{ metricId: "throughput", value: 100 }],
        changes: [{ variableId: "cycle-time", delta: -0.1, mode: "relative" }],
        elasticities: [{
          variableId: "cycle-time",
          metricId: "throughput",
          coefficient: -0.8,
          inputMode: "relative",
          outputMode: "relative",
          reliability: 0.9,
        }],
        constraints: [{ constraintId: "throughput-min", metricId: "throughput", minimum: 90, severity: "critical" }],
        applicabilityDomain: {
          variableRanges: [{ variableId: "cycle-time", mode: "relative", minimumDelta: -0.2, maximumDelta: 0.2 }],
          metricRanges: [{ metricId: "throughput", minimum: 80, maximum: 130 }],
        },
      },
    }, "2026-08-31T08:01:00.000Z");
    const workcell = validationStudy({
      title: "焊装工位体检",
      sourceKind: "workcell-audit",
      studyType: "workcell-audit",
      scenarioInput: { sceneId: "scene-1", objects: [{ id: "robot-1" }] },
      execution: { engineId: "manufacturing.workcell.audit", engineVersion: "1.1.0", deterministic: true },
      context: { sceneFingerprint: "scene-fp", modelFingerprint: "model-fp", versionFingerprint: "version-fp" },
      latestResult: {
        status: "failed",
        scenarioId: "workcell-audit:scene-1",
        evidenceFingerprint: "workcell-evidence",
        failureCount: 2,
        completedAt: "2026-08-31T08:02:00.000Z",
      },
    });
    const virtual = validationStudy({
      title: "虚拟验收",
      sourceKind: "manual",
      studyType: "virtual-commissioning",
      scenarioInput: { id: "scenario-1", durationMs: 1000 },
      execution: { engineId: "simulation.virtual-debug.run", engineVersion: "1.0.0", deterministic: true },
      context: { sceneFingerprint: "scene-fp", modelFingerprint: "model-fp", versionFingerprint: "version-fp" },
      baselineStudyId: "virtual-baseline",
      reproductionOf: "virtual-baseline",
      latestResult: {
        status: "passed",
        scenarioId: "scenario-1",
        evidenceFingerprint: "virtual-evidence",
        failureCount: 0,
        completedAt: "2026-08-31T08:03:00.000Z",
      },
    });

    const studies = buildOperationsStudyIndex({
      plantLiteStudies: [plant],
      whatIfStudies: [whatIf],
      validationStudies: [workcell, virtual],
    });

    expect(studies.map((study) => study.type).sort()).toEqual([
      "plant-lite",
      "virtual-commissioning",
      "what-if",
      "workcell-audit",
    ]);
    expect(studies.find((study) => study.type === "plant-lite")).toMatchObject({
      scenarioInput: { seed: "fixed", replications: 2 },
      fingerprints: { input: plant.inputFingerprint, scene: null, model: null },
      reproduction: { kind: "rerun", operationsTab: "logistics" },
    });
    expect(studies.find((study) => study.type === "plant-lite")?.fingerprints.version).toBe(
      evidenceFingerprint({ engineId: "plant-lite-des", engineVersion: "1.0.0" }),
    );
    expect(studies.find((study) => study.type === "workcell-audit")).toMatchObject({
      context: { sceneId: "scene-1" },
      fingerprints: { scene: "scene-fp", model: "model-fp", evidence: "workcell-evidence" },
      run: { status: "failed" },
      result: { metrics: [{ key: "failures", value: 2 }] },
    });
    expect(studies.find((study) => study.type === "what-if")).toMatchObject({
      fingerprints: { scene: null, model: null, evidence: whatIf.result.evidenceFingerprint },
    });
    expect(studies.find((study) => study.type === "virtual-commissioning")).toMatchObject({
      lineage: {
        baselineStudyId: "virtual-commissioning:virtual-baseline",
        reproductionOf: "virtual-commissioning:virtual-baseline",
      },
      reproduction: { kind: "open-workbench", operationsTab: "commissioning" },
    });
  });

  it("marks legacy validation evidence as missing instead of fabricating it", () => {
    const legacy = validationStudy({ title: "旧任务卡", sourceKind: "manual" });
    const [study] = buildOperationsStudyIndex({ plantLiteStudies: [], whatIfStudies: [], validationStudies: [legacy] });
    expect(study).toMatchObject({
      type: "virtual-commissioning",
      scenarioInput: null,
      execution: null,
      fingerprints: { input: null, scene: null, model: null, evidence: null },
      run: { status: "ready" },
    });
  });
});

function validationStudy(
  overrides: Partial<Parameters<typeof buildValidationStudyRecord>[1]>,
): IndustrialValidationStudyRecord {
  return buildValidationStudyRecord("project-1", {
    title: "验证 Study",
    sourceKind: "manual",
    sourceRefs: [],
    sceneId: "scene-1",
    objectIds: ["robot-1"],
    objective: "验证工况",
    acceptanceCriteria: ["结果可复现"],
    ...overrides,
  });
}
