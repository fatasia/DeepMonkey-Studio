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
  });

  it("does not mutate the input snapshot", () => {
    const input = structuredClone(dashboardFixture) as SceneSnapshot;
    const before = structuredClone(input);
    migrateSceneSnapshotV1(input);
    expect(input).toEqual(before);
  });
});
