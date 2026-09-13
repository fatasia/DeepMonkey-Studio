import {
  RETAINED_UI_BUDGETS,
  type RetainedUiFrame,
  type RetainedUiLayout,
  type RetainedUiNode,
  type RetainedUiRect,
  type RetainedUiTree,
} from "./types.js";

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clampSize = (value: number, min?: number, max?: number): number =>
  Math.min(max ?? RETAINED_UI_BUDGETS.coordinate, Math.max(min ?? 0, value));

function intersect(a: RetainedUiRect | null, b: RetainedUiRect): RetainedUiRect {
  if (!a) return b;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, right - x), height: Math.max(0, bottom - y) };
}

function alignedOffset(mode: RetainedUiNode["style"]["align"], available: number, size: number): number {
  if (mode === "center") return (available - size) / 2;
  if (mode === "end") return available - size;
  return 0;
}

/** Computes rectangles only. Text shaping and GPU painting are separate consumers. */
export function layoutRetainedUi(tree: RetainedUiTree): RetainedUiLayout {
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const frames: RetainedUiFrame[] = [];
  let order = 0;

  const visit = (node: RetainedUiNode, rect: RetainedUiRect, inheritedClip: RetainedUiRect | null): void => {
    const clip = node.style.clip ? intersect(inheritedClip, rect) : inheritedClip;
    frames.push({ id: node.id, ...rect, clip, order: order++, zIndex: node.style.zIndex });
    const children = node.children.map((id) => nodes.get(id)!).filter(Boolean);
    const inner = {
      x: rect.x + node.style.padding,
      y: rect.y + node.style.padding,
      width: Math.max(0, rect.width - 2 * node.style.padding),
      height: Math.max(0, rect.height - 2 * node.style.padding),
    };
    const row = node.style.layout === "flex-row";
    const flex = row || node.style.layout === "flex-column";
    const mainSize = row ? inner.width : inner.height;
    const gapTotal = Math.max(0, children.length - 1) * node.style.gap;
    const basis = children.reduce((sum, child) => sum + clampSize(
      row ? child.style.width : child.style.height,
      row ? child.style.minWidth : child.style.minHeight,
      row ? child.style.maxWidth : child.style.maxHeight,
    ), 0);
    const totalGrow = children.reduce((sum, child) => sum + child.style.grow, 0);
    const extra = Math.max(0, mainSize - basis - gapTotal);
    let cursor = row ? inner.x : inner.y;

    for (const child of children) {
      let width = clampSize(child.style.width, child.style.minWidth, child.style.maxWidth);
      let height = clampSize(child.style.height, child.style.minHeight, child.style.maxHeight);
      let x = inner.x + child.style.x, y = inner.y + child.style.y;
      if (flex) {
        const share = totalGrow ? extra * child.style.grow / totalGrow : 0;
        const main = clampSize(
          (row ? width : height) + share,
          row ? child.style.minWidth : child.style.minHeight,
          row ? child.style.maxWidth : child.style.maxHeight,
        );
        if (row) { width = main; x = cursor + child.style.x; }
        else { height = main; y = cursor + child.style.y; }
        const crossAvailable = row ? inner.height : inner.width;
        const crossSize = row ? height : width;
        const offset = alignedOffset(node.style.align, crossAvailable, crossSize);
        if (row) { if (node.style.align === "stretch") height = clampSize(crossAvailable, child.style.minHeight, child.style.maxHeight); y = inner.y + offset + child.style.y; }
        else { if (node.style.align === "stretch") width = clampSize(crossAvailable, child.style.minWidth, child.style.maxWidth); x = inner.x + offset + child.style.x; }
        cursor += main + node.style.gap;
      } else if (node.style.layout === "stack") {
        if (node.style.align === "stretch") {
          width = clampSize(inner.width, child.style.minWidth, child.style.maxWidth);
          height = clampSize(inner.height, child.style.minHeight, child.style.maxHeight);
        }
        else {
          x += alignedOffset(node.style.align, inner.width, width);
          y += alignedOffset(node.style.align, inner.height, height);
        }
      }
      visit(child, { x, y, width, height }, clip);
    }
  };

  visit(nodes.get(tree.rootId)!, { x: 0, y: 0, width: tree.width, height: tree.height }, null);
  return { frames };
}

export function hitTestRetainedUi(
  tree: RetainedUiTree,
  layout: RetainedUiLayout,
  x: number,
  y: number,
): string | undefined {
  if (!finite(x) || !finite(y)) return;
  const nodes = new Map(tree.nodes.map((node) => [node.id, node]));
  const inside = (rect: RetainedUiRect): boolean =>
    x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
  return layout.frames.filter((frame) => {
    const node = nodes.get(frame.id)!;
    return node.style.visible && node.style.opacity > 0 && node.style.pointerEvents === "auto"
      && inside(frame) && (!frame.clip || inside(frame.clip));
  }).sort((a, b) => b.zIndex - a.zIndex || b.order - a.order)[0]?.id;
}
