import { describe, expect, it } from "vitest";
import { RETAINED_UI_BUDGETS, RETAINED_UI_SCHEMA_VERSION, hitTestRetainedUi, layoutRetainedUi, planRetainedUiUpdate, validateRetainedUiTree, type RetainedUiNode, type RetainedUiStyle, type RetainedUiTree } from "./retainedUi.js";

const style = (value: Partial<RetainedUiStyle> = {}): RetainedUiStyle => ({
  layout: "absolute", x: 0, y: 0, width: 40, height: 20,
  padding: 0, gap: 0, grow: 0, align: "start", clip: false,
  visible: true, opacity: 1, pointerEvents: "auto", zIndex: 0,
  background: null, foreground: [1, 1, 1, 1], borderColor: null,
  borderWidth: 0, cornerRadius: 0, fontId: null, fontSize: 14, ...value,
});
const node = (id: string, content: RetainedUiNode["content"], value: Partial<RetainedUiNode> = {}): RetainedUiNode => ({
  id, revision: 1, parentId: "root", children: [], style: style(), content,
  a11y: { role: content.kind === "text" ? "text" : content.kind === "image" ? "img" : "region", label: id }, ...value,
});
const allKinds = (): RetainedUiTree => {
  const children = ["label", "image", "viewport", "chart"];
  return {
    schemaVersion: RETAINED_UI_SCHEMA_VERSION, id: "ui", revision: 1, width: 300, height: 100, rootId: "root",
    nodes: [
      node("root", { kind: "container" }, { parentId: null, children, style: style({ layout: "flex-row", width: 300, height: 100, padding: 10, gap: 10, align: "stretch" }), a11y: { role: "application", label: "Studio" } }),
      node("label", { kind: "text", text: "压力" }, { style: style({ width: 40, grow: 1 }) }),
      node("image", { kind: "image", assetId: "asset/pump" }, { style: style({ width: 40, grow: 1 }) }),
      node("viewport", { kind: "viewport", surfaceId: "scene-main" }, { style: style({ width: 40, grow: 1 }) }),
      node("chart", { kind: "chart", chartSpecId: "chart/pressure" }, { style: style({ width: 40, grow: 1 }) }),
    ],
  };
};
const twoChildren = (): RetainedUiTree => ({
  schemaVersion: 1, id: "ui", revision: 1, width: 100, height: 100, rootId: "root",
  nodes: [
    node("root", { kind: "container" }, { parentId: null, children: ["a", "b"], style: style({ width: 100, height: 100, clip: true }), a11y: { role: "application" } }),
    node("a", { kind: "text", text: "A" }), node("b", { kind: "image", assetId: "B" }),
  ],
});

describe("retained UI tree validation", () => {
  it("accepts the five versioned node kinds and preserves stable ids", () => {
    const result = validateRetainedUiTree(allKinds());
    expect(result.diagnostics).toEqual([]);
    expect(result.tree?.nodes.map((item) => item.content.kind)).toEqual(["container", "text", "image", "viewport", "chart"]);
    const empty = twoChildren(); empty.nodes[1] = { ...empty.nodes[1]!, content: { kind: "text", text: "" } };
    expect(validateRetainedUiTree(empty).valid).toBe(true);
  });

  it("rejects unknown fields, duplicate ids, leaf children and parent mismatches", () => {
    const tree = structuredClone(twoChildren()) as RetainedUiTree & Record<string, unknown>;
    tree.legacyDom = true;
    (tree.nodes as RetainedUiNode[])[1] = { ...tree.nodes[1]!, parentId: "missing" };
    (tree.nodes as RetainedUiNode[])[2] = { ...tree.nodes[2]!, id: "a", parentId: "missing", children: ["a"] };
    const result = validateRetainedUiTree(tree);
    expect(result.valid).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toEqual(expect.arrayContaining(["unknown-field", "duplicate-id", "invalid-value", "parent-child-mismatch"]));
    const extent = twoChildren(); extent.nodes[0] = { ...extent.nodes[0]!, style: { ...extent.nodes[0]!.style, width: 99 } };
    expect(validateRetainedUiTree(extent).diagnostics).toContainEqual(expect.objectContaining({ code: "invalid-value", path: "$.rootId" }));
  });

  it("detects cycles even when the cycle is disconnected from root", () => {
    const tree = twoChildren();
    tree.nodes = [tree.nodes[0]!, node("a", { kind: "container" }, { parentId: "b", children: ["b"] }), node("b", { kind: "container" }, { parentId: "a", children: ["a"] })];
    tree.nodes[0]!.children = [];
    const result = validateRetainedUiTree(tree);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: "cycle" }), expect.objectContaining({ code: "unreachable" })]));
  });

  it("fails closed for functions, getters, sparse arrays, invalid numbers and budgets", () => {
    let read = false; const accessor = Object.defineProperty({}, "nodes", { enumerable: true, get: () => { read = true; return []; } });
    expect(validateRetainedUiTree(accessor).valid).toBe(false); expect(read).toBe(false);
    expect(validateRetainedUiTree({ ...twoChildren(), width: Number.NaN }).valid).toBe(false);
    const sparse = structuredClone(twoChildren()); sparse.nodes = new Array(2); sparse.nodes[1] = twoChildren().nodes[0]!;
    expect(validateRetainedUiTree(sparse).valid).toBe(false);
    const deep: Record<string, unknown> = {}; let cursor = deep; for (let i = 0; i <= RETAINED_UI_BUDGETS.jsonDepth; i += 1) { cursor.next = {}; cursor = cursor.next as Record<string, unknown>; }
    expect(validateRetainedUiTree(deep).diagnostics).toContainEqual(expect.objectContaining({ code: "budget-exceeded" }));
    expect(validateRetainedUiTree({ ...twoChildren(), callback: () => 1 }).valid).toBe(false);
    expect(validateRetainedUiTree({ ...twoChildren(), nodes: new Array(RETAINED_UI_BUDGETS.nodes + 1).fill(null) }).diagnostics).toContainEqual(expect.objectContaining({ code: "budget-exceeded", path: "$.nodes" }));
  });
});

