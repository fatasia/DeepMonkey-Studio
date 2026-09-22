import type { WidgetNode } from "@bim-studio/contracts";
import { describe, expect, it } from "vitest";
import { orderSceneLayerDragIds } from "./sceneLayerDragSession";
import { DashboardLayerDropPreview } from "./dashboardLayerDropPreview";
import { createDashboardLayerDropCommand } from "./dashboardLayerDrop";

function nodes(count: number): WidgetNode[] {
  return Array.from({ length: count }, (_, index) => ({ id: `n${index}`, zIndex: count - index, locked: false } as WidgetNode));
}
function elapsed(action: () => unknown, count: number) {
  const start = performance.now(); for (let i = 0; i < count; i++) action(); return (performance.now() - start) / count;
}

describe("large layer drag preview", () => {
  it("preserves visible order and folded selection order with linear lookup", () => {
    expect(orderSceneLayerDragIds(["a", "b", "c"], ["hidden-z", "c", "a", "hidden-y"])).toEqual(["a", "c", "hidden-z", "hidden-y"]);
    const visible = Array.from({ length: 10_000 }, (_, index) => `node-${index}`);
    const selected = [...visible].reverse();
    const reference = () => [...visible.filter(id => selected.includes(id)), ...selected.filter(id => !visible.includes(id))];
    const optimized = () => orderSceneLayerDragIds(visible, selected);
    expect(optimized()).toEqual(reference());
    const referenceMs = elapsed(reference, 3), optimizedMs = elapsed(optimized, 20);
    console.info(JSON.stringify({ benchmark: "3D 10000 selected ids", referenceMs, optimizedMs }));
  });
  it("invalidates cached preview on same-array lock, group, order and selection mutations", () => {
    const data = nodes(3), selection = ["n0"], cache = new DashboardLayerDropPreview();
    const inspect = () => cache.inspect("p", data, selection, "n0", "n2", { position: "after" });
    const first = inspect(); expect(inspect()).toBe(first);
    data[0]!.locked = true; expect(inspect().reason).toBe("locked-source");
    data[0]!.locked = false; const unlocked = inspect(); expect(unlocked.reason).toBeUndefined();
    data[2]!.groupId = "g"; expect(inspect()).not.toBe(unlocked);
    const grouped = inspect(); data[1]!.zIndex = 5; expect(inspect()).not.toBe(grouped);
    selection.push("n2"); expect(inspect().reason).toBe("self-target");
    selection.pop(); data.pop(); expect(inspect().reason).toBe("missing-node");
  });
  it("reuses unchanged target previews without sorting or rebuilding command payloads", () => {
    const data = nodes(10_000), selection = data.slice(0, 1000).map(node => node.id), cache = new DashboardLayerDropPreview();
    const intent = { position: "after" as const };
    const preview = () => cache.inspect("p", data, selection, "n0", "n9999", intent);
    const first = preview(); for (let i = 0; i < 3; i++) expect(preview()).toBe(first);
    const rebuildMs = elapsed(() => createDashboardLayerDropCommand("p", data, selection, "n0", "n9999", intent), 20);
    const cachedMs = elapsed(preview, 20);
    console.info(JSON.stringify({ benchmark: "2D 10000 nodes, 1000 selected, repeated target", rebuildMs, cachedMs }));
  });
});
