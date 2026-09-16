import { expect, it } from "vitest";
import { buildDashboardCompositionRuntimePackage } from "./dashboardComposition.js";
import { validateDashboardComposition } from "./dashboardCompositionValidation.js";
import { input } from "./dashboardComposition.testUtils.js";
import type { DashboardRuntimeNodeV1 } from "./dashboardCompositionTypes.js";
import type { Deep2dRuntimePackage } from "./types.js";

const identity = (kind: "page" | "node", number: number) => `${kind}.${number.toString(16).padStart(64, "0")}`;
const node = (number: number): DashboardRuntimeNodeV1 => ({ id: identity("node", number), revision: 1,
  frame: [0, 0, 100, 100], clip: null, visible: true, zOrder: number, hitId: null,
  deep2d: `static.${number}`, chart: null, chartSim: null });
function staticNodes(count: number) {
  const source = input(), page = { id: identity("page", 0), width: 100, height: 100,
    nodes: Array.from({ length: count }, (_, n) => node(n)) };
  return { ...source, charts: [], chartSims: [], dashboard: { ...source.dashboard, entryPageId: page.id, pages: [page] },
    deep2d: page.nodes.map(n => ({ ...source.deep2d[0]!, id: n.deep2d! })) };
}
it("accepts 128 nodes and rejects 129 even when split across pages", () => {
  expect(buildDashboardCompositionRuntimePackage(staticNodes(128)).resources).toHaveLength(131);
  const source = staticNodes(129);
  source.dashboard.pages = [
    { ...source.dashboard.pages[0]!, nodes: source.dashboard.pages[0]!.nodes.slice(0, 64) },
    { ...source.dashboard.pages[0]!, id: identity("page", 1), nodes: source.dashboard.pages[0]!.nodes.slice(64) },
  ];
  expect(() => buildDashboardCompositionRuntimePackage(source)).toThrow(/node budget/);
});
it("accepts 32 pages and rejects 33 without needing resource inflation", () => {
  const source = staticNodes(1);
  for (let n = 1; n < 32; n++) source.dashboard.pages.push({ id: identity("page", n), width: 100, height: 100, nodes: [] });
  expect(buildDashboardCompositionRuntimePackage(source).schemaVersion).toBe(5);
  source.dashboard.pages.push({ id: identity("page", 32), width: 100, height: 100, nodes: [] });
  expect(() => buildDashboardCompositionRuntimePackage(source)).toThrow(/bounded array/);
});
it("accepts 32 charts and rejects 33 across pages", () => {
  const original = input();
  const buildCharts = (count: number) => {
    const charts = Array.from({ length: count }, (_, n) => ({ ...original.charts[0]!, id: `chart.${n}`,
      chart: { ...(original.charts[0]!.chart as object), id: `internal-${n}` } }));
    const nodes = charts.map((chart, n) => ({ ...node(n), deep2d: null, chart: chart.id }));
    return { ...original, charts, chartSims: [], deep2d: [], dashboard: { ...original.dashboard,
      entryPageId: identity("page", 0), pages: [
        { id: identity("page", 0), width: 100, height: 100, nodes: nodes.slice(0, 16) },
        { id: identity("page", 1), width: 100, height: 100, nodes: nodes.slice(16) },
      ] } };
  };
  expect(buildDashboardCompositionRuntimePackage(buildCharts(32)).resources).toHaveLength(35);
  expect(() => buildDashboardCompositionRuntimePackage(buildCharts(33))).toThrow(/chart budget/);
});
it("keeps the existing resource budget including the composition root", () => {
  const source = staticNodes(128);
  source.deep2d.push({ ...source.deep2d[0]!, id: "unused.a" }, { ...source.deep2d[0]!, id: "unused.b" });
  expect(() => buildDashboardCompositionRuntimePackage(source)).toThrow(/bounded array/);
});
it("aggregates decoded atlas bytes across payloads instead of granting each node 64 MiB", () => {
  const source = staticNodes(3);
  const makeAtlas = (value: Deep2dRuntimePackage, large: boolean): Deep2dRuntimePackage => {
    const atlas = value.atlases.find(a => a.kind === "glyph")!;
    const quad = value.quads.find(q => q.atlasId === atlas.id)!;
    return { ...value, atlases: [{ ...atlas, width: large ? 8192 : atlas.width, height: large ? 4096 : atlas.height,
      dataBase64: large ? Buffer.alloc(32 * 1024 * 1024).toString("base64") : atlas.dataBase64 }], quads: [quad] };
  };
  const large = makeAtlas(source.deep2d[0]!, true);
  const resources = [large, { ...large, id: "static.1" }, makeAtlas(source.deep2d[2]!, false)];
  const payloads = Object.fromEntries(resources.map(r => [r.id, r]));
  const index = new Map([[source.dashboard.id, { revision: 1 }], ...resources.map(r => [r.id, { revision: 1 }] as const)]);
  const use = (id: unknown) => String(id);
  const two = { ...source.dashboard, pages: [{ ...source.dashboard.pages[0]!, nodes: source.dashboard.pages[0]!.nodes.slice(0, 2) }] };
  expect(() => validateDashboardComposition(two, two.id, index, payloads, use)).not.toThrow();
  expect(() => validateDashboardComposition(source.dashboard, source.dashboard.id, index, payloads, use)).toThrow(/aggregate atlas budget/);
});
