import { expect, it } from "vitest";
import { buildDashboardCompositionRuntimePackage } from "./dashboardComposition.js";
import { parseDeepRuntimePackage, serializeDeepRuntimePackage } from "./serialization.js";
import { validateDeepRuntimePackage } from "./validation.js";
import { runtimePackageSha256 } from "./hash.js";
import { build, draft, input, json, rehash, root, type Mutable } from "./dashboardComposition.testUtils.js";
import type { DeepRuntimePackageV5 } from "./types.js";

it("rebuilds the two-page producer golden with static content and independent chart simulations", () => {
  const result = build();
  expect(result).toEqual(json("dashboard-composition-v1.json"));
  expect(result.schemaVersion).toBe(5);
  expect(result.resources).toHaveLength(9);
  expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(result)).valid).toBe(true);
});
it("snapshots producer inputs and keeps resource identity across revisions", () => {
  const source = input(), before = buildDashboardCompositionRuntimePackage(source);
  const bytes = serializeDeepRuntimePackage(before);
  const revised = { ...source, dashboard: { ...source.dashboard, revision: 2, documentRevision: 2 } };
  const after = buildDashboardCompositionRuntimePackage(revised);
  expect(after.entrypoints).toEqual(before.entrypoints);
  expect(after.packageHash).not.toEqual(before.packageHash);
  (source.dashboard as { documentId: string }).documentId = "mutated";
  expect(serializeDeepRuntimePackage(before)).toBe(bytes);
});

const invalid = (edit: (value: Mutable<DeepRuntimePackageV5>) => void) => {
  const value = draft(); edit(value); rehash(value);
  expect(validateDeepRuntimePackage(value).valid).toBe(false);
};
it.each([
  ["missing required nullable", (v: Mutable<DeepRuntimePackageV5>) => { Reflect.deleteProperty(root(v).pages[0]!.nodes[0]!, "clip"); }],
  ["unknown node field", (v: Mutable<DeepRuntimePackageV5>) => { Object.assign(root(v).pages[0]!.nodes[0]!, { opacity: 1 }); }],
  ["root revision mismatch", (v: Mutable<DeepRuntimePackageV5>) => { root(v).revision++; }],
  ["unsupported root version", (v: Mutable<DeepRuntimePackageV5>) => { Object.assign(root(v), { schemaVersion: 2 }); }],
  ["missing page", (v: Mutable<DeepRuntimePackageV5>) => { root(v).entryPageId = `page.${"f".repeat(64)}`; }],
  ["duplicate page", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[1]!.id = root(v).pages[0]!.id; }],
  ["duplicate node across pages", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[1]!.nodes[0]!.id = root(v).pages[0]!.nodes[0]!.id; }],
  ["cross-page resource ownership", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[1]!.nodes[0]!.deep2d = "dashboard.static.a"; }],
  ["wrong resource kind", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes[0]!.deep2d = "dashboard.chart.a"; }],
  ["missing resource", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes[0]!.deep2d = "missing"; }],
  ["orphan resource", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[1]!.nodes = []; }],
  ["foreign hit identity", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes[0]!.hitId = root(v).pages[0]!.nodes[1]!.id; }],
  ["bad frame", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes[0]!.frame[2] = 0; }],
  ["bad clip", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes[0]!.clip = [0, 0, -1, 2]; }],
  ["unsorted nodes", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes.reverse(); }],
  ["invalid z", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes[0]!.zOrder = 0.5; }],
  ["missing content", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes[0]!.deep2d = null; }],
  ["sim without chart", (v: Mutable<DeepRuntimePackageV5>) => { root(v).pages[0]!.nodes[0]!.chartSim = "dashboard.sim.a"; }],
  ["cross-chart simulation", (v: Mutable<DeepRuntimePackageV5>) => { const nodes = root(v).pages[0]!.nodes; nodes[1]!.chartSim = "dashboard.sim.b"; nodes[2]!.chartSim = "dashboard.sim.a"; }],
  ["camera", (v: Mutable<DeepRuntimePackageV5>) => { Object.assign(v.entrypoints, { camera: null }); }],
  ["top-level content", (v: Mutable<DeepRuntimePackageV5>) => { Object.assign(v.entrypoints, { deep2d: "dashboard.static.a" }); }],
  ["control character document id", (v: Mutable<DeepRuntimePackageV5>) => { root(v).documentId = "bad\u0085id"; }],
  ["UTF8 document byte budget", (v: Mutable<DeepRuntimePackageV5>) => { root(v).documentId = "字".repeat(86); }],
] as const)("rejects %s after hashes are recomputed", (_name, edit) => invalid(edit));

it("rejects duplicate internal chart identities even with independent resource IDs", () => {
  const source = input();
  const charts = source.charts.map(c => ({ ...c, chart: { ...(c.chart as object), id: "same-chart" } }));
  expect(() => buildDashboardCompositionRuntimePackage({ ...source, charts, chartSims: [], dashboard: { ...source.dashboard,
    pages: source.dashboard.pages.map(p => ({ ...p, nodes: p.nodes.map(n => ({ ...n, chartSim: null })) })) } })).toThrow(/Duplicate internal ChartIR/);
});
it("rejects duplicate producer resources before hashing overwrites a payload", () => {
  const source = input();
  expect(() => buildDashboardCompositionRuntimePackage({ ...source, deep2d: [...source.deep2d, source.deep2d[0]!] })).toThrow(/Duplicate resource/);
});
it("rejects corrupted hashes before trusting any node content", () => {
  const value = draft(); root(value).documentId = "changed";
  expect(validateDeepRuntimePackage(value).valid).toBe(false);
  rehash(value); value.resources[0]!.contentHash.value = "0".repeat(64);
  expect(validateDeepRuntimePackage(value).valid).toBe(false);
});
it("does not change legacy wire goldens", () => {
  for (const file of ["dashboard-runtime-v1.json", "chart-runtime-v1.json", "chart-runtime-static-v1.json"]) {
    const value = json(file);
    expect(validateDeepRuntimePackage(value).valid).toBe(true);
    expect(JSON.parse(serializeDeepRuntimePackage(value))).toEqual(value);
    Object.assign(value.entrypoints, { dashboard: "dashboard.root" });
    value.packageHash.value = runtimePackageSha256(value);
    const rejected = validateDeepRuntimePackage(value);
    expect(rejected.valid).toBe(false);
    if (!rejected.valid) expect(rejected.issues[0]?.path).toBe("$.entrypoints.dashboard");
  }
});
it("keeps the existing TS v4 camera rejection rather than implicitly widening its contract", () => {
  const value = json("chart-runtime-v1.json");
  value.entrypoints.camera = null;
  value.packageHash.value = runtimePackageSha256(value);
  const result = validateDeepRuntimePackage(value);
  expect(result.valid).toBe(false);
  if (!result.valid) expect(result.issues[0]?.path).toBe("$.entrypoints.camera");
});
it.each([
  ["invalid dimensions", { dimensions: [123] }],
  ["unknown dataset", { datasetId: "missing" }],
  ["invalid row cell", { rows: [[{ value: 1 }]] }],
  ["invalid row width", { rows: [[1]] }],
  ["oversized retained window", { maxRows: 500_001 }],
] as const)("v5 rejects simulation %s at package validation", (_name, changes) => {
  const source = input();
  const chartSims = source.chartSims.map((sim, index) => index ? sim : {
    ...sim, fixture: { ...(sim.fixture as object), ...changes } as unknown as typeof sim.fixture,
  });
  expect(() => buildDashboardCompositionRuntimePackage({ ...source, chartSims })).toThrow();
});
