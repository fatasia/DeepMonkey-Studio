import { AlertTriangle, ArrowRight, Route } from "lucide-react";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import {
  derivePlantLiteMaterialFlowAnalysis,
  type PlantLiteDurationDistribution,
} from "./plantLiteMaterialFlowModel";
import { PlantLiteMaterialFlowDiagram } from "./PlantLiteMaterialFlowDiagram";
import "./PlantLiteMaterialFlowAnalysis.css";

export function PlantLiteMaterialFlowAnalysis({
  model,
  trace,
}: {
  model: PlantLiteModel;
  trace: PlantLiteReplicationTrace;
}) {
  const analysis = derivePlantLiteMaterialFlowAnalysis(model, trace);
  const hasParallelRoutes = analysis.edgeFlows.some((edge) => edge.attribution === "parallel-route-total");
  const hasPairingGaps = analysis.unpairedExitCount > 0 || analysis.transfersOutsideModel > 0;

  return (
    <details className="plant-material-flow">
      <summary className="plant-material-flow-heading">
        <span>
          <Route size={15} />
          <span><strong>物料流分析</strong><small>已保存重复 #{trace.replication + 1} · 只统计实际配对事件</small></span>
        </span>
        <em>{analysis.pairedTransferCount} 次已采集转移{analysis.truncated || hasPairingGaps ? " · 证据不完整" : ""}</em>
      </summary>

      <div className="plant-material-flow-body">
        <PlantLiteMaterialFlowDiagram model={model} edgeFlows={analysis.edgeFlows} truncated={analysis.truncated} />
        <div className="plant-material-flow-layout">
          <div className="plant-flow-table plant-flow-routes" role="table" aria-label="各边已采集物料转移次数">
            <div className="plant-flow-table-head" role="row">
              <span role="columnheader">路径</span><span role="columnheader">已采集转移</span>
            </div>
            {analysis.edgeFlows.map((edge) => (
              <div key={edge.edgeId} role="row" title={`边 ID：${edge.edgeId}`}>
                <span role="cell"><b>{edge.fromNodeName}</b><ArrowRight size={12} /><b>{edge.toNodeName}</b></span>
                {edge.capturedTransferCount === null
                  ? <span role="cell" className="plant-flow-ambiguous"><strong>{edge.routeCapturedTransferCount}</strong><small>同端点路径合计</small></span>
                  : <span role="cell"><strong>{edge.capturedTransferCount}</strong><small>次</small></span>}
              </div>
            ))}
          </div>

          <div className="plant-flow-table plant-flow-timings" role="table" aria-label="加工与搬运节点耗时分布">
            <div className="plant-flow-table-head" role="row">
              <span role="columnheader">节点</span><span role="columnheader">等待</span><span role="columnheader">加工 / 搬运</span>
            </div>
            {analysis.nodeTimings.map((node) => (
              <div key={node.nodeId} role="row">
                <span role="cell"><b>{node.nodeName}</b><small>{node.kind === "transport" ? "搬运" : "加工"}</small></span>
                <DurationCell distribution={node.waiting} />
                <DurationCell distribution={node.processing} />
              </div>
            ))}
          </div>
        </div>

        <footer className={analysis.truncated || hasPairingGaps ? "warning" : ""}>
          {analysis.truncated || hasPairingGaps ? <AlertTriangle size={13} /> : null}
          <span>
            {analysis.truncated
              ? `轨迹已截断：以下仅代表 ${analysis.capturedItemCount} 个已采集物料中能够完整配对的样本，不代表全量运行；另有 ${analysis.omittedEventCount} 个事件未记录。`
              : `来自 ${analysis.capturedItemCount} 个已采集物料；等待与加工/搬运耗时只纳入 enter→start→complete 完整区间。`}
            {analysis.unpairedExitCount > 0 ? ` ${analysis.unpairedExitCount} 个离开事件缺少后续进入事件，未计入路径。` : ""}
            {analysis.transfersOutsideModel > 0 ? ` ${analysis.transfersOutsideModel} 次事件转移不属于当前模型边，未计入边统计。` : ""}
            {hasParallelRoutes ? " 同端点并行边无法由现有轨迹区分，显示路径合计而不虚构单边归属。" : ""}
          </span>
        </footer>
      </div>
    </details>
  );
}

function DurationCell({ distribution }: { distribution: PlantLiteDurationDistribution | null }) {
  if (!distribution) return <span role="cell" className="plant-flow-missing"><strong>—</strong><small>无完整区间</small></span>;
  return (
    <span
      role="cell"
      title={`范围 ${formatMinute(distribution.minimumMinutes)}–${formatMinute(distribution.maximumMinutes)} 分钟`}
    >
      <strong>{formatMinute(distribution.meanMinutes)} 分</strong>
      <small>P50 {formatMinute(distribution.p50Minutes)} · P95 {formatMinute(distribution.p95Minutes)} · n={distribution.samples}</small>
    </span>
  );
}

function formatMinute(value: number): string {
  if (value === 0) return "0";
  if (value < 0.1) return value.toFixed(2);
  return value.toFixed(1);
}
