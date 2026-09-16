import { afterEach, describe, expect, it, vi } from "vitest";
import { captureDashboardDataLayout } from "./captureDashboardDataLayout";
import { capturePixels, captureTextWrap, captureTransformScale } from "./dashboardDataCaptureGeometry";

// Explicit DOM/Range substitutes: no browser layout, paint or font-loading evidence.
class Rect {
  constructor(public x = 0, public y = 0, public width = 0, public height = 0) {}
}
const DOMRect = Rect as typeof globalThis.DOMRect;
class TestElement {
  readonly tagName: string;
  parentElement: TestElement | null = null;
  children: TestElement[] = [];
  firstChild: { nodeType: number; parentElement: TestElement } | null = null;
  private content = "";
  clientLeft = 0; clientTop = 0; clientWidth = 0; clientHeight = 0;
  constructor(tag = "div") { this.tagName = tag.toUpperCase(); }
  get ownerDocument() { return document; }
  get isConnected(): boolean { return this === body || Boolean(this.parentElement?.isConnected); }
  set textContent(value: string) { this.content = value; this.firstChild = { nodeType: 3, parentElement: this }; }
  get textContent() { return this.content; }
  append(child: TestElement) { child.parentElement = this; this.children.push(child); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  replaceChildren() { this.children.forEach(child => { child.parentElement = null; }); this.children = []; }
  contains(node: TestElement | { parentElement: TestElement | null } | null): boolean {
    return node === this || Boolean(node?.parentElement && this.contains(node.parentElement));
  }
  getBoundingClientRect() { return new DOMRect(); }
}
const body = new TestElement();
const window = { getComputedStyle: (_element: Element): CSSStyleDeclaration => base as unknown as CSSStyleDeclaration };
const document = {
  body, defaultView: window, fonts: { status: "loaded" },
  createElement: (tag: string) => new TestElement(tag) as unknown as HTMLElement,
  createRange: (): Range => {
    const range = { startContainer: null as Node | null, endContainer: null as Node | null, collapsed: false,
      setStart(node: Node, _offset: number) { this.startContainer = node; },
      setEnd(node: Node, _offset: number) { this.endContainer = node; },
      selectNodeContents(node: Node) { this.startContainer = node; this.endContainer = node; },
      collapse() { this.collapsed = true; },
    };
    return range as unknown as Range;
  },
};
const base = { display: "block", visibility: "visible", opacity: "1", transform: "none",
  overflowX: "visible", overflowY: "visible", writingMode: "horizontal-tb", textTransform: "none",
  letterSpacing: "normal", whiteSpace: "normal", overflowWrap: "anywhere", wordBreak: "normal",
  fontWeight: "400", fontStyle: "normal", textAlign: "left", direction: "ltr",
  fontSize: "16px", lineHeight: "20px", color: "rgb(10, 20, 30)", backgroundColor: "rgb(1, 2, 3)",
  backgroundImage: "none", boxShadow: "none", borderTopLeftRadius: "0px", borderTopRightRadius: "0px",
  borderBottomLeftRadius: "0px", borderBottomRightRadius: "0px" };
function rect(element: Element, x: number, y: number, width: number, height: number): void {
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(x, y, width, height));
}
function setup() {
  const outer = document.createElement("section"), root = document.createElement("div"), text = document.createElement("strong");
  document.body.append(outer as unknown as TestElement); outer.append(root); root.append(text); text.textContent = "12件";
  rect(outer, 0, 0, 400, 200); rect(root, 20, 10, 200, 100); rect(text, 30, 20, 40, 20);
  const styles = new Map<Element, Partial<typeof base>>();
  vi.spyOn(window, "getComputedStyle").mockImplementation(element => ({ ...base, ...styles.get(element) }) as CSSStyleDeclaration);
  const options = { logicalSize: [200, 100] as const, text: [{ role: { kind: "value" as const }, element: text }],
    resolveFonts: () => ["font.frozen"] };
  return { outer, root, text, styles, options };
}
afterEach(() => { vi.restoreAllMocks(); document.body.replaceChildren(); });

