import { Activity, AlertTriangle } from "lucide-react";
import { useMemo } from "react";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { formatPlantLiteMinute } from "./plantLitePlaybackModel";
import {
  derivePlantLiteFlowSeries,
  type PlantLiteFlowPoint,
  type PlantLiteNodeOccupancySeries,
  type PlantLiteOccupancyPoint,
} from "./plantLiteFlowSeriesModel";
import "./PlantLiteFlowDynamics.css";

const WIDTH = 720;
const HEIGHT = 176;
const PLOT = { left: 38, right: 36, top: 14, bottom: 27 };
const NODE_COLORS = ["#5fbab2", "#7d9bd1", "#b689cc", "#d29d5a"];

export function PlantLiteFlowDynamics({
  trace,
  model,
}: {
  trace: PlantLiteReplicationTrace;
  model: PlantLiteModel;
}) {
  const result = useMemo(() => derivePlantLiteFlowSeries(trace, model), [model, trace]);
  const repetition = result.evidence.replication === null ? "未知" : `#${result.evidence.replication + 1}`;
  const hasItemEvidence = result.evidence.capturedItemCount > 0 || result.completedItems > 0 || result.nodeSeries.length > 0;
  const evidenceWarning = result.evidence.captureStatus !== "complete"
    || result.evidence.invalidEventCount > 0
    || result.evidence.inferredTransitionCount > 0
    || result.evidence.unmatchedExitCount > 0;

  return (
    <details className="plant-flow-dynamics">
      <summary>
        <span><Activity size={14} /><span><strong>物流动态曲线</strong><small>代表性重复 {repetition} · 轨迹内事件派生</small></span></span>
        <em>峰值 WIP {result.peakWip} · 累计产出 {result.completedItems}{result.scrappedItems ? ` · 报废 ${result.scrappedItems}` : ""}</em>
      </summary>
      <div className="plant-flow-dynamics-body">
        {!hasItemEvidence ? (
          <div className="plant-flow-dynamics-empty">
            <Activity size={18} />
            <span><strong>没有可绘制的物料事件</strong><small>该保存记录只有资源事件或没有轨迹；重新运行并采集代表性轨迹后可查看。</small></span>
          </div>
        ) : result.durationMinutes <= 0 ? (
          <div className="plant-flow-dynamics-empty">
            <Activity size={18} />
            <span><strong>事件集中在 00:00</strong><small>累计产出 {result.completedItems} 件、峰值 WIP {result.peakWip}；没有时间跨度，无法形成连续曲线。</small></span>
          </div>
        ) : (
          <FlowChart result={result} />
        )}
        <FlowLegend nodeSeries={result.nodeSeries} />
        <EvidenceNote result={result} warning={evidenceWarning} repetition={repetition} />
      </div>
    </details>
  );
}

function FlowChart({ result }: { result: ReturnType<typeof derivePlantLiteFlowSeries> }) {
  const plotWidth = WIDTH - PLOT.left - PLOT.right;
  const plotHeight = HEIGHT - PLOT.top - PLOT.bottom;
  const leftMaximum = Math.max(1, result.peakWip, ...result.nodeSeries.map((series) => series.peakOccupancy));
  const outputMaximum = Math.max(1, result.completedItems);
  const x = (minute: number) => PLOT.left + minute / result.durationMinutes * plotWidth;
  const leftY = (value: number) => PLOT.top + (1 - value / leftMaximum) * plotHeight;
  const outputY = (value: number) => PLOT.top + (1 - value / outputMaximum) * plotHeight;
  const ariaLabel = `代表性重复物流动态曲线。峰值在制品 ${result.peakWip}，累计产出 ${result.completedItems}，显示 ${result.nodeSeries.length} 个关键节点。`;
  return (
    <div className="plant-flow-chart-shell">
      <svg className="plant-flow-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={ariaLabel}>
        <title>{ariaLabel}</title>
        {[0, .5, 1].map((ratio) => {
          const y = PLOT.top + ratio * plotHeight;
          const leftValue = Math.round(leftMaximum * (1 - ratio));
          const outputValue = Math.round(outputMaximum * (1 - ratio));
          return <g key={ratio} className="plant-flow-grid"><line x1={PLOT.left} x2={WIDTH - PLOT.right} y1={y} y2={y} /><text x={PLOT.left - 7} y={y + 3} textAnchor="end">{leftValue}</text><text x={WIDTH - PLOT.right + 7} y={y + 3}>{outputValue}</text></g>;
        })}
        {[0, .5, 1].map((ratio) => {
          const at = result.durationMinutes * ratio;
          const axisX = x(at);
          return <g key={ratio} className="plant-flow-time"><line x1={axisX} x2={axisX} y1={PLOT.top} y2={HEIGHT - PLOT.bottom} /><text x={axisX} y={HEIGHT - 8} textAnchor={ratio === 0 ? "start" : ratio === 1 ? "end" : "middle"}>{formatPlantLiteMinute(at)}</text></g>;
        })}
        <path className="plant-flow-line wip" d={stepPath(result.flowPoints, x, (point) => leftY(point.wip))} aria-label={`轨迹内 WIP，峰值 ${result.peakWip}`}>
          <title>{`轨迹内 WIP · 峰值 ${result.peakWip}`}</title>
        </path>
        <path className="plant-flow-line output" d={stepPath(result.flowPoints, x, (point) => outputY(point.completedItems))} aria-label={`累计产出，期末 ${result.completedItems} 件`}>
          <title>{`累计产出 · 期末 ${result.completedItems} 件`}</title>
        </path>
        {result.nodeSeries.map((series, index) => (
          <path
            key={series.nodeId}
            className="plant-flow-line node"
            style={{ stroke: NODE_COLORS[index % NODE_COLORS.length] }}
            d={stepPath(series.points, x, (point) => leftY(point.occupancy))}
            aria-label={`${series.nodeName}占用，峰值 ${series.peakOccupancy}`}
          >
            <title>{`${series.nodeName}占用 · 峰值 ${series.peakOccupancy} · 期末 ${series.finalOccupancy}`}</title>
          </path>
        ))}
        <text className="plant-flow-axis-label left" x={PLOT.left} y={10}>WIP / 节点占用</text>
        <text className="plant-flow-axis-label right" x={WIDTH - PLOT.right} y={10} textAnchor="end">累计产出</text>
      </svg>
    </div>
  );
}

