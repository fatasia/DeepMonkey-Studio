import { validateChartIR, validateDeep2dDisplayList, type ChartIR, type Deep2dDisplayList } from "@bim-studio/deep-engine";
import { runtimeContentSha256, type DashboardCandidateNode, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { chartPlot } from "./dashboardChartFrameGeometry";
import { ChartPaths } from "./dashboardChartFramePaths";
import { renderSeries } from "./dashboardChartFrameSeries";
/** Static Native render_chart geometry; interaction/legend text presentation is a separate pass. */
export function renderChartFrame(ir: ChartIR, width: number, height: number, signal?: AbortSignal): Deep2dDisplayList {
  signal?.throwIfAborted();
  const checked = validateChartIR(ir);
  if (!checked.ok || !checked.ir) throw new Error(`Invalid ChartIR: ${JSON.stringify(checked.diagnostics)}`);
  ir = checked.ir;
  for (const series of ir.series) if (!["bar","line","scatter","pie","heatmap","gauge"].includes(series.type))
    throw new Error(`Unsupported static chart series: ${series.type}`);
  const plot = chartPlot(ir,width,height), paths = new ChartPaths(width,height);
  for (const series of ir.series) {
    signal?.throwIfAborted();
    const dataset = ir.datasets.find(value => value.id === series.datasetId);
    if (!dataset) throw new Error(`Missing chart dataset: ${series.datasetId}`);
    paths.series(ir.id,series.id,series.type === "heatmap" ? plot : undefined); renderSeries(paths,ir,series,dataset,plot);
  }
  let id = ir.id.replace(/[^A-Za-z0-9._:/-]/g, "") || "chart";
  if (!/^[A-Za-z0-9]/.test(id) || ["__proto__","prototype","constructor"].includes(id)) id = `c${id}`;
  const displayList: Deep2dDisplayList = { schemaVersion:1,id:id.slice(0,256),revision:0,
    logicalWidth:width,logicalHeight:height,scaleFactor:1,resources:paths.resources,commands:paths.commands };
  const validation = validateDeep2dDisplayList(displayList);
  if (!validation.valid) throw new Error(`Invalid chart frame: ${JSON.stringify(validation.issues)}`);
  signal?.throwIfAborted(); return displayList;
}
export async function chartFrame(candidate: DashboardCandidateNode, signal: AbortSignal): Promise<Deep2dRuntimePackage> {
  signal.throwIfAborted();
  if (!candidate.chart) throw new Error("Chart frame requires a chart candidate");
  const { ir, dataRevision } = candidate.chart;
  if (ir.dataZoom.length || ir.actions.length)
    throw new Error("Static chart frame does not support initial dataZoom or actions");
  if (!Number.isSafeInteger(dataRevision) || dataRevision < 0) throw new Error("Invalid chart data revision");
  const displayList = renderChartFrame(ir,candidate.node.frame[2],candidate.node.frame[3],signal);
  return { schema:"deep-engine.deep2d-runtime",schemaVersion:2,composition:"z-ordered",
    id:`chart-frame.${runtimeContentSha256([candidate.node.id,ir.id])}`,revision:dataRevision,
    displayList:{...displayList,revision:dataRevision},atlases:[],quads:[] };
}
