import type { DashboardDataPaint, DashboardDataTextBox, DashboardDataTextRole, DashboardFrozenData } from "./dashboardDataRasterTypes";
import { validateDashboardTablePaint } from "./dashboardTablePaintCapture";
import { cssSrgbToLinearColor } from "./dashboardColor";
import { captureColor, captureNormalizedColor, capturePixels, captureTextWrap, captureTransformScale, intersectCaptureRects, type CaptureRect } from "./dashboardDataCaptureGeometry";

export interface DashboardTextCaptureBinding {
  readonly role: DashboardDataTextRole;
  readonly element: HTMLElement;
  /** A DOM range separates a value from its inline unit without inventing their widths. */
  readonly range?: Range;
  readonly verticalAlign?: "top" | "center" | "bottom";
}
export interface DashboardDataCaptureOptions {
  readonly logicalSize: readonly [number, number];
  readonly text: readonly DashboardTextCaptureBinding[];
  readonly backgrounds?: readonly HTMLElement[];
  /** Complete adapter-supplied report-table order, checked against actual DOM stacking. */
  readonly tablePaint?: readonly DashboardDataPaint[];
  readonly resolveFonts: (style: CSSStyleDeclaration) => readonly string[];
}

/** Capture already-rendered author geometry. Metric/state freezing is owned by the caller. */
export function captureDashboardDataLayout(root: HTMLElement, options: DashboardDataCaptureOptions): DashboardFrozenData["layout"] {
  const view = root.ownerDocument.defaultView;
  if (!view || !root.isConnected) throw new Error("Capture requires a connected document");
  if (root.ownerDocument.fonts && root.ownerDocument.fonts.status !== "loaded")
    throw new Error("Capture requires settled fonts");
  const origin = root.getBoundingClientRect(), [width, height] = options.logicalSize;
  const scale = origin.width / width;
  if (![width, height, scale].every(v => Number.isFinite(v) && v > 0)
    || ![origin.x, origin.y].every(Number.isFinite)
    || Math.abs(origin.height / height - scale) > 0.0001) throw new Error("Unsupported capture scale");
  const local = (rect: DOMRect): CaptureRect => {
    if (![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) || rect.width < 0 || rect.height < 0)
      throw new Error("Invalid capture rectangle");
    return [(rect.x - origin.x) / scale, (rect.y - origin.y) / scale, rect.width / scale, rect.height / scale];
  };
  const worldScale = (element: HTMLElement): number => {
    let result = 1;
    for (let current: HTMLElement | null = element; current; current = current.parentElement)
      result *= captureTransformScale(view.getComputedStyle(current));
    return result;
  };
  if (Math.abs(worldScale(root) - scale) > 0.0001)
    throw new Error("Logical dimensions must match the untransformed author node");
  const inspect = (element: HTMLElement): { style: CSSStyleDeclaration; clip: CaptureRect | null } => {
    if (!root.contains(element)) throw new Error("Capture element is outside the author node");
    let clip: CaptureRect | null = null;
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = view.getComputedStyle(current);
      if (style.display === "none" || style.visibility !== "visible" || Number(style.opacity) !== 1)
        throw new Error("Hidden or translucent capture requires a separate appearance pass");
      if ([style.clipPath, style.filter, style.perspective].some(value => value && value !== "none"))
        throw new Error("Nonrectangular clipping or effects require a separate appearance pass");
      const transformScale = captureTransformScale(style);
      if (current !== root && root.contains(current) && transformScale !== 1)
        throw new Error("Nested scale requires a separate appearance pass");
      if ([style.overflowX, style.overflowY].some(v => v !== "visible")) {
        const bounds = local(current.getBoundingClientRect());
        const ratio = worldScale(current) / scale;
        const content: CaptureRect = [bounds[0] + current.clientLeft * ratio, bounds[1] + current.clientTop * ratio,
          current.clientWidth * ratio, current.clientHeight * ratio];
        const candidate: CaptureRect = [style.overflowX === "visible" ? -16_777_216 : content[0],
          style.overflowY === "visible" ? -16_777_216 : content[1],
          style.overflowX === "visible" ? 33_554_432 : content[2],
          style.overflowY === "visible" ? 33_554_432 : content[3]];
        clip = clip ? intersectCaptureRects(clip, candidate) : candidate;
      }
    }
    return { style: view.getComputedStyle(element), clip };
  };
  const identities = new Set<string>();
  const textBoxes: DashboardDataTextBox[] = options.text.map(binding => {
    const role = binding.role;
    if (!["title", "value", "unit", "footer", "previous", "next", "row-number-header", "header", "sort", "total", "cell", "row-number"].includes(role.kind)
      || ("row" in role && (!Number.isSafeInteger(role.row) || role.row < 0))
      || ("column" in role && (typeof role.column !== "string" || !role.column)))
      throw new Error("Invalid semantic text capture role");
    const identity = JSON.stringify([binding.role.kind, "row" in binding.role ? binding.role.row : null,
      "column" in binding.role ? binding.role.column : null]);
    if (identities.has(identity)) throw new Error("Duplicate text capture role");
    identities.add(identity);
    const { style, clip } = inspect(binding.element);
    if (binding.range && (binding.range.collapsed || binding.range.startContainer !== binding.range.endContainer
      || binding.range.startContainer.nodeType !== 3 || binding.range.startContainer.parentElement !== binding.element
      || binding.range.getClientRects().length !== 1))
      throw new Error("Range must select one direct, unwrapped text run of its element");
    if (!binding.range && binding.element.children.length)
      throw new Error("Mixed text content requires explicit text ranges");
    const wrap = captureTextWrap(style, binding.range ? binding.range.toString() : binding.element.textContent ?? "");
    if (style.writingMode !== "horizontal-tb" || style.textTransform !== "none"
      || (style.letterSpacing !== "normal" && capturePixels(style.letterSpacing, "letter-spacing") !== 0))
      throw new Error("Unsupported text capture writing mode or spacing");
    const fontWeight = Number(style.fontWeight), fontStyle = style.fontStyle;
    const align = style.textAlign === "start" ? (style.direction === "rtl" ? "right" : "left")
      : style.textAlign === "end" ? (style.direction === "rtl" ? "left" : "right") : style.textAlign;
    if (!Number.isInteger(fontWeight) || fontWeight < 1 || fontWeight > 1000 || !["normal", "italic", "oblique"].includes(fontStyle)
      || !["left", "center", "right"].includes(align)) throw new Error("Unsupported computed font style");
    const fonts = [...options.resolveFonts(style)];
    if (!fonts.length || fonts.some(font => typeof font !== "string" || !font.trim()) || new Set(fonts).size !== fonts.length)
      throw new Error("Computed font has no unique frozen resource binding");
    const fontSize = capturePixels(style.fontSize, "font-size"), lineHeight = capturePixels(style.lineHeight, "line-height");
    if (fontSize <= 0 || lineHeight <= 0) throw new Error("Invalid computed text metrics");
    return { role: structuredClone(binding.role), rect: local((binding.range ?? binding.element).getBoundingClientRect()),
      clip, fonts, wrap, whiteSpace: style.whiteSpace as DashboardDataTextBox["whiteSpace"],
      verticalAlign: binding.verticalAlign ?? "top", style: {
        fontSize, lineHeight,
        fontWeight, fontStyle: fontStyle as "normal" | "italic" | "oblique",
        align: align as "left" | "center" | "right", color: captureColor(style.color),
      } };
  });
  if (options.tablePaint) validateDashboardTablePaint(root, options.text, options.backgrounds ?? [], options.tablePaint);
  const backgroundGroups = (options.backgrounds ?? []).map(element => {
    const { style, clip } = inspect(element);
    if (style.backgroundImage !== "none"
      || [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
        .some(value => value !== "0px")) throw new Error("Background needs a separate appearance producer");
    const rect = local(element.getBoundingClientRect());
    const base = { rect: clip ? intersectCaptureRects(rect, clip) : rect,
      color: cssSrgbToLinearColor(captureNormalizedColor(style.backgroundColor)) };
    if (style.boxShadow === "none") return [base];
    const shadow = /^(rgba?\([^)]+\)) (-?[\d.]+px) (-?[\d.]+px) 0px(?: 0px)?$/.exec(style.boxShadow);
    if (!options.tablePaint || !shadow) throw new Error("Background needs a separate appearance producer");
    const shadowRect: CaptureRect = [rect[0] + capturePixels(shadow[2]!, "shadow-x"),
      rect[1] + capturePixels(shadow[3]!, "shadow-y"), rect[2], rect[3]];
    return [{ rect: clip ? intersectCaptureRects(shadowRect, clip) : shadowRect,
      color: cssSrgbToLinearColor(captureNormalizedColor(shadow[1]!)) }, base];
  });
  const backgrounds = backgroundGroups.flat();
  let offset = 0;
  const indices = backgroundGroups.map(group => { const result = group.map((_, index) => offset + index); offset += group.length; return result; });
  const paint = options.tablePaint?.flatMap(entry => entry.kind === "text" ? [entry]
    : indices[entry.index]!.map(index => ({ kind: "background" as const, index })));
  return { textBoxes, backgrounds, ...(paint ? { paint } : {}) };
}
