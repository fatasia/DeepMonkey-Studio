import { describe, expect, it, vi } from "vitest";
import type { AiDataBinding, DataDatasetRecord, MaintenanceDeploymentRecord } from "@bim-studio/contracts";
import { MaintenanceInferenceScheduler } from "./maintenanceInferenceScheduler.js";

const dataset: DataDatasetRecord = {
  id: "telemetry", projectId: "project-1", connectionId: "connection-1", name: "设备遥测",
  refreshSeconds: 5, fields: [{ key: "vibration", label: "振动", type: "number" }],
  createdAt: "2026-08-31T00:00:00.000Z", updatedAt: "2026-08-31T00:00:00.000Z",
};
const deployment: MaintenanceDeploymentRecord = {
  id: "deployment-1", projectId: "project-1", name: "电机预测维护", modelId: "model-1",
  equipmentId: "motor-1", maintainableUnitId: "bearing-1", objectIds: [], sourceId: dataset.id,
  featureMappings: { vibration: "vibration" }, sampleIntervalSec: 5, windowSize: 30,
  enabled: true, status: "running", createdAt: dataset.createdAt, updatedAt: dataset.updatedAt,
};

const binding: AiDataBinding = {
  id: "binding-1", projectId: "project-1", name: "电机预测维护", datasetId: dataset.id,
  capabilityId: "operations.maintenance.assess", status: "active",
  features: [{ modelField: "vibration", sourceField: "vibration", required: true }],
  window: { rows: 1 }, trigger: { type: "interval", seconds: 10 },
  quality: { minimumSamples: 1, maxAgeSeconds: 60, maximumMissingRate: 0 },
  retry: { maxAttempts: 3, backoffSeconds: 2 }, output: { type: "case", caseType: "maintenance" },
  revision: 1, createdAt: dataset.createdAt, updatedAt: dataset.updatedAt,
};

describe("maintenance inference scheduler", () => {
  it("runs a bound dataset at its sampling interval and keeps source evidence", async () => {
    const assess = vi.fn(async () => undefined);
    const source = {
      listDatasets: () => [dataset],
      getDataset: () => dataset,
      readDataset: vi.fn(async () => ({
        dataset, fields: dataset.fields, rows: [{ vibration: 0.26 }], durationMs: 7,
      })),
    };
    const scheduler = new MaintenanceInferenceScheduler({
      store: {
        listProjects: () => [{ id: "project-1" }],
        listDataConnections: () => [{ id: "connection-1", projectId: "project-1", name: "Kafka", type: "kafka", enabled: true, config: {}, createdAt: dataset.createdAt, updatedAt: dataset.updatedAt }],
      } as never,
      operations: { snapshot: () => ({ deployments: [deployment] }), assess, recordDeploymentFailure: vi.fn() } as never,
      dataQuerySource: source,
    });

    await scheduler.tick(1_000);
    await scheduler.tick(2_000);
    await scheduler.tick(6_000);

    expect(source.readDataset).toHaveBeenCalledTimes(2);
    expect(assess).toHaveBeenCalledWith(
      "project-1", "deployment-1", [{ vibration: 0.26 }],
      expect.objectContaining({ datasetId: "telemetry", connectionType: "kafka", rowCount: 1 }),
    );
  });

  it("records a visible deployment failure without crashing later schedules", async () => {
    const recordDeploymentFailure = vi.fn(async () => undefined);
    const scheduler = new MaintenanceInferenceScheduler({
      store: {
        listProjects: () => [{ id: "project-1" }],
        listDataConnections: () => [{ id: "connection-1", projectId: "project-1", name: "API", type: "http", enabled: true, config: {}, createdAt: dataset.createdAt, updatedAt: dataset.updatedAt }],
      } as never,
      operations: { snapshot: () => ({ deployments: [deployment] }), assess: vi.fn(), recordDeploymentFailure } as never,
      dataQuerySource: { listDatasets: () => [dataset], getDataset: () => dataset, readDataset: async () => { throw new Error("upstream offline"); } },
    });

    await scheduler.tick(1_000);
    expect(recordDeploymentFailure).toHaveBeenCalledWith("project-1", "deployment-1", expect.any(Error));
  });

  it("uses an active binding interval, window and quality gate", async () => {
    const assess = vi.fn(async () => undefined);
    const boundDeployment = { ...deployment, bindingId: binding.id };
    const rows = [{ vibration: 0.1 }, { vibration: 0.2 }];
    const scheduler = new MaintenanceInferenceScheduler({
      store: {
        listProjects: () => [{ id: "project-1" }],
        getAiDataBinding: () => binding,
        listDataConnections: () => [{ id: "connection-1", projectId: "project-1", name: "Kafka", type: "kafka", enabled: true, config: {}, createdAt: dataset.createdAt, updatedAt: dataset.updatedAt }],
        saveAiDataBindingRun: async (_projectId: string, run: unknown) => run,
      } as never,
      operations: { snapshot: () => ({ deployments: [boundDeployment] }), assess, recordDeploymentFailure: vi.fn() } as never,
      dataQuerySource: { listDatasets: () => [dataset], getDataset: () => dataset, readDataset: async () => ({ dataset, fields: dataset.fields, rows, durationMs: 2 }) },
    });

    await scheduler.tick(1_000);
    await scheduler.tick(6_000);
    await scheduler.tick(11_000);

    expect(assess).toHaveBeenCalledTimes(2);
    expect(assess).toHaveBeenLastCalledWith("project-1", deployment.id, [{ vibration: 0.2 }], expect.any(Object));
  });

  it("does not schedule manual or paused bindings", async () => {
    const assess = vi.fn();
    const boundDeployment = { ...deployment, bindingId: binding.id };
    let current = { ...binding, trigger: { type: "manual" } as const };
    const scheduler = new MaintenanceInferenceScheduler({
      store: {
        listProjects: () => [{ id: "project-1" }], getAiDataBinding: () => current,
      } as never,
      operations: { snapshot: () => ({ deployments: [boundDeployment] }), assess } as never,
      dataQuerySource: { listDatasets: () => [dataset] } as never,
    });
    await scheduler.tick(1_000);
    current = { ...binding, status: "paused", trigger: { type: "interval", seconds: 1 } };
    await scheduler.tick(2_000);
    expect(assess).not.toHaveBeenCalled();
  });
});
