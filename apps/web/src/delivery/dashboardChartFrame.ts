import { validateChartIR, validateDeep2dDisplayList, type ChartIR, type Deep2dDisplayList } from "@bim-studio/deep-engine";
import { runtimeContentSha256, type DashboardCandidateNode, type Deep2dRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { chartPlot, type ChartZoomWindow } from "./dashboardChartFrameGeometry";
import { ChartPaths } from "./dashboardChartFramePaths";
import { renderSeries } from "./dashboardChartFrameSeries";
/** Static Native render_chart geometry; interaction/legend text presentation is a separate pass. */
export function renderChartFrame(ir: ChartIR, width: number, height: number, signal?: AbortSignal, zoomWindows: readonly ChartZoomWindow[] = []): Deep2dDisplayList {
  signal?.throwIfAborted();
  const checked = validateChartIR(ir);
  if (!checked.ok || !checked.ir) throw new Error(`Invalid ChartIR: ${JSON.stringify(checked.diagnostics)}`);
  ir = checked.ir;
  // Native render_chart_with_windows 的帧级窗口检查：重复轴、未知轴、非 [0,1] 有序窗口
  // 在帧组装前整体失败；窗口之外的交互叠加（强调/选中轮廓）属于 runtime presentation。
  const seen = new Set<string>();
  for (const [axisId, start, end] of zoomWindows) {
    if (!seen.add(axisId) || !ir.axes.some(axis => axis.id === axisId)
      || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start >= end || end > 1)
      throw new Error(`Invalid chart zoom window: ${axisId}`);
  }
  for (const series of ir.series) if (!["bar","line","scatter","pie","heatmap","gauge"].includes(series.type))
    throw new Error(`Unsupported static chart series: ${series.type}`);
  const plot = chartPlot(ir,width,height), paths = new ChartPaths(width,height);
  for (const series of ir.series) {
    signal?.throwIfAborted();
    const dataset = ir.datasets.find(value => value.id === series.datasetId);
    if (!dataset) throw new Error(`Missing chart dataset: ${series.datasetId}`);
    paths.series(ir.id,series.id,series.type === "heatmap" ? plot : undefined); renderSeries(paths,ir,series,dataset,plot,zoomWindows);
  }
  let id = ir.id.replace(/[^A-Za-z0-9._:/-]/g, "") || "chart";
  if (!/^[A-Za-z0-9]/.test(id) || ["__proto__","prototype","constructor"].includes(id)) id = `c${id}`;
  const displayList: Deep2dDisplayList = { schemaVersion:1,id:id.slice(0,256),revision:0,
    logicalWidth:width,logicalHeight:height,scaleFactor:1,resources:paths.resources,commands:paths.commands };
  const validation = validateDeep2dDisplayList(displayList);
  if (!validation.valid) throw new Error(`Invalid chart frame: ${JSON.stringify(validation.issues)}`);
  signal?.throwIfAborted(); return displayList;
}
/** Deferred 原因登记：初始 action 属运行期呈现、静态帧不产生像素影响的类型与路径。 */
export interface ChartFrameDeferredAction { readonly path: string; readonly type: string; readonly reason: string }
/**
 * Native `InteractionState::from_ir` 的同语义投影（无部分状态，任一条失败即整体失败）：
 * - 先 `$.dataZoom[i]` 后 `$.actions[i]` 逐条应用；同轴窗口后到者覆盖（latest-wins）；
 * - dataZoom 按 `/100` 归一进轴域，未知轴/越界窗口 fail-closed；
 * - highlight/downplay/select/unselect 经 `validate_target` 同款校验（未知系列、
 *   行越界即失败），但只进入运行期强调/选中轮廓（Native `append_state_outlines`），
 *   静态 `render_chart_with_windows` 不消费——这里同样不改变几何，登记 deferred 原因；
 * - 未知 action 类型 fail-closed 拒绝（Native 侧 serde closed enum 同样拒绝）。
 */
export function initialChartState(ir: ChartIR): { zoomWindows: ChartZoomWindow[]; deferredActions: ChartFrameDeferredAction[] } {
  const zoomWindows: ChartZoomWindow[] = [], deferredActions: ChartFrameDeferredAction[] = [];
  const applyZoom = (axisId: unknown, start: unknown, end: unknown, path: string): void => {
    if (typeof axisId !== "string" || !ir.axes.some(axis => axis.id === axisId))
      throw new Error(`Invalid chart initial state at ${path}: unknown zoom axis`);
    if (typeof start !== "number" || typeof end !== "number" || !Number.isFinite(start) || !Number.isFinite(end)
      || start < 0 || end > 100 || start >= end)
      throw new Error(`Invalid chart initial state at ${path}: expected 0 <= start < end <= 100`);
    const window: ChartZoomWindow = [axisId, start / 100, end / 100];
    const existing = zoomWindows.findIndex(([id]) => id === axisId);
    if (existing >= 0) zoomWindows[existing] = window; else zoomWindows.push(window);
  };
  ir.dataZoom.forEach((zoom, index) => applyZoom(zoom?.axisId, zoom?.start, zoom?.end, `$.dataZoom[${index}]`));
  ir.actions.forEach((action, index) => {
    const path = `$.actions[${index}]`, type = action?.type;
    if (type === "dataZoom") { applyZoom(action.axisId, action.start, action.end, path); return; }
    if (type === "highlight" || type === "downplay" || type === "select" || type === "unselect") {
      const series = ir.series.find(item => item.id === action.seriesId);
      if (!series) throw new Error(`Invalid chart initial state at ${path}: unknown series`);
      if (action.dataIndex !== null) {
        const rows = ir.datasets.find(item => item.id === series.datasetId)?.rows.length;
        if (!Number.isSafeInteger(action.dataIndex) || action.dataIndex < 0
          || (rows !== undefined && action.dataIndex >= rows))
          throw new Error(`Invalid chart initial state at ${path}: data index out of range`);
      }
      deferredActions.push({ path, type,
        reason: "runtime-only emphasis/selection outline; static frame pixels match Native render_chart_with_windows" });
      return;
    }
    throw new Error(`Invalid chart initial state at ${path}: unsupported action type`);
  });
  return { zoomWindows, deferredActions };
}
export async function chartFrame(candidate: DashboardCandidateNode, signal: AbortSignal): Promise<Deep2dRuntimePackage> {
  signal.throwIfAborted();
  if (!candidate.chart) throw new Error("Chart frame requires a chart candidate");
  const { ir, dataRevision } = candidate.chart;
  // C1 缺口②：初始交互态不再整体拒绝——按 Native from_ir 同语义投影后渲染；
  // 运行期才呈现的类型登记 deferred，不静默丢弃（对齐方向是两侧同一可见初态）。
  const state = initialChartState(ir);
  if (!Number.isSafeInteger(dataRevision) || dataRevision < 0) throw new Error("Invalid chart data revision");
  const displayList = renderChartFrame(ir,candidate.node.frame[2],candidate.node.frame[3],signal,state.zoomWindows);
  return { schema:"deep-engine.deep2d-runtime",schemaVersion:2,composition:"z-ordered",
    id:`chart-frame.${runtimeContentSha256([candidate.node.id,ir.id])}`,revision:dataRevision,
    displayList:{...displayList,revision:dataRevision},atlases:[],quads:[] };
}
