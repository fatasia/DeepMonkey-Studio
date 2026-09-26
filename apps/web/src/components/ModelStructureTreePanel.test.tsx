import { isValidElement, type ReactNode, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelManifest, ModelRecord, ModelStructureResponse } from "@bim-studio/contracts";

const state = vi.hoisted(() => ({
  cursor: 0,
  cells: [] as unknown[],
  effects: [] as Array<() => (() => void) | void>,
  requests: [] as Array<{ url: string; init?: RequestInit | undefined }>,
  structurePayload: null as Record<string, unknown> | null,
  structureError: null as Error | null,
  propertiesPayload: null as Record<string, unknown> | null,
}));
vi.mock("react", async importOriginal => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => (() => void) | void) => { state.effects.push(effect); },
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.cells)) state.cells[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [state.cells[index], (next: unknown) => { state.cells[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(state.cells[index]) : next; }];
  },
}));
import { ModelStructureTreePanel, flattenStructure, propertyRequestIds, structureAvailability } from "./ModelStructureTreePanel";

type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...walk(node.props.children)];
}
function render() { state.cursor = 0; return walk(ModelStructureTreePanel({ model: model(), locale: "zh-CN", request })); }
/** 真实 React 会在渲染后提交 effect；点击改变状态后必须重新渲染产生新 effect 再提交。 */
async function flushEffects() {
  const effects = state.effects.splice(0);
  for (const effect of effects) {
    const cleanup = effect();
    await Promise.resolve();
    await Promise.resolve();
    if (typeof cleanup === "function") cleanup();
  }
}
async function renderAndFlush() { render(); await flushEffects(); }
function request<T>(url: string, init?: RequestInit): Promise<T> {
  state.requests.push({ url, init });
  if (state.structureError) return Promise.reject(state.structureError);
  if (url.includes("/structure/properties")) return Promise.resolve(state.propertiesPayload as T);
  return Promise.resolve(state.structurePayload as T);
}
function find(finder: (item: Element) => boolean): Element | undefined { return render().find(finder); }
function click(finder: (item: Element) => boolean) {
  const target = render().find(finder);
  expect(target, "expected element to exist").toBeDefined();
  target!.props.onClick();
}
function textOf(item: Element): string {
  return walk(item).map(child => {
    const children = child.props.children;
    if (typeof children === "string") return children;
    if (Array.isArray(children)) return children.filter(entry => typeof entry === "string").join("");
    return "";
  }).join("");
}
const rowItems = () => render().filter(item => item.props.role === "treeitem");
const rowNames = () => rowItems().flatMap(item => walk(item).filter(child => String(child.props.className ?? "").includes("model-structure-name")).map(child => String(child.props.children)));
const toggleLabels = () => render().filter(item => typeof item.props["aria-label"] === "string" && /^(展开|折叠) /.test(item.props["aria-label"])).map(item => item.props["aria-label"]);
const statusTexts = () => render().filter(item => item.props.role === "status").map(textOf).join(" | ");

function model(overrides: Partial<Omit<ModelRecord, "manifest"> & { manifest?: ModelManifest | undefined }> = {}): ModelRecord {
  const now = new Date().toISOString();
  return {
    id: "m1", projectId: "default", name: "coffee-maker.jt", format: "jt", size: 128,
    status: "waiting_converter", progress: 40, message: "JT 结构已读取；未发现 LOD0 三角网格",
    sourceUrl: "/assets/projects/default/models/m1/source/coffee-maker.jt",
    manifest: { schemaVersion: 1, modelId: "m1", sourceName: "coffee-maker.jt", sourceFormat: "jt", hierarchyUrl: "/assets/projects/default/models/m1/output/hierarchy.json", propertiesUrl: "/assets/projects/default/models/m1/output/properties.json", createdAt: now },
    createdAt: now, updatedAt: now, ...overrides,
  } as ModelRecord;
}

