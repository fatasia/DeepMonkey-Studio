/**
 * VSM 价值流图库(Plant 替代 P2 尾巴,对位西门子 VSM Library 的数据层)。
 * 从既有模型 + runPlantLiteExperiment 结果推导价值流视图:
 * process=station 节点(周期/换型/利用率/故障可用率取自结果),
 * inventory=buffer 节点(平均队列长度),supplier=source,customer=sink;
 * leadTime=平均交付期,processTime=Σ工序标准工时,pce=processTime/leadTime(VSM 核心指标)。
 * 纯函数、零随机;确定性双跑逐位一致。
 * 诚实边界:split/transport 节点不在合同四类要素内,暂不映射,其边不入 flows;
 * 图形版式由前端 ECharts 二层承担,本层只提供表格摘要。
 */

import {
  type VsmAnalysis,
  type VsmElement,
  type VsmElementKind,
  type VsmFlow,
} from "@bim-studio/contracts";
import type { Distribution, PlantLiteExperimentResult, PlantLiteModel, PlantLiteNode } from "./model.js";

/** 分布代表值(期望):deterministic 取值,uniform 取区间中点,exponential/normal 取均值。 */
export function representativeMinutes(distribution: Distribution): number {
  if (distribution.kind === "deterministic") return distribution.value;
  if (distribution.kind === "uniform") return (distribution.minimum + distribution.maximum) / 2;
  return distribution.mean;
}

function elementKind(node: PlantLiteNode): VsmElementKind | undefined {
  if (node.kind === "station") return "process";
  if (node.kind === "buffer" || node.kind === "queue-buffer") return "inventory";
  if (node.kind === "source") return "supplier";
  if (node.kind === "sink") return "customer";
  return undefined;
}

/** 构建价值流分析;模型与结果必须同源(同一模型跑出的结果),缺指标立即抛错。 */
export function buildVsmAnalysis(model: PlantLiteModel, result: PlantLiteExperimentResult): VsmAnalysis {
  if (result.engineId !== "plant-lite-des") throw new Error(`结果引擎不符:${String(result.engineId)}`);
  const nodeMetric = (nodeId: string, path: "utilization" | "averageQueueLength" | "changeoverMinutes"): number => {
    const metrics = result.nodeMetrics95[nodeId];
    if (!metrics) throw new Error(`结果缺少节点指标 ${nodeId},模型与结果不同源`);
    return metrics[path].mean;
  };
  const resourceFailedMinutes = (resourceId: string): number => {
    const interval = result.resourceFailedMinutes95[resourceId];
    if (!interval) throw new Error(`结果缺少资源故障指标 ${resourceId},模型与结果不同源`);
    return interval.mean;
  };
  const resourceCapacity = (resourceId: string): number => {
    const resource = model.resources?.find((candidate) => candidate.id === resourceId);
    if (!resource) throw new Error(`工位绑定的资源 ${resourceId} 不在模型中`);
    return resource.capacity;
  };
  const measurementMinutes = mean(result.replications
    .filter((replication) => replication.termination === "completed")
    .map((replication) => replication.measurementMinutes));
  if (!(measurementMinutes > 0)) throw new Error("无已完成的 replication,无法推导价值流");
  const elements: VsmElement[] = model.nodes.flatMap((node) => {
    const kind = elementKind(node);
    if (kind === undefined) return [];
    return [{
      id: node.id,
      kind,
      nodeId: node.id,
      name: node.name,
      metrics: elementMetrics(node, kind, { nodeMetric, resourceFailedMinutes, resourceCapacity, measurementMinutes }),
    }];
  });
  const throughputPerHour = result.confidence95.throughputPerHour.mean;
  const splitShare = splitSharePerHour(model, result);
  const flows: VsmFlow[] = model.edges
    .filter((edge) => elements.some((element) => element.id === edge.from) && elements.some((element) => element.id === edge.to))
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      itemsPerHour: round(splitShare.get(`${edge.from}->${edge.to}`) ?? throughputPerHour),
    }));
  const processTimeMinutes = round(elements
    .filter((element) => element.kind === "process")
    .reduce((sum, element) => sum + (element.metrics.cycleMinutes ?? 0), 0));
  const totalLeadTimeMinutes = round(result.confidence95.averageLeadTimeMinutes.mean);
  if (!(totalLeadTimeMinutes > 0)) throw new Error("平均交付期非正,PCE 无定义");
  const demandItemsPerHour = model.nodes
    .filter((node) => node.kind === "source")
    .reduce((sum, node) => sum + 60 / representativeMinutes(node.interarrivalTime), 0);
  return {
    elements,
    flows,
    summary: {
      totalLeadTimeMinutes,
      processTimeMinutes,
      pceRatio: round(processTimeMinutes / totalLeadTimeMinutes),
      ...(demandItemsPerHour > 0 ? { taktMinutes: round(60 / demandItemsPerHour) } : {}),
    },
    basis: {
      leadTimeSource: "confidence95.averageLeadTimeMinutes.mean",
      flowEstimation: "split-share-where-observed-else-total-throughput",
      ...(demandItemsPerHour > 0 ? { demandItemsPerHour: round(demandItemsPerHour) } : {}),
    },
  };
}

