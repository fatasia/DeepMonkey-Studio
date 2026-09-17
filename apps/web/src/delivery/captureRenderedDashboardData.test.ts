import { afterEach, describe, expect, it, vi } from "vitest";
import { captureRenderedDashboardData } from "./captureRenderedDashboardData";

// Explicit DOM substitutes: no browser layout, paint or font-loading evidence.
class Rect { constructor(public x = 0, public y = 0, public width = 0, public height = 0) {} }
const DOMRect = Rect as typeof globalThis.DOMRect;
class TestNode { nodeType = 3; parentElement: TestElement | null = null; constructor(public textContent: string) {} }
class TestElement {
  readonly tagName: string;
  readonly dataset: Record<string, string> = {};
  childNodes: Array<TestNode | TestElement> = [];
  children: TestElement[] = [];
  parentElement: TestElement | null = null;
  scrollLeft = 0;
  get ownerDocument() { return document as unknown as Document; }
  constructor(tag: string, text = "") { this.tagName = tag.toUpperCase(); if (text) this.append(new TestNode(text)); }
  append(node: TestNode | TestElement) { node.parentElement = this; this.childNodes.push(node); if (node instanceof TestElement) this.children.push(node); }
  get textContent(): string { return this.childNodes.map(node => node.textContent).join(""); }
  contains(node: TestElement | TestNode | null): boolean {
    return Boolean(node) && (node === this || this.contains(node!.parentElement));
  }
  get isConnected(): boolean { return this === body || Boolean(this.parentElement?.isConnected); }
  getBoundingClientRect() { return new DOMRect(); }
  hasAttribute(name: string) { return this.dataset[name] !== undefined; }
}
const body = new TestElement("body");
const window = { getComputedStyle: (_element: Element): CSSStyleDeclaration => base as unknown as CSSStyleDeclaration };
const document = {
  body, defaultView: window, fonts: { status: "loaded" },
  createRange: (): Range => {
    const range = { container: null as TestNode | null, collapsed: false,
      selectNodeContents(node: TestNode) { this.container = node; this.collapsed = false; },
      collapse() { this.collapsed = true; },
      get startContainer() { return this.container; }, get endContainer() { return this.container; },
      getClientRects: () => [new DOMRect()], getBoundingClientRect: () => new DOMRect(),
      toString() { return this.container?.textContent ?? ""; } };
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
const buttonStyles = { borderTopWidth: "1px", borderRightWidth: "1px", borderBottomWidth: "1px", borderLeftWidth: "1px",
  borderTopColor: "rgb(0, 0, 0)", borderRightColor: "rgb(0, 0, 0)", borderBottomColor: "rgb(0, 0, 0)", borderLeftColor: "rgb(0, 0, 0)",
  borderTopStyle: "solid", borderRightStyle: "solid", borderBottomStyle: "solid", borderLeftStyle: "solid",
  borderTopLeftRadius: "4px", borderTopRightRadius: "4px", borderBottomRightRadius: "4px", borderBottomLeftRadius: "4px",
  backgroundColor: "rgb(9, 9, 9)", opacity: "0.4", textShadow: "none", backgroundClip: "border-box" };
const styles = new Map<unknown, Partial<typeof base>>();
const options = { logicalSize: [200, 100] as const, resolveFonts: () => ["font.frozen"] };

it("captures chart heading roles without requiring KPI or table state", () => {
  const { root } = widgetRoot();
  root.dataset.dashboardCapture = "chart";
  root.querySelectorAll<HTMLElement>("[data-capture-role]")[0]!.dataset.captureRole = "title";
  expect(captureRenderedDashboardData(root, options).layout.textBoxes.map(box => box.role)).toEqual([{ kind: "title" }]);
  root.querySelectorAll<HTMLElement>("[data-capture-role]")[0]!.dataset.captureRole = "value";
  expect(() => captureRenderedDashboardData(root, options)).toThrow("only accepts title and unit");
});

function widgetRoot(...extras: TestElement[]) {
  const root = new TestElement("div");
  root.dataset.dashboardCapture = "value";
  root.getBoundingClientRect = () => new DOMRect(0, 0, 200, 100);
  const value = new TestElement("strong", "81.7"); value.dataset.captureRole = "value";
  value.parentElement = root;
  value.getBoundingClientRect = () => new DOMRect(0, 0, 40, 20);
  const buttons = extras.map((button, index) => {
    button.parentElement = root;
    button.getBoundingClientRect = () => new DOMRect(120 + index * 40, 0, 36, 18);
    return button;
  });
  Object.assign(root, { querySelector: () => null, querySelectorAll: (selector: string) =>
    selector === "[data-capture-role]" ? [value, ...buttons] : selector === "[data-capture-background]" ? [] : [] });
  vi.spyOn(window, "getComputedStyle").mockImplementation(element =>
    ({ ...base, ...styles.get(element) }) as unknown as CSSStyleDeclaration);
  body.append(root);
  return { root: root as unknown as HTMLElement, value };
}
function exportButton(text: string, tool: string) {
  const button = new TestElement("button", text);
  button.dataset.captureRole = "tool"; button.dataset.captureTool = tool;
  return button;
}
afterEach(() => { vi.restoreAllMocks(); styles.clear(); body.childNodes = []; body.children = []; });

describe("rendered dashboard capture roles", () => {
  it("captures export toolbar buttons under the static tool appearance contract", () => {
    const csv = exportButton("CSV", "csv"), excel = exportButton("Excel", "excel");
    const { root } = widgetRoot(csv, excel);
    styles.set(csv, buttonStyles); styles.set(excel, buttonStyles);
    const result = captureRenderedDashboardData(root, options);
    expect(result.layout.textBoxes.map(box => box.role)).toEqual([{ kind: "value" }, { kind: "tool", tool: "csv" }, { kind: "tool", tool: "excel" }]);
    expect(result.layout.textBoxes[1]?.buttonGroup).toEqual({ rect: [120, 0, 36, 18], radius: 4, borderWidth: 1, opacity: 0.4,
      background: [9, 9, 9, 255], border: [0, 0, 0, 255] });
  });
  it("skips hidden toolbar buttons like any other hidden capture role", () => {
    const csv = exportButton("CSV", "csv");
    const { root } = widgetRoot(csv);
    styles.set(csv, buttonStyles); styles.set(csv, { ...buttonStyles, display: "none" });
    expect(captureRenderedDashboardData(root, options).layout.textBoxes.map(box => box.role)).toEqual([{ kind: "value" }]);
  });
  it("rejects an unknown export tool value instead of guessing", () => {
    const csv = exportButton("CSV", "pdf");
    const { root } = widgetRoot(csv);
    styles.set(csv, buttonStyles);
    expect(() => captureRenderedDashboardData(root, options)).toThrow("Unknown rendered export tool capture role");
  });
  it("rejects nested widget capture before reading any role", () => {
    const csv = exportButton("CSV", "csv");
    const { root } = widgetRoot(csv);
    styles.set(csv, buttonStyles);
    Object.assign(root, { querySelector: (selector: string) => selector === "[data-dashboard-capture]" ? new TestElement("div") : null });
    expect(() => captureRenderedDashboardData(root, options)).toThrow("Nested widget capture is unsupported");
  });
  it("rejects toolbar buttons with more than one direct text run", () => {
    const csv = exportButton("CSV", "csv");
    const { root } = widgetRoot(csv);
    styles.set(csv, buttonStyles);
    csv.append(new TestNode("!"));
    expect(() => captureRenderedDashboardData(root, options)).toThrow("exactly one direct text run");
  });
});