describe("headless layout and clipped hit testing", () => {
  it("lays out flex rows deterministically with gap, grow and stretch", () => {
    const tree = allKinds(), layout = layoutRetainedUi(tree);
    const label = layout.frames.find((frame) => frame.id === "label")!, image = layout.frames.find((frame) => frame.id === "image")!;
    expect(label).toMatchObject({ x: 10, y: 10, width: 62.5, height: 80 });
    expect(image.x).toBe(82.5);
    expect(layoutRetainedUi(tree)).toEqual(layout);
    tree.nodes[1] = { ...tree.nodes[1]!, style: { ...tree.nodes[1]!.style, maxWidth: 50, maxHeight: 60 } };
    expect(layoutRetainedUi(tree).frames[1]).toMatchObject({ width: 50, height: 60 });
  });

  it.each([
    ["absolute", { x: 15, y: 25, width: 20, height: 10 }],
    ["stack", { x: 40, y: 45, width: 20, height: 10 }],
    ["flex-column", { x: 40, y: 0, width: 20, height: 100 }],
  ] as const)("supports %s layout", (mode, expected) => {
    const tree = twoChildren(); tree.nodes = [
      { ...tree.nodes[0]!, children: ["a"], style: style({ layout: mode, width: 100, height: 100, align: mode === "absolute" ? "start" : mode === "stack" ? "center" : "center" }) },
      { ...tree.nodes[1]!, style: style({ x: mode === "absolute" ? 15 : 0, y: mode === "absolute" ? 25 : 0, width: 20, height: 10, grow: mode === "flex-column" ? 1 : 0 }) },
    ];
    expect(layoutRetainedUi(tree).frames[1]).toMatchObject(expected);
  });

  it("clips descendants and resolves overlap by z-index then keyed paint order", () => {
    const tree = twoChildren(); tree.nodes = [
      tree.nodes[0]!,
      { ...tree.nodes[1]!, style: style({ x: 0, y: 0, width: 100, height: 100 }) },
      { ...tree.nodes[2]!, style: style({ x: 80, y: 0, width: 50, height: 50, zIndex: 2 }) },
    ];
    const layout = layoutRetainedUi(tree);
    expect(hitTestRetainedUi(tree, layout, 90, 10)).toBe("b");
    expect(hitTestRetainedUi(tree, layout, 110, 10)).toBeUndefined();
    expect(hitTestRetainedUi(tree, layout, Number.NaN, 0)).toBeUndefined();
  });
});