interface MetricContext {
  nodeMetric(nodeId: string, path: "utilization" | "averageQueueLength" | "changeoverMinutes"): number;
  resourceFailedMinutes(resourceId: string): number;
  resourceCapacity(resourceId: string): number;
  measurementMinutes: number;
}

function elementMetrics(node: PlantLiteNode, kind: VsmElementKind, context: MetricContext): VsmElement["metrics"] {
  if (kind === "process") {
    if (node.kind !== "station") throw new Error(`process 要素必须来自 station 节点:${node.id}`);
    const uptimeFraction = node.resourceId === undefined
      ? undefined
      : 1 - context.resourceFailedMinutes(node.resourceId)
        / (context.measurementMinutes * context.resourceCapacity(node.resourceId));
    return {
      cycleMinutes: round(representativeMinutes(node.processingTime)),
      changeoverMinutes: round(context.nodeMetric(node.id, "changeoverMinutes")),
      utilization: round(context.nodeMetric(node.id, "utilization")),
      ...(uptimeFraction === undefined ? {} : { uptimeFraction: round(Math.min(1, Math.max(0, uptimeFraction))) }),
    };
  }
  if (kind === "inventory") {
    return { inventoryItems: round(context.nodeMetric(node.id, "averageQueueLength")) };
  }
  return {};
}

/** VSM 表格摘要(数据版价值流图);数值格式与 elements/summary 完全同源。 */
export function renderVsmMarkdown(vsm: VsmAnalysis): string {
  const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines: string[] = [
    "# VSM 价值流摘要",
    "",
    "## 汇总",
    `- 总交付期 Lead Time:${fmt(vsm.summary.totalLeadTimeMinutes)} 分钟`,
    `- 工序时间 Process Time:${fmt(vsm.summary.processTimeMinutes)} 分钟`,
    `- 流程效率 PCE:${percent(vsm.summary.pceRatio)}(工序时间 / 总交付期)`,
    ...(vsm.summary.taktMinutes === undefined ? [] : [`- 节拍 Takt:${fmt(vsm.summary.taktMinutes)} 分钟/件`]),
    "",
    "## 要素",
    "| ID | 类别 | 名称 | 周期(分) | 换型(分) | 利用率 | 可用率 | 在库(件) |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const element of vsm.elements) {
    const metrics = element.metrics;
    lines.push(`| ${element.id} | ${element.kind} | ${element.name ?? "-"} | ${opt(metrics.cycleMinutes)} | ${opt(metrics.changeoverMinutes)} | ${opt(metrics.utilization, percent)} | ${opt(metrics.uptimeFraction, percent)} | ${opt(metrics.inventoryItems)} |`);
  }
  lines.push("", "## 物流", "| From | To | 件/小时 |", "| --- | --- | --- |");
  for (const flow of vsm.flows) {
    lines.push(`| ${flow.from} | ${flow.to} | ${fmt(flow.itemsPerHour)} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** 分流边按 split 节点 routeDelivered 折算件/小时(已完成 replication 均值)。 */
function splitSharePerHour(model: PlantLiteModel, result: PlantLiteExperimentResult): Map<string, number> {
  const shares = new Map<string, number>();
  const splits = model.nodes.filter((node) => node.kind === "split");
  if (splits.length === 0) return shares;
  const completed = result.replications.filter((replication) => replication.termination === "completed");
  for (const split of splits) {
    for (const route of split.routes) {
      const rates = completed.map((replication) => {
        const node = replication.nodes.find((candidate) => candidate.nodeId === split.id);
        const delivered = node?.routeDelivered?.find((candidate) => candidate.to === route.to)?.items ?? 0;
        return delivered / (replication.measurementMinutes / 60);
      });
      shares.set(`${split.id}->${route.to}`, mean(rates));
    }
  }
  return shares;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function fmt(value: number): string {
  return String(round(value));
}

function opt(value: number | undefined, format: (input: number) => string = fmt): string {
  return value === undefined ? "-" : format(value);
}
