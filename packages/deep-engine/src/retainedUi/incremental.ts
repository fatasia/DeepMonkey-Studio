import { layoutRetainedUi } from "./layout.js";
import { validateRetainedUiTree } from "./validation.js";
import { RETAINED_UI_BUDGETS, type RetainedUiDiagnostic, type RetainedUiFingerprint, type RetainedUiIncrementalPlan, type RetainedUiNode, type RetainedUiOperation, type RetainedUiPlanResult, type RetainedUiTree } from "./types.js";
type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);
function add(out: RetainedUiDiagnostic[], code: RetainedUiDiagnostic["code"], path: string, message: string): void {
  if (out.length < RETAINED_UI_BUDGETS.diagnostics)
    out.push({ code, path, message });
}
function canonical(v: unknown): string { if (Array.isArray(v))
  return `[${v.map(canonical).join(",")}]`; if (object(v))
  return `{${Object.keys(v).sort().map((key) => `${JSON.stringify(key)}:${canonical(v[key])}`).join(",")}}`; return JSON.stringify(v); }
function hash(v: unknown): string { let value = 0xcbf29ce484222325n; for (const byte of new TextEncoder().encode(canonical(v))) {
  value ^= BigInt(byte);
  value = BigInt.asUintN(64, value * 0x100000001b3n);
} return value.toString(16).padStart(16, "0"); }
function fingerprints(tree: RetainedUiTree): RetainedUiFingerprint[] {
  return tree.nodes.map((node) => {
    const { visible, opacity, pointerEvents, zIndex, background, foreground, borderColor, borderWidth, cornerRadius, fontId, fontSize, ...layoutStyle } = node.style;
    const paintStyle = { background, foreground, borderColor, borderWidth, cornerRadius, fontId, fontSize };
    return {
      id: node.id,
      revision: node.revision,
      layout: hash({ parentId: node.parentId, children: node.children, style: layoutStyle }),
      paint: hash({ visible, opacity, zIndex, paintStyle, content: node.content }),
      hit: hash({ visible, opacity, clip: node.style.clip, pointerEvents, zIndex }),
      a11y: hash({ visible, a11y: node.a11y, children: node.children }),
      content: hash(node.content),
    };
  });
}
function preorder(tree: RetainedUiTree): string[] { const map = new Map(tree.nodes.map((node) => [node.id, node])), out: string[] = []; const visit = (id: string): void => { out.push(id); map.get(id)?.children.forEach(visit); }; visit(tree.rootId); return out; }
function minimal(ids: Set<string>, parents: Map<string, string | null>, order: readonly string[]): string[] { return order.filter((id) => { if (!ids.has(id))
  return false; for (let parent = parents.get(id); parent; parent = parents.get(parent))
  if (ids.has(parent))
    return false; return true; }); }