function FlowLegend({ nodeSeries }: { nodeSeries: PlantLiteNodeOccupancySeries[] }) {
  return (
    <div className="plant-flow-legend" aria-label="曲线图例">
      <span title="当前代表性轨迹内、尚未在成品节点完工的已采集物料"><i className="wip" />轨迹内 WIP</span>
      <span title="在保存模型的成品节点完成的已采集物料累计数"><i className="output" />累计产出</span>
      {nodeSeries.map((series, index) => (
        <span key={series.nodeId} title={`${series.nodeName}：峰值 ${series.peakOccupancy}，占用 ${formatItemMinutes(series.occupiedItemMinutes)} 物料·分钟`}>
          <i style={{ background: NODE_COLORS[index % NODE_COLORS.length] }} />{series.nodeName}<small>峰值 {series.peakOccupancy}</small>
        </span>
      ))}
    </div>
  );
}

function EvidenceNote({
  result,
  warning,
  repetition,
}: {
  result: ReturnType<typeof derivePlantLiteFlowSeries>;
  warning: boolean;
  repetition: string;
}) {
  const { evidence } = result;
  const capture = evidence.captureStatus === "truncated"
    ? `轨迹已截断${limitsText(evidence.limits)}${evidence.omittedEventCount === null ? "" : `，另有 ${evidence.omittedEventCount} 个事件未记录`}；截断后的 WIP、产出和节点占用不完整，不用于方案验收。`
    : evidence.captureStatus === "unknown"
      ? "旧记录未保存完整的轨迹采集状态，曲线只能作为浏览证据。"
      : `轨迹未触达采集上限${limitsText(evidence.limits)}。`;
  const quality = [
    evidence.invalidEventCount > 0 ? `${evidence.invalidEventCount} 个无效事件已忽略` : "",
    evidence.inferredTransitionCount > 0 ? `${evidence.inferredTransitionCount} 次状态由可见事件推断` : "",
    evidence.unmatchedExitCount > 0 ? `${evidence.unmatchedExitCount} 个离开事件无法配对` : "",
    result.omittedNodeSeriesCount > 0 ? `关键节点按占用峰值仅显示前 ${result.nodeSeries.length} 个，另有 ${result.omittedNodeSeriesCount} 个未显示` : "",
    result.omittedVisualizationPointCount > 0 ? `为控制渲染保留峰值并抽样，${result.omittedVisualizationPointCount} 个绘图点未显示` : "",
  ].filter(Boolean).join("；");
  return (
    <p className={`plant-flow-evidence${warning ? " warning" : ""}`}>
      {warning ? <AlertTriangle size={12} /> : null}
      <span>仅来自已保存的代表性重复 {repetition}，不替代多次重复的 95% 统计区间。{capture}{quality ? ` ${quality}。` : ""}</span>
    </p>
  );
}

function stepPath<T extends { atMinute: number }>(
  points: T[],
  x: (minute: number) => number,
  y: (point: T) => number,
): string {
  if (!points.length) return "";
  const first = points[0]!;
  let path = `M ${x(first.atMinute).toFixed(2)} ${y(first).toFixed(2)}`;
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1]!;
    const point = points[index]!;
    const nextX = x(point.atMinute).toFixed(2);
    path += ` L ${nextX} ${y(previous).toFixed(2)} L ${nextX} ${y(point).toFixed(2)}`;
  }
  return path;
}

function limitsText(limits: { maxEvents: number; maxItems: number } | null): string {
  return limits ? `（最多 ${limits.maxItems} 个物料 / ${limits.maxEvents} 个事件）` : "（旧记录未保存采集上限）";
}

function formatItemMinutes(value: number): string {
  return value < 10 ? value.toFixed(1) : Math.round(value).toString();
}
