import { describe, expect, it } from "vitest";
import type { DataConnectionRecord, DataDatasetRecord, ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { assessProjectPublication, assessScenePublication, hasPublicationDataProduct } from "./publicationReadiness";

describe("publication data readiness", () => {
  it("accepts Kafka as a native runnable publication source", () => {
    expect(hasPublicationDataProduct({ dataConnections: [connection("kafka", true)], datasets: [dataset()] })).toBe(true);
    expect(hasPublicationDataProduct({ dataConnections: [connection("sqlserver", true)], datasets: [dataset()] })).toBe(true);
    expect(hasPublicationDataProduct({ dataConnections: [connection("clickhouse", true)], datasets: [dataset()] })).toBe(true);
    expect(hasPublicationDataProduct({ dataConnections: [connection("doris", true)], datasets: [dataset()] })).toBe(true);
  });

  it("requires both an enabled connection and a dataset", () => {
    expect(hasPublicationDataProduct({ dataConnections: [connection("http", false)], datasets: [dataset()] })).toBe(false);
    expect(hasPublicationDataProduct({ dataConnections: [connection("http", true)], datasets: [] })).toBe(false);
  });

  it("blocks broken model, data, media and interaction references", () => {
    const project = publicationProject();
    const scene = publicationScene();
    scene.models.push({ ...scene.models[0]!, modelId: "missing-model", name: "已删除设备" });
    scene.dataBindings = [{
      id: "binding-1", name: "温度联动", enabled: true, datasetId: "dataset-1", field: "missing-field",
      target: { modelId: "model-1", layerId: "missing-layer" }, action: "color", refreshSeconds: 5,
    }];
    scene.dashboard = {
      side: "right", width: 400,
      widgets: [{ id: "camera", title: "实时画面", key: "", type: "monitor", unit: "", x: 0, y: 0, w: 300, h: 180, monitorSourceUrl: "http://camera.local/live" }],
    };
    scene.interactions = [{
      id: "interaction-1", name: "跳转", enabled: true, trigger: "click", target: { kind: "object", modelId: "model-1" }, code: "",
      actions: [{ id: "action-1", type: "navigateScene", enabled: true, sceneId: "missing-scene" }],
    }];

    const report = assessProjectPublication(project, [scene]);
    expect(report.evidenceFingerprint).toMatch(/^fnv1a64-canonical-v1:[a-f0-9]{16}$/);
    expect(report.status).toBe("blocked");
    expect(report.blockers).toBeGreaterThanOrEqual(5);
    expect(report.issues.map((issue) => issue.title)).toEqual(expect.arrayContaining([
      "场景模型已断链", "数据字段引用已失效", "模型内部对象不存在", "组件地址无效", "跳转场景不存在",
    ]));
  });

  it("keeps disabled drafts out of the hard publication gate", () => {
    const project = publicationProject();
    const scene = publicationScene();
    scene.dataBindings = [{
      id: "draft", name: "草稿绑定", enabled: false, datasetId: "deleted", field: "value",
      target: { modelId: "deleted" }, action: "visibility", refreshSeconds: 5,
    }];
    expect(assessProjectPublication(project, [scene])).toMatchObject({ status: "ready", blockers: 0, warnings: 0 });
  });

  it("treats the replacement asset as the dependency while retaining the scene instance identity", () => {
    const project = publicationProject();
    const scene = publicationScene();
    scene.models[0] = { ...scene.models[0]!, modelId: "pump-instance", assetModelId: "model-1", name: "一号泵实例" };
    scene.dataBindings = [{
      id: "binding-1", name: "温度联动", enabled: true, datasetId: "dataset-1", field: "temperature",
      target: { modelId: "pump-instance", layerId: "pump" }, action: "color", refreshSeconds: 5,
    }];
    scene.assetBindings = [{
      id: "asset-binding-1", sceneObjectId: "pump-instance/pump", objectName: "泵",
      modelId: "pump-instance", layerId: "pump", deviceId: "P-001", confidence: 1,
      confirmedAt: "2026-09-09T08:00:00.000Z",
    }];

    const report = assessProjectPublication(project, [scene]);

    expect(report).toMatchObject({ status: "ready", blockers: 0, warnings: 0 });
    expect(report.issues).toEqual([]);
  });

  it("blocks duplicate or broken confirmed asset mappings", () => {
    const project = publicationProject();
    const scene = publicationScene();
    scene.assetBindings = [
      {
        id: "asset-1", sceneObjectId: "model-1/pump", objectName: "泵", modelId: "model-1",
        layerId: "pump", deviceId: "P-001", confidence: 0.94, confirmedAt: "2026-08-30T08:00:00.000Z",
      },
      {
        id: "asset-2", sceneObjectId: "model-1/removed", objectName: "已删除设备", modelId: "model-1",
        layerId: "removed", deviceId: "P-001", confidence: 0.82, confirmedAt: "2026-08-30T08:00:00.000Z",
      },
    ];

    const report = assessProjectPublication(project, [scene]);
    expect(report.status).toBe("blocked");
    expect(report.issues.map((item) => item.title)).toEqual(expect.arrayContaining([
      "模型内部对象不存在",
      "设备映射存在冲突",
    ]));
  });

  it("checks model screen resources without rejecting packaged project media", () => {
    const project = publicationProject();
    const packaged = publicationScene();
    packaged.models[0]!.material = {
      screen: { enabled: true, sourceType: "video", url: "/assets/screens/line.mp4", autoplay: true, loopMode: "loop", muted: true, emissiveIntensity: 1 },
    };
    expect(assessProjectPublication(project, [packaged])).toMatchObject({ status: "ready", blockers: 0, warnings: 0 });

    const external = publicationScene();
    external.models[0]!.material = {
      screen: { enabled: true, sourceType: "video", url: "https://media.example.test/line.mp4", autoplay: true, loopMode: "once", muted: true, emissiveIntensity: 1 },
    };
    expect(assessProjectPublication(project, [external])).toMatchObject({ status: "warning", blockers: 0, warnings: 1 });

    const unsafe = publicationScene();
    unsafe.models[0]!.material = {
      screen: { enabled: true, sourceType: "video", url: "javascript:alert(1)", autoplay: false, loopMode: "once", muted: true, emissiveIntensity: 1 },
    };
    expect(assessProjectPublication(project, [unsafe])).toMatchObject({ status: "blocked", blockers: 1 });
  });

  it("checks spatial audio resources for offline-safe publication", () => {
    const project = publicationProject();
    const packaged = publicationScene();
    packaged.models[0]!.spatialAudio = spatialAudio("/assets/audio/motor.ogg");
    expect(assessProjectPublication(project, [packaged])).toMatchObject({ status: "ready", blockers: 0, warnings: 0 });

    const external = publicationScene();
    external.models[0]!.spatialAudio = spatialAudio("https://media.example.test/motor.ogg");
    expect(assessProjectPublication(project, [external])).toMatchObject({ status: "warning", blockers: 0, warnings: 1 });

    const unsafe = publicationScene();
    unsafe.models[0]!.spatialAudio = spatialAudio("javascript:alert(1)");
    const report = assessProjectPublication(project, [unsafe]);
    expect(report).toMatchObject({ status: "blocked", blockers: 1 });
    expect(report.issues[0]?.title).toBe("空间音频资源无效");
  });
});

describe("selected scene publication audit", () => {
  it("resolves scene navigation without auditing unrelated broken drafts", () => {
    const scene = publicationScene();
    const other = { ...publicationScene(), id: "scene-2", models: [{ ...scene.models[0]!, modelId: "missing" }] };
    scene.interactions = [{ id: "jump", name: "跳转", enabled: true, trigger: "click", target: { kind: "object", modelId: "model-1" }, code: "",
      actions: [{ id: "go", type: "navigateScene", enabled: true, sceneId: other.id }] }];
    expect(assessScenePublication(publicationProject(), scene, [other]).blockers).toBe(0);
    expect(assessProjectPublication(publicationProject(), [scene, other]).blockers).toBe(1);
    const missing = assessScenePublication(publicationProject(), scene, []);
    expect(missing.issues).toEqual([expect.objectContaining({ title: "跳转场景不存在", sceneId: scene.id, targetId: "jump" })]);
  });

  it("uses the selected saved snapshot and resolves self navigation", () => {
    const scene = publicationScene();
    scene.interactions = [{ id: "jump", name: "重开", enabled: true, trigger: "click", target: { kind: "object", modelId: "model-1" }, code: "",
      actions: [{ id: "go", type: "navigateScene", enabled: true, sceneId: scene.id }] }];
    const stale = { ...scene, models: [{ ...scene.models[0]!, modelId: "missing" }] };
    expect(assessScenePublication(publicationProject(), scene, [stale])).toMatchObject({ status: "ready", blockers: 0 });
  });

  it.each(["models", "primitives", "cross-kind"] as const)("blocks duplicate IDs in %s", (kind) => {
    const scene = publicationScene();
    const model = scene.models[0]!;
    const primitive = { ...model, kind: "box" as const, color: "#ffffff" };
    if (kind === "models") scene.models.push({ ...model }, { ...model });
    else if (kind === "primitives") { scene.models = []; scene.primitives = [primitive, { ...primitive }]; }
    else scene.primitives = [primitive];
    const report = assessScenePublication(publicationProject(), scene, []);
    expect(report.blockers).toBe(1);
    expect(report.issues).toEqual([expect.objectContaining({ title: "三维对象 ID 重复", targetId: model.modelId })]);
  });

  it("blocks duplicate widgets instead of silently accepting the last one", () => {
    const scene = publicationScene();
    const widget = { id: "kpi", title: "数值", key: "", type: "text" as const, unit: "", x: 0, y: 0, w: 100, h: 100 };
    scene.dashboard = { side: "right", width: 400, widgets: [widget, { ...widget }] };
    expect(assessScenePublication(publicationProject(), scene, []).issues).toEqual([
      expect.objectContaining({ title: "组件 ID 重复", targetId: "kpi" }),
    ]);
  });

  it("accepts primitive interaction targets without requiring an imported asset", () => {
    const scene = publicationScene();
    scene.primitives = [{ ...scene.models[0]!, modelId: "primitive-1", kind: "box", color: "#ffffff" }];
    scene.interactions = [{ id: "pick", name: "选择", enabled: true, trigger: "click", target: { kind: "object", modelId: "primitive-1" }, code: "console.log('pick')" }];
    expect(assessScenePublication(publicationProject(), scene, [])).toMatchObject({ status: "ready", blockers: 0 });
  });

  it("distinguishes an empty saved scene from a project with no scenes", () => {
    const scene = { ...publicationScene(), models: [] };
    expect(assessScenePublication(publicationProject(), scene, [])).toMatchObject({ status: "ready", blockers: 0 });
    expect(assessProjectPublication(publicationProject(), [])).toMatchObject({ status: "blocked", blockers: 1 });
  });
});

function spatialAudio(url: string) {
  return { enabled: true, url, autoplay: true, loopMode: "loop" as const, muted: false, volume: 0.7, refDistance: 2, maxDistance: 50, rolloffFactor: 1 };
}

function connection(type: DataConnectionRecord["type"], enabled: boolean): DataConnectionRecord {
  return { id: "connection-1", projectId: "project-1", name: type, type, enabled, config: {}, createdAt: "2026-08-27T10:00:00.000Z", updatedAt: "2026-08-27T10:00:00.000Z" };
}

function dataset(): DataDatasetRecord {
  return { id: "dataset-1", projectId: "project-1", connectionId: "connection-1", name: "Events", sourceKey: "events", refreshSeconds: 5, fields: [], createdAt: "2026-08-27T10:00:00.000Z", updatedAt: "2026-08-27T10:00:00.000Z" };
}

function publicationProject(): ProjectRecord {
  return {
    id: "project-1", name: "产线", description: "", createdAt: "2026-08-27T10:00:00.000Z", updatedAt: "2026-08-27T10:00:00.000Z",
    models: [{ id: "model-1", projectId: "project-1", name: "设备", format: "glb", size: 1024, status: "ready", progress: 100, message: "", sourceUrl: "/model.glb", createdAt: "2026-08-27T10:00:00.000Z", updatedAt: "2026-08-27T10:00:00.000Z" }],
    datasets: [{ ...dataset(), fields: [{ key: "temperature", label: "温度", type: "number", unit: "℃" }] }],
    dataPipelines: [], assets: [], unityResources: [],
  };
}

function publicationScene(): SceneSnapshot {
  return {
    schemaVersion: 1, id: "scene-1", projectId: "project-1", name: "主场景",
    camera: { position: { x: 5, y: 5, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" },
    models: [{ modelId: "model-1", name: "设备", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }, layers: [{ nodeId: "pump", name: "泵", visible: true }] }],
    primitives: [], measurements: [], publishedAt: "2026-08-28T10:00:00.000Z",
    createdAt: "2026-08-27T10:00:00.000Z", updatedAt: "2026-08-28T10:00:00.000Z",
  };
}
