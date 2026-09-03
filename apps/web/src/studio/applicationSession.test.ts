import { describe, expect, it } from "vitest";
import dashboardFixture from "../../../../test-fixtures/scene-v1-dashboard.json";
import { migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationSession } from "./applicationSession.js";

describe("ApplicationSession", () => {
  it("opens a native application document without changing its revision", () => {
    const session = new ApplicationSession();
    const application = migrateSceneSnapshotV1(dashboardFixture as unknown as SceneSnapshot);
    application.metadata.revision = 7;

    const opened = session.openDocument(application);

    expect(opened.metadata.revision).toBe(7);
    expect(opened).toEqual(application);
    expect(opened).not.toBe(application);
  });

  it("resets command history when another document is opened", () => {
    const session = new ApplicationSession();
    const first = migrateSceneSnapshotV1(dashboardFixture as unknown as SceneSnapshot);
    const second = structuredClone(first);
    second.metadata.id = "second-application";
    second.metadata.name = "第二应用";
    session.openDocument(first);
    session.store.dispatch({
      id: "temporary-rename",
      type: "application.rename",
      label: "临时重命名",
      payload: { name: "临时名称" }
    });

    session.openDocument(second);

    expect(session.getDocument()?.metadata.id).toBe("second-application");
    expect(session.getDocument()?.metadata.name).toBe("第二应用");
    expect(session.store.getState()).toMatchObject({ dirty: false, canUndo: false, canRedo: false });
  });

  it("retains valid selection when the same application is refreshed", () => {
    const session = new ApplicationSession();
    const application = migrateSceneSnapshotV1(dashboardFixture as unknown as SceneSnapshot);
    const selectedWidget = application.pages[0]?.nodes[0];
    expect(selectedWidget).toBeDefined();
    session.openDocument(application);
    session.store.setSelection([{ kind: "widget", id: selectedWidget!.id }]);

    session.openDocument(structuredClone(application));

    expect(session.store.getState().selection).toEqual([{ kind: "widget", id: selectedWidget!.id }]);
  });

  it("drops selection that no longer exists after refreshing the same application", () => {
    const session = new ApplicationSession();
    const application = migrateSceneSnapshotV1(dashboardFixture as unknown as SceneSnapshot);
    const selectedWidget = application.pages[0]?.nodes[0];
    expect(selectedWidget).toBeDefined();
    session.openDocument(application);
    session.store.setSelection([{ kind: "widget", id: selectedWidget!.id }]);
    const refreshed = structuredClone(application);
    refreshed.pages = refreshed.pages.map((page) => ({
      ...page,
      nodes: page.nodes.filter((node) => node.id !== selectedWidget!.id),
    }));

    session.openDocument(refreshed);

    expect(session.store.getState().selection).toEqual([]);
  });
});