const structure = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: 1, sourceFormat: "jt", sourceName: "coffee-maker.jt", nodeCount: 5, truncated: false,
  root: {
    id: "root", name: "coffee-maker.jt", type: "JT 结构模型", meshCount: 3, childCount: 2,
    children: [
      { id: "asm", name: "机身", type: "装配", meshCount: 1, meshSampleIds: ["mesh-1"], childCount: 1, children: [
        { id: "part", name: "加热腔", type: "零件", meshCount: 0, childCount: 0, children: [] },
      ] },
      { id: "leaf", name: "壶体", type: "零件", meshCount: 2, meshSampleIds: ["mesh-2"], childCount: 0, children: [] },
    ],
  },
  ...overrides,
});

beforeEach(() => {
  state.cells = [];
  state.effects = [];
  state.cursor = 0;
  state.requests = [];
  state.structurePayload = structure();
  state.structureError = null;
  state.propertiesPayload = {
    schemaVersion: 1,
    elements: {
      asm: { elementId: "asm", displayProperties: { 名称: "机身", 类型: "装配" } },
      "mesh-1": { elementId: "mesh-1", displayProperties: { 名称: "外壳", 三角面数: "1024" } },
    },
    missing: [],
  };
});

it("loads the tree, keeps waiting_converter readable and surfaces the geometry hint", async () => {
  await renderAndFlush();
  expect(state.requests[0]!.url).toBe("/api/projects/default/models/m1/structure");
  const note = render().find(item => item.props.role === "note");
  expect(textOf(note!)).toContain("尚未发布可视化几何");
  expect(rowNames()).toEqual(["coffee-maker.jt", "机身", "壶体"]); // root 默认展开，第二层折叠
  expect(rowItems().map(item => item.props["aria-level"])).toEqual([1, 2, 2]);
});

it("expands and collapses subtrees without rendering hidden rows", async () => {
  await renderAndFlush();
  expect(toggleLabels()).toEqual(["折叠 coffee-maker.jt", "展开 机身"]);
  click(item => item.props["aria-label"] === "折叠 coffee-maker.jt");
  expect(toggleLabels()).toEqual(["展开 coffee-maker.jt"]);
  expect(rowItems()).toHaveLength(1);
  click(item => item.props["aria-label"] === "展开 coffee-maker.jt");
  expect(rowItems()).toHaveLength(3);
  click(item => item.props["aria-label"] === "展开 机身");
  expect(rowNames()).toEqual(["coffee-maker.jt", "机身", "加热腔", "壶体"]);
});

it("filters by name and type along match paths", async () => {
  await renderAndFlush();
  const search = render().find(item => item.type === "input")!;
  search.props.onChange({ target: { value: "加热" } });
  expect(rowNames()).toEqual(["coffee-maker.jt", "机身", "加热腔"]); // 匹配路径自动展开
  expect(statusTexts()).toContain("1 / 5 节点匹配");
  search.props.onChange({ target: { value: "装配" } });
  expect(rowNames()).toEqual(["coffee-maker.jt", "机身"]); // root 是路径，asm 类型命中
  search.props.onChange({ target: { value: "不存在的东西" } });
  expect(rowItems()).toHaveLength(0);
  expect(statusTexts()).toContain("没有匹配的节点");
});

it("selects a node and renders its properties with mesh samples", async () => {
  await renderAndFlush();
  click(item => {
    if (item.props.className !== "model-structure-select") return false;
    return walk(item).some(child => child.props.children === "机身");
  });
  await renderAndFlush();
  const propertyRequest = state.requests.at(-1)!;
  expect(propertyRequest.url).toContain("/structure/properties?ids=");
  expect(decodeURIComponent(propertyRequest.url)).toContain("ids=asm,mesh-1");
  const groups = render().filter(item => item.props.className === "model-structure-property-group");
  expect(groups).toHaveLength(2);
  const values = (group: Element) => walk(group).filter(item => item.type === "td").map(cell => cell.props.children);
  expect(values(groups[0]!)).toEqual(["机身", "装配"]);
  expect(values(groups[1]!)).toEqual(["外壳", "1024"]);
});

it("reports nodes without property records instead of failing", async () => {
  state.propertiesPayload = { schemaVersion: 1, elements: {}, missing: ["root"] };
  await renderAndFlush();
  click(item => item.props.className === "model-structure-select");
  await renderAndFlush();
  expect(render().some(item => typeof item.props.children === "string" && item.props.children.includes("该节点没有属性记录"))).toBe(true);
});

