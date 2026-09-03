import { AlertTriangle, RefreshCcw } from "lucide-react";
import type { PlantLiteStudyRecord, PlantLiteTraceEvent } from "@bim-studio/contracts";
import { formatPlantLiteMinute } from "./plantLitePlaybackModel";
import "./PlantLiteChangeoverEvidence.css";

type ItemEvent = Extract<PlantLiteTraceEvent, { itemId: string }>;

export function PlantLiteChangeoverEvidence({ result }: { result: PlantLiteStudyRecord }) {
  const products = result.model?.productTypes ?? [];
  if (!products.length) return null;
  const stations = result.model?.nodes.filter((node): node is Extract<typeof node, { kind: "station" }> =>
    node.kind === "station" && Boolean(node.changeovers?.length)) ?? [];
  const traceStarts = (result.trace?.events ?? []).filter((event): event is ItemEvent =>
    "itemId" in event && event.type === "item-changeover-start");
  return <section className="plant-changeover-evidence" aria-label="产品混流与换型证据">
    <header>
      <span><RefreshCcw size={14} /><strong>混流与换型证据</strong></span>
      <small>{products.length} 种产品 · {stations.length} 个换型工位 · DES 重复统计</small>
    </header>
    <div className="plant-mix-evidence" role="table" aria-label="各产品完成占比与吞吐">
      <div role="row" className="is-heading"><span>产品</span><span>计划投放</span><span>完成占比</span><span>完成吞吐</span></div>
      {products.map((product) => {
        const metrics = result.outcome.productTypeMetrics95?.[product.id];
        return <div role="row" key={product.id}>
          <span title={product.id}>{product.name}{metrics ? <small>{metrics.completedItems.mean.toFixed(1)} 件/次</small> : null}</span>
          <strong>{percent(product.share)}</strong>
          <span>{metrics ? completionShareText(metrics.completionShare, result.outcome.completedReplications) : "旧记录无证据"}</span>
          <span>{metrics ? `${metrics.throughputPerHour.mean.toFixed(2)} 件/时 · CI ${metrics.throughputPerHour.lower95.toFixed(2)}–${metrics.throughputPerHour.upper95.toFixed(2)}` : "—"}</span>
        </div>;
      })}
    </div>
    {stations.length ? <div className="plant-changeover-stations">
      {stations.map((station) => {
        const metrics = result.outcome.nodeMetrics95?.[station.id];
        return <div key={station.id}>
          <span>{station.name}<small>{station.changeovers?.length ?? 0} 个有向规则</small></span>
          <strong>{metrics?.changeoverCount ? `${metrics.changeoverCount.mean.toFixed(1)} 次` : "无次数证据"}</strong>
          <small>{metrics?.changeoverMinutes ? `${metrics.changeoverMinutes.mean.toFixed(1)} 分钟 · 95% CI ${metrics.changeoverMinutes.lower95.toFixed(1)}–${metrics.changeoverMinutes.upper95.toFixed(1)}` : "旧记录无换型分钟"}</small>
        </div>;
      })}
    </div> : <p className="plant-changeover-note">产品组合已配置，但没有工位填写换型规则；所有产品切换均按 0 分钟处理。</p>}
    <p className="plant-changeover-note">换型矩阵是有向的；未配置的方向明确按 0 分钟处理，不表示系统推断或数据缺失。</p>
    {traceStarts.length ? <details className="plant-changeover-trace">
      <summary>代表性重复的逐次换型 <small>{traceStarts.length} 条已记录</small></summary>
      <div>
        {traceStarts.slice(0, 12).map((event) => <span key={event.sequence}>
          <time>{formatPlantLiteMinute(event.atMinute)}</time>
          <b>{nodeName(result, event.nodeId)}</b>
          <span>{productName(result, event.changeover?.fromProductTypeId)} → {productName(result, event.changeover?.toProductTypeId)}</span>
          <small>{event.changeover?.durationMinutes.toFixed(2) ?? "?"} 分钟</small>
        </span>)}
      </div>
      {traceStarts.length > 12 && <p>仅显示前 12 条，完整统计仍来自全部重复运行。</p>}
    </details> : null}
    {result.trace?.truncated && <p className="plant-changeover-warning"><AlertTriangle size={12} />代表性轨迹已截断，逐次明细不完整；95% 区间不受轨迹采集上限影响。</p>}
  </section>;
}

function productName(result: PlantLiteStudyRecord, id: string | undefined): string {
  if (!id) return "未知产品";
  return result.model?.productTypes?.find((product) => product.id === id)?.name ?? id;
}

function nodeName(result: PlantLiteStudyRecord, id: string): string {
  return result.model?.nodes.find((node) => node.id === id)?.name ?? id;
}

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function completionShareText(
  interval: NonNullable<PlantLiteStudyRecord["outcome"]["productTypeMetrics95"]>[string]["completionShare"],
  completedReplications: number,
): string {
  if (!interval.samples) return "没有完成件，无法计算占比";
  const coverage = interval.samples < completedReplications ? ` · ${interval.samples}/${completedReplications} 次有完成件` : "";
  return `${percent(interval.mean)} · CI ${percent(interval.lower95)}–${percent(interval.upper95)}${coverage}`;
}
