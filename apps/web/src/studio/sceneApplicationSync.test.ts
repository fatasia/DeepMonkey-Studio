import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../../test-fixtures/scene-v1-dashboard.json";
import interactionFixture from "../../../../test-fixtures/scene-v1-interaction.json";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { assertApplicationDocument, migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { applicationForScene, syncSceneIntoApplication } from "./sceneApplicationSync.js";

describe("scene and application synchronization", () => {
  it("keeps publication preferences on snapshots, not on the 3D document returned to 2D", () => {
    const snapshot = { ...structuredClone(pureFixture), publicationMode: "webgpu-preferred", publicationPerformance: "fast", publicationToolbarVisible: false, publishedAt: "2026-09-06T00:00:00.000Z" } as SceneSnapshot;
    const application = migrateSceneSnapshotV1(snapshot);
    const result = syncSceneIntoApplication(application, snapshot);
    expect(() => assertApplicationDocument(result)).not.toThrow();
    for (const field of ["publicationMode", "publicationPerformance", "publicationToolbarVisible", "publishedAt"]) expect(result.scenes[0]).not.toHaveProperty(field);
    expect(snapshot.publicationMode).toBe("webgpu-preferred");
    expect(result.pages).toEqual(application.pages);
  });
  it("stores shared resources once while preserving independent object identities", () => {
    const snapshot = structuredClone(pureFixture) as unknown as SceneSnapshot;
    const model = { modelId: "one", assetModelId: "shared", name: "实例", visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } };
    snapshot.models = [model, { ...model, modelId: "two" }];
    const source = migrateSceneSnapshotV1(snapshot);
    const synced = syncSceneIntoApplication(source, snapshot);
    expect(synced.assets.filter(asset => asset.kind === "model").map(asset => asset.id)).toEqual(["shared"]);
    expect(synced.scenes[0]?.models.map(instance => instance.modelId)).toEqual(["one", "two"]);
    expect(synced.scenes[0]?.models).toEqual(snapshot.models);
  });

  it("finds the application that owns the scene", () => {
    const scene = dashboardFixture as unknown as SceneSnapshot;
    const application = migrateSceneSnapshotV1(scene);
    application.metadata.id = "application-id";

    expect(applicationForScene([application], scene.id)?.metadata.id).toBe("application-id");
  });

  it("updates 3D state without allowing the scene draft to overwrite 2D-owned state", () => {
    const source = migrateSceneSnapshotV1(dashboardFixture as unknown as SceneSnapshot);
    const page = source.pages[0]!;
    page.name = "定制生产总览";
    page.nodes[0]!.frame = { x: 80, y: 40, width: 1280, height: 720 };
    const dataWidget = page.nodes.find((node) => node.kind === "data-widget")!;
    dataWidget.frame = { x: 1440, y: 60, width: 360, height: 160 };
    const originalWidgetTitle = dataWidget.kind === "data-widget" ? dataWidget.widget.title : undefined;
    source.assets.push({ id: "hero", kind: "image", projectId: source.metadata.projectId, sourceName: "hero.png" });
    const update = structuredClone(dashboardFixture) as unknown as SceneSnapshot;
    update.name = "更新后的三维场景";
    update.dashboard!.widgets[0]!.title = "最新温度";

    const synced = syncSceneIntoApplication(source, update);

    expect(synced.pages[0]?.name).toBe("定制生产总览");
    expect(synced.pages[0]?.nodes[0]?.frame).toEqual({ x: 80, y: 40, width: 1280, height: 720 });
    expect(synced.scenes[0]?.name).toBe("更新后的三维场景");
    expect(synced.pages[0]?.nodes.find((node) => node.id === dataWidget.id)).toMatchObject({
      kind: "data-widget",
      frame: { x: 1440, y: 60, width: 360, height: 160 },
      widget: { title: originalWidgetTitle }
    });
    expect(synced.assets).toContainEqual(expect.objectContaining({ id: "hero", kind: "image" }));
    expect(source.scenes[0]?.name).not.toBe("更新后的三维场景");
  });

  it("adds a scene without replacing unrelated scenes", () => {
    const source = migrateSceneSnapshotV1(dashboardFixture as unknown as SceneSnapshot);
    const additional = pureFixture as unknown as SceneSnapshot;

    const synced = syncSceneIntoApplication(source, additional);

    expect(synced.scenes.map((scene) => scene.id)).toEqual([source.scenes[0]?.id, additional.id]);
  });

  it("replaces 3D-owned interactions while preserving native 2D flows", () => {
    const update = structuredClone(interactionFixture) as unknown as SceneSnapshot;
    const source = migrateSceneSnapshotV1(update);
    source.interactions.push({
      id: "widget-flow",
      name: "二维联动",
      source: { kind: "widget", id: "temperature" },
      trigger: "click",
      enabled: true,
      actions: []
    });
    update.interactions = [];

    const synced = syncSceneIntoApplication(source, update);

    expect(synced.interactions.map((flow) => flow.id)).toEqual(["widget-flow"]);
    expect(synced.scripts.some((script) => script.id === "script:flow-1")).toBe(false);
  });
});
