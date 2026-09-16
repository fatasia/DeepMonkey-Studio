import { applyChartDataUpdate } from "../chartDataApply.js";
import type { ChartIR } from "../chartIr.js";
import { validateChartIR } from "../chartIrReader.js";
import { ChartSimulationSource } from "../chartSimulation.js";
import type { DashboardRuntimePageV1, DashboardRect } from "./dashboardCompositionTypes.js";
import type { DashboardCandidateIdentity, DashboardCandidateOptions, DashboardPageCandidate } from "./dashboardCandidateTypes.js";
import type { ChartIrRuntimeValue, ChartSimRuntimeValue, Deep2dRuntimePackage, DeepRuntimePackageV5 } from "./types.js";

interface ChartState { readonly ir: ChartIR; readonly dataRevision: number; readonly simulation?: ChartSimulationSource }
export interface DashboardCandidateState {
  readonly page: DashboardPageCandidate;
  readonly charts: ReadonlyMap<string, ChartState>;
}

/** Every mutable simulation belongs to this candidate, never to the active page. */
export function buildDashboardCandidateState(value: DeepRuntimePackageV5, page: DashboardRuntimePageV1,
  identity: DashboardCandidateIdentity, options: DashboardCandidateOptions,
  prior?: DashboardCandidateState): DashboardCandidateState {
  const charts = new Map<string, ChartState>();
  if (options.elapsedMs !== undefined && (!Number.isSafeInteger(options.elapsedMs) || options.elapsedMs < 0)) {
    throw new Error("Invalid dashboard elapsed time.");
  }
  const updates = new Map<string, unknown>();
  if ((options.updates?.length ?? 0) > page.nodes.length) throw new Error("Too many dashboard chart updates.");
  for (const update of options.updates ?? []) {
    if (updates.has(update.nodeId) || !page.nodes.some(node => node.id === update.nodeId && node.chart)) {
      throw new Error("Duplicate or unknown dashboard chart update target.");
    }
    updates.set(update.nodeId, update.message);
  }
  const nodes = page.nodes.map(node => {
    let chart: ChartState | undefined;
    if (node.chart) {
      const previous = prior?.charts.get(node.id);
      const parsed = previous ? { ir: previous.ir } : validateChartIR(
        (value.payloads[node.chart] as unknown as ChartIrRuntimeValue).chart);
      if (!parsed.ir) throw new Error("Invalid dashboard ChartIR.");
      let ir = parsed.ir, dataRevision = previous?.dataRevision ?? 0;
      const simulation = previous?.simulation?.fork(ir, dataRevision) ?? (node.chartSim
        ? new ChartSimulationSource((value.payloads[node.chartSim] as unknown as ChartSimRuntimeValue).fixture, ir, dataRevision)
        : undefined);
      if (updates.has(node.id)) ({ ir, dataRevision } = applyChartDataUpdate(ir, dataRevision, updates.get(node.id)));
      if (simulation && options.elapsedMs !== undefined) {
        const frame = simulation.prepare(options.elapsedMs, dataRevision);
        if (frame) {
          ({ ir, dataRevision } = applyChartDataUpdate(ir, dataRevision, frame.message));
          simulation.commit(frame, dataRevision);
        }
      }
      chart = { ir, dataRevision, ...(simulation ? { simulation } : {}) };
      charts.set(node.id, chart);
    }
    return { node, effectiveClip: effectiveClip(page, node.frame, node.clip),
      deep2d: node.deep2d ? value.payloads[node.deep2d] as unknown as Deep2dRuntimePackage : null,
      chart: chart ? { ir: chart.ir, dataRevision: chart.dataRevision } : null };
  });
  return { charts, page: freeze({ identity, width: page.width, height: page.height, nodes }) };
}

function effectiveClip(page: DashboardRuntimePageV1, frame: DashboardRect, clip: DashboardRect | null): DashboardRect {
  if (!clip) return [0, 0, page.width, page.height];
  const left = Math.max(0, frame[0] + clip[0]), top = Math.max(0, frame[1] + clip[1]);
  const right = Math.min(page.width, frame[0] + clip[0] + clip[2]);
  const bottom = Math.min(page.height, frame[1] + clip[1] + clip[3]);
  return [left, top, Math.max(0, right - left), Math.max(0, bottom - top)];
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
