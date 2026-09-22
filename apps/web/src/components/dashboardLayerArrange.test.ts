import { describe, expect, it } from "vitest";
import { dashboardLayerNodes, migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore } from "@bim-studio/studio-core";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { createDashboardGroupingCommand, createDashboardLayerArrangeCommand } from "./dashboardLayerArrange";

function setup() {
  const document = migrateSceneSnapshotV1(fixture as SceneSnapshot), page = document.pages[0]!;
  const base = page.nodes[0]!;
  page.nodes = ["a", "b", "c", "d"].map((id, index) => ({ ...base, id, zIndex: 3 - index,
    ...(index < 2 ? { groupId: "g", groupName: "Group" } : {}) }));
  page.rootLayerOrder = [{ kind: "node", id: "c" }, { kind: "group", id: "g" }, { kind: "node", id: "d" }];
  return { document, page };
}
describe("dashboard menu layer order", () => {
  it("reorders whole groups as roots, but partial selections within their group", () => {
    const { document, page } = setup(), store = new ApplicationStore(document);
    store.dispatch(createDashboardLayerArrangeCommand(page, ["a", "b"], "front")!);
    let next = store.getState().document!.pages[0]!;
    expect(next.rootLayerOrder?.map(ref => ref.id)).toEqual(["g", "c", "d"]);
    store.dispatch(createDashboardLayerArrangeCommand(next, ["b"], "front")!);
    next = store.getState().document!.pages[0]!;
    expect(dashboardLayerNodes(next.nodes, next.rootLayerOrder).map(node => node.id)).toEqual(["b", "a", "c", "d"]);
    expect([...next.nodes].sort((a, b) => b.zIndex - a.zIndex).map(node => node.id)).toEqual(["b", "a", "c", "d"]);
    expect(next.nodes.find(node => node.id === "b")?.groupId).toBe("g");
  });
  it("groups and ungroups in place as single atomic history entries", () => {
    const { document, page } = setup(), store = new ApplicationStore(document);
    store.dispatch(createDashboardGroupingCommand(page, ["c", "d"], { id: "new", name: "Group" })!);
    let next = store.getState().document!.pages[0]!;
    expect(next.rootLayerOrder?.map(ref => ref.id)).toEqual(["new", "g"]);
    store.dispatch(createDashboardGroupingCommand(next, ["c", "d"])!);
    next = store.getState().document!.pages[0]!;
    expect(next.rootLayerOrder?.map(ref => ref.id)).toEqual(["c", "d", "g"]);
    expect(store.undo()).toBe(true); expect(store.getState().document!.pages[0]?.rootLayerOrder?.[0]?.id).toBe("new");
    expect(store.undo()).toBe(true); expect(store.getState().document!.pages[0]).toEqual(page);
  });
  it("refuses any locked or missing source without a partial command", () => {
    const { page } = setup(); page.nodes[0]!.locked = true;
    expect(createDashboardGroupingCommand(page, ["a", "c"])).toBeUndefined();
    expect(createDashboardLayerArrangeCommand(page, ["a", "c"], "back")).toBeUndefined();
    expect(createDashboardLayerArrangeCommand(page, ["missing"], "front")).toBeUndefined();
  });
});
