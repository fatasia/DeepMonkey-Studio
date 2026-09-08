import { describe, expect, it } from "vitest";
import fixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { migrateSceneSnapshotV1, type DashboardDataWidgetNode, type SceneSnapshot } from "@bim-studio/contracts";
import { ApplicationStore, applyStudioCommand, createPatchDashboardNodesCommand } from "./index.js";

const widget = (id: string): DashboardDataWidgetNode => ({ id, kind: "data-widget", frame: { x: 40, y: 40, width: 300, height: 160 }, zIndex: 1, widget: { type: "value", title: id, key: id, unit: "件" } });
function setup() { const doc = migrateSceneSnapshotV1(fixture as SceneSnapshot); doc.pages[0]!.nodes.push(widget("old")); return { doc, page: doc.pages[0]! }; }

describe("atomic dashboard draft command", () => {
  it("adds, updates and deletes in one undo step without mutating other objects", () => {
    const { doc, page } = setup(); page.nodes.push(widget("delete"));
    const store = new ApplicationStore(); store.load(doc);
    const command = createPatchDashboardNodesCommand(doc, page, [
      { op: "add", node: widget("new") }, { op: "update", node: { ...widget("old"), widget: { ...widget("old").widget, title: "更新" } } }, { op: "delete", nodeId: "delete" },
    ]);
    store.dispatch(command);
    expect(store.getState().document!.pages[0]!.nodes.find(node => node.id === "new")).toBeDefined();
    expect(store.getState().document!.scenes).toEqual(doc.scenes);
    store.undo(); expect(store.getState().document).toEqual(doc);
    store.redo(); expect(store.getState().document!.pages[0]!.nodes.some(node => node.id === "delete")).toBe(false);
  });
  it("rejects stale revisions, page edits, foreign identities and empty commands", () => {
    const { doc, page } = setup(); const command = createPatchDashboardNodesCommand(doc, page, [{ op: "add", node: widget("new") }]);
    for (const patch of [{ revision: 99 }, { projectId: "other" }, { pageId: "missing" }, { baseline: "{}" }, { changes: [] }]) {
      expect(() => applyStudioCommand(doc, { ...command, payload: { ...command.payload, ...patch } })).toThrow();
    }
    expect(page.nodes.some(node => node.id === "new")).toBe(false);
  });
  it("rejects unknown JSON and malformed nodes at the public command boundary", () => {
    const { doc, page } = setup(); const command = createPatchDashboardNodesCommand(doc, page, []);
    for (const changes of [null, [null], [{ op: "rename", node: widget("old") }], [{ op: "add" }], [{ op: "add", node: { ...widget("bad"), frame: null } }], [{ op: "delete" }]]) {
      expect(() => applyStudioCommand(doc, { ...command, payload: { ...command.payload, changes } } as never)).toThrowError(/草案|组件/);
    }
  });
  it("rejects locked, out-of-bounds, duplicate and cross-page IDs without partial mutation", () => {
    const { doc, page } = setup(); page.nodes.push({ ...widget("locked"), locked: true });
    doc.pages.push({ ...page, id: "other", nodes: [widget("foreign")] });
    for (const change of [{ op: "delete", nodeId: "locked" }, { op: "add", node: widget("foreign") }, { op: "add", node: { ...widget("far"), frame: { x: -1, y: 0, width: 100, height: 100 } } }] as const) {
      const before = JSON.stringify(doc);
      expect(() => applyStudioCommand(doc, createPatchDashboardNodesCommand(doc, page, [{ op: "add", node: widget("first") }, change]))).toThrow();
      expect(JSON.stringify(doc)).toBe(before);
    }
  });
  it("protects cross-page parameters, explicit script targets and interaction sources", () => {
    const { doc, page } = setup();
    doc.pages.push({ ...page, id: "other", nodes: [{ ...widget("child"), widget: { ...widget("child").widget, parentFilterKey: "old" } }] });
    expect(() => applyStudioCommand(doc, createPatchDashboardNodesCommand(doc, page, [{ op: "delete", nodeId: "old" }]))).toThrow("引用");
    doc.pages.pop(); doc.interactions.push({ id: "flow", name: "联动", source: { kind: "widget", id: "old" }, trigger: "click", enabled: true, actions: [] });
    expect(() => applyStudioCommand(doc, createPatchDashboardNodesCommand(doc, page, [{ op: "delete", nodeId: "old" }]))).toThrow("引用");
    doc.interactions = []; doc.scripts.push({ id: "script", name: "脚本", target: { kind: "component", id: "old" }, code: "", enabled: false, apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", lifecycle: [], capabilities: [], permissions: [] });
    expect(() => applyStudioCommand(doc, createPatchDashboardNodesCommand(doc, page, [{ op: "delete", nodeId: "old" }]))).toThrow("引用");
    expect(() => applyStudioCommand(doc, createPatchDashboardNodesCommand(doc, page, [{ op: "update", node: { ...widget("old"), widget: { ...widget("old").widget, key: "new-key" } } }]))).toThrow("数据键");
  });
});
