/**
 * Plant 平替的渲染数据层合同(矩阵 P0-B;Plant Simulation 标配输出):
 * Sankey 物料流决策图 + Gantt 订单/工序时序图。数据层产出纯数据对象,
 * ECharts option 组装是第二层(plant-lite analytics.ts),前端 echarts 仅消费。
 * 全部时间均为窗口坐标:0 = 正式统计窗口起点(预热期已剔除,与内核 measurementMinutes 同口径)。
 */

/** Sankey 节点 = 模型节点;label 为展示名,可能与其它节点重名,链关联用 id。 */
export interface PlantAnalyticsSankeyNode {
  id: string;
  label: string;
}

/** 节点间物料流量;value 单位为件(整数或估算取整),unit 缺省按"件"理解。 */
export interface PlantAnalyticsSankeyLink {
  source: string;
  target: string;
  value: number;
  unit?: string;
}

/**
 * Sankey 分析结果。estimated=false 时链流量按代表性重复轨迹的真实事件统计;
 * estimated=true 时无轨迹,按节点吞吐传播估算(只用于示意,禁止当实测宣示)。
 * 守恒口径:仅统计正式窗口内抵达 sink 的工件完整路径;报废件不参与流量,
 * 因此 source 流出链和 = 窗口完工件数(±轨迹截断或报废残差)。
 */
export interface PlantAnalyticsSankeyAnalysis {
  nodes: PlantAnalyticsSankeyNode[];
  links: PlantAnalyticsSankeyLink[];
  windowMinutes: number;
  estimated: boolean;
  generatedFrom: { modelId: string; replications: number };
}

export type PlantAnalyticsGanttSegmentKind = "occupied" | "blocked" | "failed" | "changeover";

/** 一段时间区间;endMinute > startMinute,均落在 [0, windowMinutes] 内。 */
export interface PlantAnalyticsGanttSegment {
  startMinute: number;
  endMinute: number;
  kind: PlantAnalyticsGanttSegmentKind;
  /** 可选展示备注;estimated 行建议注明口径来源。 */
  label?: string;
}

/** Gantt 一行 = 一个 station/transport 节点。estimated=true 时段为指标占比铺段(无逐事件证据)。 */
export interface PlantAnalyticsGanttRow {
  id: string;
  label: string;
  estimated: boolean;
  segments: PlantAnalyticsGanttSegment[];
}

/**
 * Gantt 分析结果。有 representativeTrace 时按事件对齐切分(item-start/complete 区间、
 * blocked 由 complete→exit 停留区间还原、changeover 事件区间、failure/repair 对);
 * 无轨迹时按指标占比铺段,occupied 为残差(资源在场时长,含空闲),各段和恰为窗口长。
 */
export interface PlantAnalyticsGanttAnalysis {
  rows: PlantAnalyticsGanttRow[];
  windowMinutes: number;
  /** 观测节拍:正式窗口完工件数 > 0 时为 窗口分钟/完工件数,否则省略。 */
  taktMinutes?: number;
}