it("shows failure text when the structure endpoint errors", async () => {
  state.structureError = new Error("hierarchy.json 不是有效 JSON");
  await renderAndFlush();
  const alert = render().find(item => item.props.role === "alert");
  expect(textOf(alert!)).toContain("不是有效 JSON");
});

it("renders a disabled notice with the task reason when no sidecar exists", () => {
  const rendered = walk(ModelStructureTreePanel({
    model: model({ status: "failed", message: "解析崩溃", manifest: undefined }),
    locale: "zh-CN", request,
  }));
  expect(state.requests).toHaveLength(0);
  const note = rendered.find(item => item.props.role === "note")!;
  expect(note).toBeDefined();
  expect(walk(note).some(item => item.props.children === "转换失败，未生成装配结构")).toBe(true);
  expect(walk(note).some(item => item.props.children === "解析崩溃")).toBe(true);
});

it("keeps the panel disabled for a queued model and never requests the endpoint", () => {
  const rendered = walk(ModelStructureTreePanel({
    model: model({ status: "queued", manifest: undefined }),
    locale: "en-US", request,
  }));
  expect(state.requests).toHaveLength(0);
  expect(walk(rendered.find(item => item.props.role === "note")!).some(item => String(item.props.children).includes("Conversion in progress"))).toBe(true);
});

it("renders only the visible virtual window even for huge assemblies", async () => {
  const children = Array.from({ length: 3000 }, (_, index) => ({ id: `n${index}`, name: `零件 ${index}`, type: "零件", meshCount: 0, childCount: 0, children: [] as never[] }));
  state.structurePayload = structure({
    nodeCount: 3001,
    root: { id: "root", name: "root", type: "装配", meshCount: 0, childCount: 3000, children },
  });
  await renderAndFlush();
  expect(rowItems().length).toBeLessThanOrEqual(24); // 窗口 12 行 + 上下过扫 6 行，不随 3000 节点线性增长
  const tree = render().find(item => typeof item.props.onScroll === "function")!;
  tree.props.onScroll({ currentTarget: { scrollTop: 260 } });
  expect(rowItems().length).toBeLessThanOrEqual(24);
  expect(rowNames()).toContain("零件 10"); // scrollTop 260 → 自第 4 行起渲染
  expect(rowNames()).not.toContain("零件 0");
});

it("keeps flatten helpers honest: no query honours expansion, query auto-expands match paths", () => {
  const data = structure() as unknown as ModelStructureResponse;
  expect(flattenStructure(data.root, { expanded: new Set<string>(), query: "" })).toHaveLength(1);
  expect(flattenStructure(data.root, { expanded: new Set(["root"]), query: "" }).map(row => row.node.id)).toEqual(["root", "asm", "leaf"]);
  const filtered = flattenStructure(data.root, { expanded: new Set<string>(), query: "壶体" });
  expect(filtered.map(row => row.node.id)).toEqual(["root", "leaf"]);
  expect(filtered[1]!.selfMatch).toBe(true);
  expect(filtered[0]!.selfMatch).toBe(false);
});

it("caps property ids at the node plus its mesh sample", () => {
  expect(propertyRequestIds({ id: "a", name: "a", meshCount: 3, meshSampleIds: ["m1", "m2"], childCount: 0, children: [] })).toEqual(["a", "m1", "m2"]);
  expect(propertyRequestIds({ id: "b", name: "b", meshCount: 0, childCount: 0, children: [] })).toEqual(["b"]);
});

it("explains availability per conversion status", () => {
  expect(structureAvailability(model(), "zh-CN")).toMatchObject({ available: true, hint: expect.stringContaining("尚未发布可视化几何") });
  expect(structureAvailability(model({ manifest: undefined, status: "queued" }), "zh-CN")).toMatchObject({ available: false });
  expect(structureAvailability(model({ manifest: undefined, status: "waiting_converter" }), "zh-CN")).toMatchObject({ available: false, reason: expect.stringContaining("尚未为该文件发布结构数据") });
  expect(structureAvailability(model({ manifest: undefined, status: "failed" }), "en-US")).toMatchObject({ available: false, reason: expect.stringContaining("Conversion failed") });
});
