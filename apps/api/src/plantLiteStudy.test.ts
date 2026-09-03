import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createApiServer } from "./serverOptions.js";
import { OperationsService } from "./operations.js";
import { registerOperationsRoutes } from "./operationsRoutes.js";
import { plantLiteRequestFromRecord, runPlantLiteStudy } from "./plantLiteStudy.js";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((action) => action())); });

describe("Plant Lite study adapter", () => {
  it("marks one replication as insufficient data instead of overstating a confidence interval", () => {
    const result = runPlantLiteStudy("project-1", { name: "单次试跑", seed: "fixed", replications: 1 }, "2026-08-31T08:00:00.000Z");
    expect(result).toMatchObject({ templateId: "agv-line-v1", outcome: { status: "insufficient-data", completedReplications: 1, throughputPerHour: { samples: 1 } } });
  });

  it("persists a bounded DES study and exactly reproduces its evidence and statistics", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-plant-lite-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new OperationsService(directory); await service.init();
    const app = createApiServer(); cleanups.push(() => app.close());
    await registerOperationsRoutes(app, { service, store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never });
    const payload = { name: "AGV 基线", agvCount: 3, bufferCapacity: 8, seed: "baseline-42", replications: 3 };
    const first = await app.inject({ method: "POST", url: "/api/projects/project-1/operations/logistics/des-studies", payload });
    expect(first.statusCode).toBe(200);
    const baseline = first.json() as {
      id: string;
      inputFingerprint: string;
      execution: { inputFingerprint: string; engineVersion: string; trace: { replication: number; maxEvents: number; maxItems: number } };
      trace: { engineVersion: string; events: Array<{ type: string; nodeId?: string }>; limits: { maxEvents: number; maxItems: number } };
      outcome: { status: string; throughputPerHour: { samples: number } };
    };
    expect(baseline).toMatchObject({
      execution: { engineVersion: "1.0.0", trace: { replication: 0, maxEvents: 2_000, maxItems: 100 } },
      trace: { engineVersion: "1.0.0", limits: { maxEvents: 2_000, maxItems: 100 } },
      outcome: { status: "completed", throughputPerHour: { samples: 3 } },
    });
    expect(baseline.trace.events).toContainEqual(expect.objectContaining({ type: "item-complete", nodeId: "sink" }));
    expect(baseline.execution.inputFingerprint).toBe(baseline.inputFingerprint);
    const repeat = await app.inject({ method: "POST", url: `/api/projects/project-1/operations/logistics/des-studies/${baseline.id}/reproduce` });
    expect(repeat.statusCode).toBe(200);
    expect(repeat.json()).toMatchObject({
      reproductionOf: baseline.id,
      inputFingerprint: baseline.inputFingerprint,
      execution: first.json().execution,
      trace: first.json().trace,
      outcome: first.json().outcome,
    });
    expect(service.snapshot("project-1").plantLiteStudies).toHaveLength(2);

    const reloaded = new OperationsService(directory);
    await reloaded.init();
    expect(reloaded.snapshot("project-1").plantLiteStudies).toMatchObject([
      { reproductionOf: baseline.id, trace: first.json().trace, outcome: first.json().outcome },
      { id: baseline.id, trace: first.json().trace, outcome: first.json().outcome },
    ]);
  });

  it("executes, persists and exactly reproduces an authored model snapshot in the Worker", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-plant-lite-authored-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new OperationsService(directory); await service.init();
    const app = createApiServer(); cleanups.push(() => app.close());
    await registerOperationsRoutes(app, { service, store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never });
    const model = createAgvLinePlantLiteModel({ agvCount: 5, bufferCapacity: 18 });
    model.id = "authored-line";
    model.name = "总装与检验线";
    model.nodes.splice(-1, 0, { id: "pack", name: "包装工位", kind: "station", processingTime: { kind: "deterministic", value: 0.8 }, capacity: 2 });
    model.edges.splice(-1, 1,
      { id: "b-pack", from: "station-b", to: "pack" },
      { id: "pack-sink", from: "pack", to: "sink" },
    );

    const first = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/operations/logistics/des-studies",
      payload: { name: "自定义总装 Study", templateId: "agv-line-v1", model, seed: "authored-42", replications: 3 },
    });
    expect(first.statusCode).toBe(200);
    const baseline = first.json();
    expect(baseline).toMatchObject({
      model,
      modelFingerprint: expect.any(String),
      outcome: { status: "completed", nodeMetrics95: { pack: { utilization: { samples: 3 } } } },
      execution: { limits: { maxResources: 100 }, trace: { replication: 0, maxEvents: 2_000, maxItems: 100 } },
      trace: { engineVersion: "1.0.0", replication: 0 },
    });
    expect(baseline).not.toHaveProperty("agvCount");

    const repeated = await app.inject({ method: "POST", url: `/api/projects/project-1/operations/logistics/des-studies/${baseline.id}/reproduce` });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({
      reproductionOf: baseline.id,
      model,
      modelFingerprint: baseline.modelFingerprint,
      inputFingerprint: baseline.inputFingerprint,
      trace: baseline.trace,
      outcome: baseline.outcome,
    });
  });

  it("persists station equipment reliability and recreates an independent authored request", () => {
    const model = createAgvLinePlantLiteModel();
    const station = model.nodes.find((node) => node.id === "station-a");
    if (!station || station.kind !== "station") throw new Error("missing fixture station");
    station.capacity = 2;
    station.resourceId = "assembly-equipment";
    delete station.power;
    model.resources!.push({
      id: "assembly-equipment",
      name: "装配设备",
      kind: "equipment",
      capacity: 1,
      power: { activePowerKw: 18, idlePowerKw: 2.2 },
      failure: {
        timeToFailure: { kind: "deterministic", value: 4 },
        repairTime: { kind: "deterministic", value: 2 },
      },
    });

    const record = runPlantLiteStudy("project-1", { name: "装配设备可靠性", model, seed: "equipment", replications: 3, limits: { durationMinutes: 12 } });
    const recreated = plantLiteRequestFromRecord(record);
    expect(record.model?.resources).toContainEqual(expect.objectContaining({ id: "assembly-equipment", kind: "equipment", capacity: 1 }));
    expect(record.outcome.resourceFailedMinutes95?.["assembly-equipment"]).toMatchObject({ mean: 4, samples: 3 });
    expect(record.trace?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "resource-failure", resourceId: "assembly-equipment" }),
      expect.objectContaining({ type: "resource-repair", resourceId: "assembly-equipment" }),
    ]));
    expect(recreated.model).toEqual(record.model);
    expect(recreated.model).not.toBe(record.model);
    expect(recreated.model?.resources).not.toBe(record.model?.resources);
  });

  it("persists shared worker constraints and exactly reproduces workforce utilization", () => {
    const model = createAgvLinePlantLiteModel();
    model.resources!.push({
      id: "assembly-team",
      name: "装配检验班组",
      kind: "worker",
      capacity: 1,
      availability: { shifts: [{ startMinute: 0, endMinute: 480 }] },
    });
    for (const station of model.nodes.filter((node) => node.kind === "station")) {
      station.workerResourceId = "assembly-team";
    }

    const baseline = runPlantLiteStudy("project-1", {
      name: "共享人工约束 Study",
      model,
      seed: "workforce-api",
      replications: 3,
      limits: { durationMinutes: 120 },
    });
    const request = plantLiteRequestFromRecord(baseline);
    const reproduction = runPlantLiteStudy("project-1", request);

    expect(baseline.model?.resources).toContainEqual(expect.objectContaining({ id: "assembly-team", kind: "worker", capacity: 1 }));
    expect(baseline.model?.nodes.filter((node) => node.kind === "station")).toEqual(expect.arrayContaining([
      expect.objectContaining({ workerResourceId: "assembly-team" }),
    ]));
    expect(baseline.outcome.resourceUtilization95["assembly-team"]).toMatchObject({ samples: 3 });
    expect(baseline.outcome.resourceUtilization95["assembly-team"]?.mean).toBeGreaterThan(0);
    expect(request.model).toEqual(baseline.model);
    expect(reproduction.inputFingerprint).toBe(baseline.inputFingerprint);
    expect(reproduction.outcome).toEqual(baseline.outcome);
  });

  it("round-trips a shared worker pool through the API Worker and reproduce route", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-plant-lite-workers-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new OperationsService(directory); await service.init();
    const app = createApiServer(); cleanups.push(() => app.close());
    await registerOperationsRoutes(app, { service, store: { getProject: (id: string) => id === "project-1" ? { id } : undefined } as never });
    const model = createAgvLinePlantLiteModel();
    model.resources!.push({ id: "shared-workers", name: "共享班组", kind: "worker", capacity: 2 });
    model.nodes.forEach((node) => { if (node.kind === "station") node.workerResourceId = "shared-workers"; });

    const first = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/operations/logistics/des-studies",
      payload: { name: "人工池 API Study", model, seed: "worker-route", replications: 3, limits: { durationMinutes: 60 } },
    });
    expect(first.statusCode).toBe(200);
    const baseline = first.json();
    expect(baseline.model).toMatchObject({ resources: expect.arrayContaining([expect.objectContaining({ id: "shared-workers", kind: "worker" })]) });
    expect(baseline.outcome.resourceUtilization95["shared-workers"]).toMatchObject({ samples: 3 });

    const repeated = await app.inject({ method: "POST", url: `/api/projects/project-1/operations/logistics/des-studies/${baseline.id}/reproduce` });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toMatchObject({
      reproductionOf: baseline.id,
      inputFingerprint: baseline.inputFingerprint,
      model: baseline.model,
      outcome: baseline.outcome,
    });
  });

  it("persists model-driven energy, unit cost and carbon evidence for exact comparison", () => {
    const baseline = runPlantLiteStudy("project-1", {
      name: "能效基线",
      model: createAgvLinePlantLiteModel({ agvCount: 2 }),
      seed: "energy-baseline",
      replications: 3,
      limits: { durationMinutes: 60 },
    });
    const reproduction = runPlantLiteStudy("project-1", plantLiteRequestFromRecord(baseline));

    expect(baseline.outcome.energy).toMatchObject({
      totalEnergyKwh: { samples: 3 },
      energyPerCompletedItemKwh: { samples: 3 },
      electricityCostPerCompletedItem: { samples: 3 },
      carbonEmissionPerCompletedItemKg: { samples: 3 },
      peakDemandKw: { samples: 3 },
      consumerEnergyKwh: {
        "station-a": { samples: 3 },
        "station-b": { samples: 3 },
        "agv-fleet": { samples: 3 },
      },
    });
    expect(baseline.outcome.energy?.totalEnergyKwh.mean).toBeGreaterThan(0);
    expect(reproduction.inputFingerprint).toBe(baseline.inputFingerprint);
    expect(reproduction.outcome.energy).toEqual(baseline.outcome.energy);
  });

  it("persists station scrap, first-pass-yield intervals and an explicit scrap trace", () => {
    const model = createAgvLinePlantLiteModel();
    const inspection = model.nodes.find((node) => node.id === "station-b");
    if (!inspection || inspection.kind !== "station") throw new Error("missing inspection fixture");
    inspection.yieldRate = 0.6;
    const baseline = runPlantLiteStudy("project-1", {
      name: "终检良率 Study", model, seed: "quality-api", replications: 4,
      limits: { durationMinutes: 120 }, trace: { maxEvents: 10_000, maxItems: 500 },
    });
    const reproduction = runPlantLiteStudy("project-1", plantLiteRequestFromRecord(baseline));

    expect(baseline.model?.nodes.find((node) => node.id === "station-b")).toMatchObject({ yieldRate: 0.6 });
    expect(baseline.outcome.quality).toMatchObject({
      goodOutputItems: { samples: 4 },
      scrapItems: { samples: 4 },
      firstPassYield: { samples: 4 },
      stationMetrics95: { "station-b": { inspectedItems: { samples: 4 }, scrapItems: { samples: 4 } } },
    });
    expect(baseline.outcome.quality?.scrapItems.mean).toBeGreaterThan(0);
    expect(baseline.trace?.events).toContainEqual(expect.objectContaining({
      type: "item-scrap", nodeId: "station-b", quality: { configuredYieldRate: 0.6, disposition: "scrap" },
    }));
    expect(reproduction.inputFingerprint).toBe(baseline.inputFingerprint);
    expect(reproduction.outcome.quality).toEqual(baseline.outcome.quality);
    expect(reproduction.trace).toEqual(baseline.trace);
  });

  it("persists and exactly reproduces the total horizon and warmup measurement window", () => {
    const baseline = runPlantLiteStudy("project-1", {
      name: "稳态产能",
      seed: "warmup-42",
      replications: 3,
      limits: { durationMinutes: 120, warmupMinutes: 30, maxEvents: 50_000, maxResources: 100 },
    });
    const request = plantLiteRequestFromRecord(baseline);
    const reproduction = runPlantLiteStudy("project-1", request);

    expect(baseline.execution.limits).toEqual({ durationMinutes: 120, warmupMinutes: 30, maxEvents: 50_000, maxResources: 100 });
    expect(request.limits).toEqual(baseline.execution.limits);
    expect(reproduction.inputFingerprint).toBe(baseline.inputFingerprint);
    expect(reproduction.execution.limits).toEqual(baseline.execution.limits);
    expect(reproduction.outcome).toEqual(baseline.outcome);
  });

  it("interprets a legacy execution without warmupMinutes as zero without changing its fingerprint", () => {
    const baseline = runPlantLiteStudy("project-1", { name: "零预热兼容", seed: "legacy-window", replications: 3 });
    const legacy = structuredClone(baseline);
    delete legacy.execution.limits.warmupMinutes;
    const reproduction = runPlantLiteStudy("project-1", plantLiteRequestFromRecord(legacy));

    expect(reproduction.execution.limits.warmupMinutes).toBe(0);
    expect(reproduction.inputFingerprint).toBe(baseline.inputFingerprint);
    expect(reproduction.outcome).toEqual(baseline.outcome);
  });

  it("persists custom trace bounds in the input snapshot and reproduces them exactly", () => {
    const baseline = runPlantLiteStudy("project-1", {
      name: "短轨迹",
      seed: "trace-limits",
      replications: 3,
      trace: { replication: 1, maxEvents: 7, maxItems: 2 },
    });
    const reproduction = runPlantLiteStudy("project-1", plantLiteRequestFromRecord(baseline));

    expect(baseline.execution.trace).toEqual({ replication: 1, maxEvents: 7, maxItems: 2 });
    expect(baseline.trace).toMatchObject({ replication: 1, limits: { maxEvents: 7, maxItems: 2 }, truncated: true });
    expect(reproduction.inputFingerprint).toBe(baseline.inputFingerprint);
    expect(reproduction.trace).toEqual(baseline.trace);
    expect(reproduction.outcome).toEqual(baseline.outcome);
  });

  it("persists validated scenario-group evidence and keeps it during exact reproduction", () => {
    const comparison = { groupId: "bottleneck-sweep:base", baselineStudyId: "base", parameterLabel: "并行工位数", candidateLabel: "2 个并行工位" };
    const baseline = runPlantLiteStudy("project-1", { name: "瓶颈候选", seed: "same", replications: 3, comparison });
    const request = plantLiteRequestFromRecord(baseline);
    const reproduction = runPlantLiteStudy("project-1", request);
    expect(baseline.comparison).toEqual(comparison);
    expect(request.comparison).toEqual(comparison);
    expect(reproduction.comparison).toEqual(comparison);
    expect(reproduction.inputFingerprint).toBe(baseline.inputFingerprint);
  });

  it("persists acceptance thresholds as decision evidence and reproduces them exactly", () => {
    const acceptanceTargets = {
      basis: "规划冻结版",
      minimumThroughputPerHour: 60,
      maximumAverageWip: 12,
      maximumAverageLeadTimeMinutes: 8,
      maximumEnergyPerCompletedItemKwh: 1.5,
    };
    const baseline = runPlantLiteStudy("project-1", {
      name: "目标产能校核", seed: "target-42", replications: 3, acceptanceTargets,
    });
    const request = plantLiteRequestFromRecord(baseline);
    const reproduction = runPlantLiteStudy("project-1", request);

    expect(baseline.acceptanceTargets).toEqual(acceptanceTargets);
    expect(request.acceptanceTargets).toEqual(acceptanceTargets);
    expect(reproduction.acceptanceTargets).toEqual(acceptanceTargets);
    expect(reproduction.inputFingerprint).toBe(baseline.inputFingerprint);
  });

  it("rejects malformed acceptance thresholds instead of issuing a misleading decision", () => {
    expect(() => runPlantLiteStudy("project-1", {
      name: "错误目标", acceptanceTargets: { minimumThroughputPerHour: 0 },
    })).toThrow("最低吞吐");
    expect(() => runPlantLiteStudy("project-1", {
      name: "错误目标类型", acceptanceTargets: "60" as never,
    })).toThrow("验收目标必须是对象");
  });

  it("rejects incomplete scenario-group metadata", () => {
    expect(() => runPlantLiteStudy("project-1", {
      name: "错误方案组",
      comparison: { groupId: " ", baselineStudyId: "base", parameterLabel: "并行工位数", candidateLabel: "2 个" },
    })).toThrow("方案组标识");
  });

  it("rejects an out-of-range representative replication", () => {
    expect(() => runPlantLiteStudy("project-1", {
      name: "错误轨迹配置",
      replications: 2,
      trace: { replication: 2 },
    })).toThrow("轨迹重复序号");
  });

  it("rejects an invalid authored graph before the solver runs", () => {
    const model = createAgvLinePlantLiteModel();
    model.edges = model.edges.filter((edge) => edge.to !== "sink");
    expect(() => runPlantLiteStudy("project-1", { name: "断开的流程", model })).toThrow("非 sink 节点必须有出边");
  });

  it("does not silently replace an explicit null model with the start template", () => {
    expect(() => runPlantLiteStudy("project-1", { name: "空模型", model: null } as never)).toThrow("模型必须是对象");
  });

  it("rejects malformed run-setting objects instead of silently applying defaults", () => {
    expect(() => runPlantLiteStudy("project-1", { name: "错误上限", limits: "480" } as never)).toThrow("运行上限必须是对象");
    expect(() => runPlantLiteStudy("project-1", { name: "错误轨迹", trace: [] } as never)).toThrow("轨迹采集参数必须是对象");
    expect(() => runPlantLiteStudy("project-1", { name: "错误预热期", limits: { durationMinutes: 60, warmupMinutes: 60 } })).toThrow("预热期必须小于总运行时长");
  });

  it("keeps old template-only records reproducible without inventing a saved model", () => {
    const current = runPlantLiteStudy("project-1", { name: "旧方案", agvCount: 7, bufferCapacity: 22, seed: "legacy", replications: 2 });
    const legacy = structuredClone(current);
    delete legacy.model;
    delete legacy.modelFingerprint;
    const request = plantLiteRequestFromRecord(legacy);

    expect(request).toMatchObject({ templateId: "agv-line-v1", agvCount: 7, bufferCapacity: 22, seed: "legacy", replications: 2 });
    expect(request).not.toHaveProperty("model");
    const reproduced = runPlantLiteStudy("project-1", request);
    expect(reproduced.inputFingerprint).toBe(current.inputFingerprint);
    expect(reproduced.trace).toEqual(current.trace);
    expect(reproduced.outcome).toEqual(current.outcome);
  });

  it("rejects an empty executor result without persisting a poisoned study", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-plant-lite-empty-")); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new OperationsService(directory, {
      plantLiteExecutor: { run: async () => null as never },
    });
    await service.init();

    await expect(service.runPlantLite("project-1", { name: "empty" })).rejects.toThrow("没有返回有效结果");
    expect(service.snapshot("project-1").plantLiteStudies).toEqual([]);
  });
});