describe("dashboard measured geometry capture", () => {
  it("expands an explicitly ordered frozen-cell hard shadow before its background and text", () => {
    const { root, text, styles, options } = setup();
    const table = { querySelectorAll: () => [text] };
    Object.assign(root, { querySelector: () => table, querySelectorAll: () => [table] });
    Object.assign(text, { closest: (selector: string) => selector === "table" ? table : text });
    styles.set(text, { position: "sticky", zIndex: "2", boxShadow: "rgb(43, 57, 63) 1px 0px 0px 0px" } as Partial<typeof base>);
    const result = captureDashboardDataLayout(root, { ...options, backgrounds: [text],
      tablePaint: [{ kind: "background", index: 0 }, { kind: "text", index: 0 }] });
    expect(result.backgrounds.map(item => item.rect)).toEqual([[11, 10, 40, 20], [10, 10, 40, 20]]);
    expect(result.paint).toEqual([{ kind: "background", index: 0 }, { kind: "background", index: 1 }, { kind: "text", index: 0 }]);
    expect(() => captureDashboardDataLayout(root, { ...options, backgrounds: [text],
      tablePaint: [{ kind: "text", index: 0 }, { kind: "background", index: 0 }] })).toThrow("background");
  });
  it("captures background as linear RGB while retaining text sRGB bytes", () => {
    const { root, text, styles, options } = setup();
    styles.set(text, { color: "rgb(128, 128, 128)", backgroundColor: "rgba(128, 128, 128, 0.5)" });
    const result = captureDashboardDataLayout(root, { ...options, backgrounds: [text] });
    expect(result.textBoxes[0]?.style.color).toEqual([128, 128, 128, 255]);
    expect(result.backgrounds[0]?.color[0]).toBeCloseTo(0.21586050011389926, 14);
    expect(result.backgrounds[0]?.color[3]).toBe(0.5);
  });
  it("captures measured geometry and computed font without deriving text or widths", () => {
    const { root, options } = setup();
    expect(captureDashboardDataLayout(root, options).textBoxes[0]).toMatchObject({
      role: { kind: "value" }, rect: [10, 10, 40, 20], fonts: ["font.frozen"],
      style: { fontSize: 16, lineHeight: 20, color: [10, 20, 30, 255] },
    });
  });
  it("undoes root scale for coordinates while keeping CSS font sizes", () => {
    const { root, text, styles, options } = setup();
    styles.set(root, { transform: "matrix(2,0,0,2,0,0)" });
    vi.mocked(root.getBoundingClientRect).mockReturnValue(new DOMRect(20, 10, 400, 200));
    vi.mocked(text.getBoundingClientRect).mockReturnValue(new DOMRect(40, 30, 80, 40));
    const result = captureDashboardDataLayout(root, options);
    expect(result.textBoxes[0]?.rect).toEqual([10, 10, 40, 20]);
    expect(result.textBoxes[0]?.style.fontSize).toBe(16);
  });
  it("converts ancestor clips across the root scale, including client borders", () => {
    const { root, outer, styles, options } = setup();
    styles.set(root, { transform: "matrix(2,0,0,2,0,0)" });
    styles.set(outer, { overflowX: "hidden", overflowY: "hidden" });
    vi.mocked(root.getBoundingClientRect).mockReturnValue(new DOMRect(20, 10, 400, 200));
    Object.defineProperties(outer, { clientLeft: { value: 2 }, clientTop: { value: 4 },
      clientWidth: { value: 300 }, clientHeight: { value: 180 } });
    expect(captureDashboardDataLayout(root, options).textBoxes[0]?.clip).toEqual([-9, -3, 150, 90]);
  });
  it("accepts uniform ancestor scaling but rejects a scale inconsistent with logical dimensions", () => {
    const { outer, root, styles, options } = setup();
    styles.set(outer, { transform: "matrix(2,0,0,2,0,0)" });
    expect(() => captureDashboardDataLayout(root, options)).toThrow("Logical dimensions");
    vi.mocked(root.getBoundingClientRect).mockReturnValue(new DOMRect(20, 10, 400, 200));
    expect(captureDashboardDataLayout(root, options).textBoxes).toHaveLength(1);
  });
  it.each(["matrix(2,0,0,2,0,0)", "matrix(0,1,-1,0,0,0)", "matrix(-1,0,0,1,0,0)"])("rejects nested transform %s", transform => {
    const { root, text, styles, options } = setup(); styles.set(text, { transform });
    expect(() => captureDashboardDataLayout(root, options)).toThrow();
  });
  it.each([{ opacity: "0.5" }, { display: "none" }, { visibility: "hidden" },
    { transform: "matrix(0,1,-1,0,0,0)" }])("inspects ancestors beyond root %j", style => {
    const { outer, root, styles, options } = setup(); styles.set(outer, style);
    expect(() => captureDashboardDataLayout(root, options)).toThrow();
  });
  it("rejects missing or ambiguous frozen fonts", () => {
    const { root, options } = setup();
    for (const fonts of [[], [" "], ["same", "same"]])
      expect(() => captureDashboardDataLayout(root, { ...options, resolveFonts: () => fonts })).toThrow("frozen");
  });
  it("uses range geometry only for a direct unwrapped run", () => {
    const { root, text, options } = setup();
    const range = document.createRange(); range.setStart(text.firstChild!, 0); range.setEnd(text.firstChild!, 2);
    Object.assign(range, { toString: () => "12", getBoundingClientRect: () => new DOMRect(31, 21, 19, 17), getClientRects: () => [new DOMRect(31, 21, 19, 17)] });
    const capture = () => captureDashboardDataLayout(root, { ...options, text: [{ ...options.text[0]!, range }] });
    expect(capture().textBoxes[0]?.rect).toEqual([11, 11, 19, 17]);
    range.collapse(); expect(capture).toThrow("Range");
  });
  it("rejects multi-run ranges, nested mixed text and order-independent duplicate roles", () => {
    const { root, text, options } = setup();
    const unit = document.createElement("small"); unit.textContent = "件"; text.append(unit);
    expect(() => captureDashboardDataLayout(root, options)).toThrow("Mixed");
    const range = document.createRange(); range.selectNodeContents(text);
    expect(() => captureDashboardDataLayout(root, { ...options, text: [{ ...options.text[0]!, range }] })).toThrow("Range");
    unit.remove();
    expect(() => captureDashboardDataLayout(root, { ...options, text: [
      { element: text, role: { kind: "cell", row: 0, column: "x" } },
      { element: text, role: { column: "x", row: 0, kind: "cell" } },
    ] })).toThrow("Duplicate");
  });
  it("rejects malformed metrics, independent transforms and invalid rectangles", () => {
    expect(() => capturePixels("1.2.3px", "size")).toThrow();
    expect(() => captureTransformScale({ transform: "none", scale: "2" } as CSSStyleDeclaration)).toThrow();
    const { root, text, styles, options } = setup(); styles.set(text, { fontSize: "0px" });
    expect(() => captureDashboardDataLayout(root, options)).toThrow("metrics");
    styles.clear(); vi.mocked(text.getBoundingClientRect).mockReturnValue(new DOMRect(NaN, 0, 1, 1));
    expect(() => captureDashboardDataLayout(root, options)).toThrow("rectangle");
  });
  it("rejects nonrectangular ancestor clipping and missing semantic row identity", () => {
    const { root, outer, styles, options } = setup();
    styles.set(outer, { clipPath: "circle(50%)" } as Partial<typeof base>);
    expect(() => captureDashboardDataLayout(root, options)).toThrow("Nonrectangular");
    styles.clear();
    expect(() => captureDashboardDataLayout(root, { ...options, text: [{ ...options.text[0]!,
      role: { kind: "cell", row: NaN, column: "value" } }] })).toThrow("semantic");
  });
  it.each(["nowrap", "pre", "normal", "pre-wrap"])("captures explicit %s wrapping", whiteSpace => {
    const { root, text, styles, options } = setup(); styles.set(text, { whiteSpace });
    expect(captureDashboardDataLayout(root, options).textBoxes[0]?.wrap)
      .toBe(["nowrap", "pre"].includes(whiteSpace) ? "none" : "word-or-glyph");
  });
  const buttonStyles = { borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
    borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)",
    borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
    borderTopLeftRadius: "4px", borderTopRightRadius: "4px", borderBottomRightRadius: "4px", borderBottomLeftRadius: "4px",
    backgroundColor: "rgb(9, 9, 9)", opacity: "0.4", textShadow: "none", backgroundClip: "border-box" };
  function toolbarButton(name: string, tool: "csv" | "excel", x: number) {
    const button = document.createElement("button");
    button.textContent = name; rect(button, x, 10, 36, 18);
    return { button, binding: { element: button, role: { kind: "tool" as const, tool } } };
  }  it("captures export toolbar buttons as isolated tool groups with distinct role identities", () => {
    const { root, styles, options } = setup();
    const csv = toolbarButton("CSV", "csv", 120), excel = toolbarButton("Excel", "excel", 160);
    root.append(csv.button); root.append(excel.button);
    styles.set(csv.button, buttonStyles);
    styles.set(excel.button, { ...buttonStyles, borderTopLeftRadius: "6px", borderTopRightRadius: "6px",
      borderBottomRightRadius: "6px", borderBottomLeftRadius: "6px" });
    const result = captureDashboardDataLayout(root, { ...options, text: [...options.text, csv.binding, excel.binding] });
    expect(result.textBoxes[1]?.buttonGroup).toEqual({ rect: [100, 0, 36, 18], radius: 4, borderWidth: 1, opacity: 0.4,
      background: [9, 9, 9, 255], border: [0, 0, 0, 255] });
    expect(result.textBoxes[2]?.buttonGroup).toMatchObject({ radius: 6, rect: [140, 0, 36, 18] });
    expect(result.textBoxes[2]?.role).toEqual({ kind: "tool", tool: "excel" });
    const cloned = toolbarButton("Excel", "csv", 160);
    root.append(cloned.button); styles.set(cloned.button, buttonStyles);
    expect(() => captureDashboardDataLayout(root, { ...options, text: [...options.text, csv.binding, cloned.binding] }))
      .toThrow("Duplicate");
  });
  it("applies the hidden, nested-content and single-run discipline to tool roles", () => {
    const { root, styles, options } = setup();
    const csv = toolbarButton("CSV", "csv", 120);
    root.append(csv.button); styles.set(csv.button, buttonStyles);
    const optionsWithTool = { ...options, text: [...options.text, csv.binding] };
    styles.set(csv.button, { ...buttonStyles, display: "none" });
    expect(() => captureDashboardDataLayout(root, optionsWithTool)).toThrow("Hidden or translucent");
    styles.set(csv.button, buttonStyles);
    const badge = document.createElement("span"); badge.textContent = "!"; csv.button.append(badge);
    expect(() => captureDashboardDataLayout(root, optionsWithTool)).toThrow("single-text");
    badge.remove();
    const range = document.createRange(); range.selectNodeContents(csv.button.firstChild!); range.collapse();
    expect(() => captureDashboardDataLayout(root, { ...optionsWithTool, text: [...options.text, { ...csv.binding, range }] }))
      .toThrow("Range");
  });
  it("refuses whitespace collapse and unsupported CSS breaking instead of changing text", () => {
    const style = base as unknown as CSSStyleDeclaration;
    for (const text of ["two  spaces", " leading", "trailing ", "new\nline", "tab\there"])
      expect(() => captureTextWrap(style, text)).toThrow();
    expect(captureTextWrap({ ...base, whiteSpace: "pre" } as unknown as CSSStyleDeclaration, "two  spaces\nnext")).toBe("none");
    expect(captureTextWrap({ ...base, overflowWrap: "normal" } as unknown as CSSStyleDeclaration, "longword")).toBe("word");
    for (const patch of [{ whiteSpace: "pre-line" }, { wordBreak: "break-all" }, { overflowWrap: "unknown" }])
      expect(() => captureTextWrap({ ...base, ...patch } as unknown as CSSStyleDeclaration, "word")).toThrow();
  });
});
