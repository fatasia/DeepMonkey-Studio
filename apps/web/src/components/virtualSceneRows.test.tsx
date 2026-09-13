import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { LayerTreeNode } from "../viewer/ViewerEngine";
import { WindowedSceneRows } from "./WindowedSceneRows";
import { sceneRowOffsets, sceneRowScrollDelta, visibleSceneRows } from "./virtualSceneRows";
import { layerAncestors, visibleLayerTree } from "./visibleLayerTree";

describe("large scene row window", () => {
  it("creates only visible rows, preserves an edited offscreen row and has a full-render escape", () => {
    const called: number[] = [], rows = Array.from({ length: 10_000 }, (_, i) => ({ key: String(i), keepMounted: i === 9999, render: () => { called.push(i); return <button>设备 {i}</button>; } }));
    const html = renderToStaticMarkup(<WindowedSceneRows rows={rows} />);
    expect(called.length).toBeLessThan(30); expect(called).toContain(9999);
    expect(html).toContain('data-total-rows="10000"'); expect(html).toContain('data-windowed="true"');
    called.length = 0;
    renderToStaticMarkup(<WindowedSceneRows rows={rows} enabled={false} />);
    expect(called).toHaveLength(10_000);
  });
  it("keeps small lists intact and handles empty lists", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({ key: String(i), render: () => <button>{i}</button> }));
    expect(renderToStaticMarkup(<WindowedSceneRows rows={rows} />)).toContain('data-windowed="false"');
    expect(sceneRowOffsets([], new Map(), 32)).toEqual([0]);
    expect(visibleSceneRows([0], 0, 400)).toEqual({ start: 0, end: 0 });
  });
  it("preserves variable expanded heights and skips an offscreen nested tree", () => {
    const rows = [{ key: "a" }, { key: "b", estimateHeight: 80 }, { key: "c" }];
    const offsets = sceneRowOffsets(rows, new Map([["a", 33], ["b", 280_000]]), 32);
    expect(offsets).toEqual([0, 33, 280_033, 280_065]);
    expect(visibleSceneRows(offsets, 32, 400, 0)).toEqual({ start: 0, end: 2 });
    expect(visibleSceneRows(offsets, -1000, 400)).toEqual({ start: 0, end: 0 });
    expect(visibleSceneRows(offsets, 300_000, 400)).toEqual({ start: 0, end: 0 });
    expect(sceneRowScrollDelta(999 * 34, 1000 * 34, 0, 260)).toBe(33740);
    expect(sceneRowScrollDelta(15, 49, 0, 260)).toBe(0);
    expect(sceneRowScrollDelta(0, 280_000, 200_000, 260)).toBe(-200_000);
  });
  it("indexes visible hierarchy in stable DFS order and opens only selected ancestors", () => {
    const node = (id: string, children: LayerTreeNode[] = []): LayerTreeNode => ({ id, modelId: "m", name: id, type: "Group", visible: true, locked: false, deleted: false, children });
    const root = node("root", [node("a", [node("a1"), node("a2")]), node("b")]);
    expect(visibleLayerTree(root, new Set(["root"])).map(row => row.node.id)).toEqual(["root", "a", "b"]);
    expect(layerAncestors(root, "a2")).toEqual(["a", "root"]);
    expect(visibleLayerTree(root, new Set(layerAncestors(root, "a2"))).map(row => [row.node.id, row.depth])).toEqual([["root", 0], ["a", 1], ["a1", 2], ["a2", 2], ["b", 1]]);
    expect(layerAncestors(root, "deleted")).toEqual([]);
  });
});
