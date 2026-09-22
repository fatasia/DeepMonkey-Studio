import { describe, expect, it } from "vitest";
import { dashboardLayerNodes, migrateSceneSnapshotV1, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore } from "@bim-studio/studio-core";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { createDashboardLayerDropCommand } from "./dashboardLayerDrop";

function setup() {
  const document = migrateSceneSnapshotV1(fixture as SceneSnapshot);
  const page = document.pages[0]!;
  const template = page.nodes[0]!;
  page.nodes = ["a", "b", "c", "d", "e"].map((id, index) => ({ ...structuredClone(template), id, zIndex: 4 - index }));
  return { document, page };
}
const order = (nodes: ReturnType<typeof setup>["page"]["nodes"]) => [...nodes].sort((a, b) => b.zIndex - a.zIndex).map(node => node.id);

describe("dashboard layer drop command", () => {
  it("moves whole same-name groups and restores both root order and zIndex with one undo", () => {
    const { document, page } = setup();
    Object.assign(page.nodes[0]!, { groupId: "one", groupName: "同名" });
    Object.assign(page.nodes[1]!, { groupId: "one", groupName: "同名" });
    Object.assign(page.nodes[2]!, { groupId: "two", groupName: "同名" });
    const store = new ApplicationStore(document);
    const original = structuredClone(page);
    store.dispatch(createDashboardLayerDropCommand(page.id, page.nodes, [], "one", "two", { sourceKind: "group", targetKind: "group", position: "after" }).command!);
    const next = store.getState().document!.pages[0]!;
    expect(next.rootLayerOrder?.map(ref => ref.id)).toEqual(["two", "one", "d", "e"]);
    expect(order(next.nodes)).toEqual(dashboardLayerNodes(next.nodes, next.rootLayerOrder).map(node => node.id));
    expect(next.nodes.find(node => node.id === "a")?.groupId).toBe("one");
    expect(next.nodes.map(node => node.frame)).toEqual(original.nodes.map(node => node.frame));
    expect(store.undo()).toBe(true); expect(store.getState().document!.pages[0]).toEqual(original);
    expect(store.undo()).toBe(false); expect(store.redo()).toBe(true);
    expect(store.getState().document!.pages[0]?.rootLayerOrder).toEqual(next.rootLayerOrder);
  });
  it("places ordinary nodes at group edges without joining the group", () => {
    const { document, page } = setup(); Object.assign(page.nodes[0]!, { groupId: "one" });
    const store = new ApplicationStore(document);
    store.dispatch(createDashboardLayerDropCommand(page.id, page.nodes, [], "e", "one", { targetKind: "group", position: "before" }).command!);
    const next = store.getState().document!.pages[0]!;
    expect(next.rootLayerOrder?.slice(0, 2)).toEqual([{ kind: "node", id: "e" }, { kind: "group", id: "one" }]);
    expect(next.nodes.find(node => node.id === "e")?.groupId).toBeUndefined();
    expect(order(next.nodes)).toEqual(["e", "a", "b", "c", "d"]);
  });
  it("keeps the former group position when its last member is dropped at its edge", () => {
    const { document, page } = setup(); Object.assign(page.nodes[0]!, { groupId: "only" });
    const store = new ApplicationStore(document);
    store.dispatch(createDashboardLayerDropCommand(page.id, page.nodes, [], "a", "only", { targetKind: "group", position: "before" }).command!);
    const next = store.getState().document!.pages[0]!;
    expect(next.rootLayerOrder?.map(ref => ref.id)).toEqual(["a", "b", "c", "d", "e"]);
    expect(next.nodes[0]?.groupId).toBeUndefined();
  });
  it("rejects locked group members, stale group ids and nested groups", () => {
    const { page } = setup(); Object.assign(page.nodes[0]!, { groupId: "one" }); Object.assign(page.nodes[1]!, { groupId: "one", locked: true });
    expect(createDashboardLayerDropCommand(page.id, page.nodes, [], "one", "e", { sourceKind: "group", position: "after" }).reason).toBe("locked-source");
    expect(createDashboardLayerDropCommand(page.id, page.nodes, [], "gone", "e", { sourceKind: "group", position: "after" }).reason).toBe("missing-node");
    expect(createDashboardLayerDropCommand(page.id, page.nodes, [], "one", "one", { sourceKind: "group", targetKind: "group", position: "inside" }).reason).toBe("group-edge");
  });
  it("places a selected block after a row and allows inside only for a group", () => {
    const { document, page } = setup();
    const store = new ApplicationStore(document);
    store.dispatch(createDashboardLayerDropCommand(page.id, page.nodes, ["b", "a"], "a", "d", { position: "after" }).command!);
    expect(order(store.getState().document!.pages[0]!.nodes)).toEqual(["c", "d", "a", "b", "e"]);
    expect(createDashboardLayerDropCommand(page.id, page.nodes, [], "a", "c", { position: "inside" }).reason).toBe("invalid-inside");
    Object.assign(page.nodes[3]!, { groupId: "target", groupName: "目标" });
    const inside = createDashboardLayerDropCommand(page.id, page.nodes, ["a", "b"], "a", "target", { position: "inside", targetKind: "group" });
    const groupStore = new ApplicationStore(document); groupStore.dispatch(inside.command!);
    expect(groupStore.getState().document!.pages[0]!.nodes.filter(node => ["a", "b"].includes(node.id)).every(node => node.groupId === "target")).toBe(true);
  });
  it("moves cross-group selection in layer order, and undoes/redoes the whole operation once", () => {
    const { document, page } = setup();
    Object.assign(page.nodes[0]!, { groupId: "old", groupName: "旧组" });
    Object.assign(page.nodes[3]!, { groupId: "new", groupName: "新组" });
    const original = structuredClone(page.nodes);
    const result = createDashboardLayerDropCommand(page.id, page.nodes, ["c", "a"], "a", "d");
    expect(result.command).toBeDefined();
    const store = new ApplicationStore(document);
    store.dispatch(result.command!);
    const moved = store.getState().document!.pages[0]!.nodes;
    expect(order(moved)).toEqual(["a", "c", "d", "b", "e"]);
    for (const id of ["a", "c"]) expect(moved.find(node => node.id === id)).toMatchObject({ groupId: "new", groupName: "新组" });
    expect(page.nodes).toEqual(original);
    expect(store.undo()).toBe(true);
    expect(store.getState().document!.pages[0]!.nodes).toEqual(original);
    expect(store.undo()).toBe(false);
    expect(store.redo()).toBe(true);
    expect(order(store.getState().document!.pages[0]!.nodes)).toEqual(["a", "c", "d", "b", "e"]);
  });

  it("rejects a mixed locked selection as a whole without any history change", () => {
    const { document, page } = setup();
    page.nodes[1]!.locked = true;
    const original = structuredClone(page.nodes);
    const result = createDashboardLayerDropCommand(page.id, page.nodes, ["b", "a", "c"], "a");
    expect(result).toEqual({ reason: "locked-source" });
    const store = new ApplicationStore(document);
    expect(store.getState().document!.pages[0]!.nodes).toEqual(original);
    expect(store.undo()).toBe(false);
  });

  it("moves an unselected drag source alone and removes group metadata on root drop", () => {
    const { document, page } = setup();
    Object.assign(page.nodes[0]!, { groupId: "old", groupName: "旧组" });
    const store = new ApplicationStore(document);
    store.dispatch(createDashboardLayerDropCommand(page.id, page.nodes, ["c", "d"], "a").command!);
    const nodes = store.getState().document!.pages[0]!.nodes;
    expect(order(nodes)).toEqual(["b", "c", "d", "e", "a"]);
    expect(nodes[0]!.groupId).toBeUndefined();
    expect(nodes[0]!.groupName).toBeUndefined();
  });

  it("rejects a destination group containing a locked member", () => {
    const { page } = setup();
    Object.assign(page.nodes[3]!, { groupId: "target" });
    Object.assign(page.nodes[4]!, { groupId: "target", locked: true });
    expect(createDashboardLayerDropCommand(page.id, page.nodes, ["a"], "a", "d")).toEqual({ reason: "locked-group" });
  });

  it("rejects insufficient integer space between locked anchors", () => {
    const { page } = setup();
    page.nodes[0]!.locked = true;
    page.nodes[2]!.locked = true;
    expect(createDashboardLayerDropCommand(page.id, page.nodes, ["e"], "e", "b")).toEqual({ reason: "locked-order-gap" });
  });

  it("rejects deleted, locked, selected or unchanged targets without a history command", () => {
    const { page } = setup();
    expect(createDashboardLayerDropCommand(page.id, page.nodes, [], "missing").reason).toBe("missing-node");
    expect(createDashboardLayerDropCommand(page.id, page.nodes, [], "a", "missing").reason).toBe("missing-node");
    expect(createDashboardLayerDropCommand(page.id, page.nodes, ["a", "deleted"], "a", "e").reason).toBe("missing-node");
    expect(createDashboardLayerDropCommand(page.id, page.nodes, ["a", "b"], "a", "b").reason).toBe("self-target");
    expect(createDashboardLayerDropCommand(page.id, page.nodes, [], "a", "b").reason).toBe("unchanged");
    page.nodes[0]!.locked = true;
    expect(createDashboardLayerDropCommand(page.id, page.nodes, [], "a", "e").reason).toBe("locked-source");
  });
});
