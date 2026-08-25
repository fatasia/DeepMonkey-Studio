import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../../test-fixtures/scene-v1-dashboard.json";
import pureFixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { applicationForScene, syncSceneIntoApplication } from "./sceneApplicationSync.js";

describe("scene and application synchronization", () => {
  it("finds the application that owns the scene", () => {
    const scene = dashboardFixture as unknown as SceneSnapshot;
    const application = migrateSceneSnapshotV1(scene);
    application.metadata.id = "application-id";

    expect(applicationForScene([application], scene.id)?.metadata.id).toBe("application-id");
  });

  it("updates 3D state without losing the 2D layout or non-model assets", () => {
    const source = migrateSceneSnapshotV1(dashboardFixture as unknown as SceneSnapshot);
    const page = source.pages[0]!;
    page.name = "定制生产总览";
    page.nodes[0]!.frame = { x: 80, y: 40, width: 1280, height: 720 };
    source.assets.push({ id: "hero", kind: "image", projectId: source.metadata.projectId, sourceName: "hero.png" });
    const update = structuredClone(dashboardFixture) as unknown as SceneSnapshot;
    update.name = "更新后的三维场景";

    const synced = syncSceneIntoApplication(source, update);

    expect(synced.pages[0]?.name).toBe("定制生产总览");
    expect(synced.pages[0]?.nodes[0]?.frame).toEqual({ x: 80, y: 40, width: 1280, height: 720 });
    expect(synced.scenes[0]?.name).toBe("更新后的三维场景");
    expect(synced.assets).toContainEqual(expect.objectContaining({ id: "hero", kind: "image" }));
    expect(source.scenes[0]?.name).not.toBe("更新后的三维场景");
  });

  it("adds a scene without replacing unrelated scenes", () => {
    const source = migrateSceneSnapshotV1(dashboardFixture as unknown as SceneSnapshot);
    const additional = pureFixture as unknown as SceneSnapshot;

    const synced = syncSceneIntoApplication(source, additional);

    expect(synced.scenes.map((scene) => scene.id)).toEqual([source.scenes[0]?.id, additional.id]);
  });
});
