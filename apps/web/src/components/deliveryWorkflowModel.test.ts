import { describe, expect, it } from "vitest";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { buildDeliveryBlockers, buildDeliverySteps, deriveDeliveryWorkflowFacts, firstIncompleteRequiredStep } from "./deliveryWorkflowModel";

const timestamp = "2026-08-29T00:00:00.000Z";

describe("deliveryWorkflowModel", () => {
  it("把脚本和仿真作为建议步骤，不阻塞基础交付校验", () => {
    const project = baseProject({
      dataConnections: [{ id: "connection-1", projectId: "project-1", name: "实时源", type: "simulation", enabled: true, config: {}, createdAt: timestamp, updatedAt: timestamp }],
      datasets: [
        { id: "dataset-1", projectId: "project-1", name: "设备数据", connectionId: "connection-1", refreshSeconds: 10, fields: [{ key: "temperature", label: "温度", type: "number" }], createdAt: timestamp, updatedAt: timestamp },
      ],
    });
    const scene = baseScene({
      publishedAt: timestamp,
      dataBindings: [
        { id: "binding-1", name: "温度", enabled: true, datasetId: "dataset-1", field: "temperature", target: {}, action: "color", refreshSeconds: 10 },
      ],
    });
    const steps = buildDeliverySteps("zh-CN", project, [scene]);
    expect(firstIncompleteRequiredStep(steps)?.id).toBeUndefined();
    expect(steps.find((step) => step.id === "behavior")).toMatchObject({ ready: false, required: false });
    expect(steps.find((step) => step.id === "simulation")).toMatchObject({ ready: false, required: false });
  });

  it("只把处理中的模型计入交付阻断项", () => {
    const project = baseProject({
      models: [
        {
          id: "model-1",
          projectId: "project-1",
          name: "待转换",
          format: "ifc",
          size: 12,
          status: "processing",
          progress: 50,
          message: "转换中",
          sourceUrl: "upload://model-1",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    });
    const facts = deriveDeliveryWorkflowFacts(project, []);
    expect(facts.pendingAssetCount).toBe(1);
    expect(facts.validationReady).toBe(false);
  });

  it("纯展示项目不强迫新增数据联动，已有绑定仍经过发布体检", () => {
    const project = baseProject({
      dataConnections: [{ id: "connection-1", projectId: "project-1", name: "实时源", type: "simulation", enabled: true, config: {}, createdAt: timestamp, updatedAt: timestamp }],
      datasets: [
        { id: "dataset-1", projectId: "project-1", name: "设备数据", connectionId: "connection-1", refreshSeconds: 10, fields: [], createdAt: timestamp, updatedAt: timestamp },
      ],
    });
    const scene = baseScene();

    expect(deriveDeliveryWorkflowFacts(project, [scene]).validationReady).toBe(true);
    expect(buildDeliverySteps("zh-CN", project, [scene]).find((step) => step.id === "validate")).toMatchObject({ ready: true, blocked: false });
    expect(buildDeliveryBlockers("zh-CN", baseProject(), [scene])).toEqual([]);
  });

  it("场景存在断链时不会让开发流程先于发布体检显示通过", () => {
    const project = baseProject({
      dataConnections: [{ id: "connection-1", projectId: "project-1", name: "实时源", type: "simulation", enabled: true, config: {}, createdAt: timestamp, updatedAt: timestamp }],
      datasets: [{
        id: "dataset-1", projectId: "project-1", name: "设备数据", connectionId: "connection-1", refreshSeconds: 10,
        fields: [{ key: "temperature", label: "温度", type: "number" }], createdAt: timestamp, updatedAt: timestamp,
      }],
    });
    const scene = baseScene({
      publishedAt: timestamp,
      dataBindings: [{
        id: "binding-1", name: "温度", enabled: true, datasetId: "dataset-1", field: "temperature",
        target: { modelId: "missing-model" }, action: "color", refreshSeconds: 10,
      }],
    });

    const facts = deriveDeliveryWorkflowFacts(project, [scene]);
    const steps = buildDeliverySteps("zh-CN", project, [scene]);
    expect(facts).toMatchObject({ linkageReady: true, validationReady: false, publicationBlockerCount: 1 });
    expect(steps.find((step) => step.id === "validate")).toMatchObject({ ready: false, blocked: true, detail: "1 个发布阻断待处理" });
    expect(buildDeliveryBlockers("zh-CN", project, [scene])).toContainEqual({
      id: "validation",
      stepId: "validate",
      label: "发布体检未通过",
      detail: "1 个断链或无效引用待处理",
    });
    expect(firstIncompleteRequiredStep(steps)?.id).toBe("validate");
  });
});

function baseProject(overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return { id: "project-1", name: "产线项目", description: "", models: [], createdAt: timestamp, updatedAt: timestamp, ...overrides };
}

function baseScene(overrides: Partial<SceneSnapshot> = {}): SceneSnapshot {
  return {
    schemaVersion: 1,
    id: "scene-1",
    projectId: "project-1",
    name: "装配线",
    camera: { position: { x: 1, y: 2, z: 3 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [],
    primitives: [],
    measurements: [],
    dataBindings: [],
    interactions: [],
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
