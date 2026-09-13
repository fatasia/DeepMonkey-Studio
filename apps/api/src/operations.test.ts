import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApiServer } from "./serverOptions.js";
import { OperationsService } from "./operations.js";
import { registerOperationsRoutes } from "./operationsRoutes.js";
import type { DataConnectionRecord, DataDatasetRecord } from "@bim-studio/contracts";
import type { DataQuerySource } from "@bim-studio/data-query-plugin";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((action) => action()));
});

describe("operations routes", () => {
  it("creates the minimal maintenance flow and persists logistics and energy outputs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-operations-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new OperationsService(directory);
    await service.init();
    const app = createApiServer();
    cleanups.push(() => app.close());
    await registerOperationsRoutes(app, { service, store: { getProject: (id: string) => (id === "project-1" ? { id } : undefined) } as never });
    const imported = await app.inject({
      method: "POST", url: "/api/projects/project-1/operations/maintenance/models",
      payload: {
        version: "pdm-logistic-real", name: "传动链健康预测", algorithm: "logistic",
        status: "validated", benchmarkOnly: true, productionEligible: false, trainRows: 120, validationRows: 30,
        metrics: { auc: 0.91 },
        artifact: { engine: "native-json", modelKind: "failure-probability", features: ["current", "temperature"], means: [10, 20], stds: [2, 4], weights: [0.8, 0.2], bias: -1 },
      },
    });
    expect(imported.statusCode).toBe(200);
    const model = imported.json() as { id: string };
    const deployed = await app.inject({
      method: "POST", url: "/api/projects/project-1/operations/maintenance/deployments",
      payload: { name: "传动链评估", modelId: model.id, equipmentId: "drive", maintainableUnitId: "drive", objectIds: [], sourceId: "drive-data", featureMappings: {}, windowSize: 40, sampleIntervalSec: 60, enabled: true, status: "shadow" },
    });
    expect(deployed.statusCode).toBe(200);
    const deployment = deployed.json() as { id: string };
    const assessed = await app.inject({
      method: "POST", url: `/api/projects/project-1/operations/maintenance/deployments/${deployment.id}/assess`,
      payload: { rows: Array.from({ length: 40 }, (_, index) => ({ current: 10 + index / 100, temperature: 20 + index / 50 })) },
    });
    expect(assessed.statusCode).toBe(200);
    expect(assessed.json()).toMatchObject({ decisionStatus: "shadow", deploymentId: deployment.id, sampleCount: 40 });

    const createdStudy = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/operations/validation-studies",
      payload: {
        title: "传动链异常验证",
        sourceKind: "maintenance-diagnosis",
        sourceRefs: ["assessment-1", "assessment-1"],
        sceneId: "scene-1",
        objectIds: ["motor-1"],
        objective: "验证故障出现后报警锁存并可人工复位",
        acceptanceCriteria: ["故障时报警为 true", "复位后报警为 false"],
        studyType: "virtual-commissioning",
        scenarioInput: { id: "scene-1-acceptance", durationMs: 1_000 },
        execution: { engineId: "simulation.virtual-debug.run", engineVersion: "1.0.0", deterministic: true },
        context: { sceneFingerprint: "scene-fp", modelFingerprint: "model-fp", versionFingerprint: "version-fp" },
      },
    });
    expect(createdStudy.statusCode).toBe(201);
    expect(createdStudy.json()).toMatchObject({
      revision: 1,
      status: "ready",
      sourceRefs: ["assessment-1"],
      objectIds: ["motor-1"],
      studyType: "virtual-commissioning",
      scenarioInput: { id: "scene-1-acceptance", durationMs: 1_000 },
      execution: { engineId: "simulation.virtual-debug.run", engineVersion: "1.0.0", inputFingerprint: expect.any(String) },
    });
    const study = createdStudy.json() as { id: string; revision: number };
    const completedStudy = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-1/operations/validation-studies/${study.id}`,
      payload: {
        expectedRevision: study.revision,
        latestResult: {
          status: "passed",
          scenarioId: "scene-1-acceptance",
          evidenceFingerprint: "evidence-1",
          failureCount: 0,
          completedAt: "2026-08-30T00:00:00.000Z",
        },
      },
    });
    expect(completedStudy.statusCode).toBe(200);
    expect(completedStudy.json()).toMatchObject({ revision: 2, status: "passed" });
    const staleUpdate = await app.inject({
      method: "PATCH",
      url: `/api/projects/project-1/operations/validation-studies/${study.id}`,
      payload: { expectedRevision: 1, title: "旧页面覆盖" },
    });
    expect(staleUpdate.statusCode).toBe(409);
    expect(staleUpdate.json()).toMatchObject({ current: { revision: 2, status: "passed" } });
    const invalidCrossTypeBaseline = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/operations/validation-studies",
      payload: {
        title: "错误的跨类型基线",
        sourceKind: "workcell-audit",
        studyType: "workcell-audit",
        sourceRefs: [],
        objectIds: ["robot-1"],
        objective: "验证错误基线被拒绝",
        acceptanceCriteria: ["不得跨类型对比"],
        baselineStudyId: study.id,
      },
    });
    expect(invalidCrossTypeBaseline.statusCode).toBe(400);
    expect(invalidCrossTypeBaseline.json()).toEqual({ message: "验证 Study 只能对比同类型基线" });

    const logisticsResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/operations/logistics/experiments",
      payload: { name: "line", durationHours: 8, agvCount: 2, bufferCapacity: 20, demandPerHour: 60, cycleTimeSec: 300, chargingMinutesPerHour: 5, congestionFactor: 0.1 },
    });
    expect(logisticsResponse.statusCode).toBe(200);
    const logistics = logisticsResponse.json() as {
      id: string;
      fingerprint: string;
      execution: { inputFingerprint: string };
    };
    expect(logistics.execution.inputFingerprint).toBe(logistics.fingerprint);
    const reproduced = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/operations/logistics/experiments/${logistics.id}/reproduce`,
    });
    expect(reproduced.statusCode).toBe(200);
    expect(reproduced.json()).toMatchObject({
      reproductionOf: logistics.id,
      fingerprint: logistics.fingerprint,
      execution: { inputFingerprint: logistics.fingerprint },
    });
    expect(reproduced.json().id).not.toBe(logistics.id);
    const whatIfPayload = {
      name: "速度提升筛查",
      input: {
        baselines: [{ metricId: "throughput", value: 100 }],
        changes: [{ variableId: "speed", delta: 0.1, mode: "relative" }],
        elasticities: [{
          variableId: "speed", metricId: "throughput", coefficient: 0.8,
          inputMode: "relative", outputMode: "relative", reliability: 0.9,
        }],
        constraints: [{ constraintId: "throughput-range", metricId: "throughput", minimum: 80, maximum: 120, severity: "critical" }],
        applicabilityDomain: {
          variableRanges: [{ variableId: "speed", mode: "relative", minimumDelta: -0.2, maximumDelta: 0.2 }],
          metricRanges: [{ metricId: "throughput", minimum: 80, maximum: 120 }],
        },
      },
    };
    const whatIfResponse = await app.inject({
      method: "POST",
      url: "/api/projects/project-1/operations/what-if/studies",
      payload: whatIfPayload,
    });
    expect(whatIfResponse.statusCode).toBe(200);
    const whatIf = whatIfResponse.json() as {
      id: string;
      result: { inputFingerprint: string; evidenceFingerprint: string };
      execution: { inputFingerprint: string };
    };
    expect(whatIf.execution.inputFingerprint).toBe(whatIf.result.inputFingerprint);
    const reproducedWhatIf = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/operations/what-if/studies/${whatIf.id}/reproduce`,
    });
    expect(reproducedWhatIf.statusCode).toBe(200);
    expect(reproducedWhatIf.json()).toMatchObject({
      reproductionOf: whatIf.id,
      result: { evidenceFingerprint: whatIf.result.evidenceFingerprint },
      execution: { inputFingerprint: whatIf.execution.inputFingerprint },
    });
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/projects/project-1/operations/energy/analyze",
          payload: {
            observations: [
              { timestamp: "1", output: 10, energyKwh: 5 },
              { timestamp: "2", output: 10, energyKwh: 5 },
              { timestamp: "3", output: 10, energyKwh: 5 },
              { timestamp: "4", output: 10, energyKwh: 8 },
            ],
          },
        })
      ).statusCode,
    ).toBe(200);
    const snapshot = await app.inject({ method: "GET", url: "/api/projects/project-1/operations" });
    expect(snapshot.json()).toMatchObject({
      models: [{ id: model.id }],
      assessments: [{ deploymentId: deployment.id }],
      validationStudies: [{ id: study.id, revision: 2, status: "passed" }],
      logisticsExperiments: [{ name: "line", reproductionOf: logistics.id }, { id: logistics.id, name: "line" }],
      whatIfStudies: [{ reproductionOf: whatIf.id }, { id: whatIf.id, name: "速度提升筛查" }],
      studies: [
        { type: "what-if", reproduction: { kind: "rerun", operationsTab: "whatif" } },
        { type: "what-if", sourceRecordId: whatIf.id },
        { type: "virtual-commissioning", sourceRecordId: study.id, scenarioInput: { id: "scene-1-acceptance" } },
      ],
      energyInsights: [{ samples: 4 }],
    });
    const reloadedService = new OperationsService(directory);
    await reloadedService.init();
    expect(reloadedService.snapshot("project-1").validationStudies).toMatchObject([
      {
        id: study.id,
        revision: 2,
        status: "passed",
        scenarioInput: { id: "scene-1-acceptance" },
        execution: { inputFingerprint: expect.any(String) },
        latestResult: { evidenceFingerprint: "evidence-1" },
      },
    ]);
    expect(reloadedService.snapshot("project-1").whatIfStudies).toMatchObject([
      { reproductionOf: whatIf.id },
      { id: whatIf.id, result: { evidenceFingerprint: whatIf.result.evidenceFingerprint } },
    ]);
    expect(reloadedService.snapshot("project-1").studies).toHaveLength(3);
  });

  it("assesses maintenance from a Kafka dataset and preserves source evidence", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "bim-operations-dataset-"));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const service = new OperationsService(directory);
    await service.init();
    const model = await service.importModel("project-1", {
      name: "传动链异常检测",
      version: "dataset-route-1",
      status: "validated",
      productionEligible: true,
      artifact: {
        engine: "native-json",
        modelKind: "failure-probability",
        features: ["temperature", "vibration"],
        weights: [0.1, 0.2],
        bias: -2,
      },
      gates: {
        minimumSamples: 2,
        minimumDataQuality: 0.5,
        maximumDriftSigma: 10,
        warningThreshold: 0.5,
        criticalThreshold: 0.8,
        scoreDirection: "high-risk",
      },
    });
    const deployment = await service.saveDeployment("project-1", {
      name: "Kafka 在线评估",
      modelId: model.id,
      equipmentId: "motor-1",
      maintainableUnitId: "bearing-1",
      sourceId: "dataset:kafka-telemetry",
      windowSize: 2,
      enabled: true,
    });
    const dataset: DataDatasetRecord = {
      id: "kafka-telemetry",
      projectId: "project-1",
      connectionId: "kafka-main",
      name: "设备实时遥测",
      refreshSeconds: 1,
      fields: [
        { key: "temperature", label: "温度", type: "number" },
        { key: "vibration", label: "振动", type: "number" },
      ],
      createdAt: "now",
      updatedAt: "now",
    };
    let rows: Array<Record<string, unknown>> = [
      { temperature: 36, vibration: 0.2 },
      { temperature: 38, vibration: 0.3 },
    ];
    let readCount = 0;
    const dataQuerySource: DataQuerySource = {
      listDatasets: () => [dataset],
      getDataset: (_projectId, datasetId) => datasetId === dataset.id ? dataset : undefined,
      readDataset: async () => {
        readCount += 1;
        return { dataset, fields: dataset.fields, rows, durationMs: 4.4 };
      },
    };
    const connection: DataConnectionRecord = {
      id: "kafka-main",
      projectId: "project-1",
      name: "生产 Kafka",
      type: "kafka",
      enabled: true,
      config: {},
      createdAt: "now",
      updatedAt: "now",
    };
    const app = createApiServer();
    cleanups.push(() => app.close());
    const store = {
      getProject: (id: string) => id === "project-1" ? { id } : undefined,
      listDataConnections: () => [connection],
    } as never;
    await registerOperationsRoutes(app, { service, store, dataQuerySource });

    const assessed = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/operations/maintenance/deployments/${deployment.id}/assess`,
      payload: { datasetId: dataset.id },
    });
    expect(assessed.statusCode).toBe(200);
    expect(assessed.json()).toMatchObject({
      sampleCount: 2,
      sourceEvidence: {
        datasetId: dataset.id,
        datasetName: dataset.name,
        connectionId: connection.id,
        connectionType: "kafka",
        rowCount: 2,
        fieldKeys: ["temperature", "vibration"],
        durationMs: 4,
      },
    });
    expect(service.snapshot("project-1").assessments[0]).toMatchObject({
      sourceEvidence: { datasetId: dataset.id, connectionType: "kafka" },
    });

    const conflicting = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/operations/maintenance/deployments/${deployment.id}/assess`,
      payload: { datasetId: dataset.id, rows: [{ temperature: 40, vibration: 0.5 }] },
    });
    expect(conflicting.statusCode).toBe(400);
    expect(conflicting.json()).toEqual({ message: "rows 与 datasetId 只能选择一种输入方式" });
    expect(readCount).toBe(1);

    connection.enabled = false;
    const disabled = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/operations/maintenance/deployments/${deployment.id}/assess`,
      payload: { datasetId: dataset.id },
    });
    expect(disabled.statusCode).toBe(400);
    expect(disabled.json().message).toContain("已停用");

    connection.enabled = true;
    rows = [];
    const empty = await app.inject({
      method: "POST",
      url: `/api/projects/project-1/operations/maintenance/deployments/${deployment.id}/assess`,
      payload: { datasetId: dataset.id },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().message).toContain("没有可用于模型运行的记录");
  });
});
