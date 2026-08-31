import { describe, expect, it } from "vitest";
import { assessBatteryRelease, BATTERY_MODEL_CATALOG, validateBatteryCatalog } from "./battery.js";

describe("battery model catalog", () => {
  it("publishes PINN/PINO/TwinMoE through the production routing chain", () => {
    const byId = new Map(BATTERY_MODEL_CATALOG.map((entry) => [entry.id, entry]));
    expect(["battery.bmsformer", "battery.socformer", "battery.batterymformer"].every((id) => byId.get(id)?.outputAuthority === "primary")).toBe(true);
    expect(["battery.batterymformer-pinn", "battery.spm-pino", "battery.twin-moe"].every((id) => {
      const entry = byId.get(id);
      return entry?.status === "production" && entry.runtimeEnabled && entry.productionEligible === true;
    })).toBe(true);
    expect(byId.get("battery.twin-moe")?.role).toBe("production-router");
    expect(byId.get("battery.twin-moe")?.outputAuthority).toBe("primary");
    expect(byId.get("battery.electrothermal-baseline")?.role).toBe("primary-baseline");
    expect(byId.get("battery.spm-fallback")?.role).toBe("safety-fallback");
    expect(validateBatteryCatalog()).toEqual([]);
  });

  it("reports the formal release boundary without pretending ONNX is ready", () => {
    const assessment = assessBatteryRelease();
    expect(assessment.ready).toBe(true);
    expect(assessment.primaryModels).toEqual(expect.arrayContaining([
      "battery.bmsformer", "battery.socformer", "battery.batterymformer"
    ]));
    expect(assessment.routedModels).toEqual(expect.arrayContaining([
      "battery.batterymformer-pinn", "battery.spm-pino", "battery.twin-moe"
    ]));
    expect(assessment.shadowModels).toEqual([]);
    expect(assessment.onnxPrimaryModels).toEqual([]);
    expect(assessment.onnxMigration).toMatchObject({ ready: false, eligibleModelIds: [], missingModelIds: [
      "battery.bmsformer", "battery.socformer", "battery.batterymformer"
    ] });
    expect(assessment.warnings.join(" ")).toContain("ONNX");
  });

  it("requires task-specific equivalence evidence for every formal ONNX model", () => {
    const manifest = {
      schemaVersion: 1 as const,
      modelId: "battery.socformer" as const,
      source: { modelVersion: "socformer-li-hybrid-v2", checkpointSha256: "a".repeat(64) },
      artifact: { fileName: "socformer.onnx", sha256: "b".repeat(64), sizeBytes: 100, opset: 18 as const, precision: "fp32" as const },
      runtimeAdapter: { fileName: "socformer.runtime-adapter.json", sha256: "d".repeat(64), sizeBytes: 200, schemaVersion: 1 as const },
      contract: {
        input: "socformer-normalized-sequence-window-v1",
        output: "soc-fraction-v1",
        preprocessing: "socformer-sequence-anchor-v1",
        postprocessing: "socformer-hybrid-soc-product-v1"
      },
      validation: {
        outputs: [{ task: "soc" as const, samples: 70, maxAbsoluteError: 0.0001, meanAbsoluteError: 0.00001, allowedMaxAbsoluteError: 0.001, allowedMeanAbsoluteError: 0.0001 }],
        boundaryCases: 8, boundaryPassed: 8, outOfDomainCases: 4, outOfDomainPassed: 4,
        invalidInputCases: 6, invalidInputRejected: 6, repeatRuns: 5, maxRepeatDrift: 0, allowedRepeatDrift: 1e-7,
        businessReplayCases: 3, businessReplayPassed: 3
      },
      approval: {
        decisionStatus: "production-approved" as const,
        independentDatasetSplit: true,
        externalLockboxCases: 1,
        approvedBy: "battery-release-board",
        approvedAt: "2026-08-29T00:00:00.000Z",
        evidenceFingerprint: "c".repeat(64)
      },
      generatedAt: "2026-08-29T00:00:00.000Z"
    };
    const assessment = assessBatteryRelease(BATTERY_MODEL_CATALOG, [manifest]).onnxMigration;
    expect(assessment.eligibleModelIds).toEqual(["battery.socformer"]);
    expect(assessment.ready).toBe(false);
    expect(assessment.missingModelIds).toEqual(["battery.bmsformer", "battery.batterymformer"]);

    const invalidTimestamp = assessBatteryRelease(BATTERY_MODEL_CATALOG, [{ ...manifest, generatedAt: "2026-08-29" }]).onnxMigration;
    expect(invalidTimestamp.eligibleModelIds).toEqual([]);
    expect(invalidTimestamp.blockers.join(" ")).toContain("清单生成时间无效");

    const prematureApproval = assessBatteryRelease(BATTERY_MODEL_CATALOG, [{
      ...manifest,
      generatedAt: "2026-08-30T00:00:00.000Z",
    }]).onnxMigration;
    expect(prematureApproval.eligibleModelIds).toEqual([]);
    expect(prematureApproval.blockers.join(" ")).toContain("批准时间早于清单生成时间");

    const wrongContract = assessBatteryRelease(BATTERY_MODEL_CATALOG, [{
      ...manifest,
      contract: { ...manifest.contract, preprocessing: "socformer-sequence-anchor-v0" },
    }]).onnxMigration;
    expect(wrongContract.eligibleModelIds).toEqual([]);
    expect(wrongContract.blockers.join(" ")).toContain("合同版本与正式运行时不一致");
  });

  it("keeps a tensor-equivalent but unapproved manifest on the Python production path", () => {
    const candidate = {
      schemaVersion: 1 as const,
      modelId: "battery.socformer" as const,
      source: { modelVersion: "socformer-li-hybrid-v2", checkpointSha256: "a".repeat(64) },
      artifact: { fileName: "socformer.onnx", sha256: "b".repeat(64), sizeBytes: 100, opset: 18 as const, precision: "fp32" as const },
      runtimeAdapter: { fileName: "socformer.runtime-adapter.json", sha256: "d".repeat(64), sizeBytes: 200, schemaVersion: 1 as const },
      contract: {
        input: "socformer-normalized-sequence-window-v1",
        output: "soc-fraction-v1",
        preprocessing: "socformer-sequence-anchor-v1",
        postprocessing: "socformer-hybrid-soc-product-v1"
      },
      validation: {
        outputs: [{ task: "soc" as const, samples: 70, maxAbsoluteError: 0, meanAbsoluteError: 0, allowedMaxAbsoluteError: 0.001, allowedMeanAbsoluteError: 0.0001 }],
        boundaryCases: 8, boundaryPassed: 8, outOfDomainCases: 4, outOfDomainPassed: 4,
        invalidInputCases: 6, invalidInputRejected: 6, repeatRuns: 5, maxRepeatDrift: 0, allowedRepeatDrift: 1e-7,
        businessReplayCases: 3, businessReplayPassed: 3
      },
      approval: { decisionStatus: "candidate" as const, independentDatasetSplit: false, externalLockboxCases: 0 },
      generatedAt: "2026-08-29T00:00:00.000Z"
    };
    const assessment = assessBatteryRelease(BATTERY_MODEL_CATALOG, [candidate]).onnxMigration;
    expect(assessment.eligibleModelIds).toEqual([]);
    expect(assessment.blockers.join(" ")).toContain("未经生产批准");
  });

  it("blocks a catalog when RUL primary coverage is removed", () => {
    const withoutRul = BATTERY_MODEL_CATALOG.map((entry) => entry.id === "battery.batterymformer"
      ? { ...entry, tasks: ["soh"] as const }
      : entry);
    const assessment = assessBatteryRelease(withoutRul);
    expect(assessment.ready).toBe(false);
    expect(assessment.blockers.join(" ")).toContain("RUL");
  });
});