describe("deterministic incremental plans", () => {
  it("emits keyed initial insertion in tree order and stable fingerprints", () => {
    const first = planRetainedUiUpdate(undefined, twoChildren()), second = planRetainedUiUpdate(undefined, twoChildren());
    expect(first).toEqual(second);
    expect(first.plan?.operations.map((operation) => `${operation.kind}:${operation.id}`)).toEqual(["insert:root", "insert:a", "insert:b"]);
    expect(first.plan?.dirtyLayoutRoots).toEqual(["root"]);
  });

  it("marks text content as paint-only and rejects unchanged revisions", () => {
    const previous = twoChildren(), next = structuredClone(previous); next.revision = 2;
    next.nodes[1] = { ...next.nodes[1]!, revision: 2, content: { kind: "text", text: "Updated" } };
    const result = planRetainedUiUpdate(previous, next);
    expect(result.plan?.dirtyLayoutRoots).toEqual([]); expect(result.plan?.dirtyPaintRoots).toEqual(["a"]); expect(result.plan?.dirtyHitRoots).toEqual([]);
    next.nodes[1] = { ...next.nodes[1]!, revision: 1 };
    expect(planRetainedUiUpdate(previous, next).diagnostics).toContainEqual(expect.objectContaining({ code: "stale-revision", path: "$.nodes.a.revision" }));
  });

  it("emits reorder, insert and remove operations and collapses dirty descendants", () => {
    const previous = twoChildren(), reordered = structuredClone(previous); reordered.revision = 2; reordered.nodes[0] = { ...reordered.nodes[0]!, revision: 2, children: ["b", "a"] };
    const reorder = planRetainedUiUpdate(previous, reordered);
    expect(reorder.plan?.operations).toContainEqual({ kind: "reorder", parentId: "root", children: ["b", "a"] });
    expect(reorder.plan?.dirtyLayoutRoots).toEqual(["root"]);
    const inserted = structuredClone(previous); inserted.revision = 2; inserted.nodes[0] = { ...inserted.nodes[0]!, revision: 2, children: ["a", "c", "b"] }; inserted.nodes.push(node("c", { kind: "chart", chartSpecId: "new" }));
    expect(planRetainedUiUpdate(previous, inserted).plan?.operations.map((operation) => operation.kind)).toEqual(["insert", "reorder"]);
    const removed = structuredClone(previous); removed.revision = 2; removed.nodes[0] = { ...removed.nodes[0]!, revision: 2, children: ["a"] }; removed.nodes = removed.nodes.filter((item) => item.id !== "b");
    expect(planRetainedUiUpdate(previous, removed).plan?.operations.map((operation) => operation.kind)).toEqual(["remove", "reorder"]);
  });

  it("treats layout changes as paint and hit dirtiness and bounds action to a subtree", () => {
    const previous = twoChildren(), next = structuredClone(previous); next.revision = 2; next.nodes[1] = { ...next.nodes[1]!, revision: 2, style: { ...next.nodes[1]!.style, width: 80 } };
    const plan = planRetainedUiUpdate(previous, next).plan!;
    expect(plan.dirtyLayoutRoots).toEqual(["a"]); expect(plan.dirtyPaintRoots).toEqual(["a"]); expect(plan.dirtyHitRoots).toEqual(["a"]); expect(plan.dirtyA11yRoots).toEqual([]);
  });

  it("separates hit and accessibility cache invalidation", () => {
    const previous = twoChildren(), transparent = structuredClone(previous); transparent.revision = 2; transparent.nodes[1] = { ...transparent.nodes[1]!, revision: 2, style: { ...transparent.nodes[1]!.style, opacity: 0 } };
    const opacityPlan = planRetainedUiUpdate(previous, transparent).plan!;
    expect(opacityPlan.dirtyPaintRoots).toEqual(["a"]); expect(opacityPlan.dirtyHitRoots).toEqual(["a"]); expect(opacityPlan.dirtyLayoutRoots).toEqual([]);
    const renamed = structuredClone(previous); renamed.revision = 2; renamed.nodes[1] = { ...renamed.nodes[1]!, revision: 2, a11y: { role: "text", label: "Renamed" } };
    const a11yPlan = planRetainedUiUpdate(previous, renamed).plan!;
    expect(a11yPlan.dirtyA11yRoots).toEqual(["a"]); expect(a11yPlan.dirtyPaintRoots).toEqual([]);
    const recolored = structuredClone(previous); recolored.revision = 2; recolored.nodes[1] = { ...recolored.nodes[1]!, revision: 2, style: { ...recolored.nodes[1]!.style, background: [0.1, 0.2, 0.3, 1] } };
    const colorPlan = planRetainedUiUpdate(previous, recolored).plan!;
    expect(colorPlan.dirtyPaintRoots).toEqual(["a"]); expect(colorPlan.dirtyLayoutRoots).toEqual([]); expect(colorPlan.dirtyHitRoots).toEqual([]);
  });

  it("rejects revision rollback even when content is otherwise unchanged", () => {
    const previous = twoChildren(), next = structuredClone(previous); previous.nodes[1] = { ...previous.nodes[1]!, revision: 3 }; previous.revision = 3; next.nodes[1] = { ...next.nodes[1]!, revision: 2 }; next.revision = 4;
    expect(planRetainedUiUpdate(previous, next).diagnostics).toContainEqual(expect.objectContaining({ code: "stale-revision", path: "$.nodes.a.revision" }));
  });
});
