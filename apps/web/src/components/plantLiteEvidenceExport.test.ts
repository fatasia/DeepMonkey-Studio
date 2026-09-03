import type { PlantLiteConfidenceInterval, PlantLiteStudyRecord } from "@bim-studio/contracts";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { describe, expect, it } from "vitest";
import {
  buildPlantLiteEvidencePackage,
  plantLiteEvidenceFileStem,
  serializePlantLiteEvidencePackage,
} from "./plantLiteEvidenceExport";
import { plantLiteEvidenceMetricsCsv } from "./plantLiteEvidenceExportCsv";

describe("Plant Lite engineering evidence export", () => {
  it("exports the complete reproducible engineering evidence and selected baseline lineage", () => {
    const study = completeStudy();
    const baseline = completeStudy({ id: "baseline-01", name: "量产基线" });
    study.comparison = { groupId: "sweep-1", baselineStudyId: baseline.id, parameterLabel: "缓冲容量", candidateLabel: "扩至 16" };
    const evidence = buildPlantLiteEvidencePackage(study, baseline, "2026-09-03T08:30:00+08:00");

    expect(evidence).toMatchObject({
      schema: "bim-studio.plant-lite-engineering-evidence.v1",
      generatedBy: "Industrial Studio",
      exportedAt: "2026-09-03T00:30:00.000Z",
      lineage: { baselineRelationship: "comparison-baseline", baseline: { id: "baseline-01" } },
      run: {
        templateId: "agv-line-v1",
        legacyTemplateParameters: { agvCount: null, bufferCapacity: null },
        seed: "fixed-seed", requestedReplications: 12, completedReplications: 12,
        window: { totalMinutes: 600, warmupMinutes: 120, measuredMinutes: 480 },
      },
      trace: {
        capture: { source: "execution-record", replication: 0, maxEvents: 100, maxItems: 20 },
        integrity: { status: "captured-within-scope", configurationMatchesSnapshot: true, fullStudyEventHistory: false },
      },
      capabilityBoundary: {
        statisticalDiscreteEventEvidence: true,
        precisePhysicalSimulation: false,
        certifiedEngineeringConclusion: false,
        productionDispatchable: false,
        tamperProofSignature: false,
      },
    });
    expect(evidence.modelSnapshot).toEqual(study.model);
    expect(evidence.modelSnapshot).not.toBe(study.model);
    expect(evidence.traceability.modelSnapshotFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(evidence.traceability.packageFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(evidence.statistics.nodeMetrics95?.["station-a"]?.changeoverCount?.mean).toBe(4);
    expect(evidence.statistics.resourceFailedMinutes95?.["agv-fleet"]?.mean).toBe(12);
    expect(evidence.statistics.productTypeMetrics95?.["product-a"]?.completionShare.mean).toBe(.6);
    expect(evidence.statistics.changeovers.configuredRules[0]).toMatchObject({ fromProductTypeId: "product-a", toProductTypeId: "product-b", minutes: 3 });
    expect(evidence.statistics.changeovers.capturedEvents).toHaveLength(2);
    expect(evidence.statistics.quality.metrics95?.firstPassYield.mean).toBe(.96);
    expect(evidence.statistics.quality.configuredStations).toContainEqual({ stationId: "station-a", stationName: "装配工位", yieldRate: .98 });
    expect(evidence.statistics.quality.capturedScrapEvents).toHaveLength(1);
    expect(evidence.statistics.quality.reworkIncluded).toBe(false);
    expect(evidence.statistics.energy?.energyPerCompletedItemKwh.mean).toBe(1.5);
    expect(evidence.statistics.bottlenecks[0]).toEqual({ nodeId: "station-a", occurrences: 10, probability: 10 / 12 });
    expect(evidence.acceptanceTargets).toMatchObject({ basis: "项目产能合同", minimumThroughputPerHour: 58 });
    expect(serializePlantLiteEvidencePackage(evidence).endsWith("\n")).toBe(true);
    expect(plantLiteEvidenceFileStem(evidence)).toMatch(/^bim-studio-plant-混流产线-[a-f0-9]{12}$/);
  });

  it("keeps legacy gaps explicit instead of inventing missing model, metrics or trace evidence", () => {
    const legacy = completeStudy();
    delete legacy.model;
    delete legacy.modelFingerprint;
    delete legacy.trace;
    delete legacy.execution.trace;
    delete legacy.execution.limits.warmupMinutes;
    delete legacy.outcome.nodeMetrics95;
    delete legacy.outcome.productTypeMetrics95;
    delete legacy.outcome.quality;
    delete legacy.outcome.energy;
    legacy.agvCount = 3;
    legacy.bufferCapacity = 8;

    const evidence = buildPlantLiteEvidencePackage(legacy, undefined, "2026-09-03T00:00:00Z");
    expect(evidence.lineage.baselineRelationship).toBe("not-provided");
    expect(evidence.run.window).toEqual({ totalMinutes: 600, warmupMinutes: 0, measuredMinutes: 600 });
    expect(evidence.run.legacyTemplateParameters).toEqual({ agvCount: 3, bufferCapacity: 8 });
    expect(evidence.modelSnapshot).toBeNull();
    expect(evidence.traceability.declaredModelFingerprint).toBeNull();
    expect(evidence.traceability.modelSnapshotFingerprint).toBeNull();
    expect(evidence.statistics.nodeMetrics95).toBeNull();
    expect(evidence.statistics.productTypeMetrics95).toBeNull();
    expect(evidence.statistics.energy).toBeNull();
    expect(evidence.trace).toMatchObject({
      capture: null,
      snapshot: null,
      integrity: { status: "missing", configurationMatchesSnapshot: null, capturedEventCount: 0 },
    });
    expect(evidence.evidenceAvailability).toMatchObject({
      modelSnapshot: false, declaredModelFingerprint: false, nodeMetrics: false,
      productMetrics: false, qualityMetrics: false, energyMetrics: false, representativeTrace: false,
    });
  });

  it("marks a bounded truncated trace and reports omitted evidence without overstating completeness", () => {
    const study = completeStudy();
    study.trace = { ...study.trace!, truncated: true, omittedEventCount: 27 };
    study.execution.trace = { replication: 0, maxEvents: 50, maxItems: 20 };

    const evidence = buildPlantLiteEvidencePackage(study);
    expect(evidence.trace.integrity).toMatchObject({
      status: "truncated",
      representativeReplicationOnly: true,
      fullStudyEventHistory: false,
      configurationMatchesSnapshot: false,
      omittedEventCount: 27,
    });
    expect(evidence.trace.integrity.declaration).toContain("不得解释为完整事件历史");
  });

  it("keeps the evidence identity deterministic while excluding only the export timestamp", () => {
    const first = buildPlantLiteEvidencePackage(completeStudy(), undefined, "2026-09-03T00:00:00Z");
    const second = buildPlantLiteEvidencePackage(completeStudy(), undefined, "2026-09-04T00:00:00Z");
    const changed = completeStudy();
    changed.outcome.averageWip = { ...changed.outcome.averageWip, mean: 9 };
    const third = buildPlantLiteEvidencePackage(changed, undefined, "2026-09-03T00:00:00Z");

    expect(first.exportedAt).not.toBe(second.exportedAt);
    expect(first.traceability.packageFingerprint).toBe(second.traceability.packageFingerprint);
    expect(first.packageId).toBe(second.packageId);
    expect(plantLiteEvidenceFileStem(first)).toBe(plantLiteEvidenceFileStem(second));
    expect(third.traceability.packageFingerprint).not.toBe(first.traceability.packageFingerprint);
  });

  it("exports UTF-8 BOM metrics and neutralises spreadsheet formulas in every text field", () => {
    const study = completeStudy({ name: "=HYPERLINK(\"bad\")" });
    study.model!.nodes[1] = { ...study.model!.nodes[1]!, name: "+SUM(A1:A2)" };
    study.model!.resources![0] = { ...study.model!.resources![0]!, name: "@resource" };
    study.model!.productTypes![0] = { ...study.model!.productTypes![0]!, name: "-product" };
    study.acceptanceTargets = { ...study.acceptanceTargets, basis: "\t=CMD" };
    study.outcome.averageWip = { ...study.outcome.averageWip, lower95: -1 };
    const evidence = buildPlantLiteEvidencePackage(study);
    const csv = plantLiteEvidenceMetricsCsv(evidence);

    expect(csv.startsWith("\uFEFFschema,package_id,package_fingerprint")).toBe(true);
    expect(csv).toContain("'=HYPERLINK");
    expect(csv).toContain("'+SUM(A1:A2)");
    expect(csv).toContain("'@resource");
    expect(csv).toContain("'-product");
    expect(csv).toContain(`"'\t=CMD"`);
    expect(csv).toContain(",10,0.5,-1,11,12,");
    expect(csv).toContain("statistical-95-ci");
    expect(csv).toContain("replication-frequency");
    expect(csv).toContain("first_pass_yield");
    expect(csv).toContain("configured_yield_rate");
    expect(csv).toContain("bounded-capture");
  });

  it("rejects evidence that JSON would silently coerce or a non-date export timestamp", () => {
    const invalid = completeStudy();
    invalid.outcome.throughputPerHour.mean = Number.NaN;
    expect(() => buildPlantLiteEvidencePackage(invalid)).toThrow("非有限数值");
    expect(() => buildPlantLiteEvidencePackage(completeStudy(), undefined, "invalid")).toThrow("导出时间无效");
  });
});

function completeStudy(overrides: Partial<PlantLiteStudyRecord> = {}): PlantLiteStudyRecord {
  const model = createAgvLinePlantLiteModel({ bufferCapacity: 16 });
  model.productTypes = [
    { id: "product-a", name: "标准件", share: .6 },
    { id: "product-b", name: "定制件", share: .4 },
  ];
  const station = model.nodes.find((node) => node.id === "station-a");
  if (station?.kind === "station") {
    station.changeovers = [{ fromProductTypeId: "product-a", toProductTypeId: "product-b", minutes: 3 }];
    station.yieldRate = .98;
  }
  const ci = (mean: number, lower95 = mean - 1, upper95 = mean + 1): PlantLiteConfidenceInterval => ({
    mean, sampleStandardDeviation: .5, lower95, upper95, samples: 12,
  });
  return {
    id: "study-01", projectId: "project-01", name: "混流产线", createdAt: "2026-09-02T00:00:00.000Z",
    templateId: "agv-line-v1", model, modelFingerprint: "sha256:model", seed: "fixed-seed", replications: 12,
    inputFingerprint: "sha256:input",
    acceptanceTargets: { basis: "项目产能合同", minimumThroughputPerHour: 58, maximumAverageWip: 12, maximumEnergyPerCompletedItemKwh: 1.6 },
    trace: {
      engineId: "plant-lite-des", engineVersion: "1.0.0", replication: 0, seed: 42,
      capturedItemCount: 2, omittedEventCount: 0, truncated: false, limits: { maxEvents: 100, maxItems: 20 },
      events: [
        { sequence: 0, atMinute: 0, type: "item-enter", itemId: "source:1", nodeId: "source", productTypeId: "product-a" },
        { sequence: 1, atMinute: 1, type: "item-changeover-start", itemId: "source:1", nodeId: "station-a", productTypeId: "product-b", changeover: { fromProductTypeId: "product-a", toProductTypeId: "product-b", startMinute: 1, durationMinutes: 3 } },
        { sequence: 2, atMinute: 4, type: "item-changeover-complete", itemId: "source:1", nodeId: "station-a", productTypeId: "product-b", changeover: { fromProductTypeId: "product-a", toProductTypeId: "product-b", startMinute: 1, durationMinutes: 3 } },
        { sequence: 3, atMinute: 5, type: "item-exit", itemId: "source:1", nodeId: "sink", productTypeId: "product-b" },
        { sequence: 4, atMinute: 6, type: "item-scrap", itemId: "source:2", nodeId: "station-a", productTypeId: "product-a", quality: { configuredYieldRate: .98, disposition: "scrap" } },
      ],
    },
    outcome: {
      status: "completed", completedReplications: 12,
      throughputPerHour: ci(60, 58, 62), averageWip: ci(10, 9, 11), averageLeadTimeMinutes: ci(8, 7, 9),
      nodeMetrics95: {
        "station-a": { utilization: ci(.82, .8, .84), averageQueueLength: ci(3), blockedMinutes: ci(2), starvedMinutes: ci(1), changeoverCount: ci(4), changeoverMinutes: ci(12) },
      },
      resourceUtilization95: { "agv-fleet": ci(.7, .67, .73) },
      resourceFailedMinutes95: { "agv-fleet": ci(12, 10, 14) },
      productTypeMetrics95: {
        "product-a": { completedItems: ci(36), completionShare: ci(.6, .58, .62), throughputPerHour: ci(36) },
        "product-b": { completedItems: ci(24), completionShare: ci(.4, .38, .42), throughputPerHour: ci(24) },
      },
      quality: {
        goodOutputItems: ci(96), scrapItems: ci(4), firstPassYield: ci(.96, .94, .98),
        stationMetrics95: { "station-a": { inspectedItems: ci(100), goodItems: ci(98), scrapItems: ci(2), firstPassYield: ci(.98, .97, .99) } },
      },
      energy: energyOutcome(ci),
      bottlenecks: [{ nodeId: "station-a", occurrences: 10, probability: 10 / 12 }],
    },
    execution: {
      engineId: "plant-lite-des", engineVersion: "1.0.0", inputFingerprint: "sha256:input", deterministic: true,
      limits: { durationMinutes: 600, warmupMinutes: 120, maxEvents: 100_000, maxResources: 100 },
      trace: { replication: 0, maxEvents: 100, maxItems: 20 },
    },
    ...overrides,
  };
}

function energyOutcome(ci: (mean: number, lower95?: number, upper95?: number) => PlantLiteConfidenceInterval): NonNullable<PlantLiteStudyRecord["outcome"]["energy"]> {
  return {
    activeEnergyKwh: ci(80), idleEnergyKwh: ci(20), totalEnergyKwh: ci(100), energyPerCompletedItemKwh: ci(1.5),
    electricityCost: ci(85), electricityCostPerCompletedItem: ci(1.275), carbonEmissionKg: ci(58),
    carbonEmissionPerCompletedItemKg: ci(.87), peakDemandKw: ci(28), consumerEnergyKwh: { "agv-fleet": ci(28) },
  };
}
