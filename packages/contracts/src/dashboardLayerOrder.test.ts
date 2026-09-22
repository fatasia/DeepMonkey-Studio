import { describe, expect, it } from "vitest";
import fixture from "../../../test-fixtures/scene-v1-pure-3d.json";
import { assertApplicationDocument, type WidgetNode } from "./application.js";
import { migrateSceneSnapshotV1 } from "./applicationMigration.js";
import { dashboardLayerNodes, dashboardRootLayerOrder } from "./dashboardLayerOrder.js";
import type { SceneSnapshot } from "./scene.js";

describe("dashboard author root order", () => {
  const document = () => migrateSceneSnapshotV1(fixture as SceneSnapshot);
  it("round trips authored order and preserves legacy absence", () => {
    const old = document(); assertApplicationDocument(old); expect(old.pages[0]).not.toHaveProperty("rootLayerOrder");
    old.pages[0]!.rootLayerOrder = [{ kind: "group", id: "same" }, { kind: "node", id: "same" }];
    const restored = JSON.parse(JSON.stringify(old)); assertApplicationDocument(restored);
    expect(restored.pages[0].rootLayerOrder).toEqual(old.pages[0]!.rootLayerOrder);
  });
  it.each([
    [{ kind: "node", id: "x" }, { kind: "node", id: "x" }], [{ kind: "node", id: " " }],
    [{ kind: "unknown", id: "x" }], [{ kind: "group", id: "x", extra: true }], [{ kind: "group" }],
  ])("rejects malformed or duplicate references %j", refs => {
    const value = document(); Object.assign(value.pages[0]!, { rootLayerOrder: refs });
    expect(() => assertApplicationDocument(value)).toThrow();
  });
  it("normalizes stale ids and keeps same-name groups distinct by id", () => {
    const base = document().pages[0]!.nodes[0]!;
    const nodes = [
      { ...base, id: "a", groupId: "one", groupName: "同名", zIndex: 3 },
      { ...base, id: "b", groupId: "two", groupName: "同名", zIndex: 2 },
      { ...base, id: "c", zIndex: 1 },
    ] as WidgetNode[];
    const roots = dashboardRootLayerOrder(nodes, [{ kind: "node", id: "deleted" }, { kind: "group", id: "two" }, { kind: "node", id: "c" }]);
    expect(roots.map(ref => ref.id)).toEqual(["two", "c", "one"]);
    expect(dashboardLayerNodes(nodes, roots).map(node => node.id)).toEqual(["b", "c", "a"]);
    expect(dashboardLayerNodes(nodes, roots, new Set(["two"])).map(node => node.id)).toEqual(["c", "a"]);
    expect(nodes.map(node => node.zIndex)).toEqual([3, 2, 1]);
  });
});
