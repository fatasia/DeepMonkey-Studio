import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../test-fixtures/scene-v1-dashboard.json";
import interactionFixture from "../../../test-fixtures/scene-v1-interaction.json";
import pure3dFixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import type { SceneSnapshot } from "./index.js";
import { applicationToSceneSnapshotV1, migrateSceneSnapshotV1 } from "./applicationMigration.js";

const fixtures = [pure3dFixture, dashboardFixture, interactionFixture] as unknown as SceneSnapshot[];

describe("scene bridge to native ApplicationDocument", () => {
  it.each(fixtures.map((fixture) => [fixture.id, fixture] as const))
    ("round-trips %s through ApplicationDocument v2", (_id, snapshot) => {
      const application = migrateSceneSnapshotV1(snapshot);
      expect(application.schemaVersion).toBe(2);
      expect(applicationToSceneSnapshotV1(application)).toEqual(snapshot);
    });

  it("promotes dashboard widgets to first-class page nodes", () => {
    const application = migrateSceneSnapshotV1(dashboardFixture as SceneSnapshot);
    expect(application.pages).toHaveLength(1);
    expect(application.pages[0]?.nodes.map((node) => node.kind)).toEqual([
      "scene-viewport",
      "data-widget"
    ]);
    expect(application.pages[0]?.nodes[1]).toMatchObject({
      id: "temperature",
      kind: "data-widget",
      widget: { title: "温度", type: "value", key: "temperature" }
    });
    expect(application.scenes[0]).not.toHaveProperty("dashboard");
  });

  it("marks v1 scripts as legacy trusted without losing actions or code", () => {
    const application = migrateSceneSnapshotV1(interactionFixture as SceneSnapshot);
    expect(application.interactions[0]?.legacyScript?.runtime).toBe("legacy-trusted-main-thread");
    expect(application.interactions[0]?.legacyScript?.script).toEqual(interactionFixture.interactions?.[0]);
    expect(application.scripts[0]).toEqual({
      id: "script:flow-1",
      name: "点击聚焦",
      enabled: true,
      apiVersion: "1.0",
      entrypoint: "behavior",
      runtime: "legacy-trusted-main-thread",
      code: "console.info('legacy trusted script')",
      lifecycle: [],
      capabilities: ["legacy.viewer", "legacy.three", "legacy.browser"],
      permissions: []
    });
  });

  it("does not mutate the input snapshot", () => {
    const input = structuredClone(dashboardFixture) as SceneSnapshot;
    const before = structuredClone(input);
    migrateSceneSnapshotV1(input);
    expect(input).toEqual(before);
  });

  it("keeps shared 3D data bindings through the application bridge", () => {
    const input = structuredClone(pure3dFixture) as unknown as SceneSnapshot;
    input.dataBindings = [{
      id: "binding-1",
      name: "机器人状态",
      enabled: true,
      pipelineId: "pipeline-robots",
      field: "online",
      target: { modelId: "robot-1" },
      action: "visibility",
      refreshSeconds: 5
    }];

    const application = migrateSceneSnapshotV1(input);
    expect(application.scenes[0]?.dataBindings).toEqual(input.dataBindings);
    expect(applicationToSceneSnapshotV1(application).dataBindings).toEqual(input.dataBindings);
  });

  it("keeps scene-level navigation tuning through the application bridge", () => {
    const input = structuredClone(pure3dFixture) as unknown as SceneSnapshot;
    input.navigationSettings = {
      walkSpeed: 3.5,
      flySpeed: 8,
      sprintMultiplier: 2.5,
      eyeHeight: 1.72,
      gravity: 9.81,
      jumpSpeed: 4.8,
      stepHeight: 0.28,
      maxSlopeAngle: 48
    };

    const application = migrateSceneSnapshotV1(input);
    expect(application.scenes[0]?.navigationSettings).toEqual(input.navigationSettings);
    expect(applicationToSceneSnapshotV1(application).navigationSettings).toEqual(input.navigationSettings);
  });

  it("keeps reusable scene selection sets independent from renderer objects", () => {
    const input = structuredClone(pure3dFixture) as unknown as SceneSnapshot;
    input.selectionSets = [{ id: "selection-line-a", name: "一号产线", objectIds: ["robot-1", "conveyor-2"] }];

    const application = migrateSceneSnapshotV1(input);
    expect(application.scenes[0]?.selectionSets).toEqual(input.selectionSets);
    expect(applicationToSceneSnapshotV1(application).selectionSets).toEqual(input.selectionSets);
  });
  it("round trips author root layer ordering without adding it to legacy scenes", () => {
    const input = structuredClone(pure3dFixture) as unknown as SceneSnapshot;
    expect(applicationToSceneSnapshotV1(migrateSceneSnapshotV1(input))).not.toHaveProperty("rootLayerOrder");
    input.rootLayerOrder = [{ kind: "object", id: "pump" }, { kind: "group", id: "line" }];
    const application = migrateSceneSnapshotV1(input);
    expect(application.scenes[0]?.rootLayerOrder).toEqual(input.rootLayerOrder);
    expect(applicationToSceneSnapshotV1(application)).toEqual(input);
    expect(application.scenes[0]?.rootLayerOrder).not.toBe(input.rootLayerOrder);
  });
});