export function planRetainedUiUpdate(previousInput: unknown | undefined, nextInput: unknown): RetainedUiPlanResult {
  const nextResult = validateRetainedUiTree(nextInput);
  if (!nextResult.valid || !nextResult.tree)
    return { ok: false, diagnostics: nextResult.diagnostics };
  const next = nextResult.tree;
  const previousResult = previousInput === undefined ? undefined : validateRetainedUiTree(previousInput);
  if (previousResult && (!previousResult.valid || !previousResult.tree))
    return { ok: false, diagnostics: previousResult.diagnostics };
  const previous = previousResult?.tree;
  const diagnostics: RetainedUiDiagnostic[] = [], nextOrder = preorder(next), nextMap = new Map(next.nodes.map((node) => [node.id, node])), nextParents = new Map(next.nodes.map((node) => [node.id, node.parentId])), nextPrint = new Map(fingerprints(next).map((value) => [value.id, value]));
  if (!previous) {
    const operations = nextOrder.map((id) => { const node = nextMap.get(id)!; return { kind: "insert" as const, id, parentId: node.parentId, index: node.parentId ? nextMap.get(node.parentId)!.children.indexOf(id) : 0 }; });
    const root = [next.rootId];
    return { ok: true, diagnostics, tree: next, layout: layoutRetainedUi(next), plan: { operations, dirtyLayoutRoots: root, dirtyPaintRoots: root, dirtyHitRoots: root, dirtyA11yRoots: root, fingerprints: nextOrder.map((id) => nextPrint.get(id)!) } };
  }
  const previousOrder = preorder(previous), previousMap = new Map(previous.nodes.map((node) => [node.id, node])), previousPrint = new Map(fingerprints(previous).map((value) => [value.id, value])), operations: RetainedUiOperation[] = [], layout = new Set<string>(), paint = new Set<string>(), hit = new Set<string>(), accessibility = new Set<string>();
  const snapshot = (tree: RetainedUiTree, order: readonly string[], map: Map<string, RetainedUiNode>): unknown => ({ id: tree.id, rootId: tree.rootId, width: tree.width, height: tree.height, nodes: order.map((id) => map.get(id)) });
  const treeChanged = canonical(snapshot(previous, previousOrder, previousMap)) !== canonical(snapshot(next, nextOrder, nextMap));
  if (previous.id !== next.id)
    add(diagnostics, "invalid-value", "$.id", "Tree id must remain stable across an incremental update.");
  if (next.revision < previous.revision || treeChanged && next.revision <= previous.revision)
    add(diagnostics, "stale-revision", "$.revision", "Tree revision cannot decrease and must increase when semantics change.");
  if (previous.rootId !== next.rootId || previous.width !== next.width || previous.height !== next.height)
    [layout, paint, hit, accessibility].forEach((set) => set.add(next.rootId));
  previousOrder.slice().reverse().filter((id) => !nextMap.has(id)).forEach((id) => { const old = previousMap.get(id)!; operations.push({ kind: "remove", id }); if (old.parentId && nextMap.has(old.parentId))
    [layout, paint, hit, accessibility].forEach((set) => set.add(old.parentId!)); });
  nextOrder.filter((id) => !previousMap.has(id)).forEach((id) => { const node = nextMap.get(id)!; operations.push({ kind: "insert", id, parentId: node.parentId, index: node.parentId ? nextMap.get(node.parentId)!.children.indexOf(id) : 0 }); [layout, paint, hit, accessibility].forEach((set) => set.add(node.parentId ?? id)); });
  for (const id of nextOrder) {
    const oldNode = previousMap.get(id), node = nextMap.get(id);
    if (!oldNode || !node)
      continue;
    const oldPrint = previousPrint.get(id)!, nextFingerprint = nextPrint.get(id)!, changed = canonical({ parentId: oldNode.parentId, children: oldNode.children, style: oldNode.style, content: oldNode.content, a11y: oldNode.a11y }) !== canonical({ parentId: node.parentId, children: node.children, style: node.style, content: node.content, a11y: node.a11y });
    if (node.revision < oldNode.revision || changed && node.revision <= oldNode.revision)
      add(diagnostics, "stale-revision", `$.nodes.${id}.revision`, "Node revision cannot decrease and must increase when semantics change.");
    if (oldNode.parentId !== node.parentId || oldNode.children.join("\0") !== node.children.join("\0")) {
      layout.add(id);
      paint.add(id);
      hit.add(id);
      accessibility.add(id);
      if (oldNode.children.join("\0") !== node.children.join("\0"))
        operations.push({ kind: "reorder", parentId: id, children: node.children });
    }
    if (oldPrint.layout !== nextFingerprint.layout)
      layout.add(id);
    if (oldPrint.paint !== nextFingerprint.paint)
      paint.add(id);
    if (oldPrint.hit !== nextFingerprint.hit)
      hit.add(id);
    if (oldPrint.a11y !== nextFingerprint.a11y)
      accessibility.add(id);
    if (oldPrint.content !== nextFingerprint.content)
      paint.add(id);
  }
  for (const id of nextOrder) {
    const oldNode = previousMap.get(id), node = nextMap.get(id);
    if (oldNode && node && oldNode.parentId !== node.parentId) {
      operations.push({ kind: "remove", id }, { kind: "insert", id, parentId: node.parentId, index: node.parentId ? nextMap.get(node.parentId)!.children.indexOf(id) : 0 });
    }
  }
  const rank = (operation: RetainedUiOperation): number => operation.kind === "remove" ? 0 : operation.kind === "insert" ? 1 : 2;
  operations.sort((a, b) => rank(a) - rank(b));
  for (const id of layout) {
    paint.add(id);
    hit.add(id);
  }
  if (diagnostics.length)
    return { ok: false, diagnostics };
  return { ok: true, diagnostics, tree: next, layout: layoutRetainedUi(next), plan: { operations, dirtyLayoutRoots: minimal(layout, nextParents, nextOrder), dirtyPaintRoots: minimal(paint, nextParents, nextOrder), dirtyHitRoots: minimal(hit, nextParents, nextOrder), dirtyA11yRoots: minimal(accessibility, nextParents, nextOrder), fingerprints: nextOrder.map((id) => nextPrint.get(id)!) } };
}
