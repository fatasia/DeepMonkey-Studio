import { runtimeContentSha256 } from "./hash.js";
import type { BuildDashboardCompositionRuntimePackageInput, DashboardRuntimeNodeV1 } from "./dashboardCompositionTypes.js";
import type { Deep2dRuntimePackage, RuntimeJson } from "./types.js";

/** Shared producer input, not a hand-authored runtime envelope. */
export function dashboardCompositionFixture(chart: RuntimeJson, sim: RuntimeJson,
  staticContent: Deep2dRuntimePackage): BuildDashboardCompositionRuntimePackageInput {
  const documentId = "dashboard-composition-golden";
  const id = (kind: string, page: string, source: string) => `${kind}.${runtimeContentSha256(JSON.stringify([documentId, page, source]))}`;
  const node = (page: string, source: string, zOrder: number): DashboardRuntimeNodeV1 => {
    const nodeId = id("node", page, source);
    return { id: nodeId, revision: 1, frame: [0, 0, 960, 640], clip: null, zOrder, visible: true,
      hitId: nodeId, deep2d: null, chart: null, chartSim: null };
  };
  const charts = ["a", "b"].map(suffix => ({ schema: "deep-engine.chart-runtime" as const, schemaVersion: 1 as const,
    id: `dashboard.chart.${suffix}`, revision: 1,
    chart: { ...(chart as Record<string, RuntimeJson>), id: `dashboard-chart-${suffix}` } }));
  const chartSims = ["a", "b"].map(suffix => ({ schema: "deep-engine.chart-sim-runtime" as const, schemaVersion: 1 as const,
    id: `dashboard.sim.${suffix}`, revision: 1,
    fixture: { ...(sim as Record<string, RuntimeJson>), id: `dashboard-sim-${suffix}`, chartId: `dashboard-chart-${suffix}` } }));
  return { packageId: "dashboard.composition", packageVersion: "1.0.0",
    dashboard: { schema: "deep-engine.dashboard-runtime", schemaVersion: 1, id: "dashboard.root", revision: 1,
      documentId, documentRevision: 1, entryPageId: id("page", "overview", "overview"),
      pages: [
        { id: id("page", "overview", "overview"), width: 960, height: 640, nodes: [
          { ...node("overview", "background", 0), hitId: null, deep2d: "dashboard.static.a" },
          { ...node("overview", "chart-a", 1), frame: [20, 180, 420, 300], clip: [0, 0, 420, 300], chart: "dashboard.chart.a", chartSim: "dashboard.sim.a" },
          { ...node("overview", "chart-b", 2), frame: [480, 180, 420, 300], clip: [0, 0, 420, 300], chart: "dashboard.chart.b", chartSim: "dashboard.sim.b" },
        ] },
        { id: id("page", "detail", "detail"), width: 960, height: 640,
          nodes: [{ ...node("detail", "background", 0), deep2d: "dashboard.static.b" }] },
      ] },
    deep2d: ["a", "b"].map(suffix => ({ ...structuredClone(staticContent), id: `dashboard.static.${suffix}`, revision: 1 })), charts, chartSims,
  };
}
