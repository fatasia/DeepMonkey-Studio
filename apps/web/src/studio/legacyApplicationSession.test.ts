import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../../packages/contracts/src/__fixtures__/scene-v1-dashboard.json";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { LegacyApplicationSession } from "./legacyApplicationSession.js";

describe("LegacyApplicationSession", () => {
  it("opens v1 as v2 state and emits the same v1 snapshot", () => {
    const session = new LegacyApplicationSession();
    const snapshot = dashboardFixture as unknown as SceneSnapshot;

    expect(session.open(snapshot).schemaVersion).toBe(2);
    expect(session.getApplication()?.metadata.id).toBe(snapshot.id);
    expect(session.capture(snapshot)).toEqual(snapshot);
  });

  it("replaces state when navigation opens another scene", () => {
    const session = new LegacyApplicationSession();
    session.open(dashboardFixture as unknown as SceneSnapshot);
    session.store.dispatch({
      id: "temporary-rename",
      type: "application.rename",
      label: "临时重命名",
      payload: { name: "临时名称" }
    });
    const second = { ...structuredClone(dashboardFixture), id: "second-scene", name: "第二场景" } as SceneSnapshot;

    session.open(second);

    expect(session.getApplication()?.metadata.id).toBe("second-scene");
    expect(session.getApplication()?.metadata.name).toBe("第二场景");
    expect(session.store.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: false });
  });

  it("captures current v1 changes instead of stale opened state", () => {
    const session = new LegacyApplicationSession();
    const opened = dashboardFixture as unknown as SceneSnapshot;
    const current = { ...structuredClone(opened), name: "当前编辑名称" } as SceneSnapshot;
    session.open(opened);

    expect(session.capture(current)).toEqual(current);
    expect(session.getApplication()?.metadata.name).toBe("当前编辑名称");
  });

  it("does not mutate snapshots passed to open or capture", () => {
    const session = new LegacyApplicationSession();
    const snapshot = structuredClone(dashboardFixture) as unknown as SceneSnapshot;
    const before = structuredClone(snapshot);

    session.open(snapshot);
    session.capture(snapshot);

    expect(snapshot).toEqual(before);
  });
});
