/**
 * VSM 价值流合同(Plant 替代 P2 尾巴,对位西门子 VSM Library 的数据层)。
 * 从既有模型 + 实验结果推导价值流视图:要素(工序/库存/供应/客户)、物流与
 * 交付期汇总(leadTime / processTime / PCE / takt)。
 * 图形渲染(价值流图版式)由前端 ECharts 二层承担,不在本合同;
 * renderVsmMarkdown 提供表格摘要,作为图形视图的数据对照版。
 */

/** 价值流要素类别;与 VSM 图例对位:工序框、库存三角、供应方、客户。 */
export type VsmElementKind = "process" | "inventory" | "supplier" | "customer";

/**
 * 要素数据盒(对位 VSM 数据框)。全部字段可选:取不到实验指标的项不编造,
 * 由消费方按 undefined 呈现“未观测”。
 */
export interface VsmElementMetrics {
  /** 单件标准工时(分钟);取自工位 processingTime 的分布代表值。 */
  cycleMinutes?: number;
  /** 观测窗口内平均换型占用分钟;取自 nodeMetrics95.changeoverMinutes.mean。 */
  changeoverMinutes?: number;
  /** 故障口径可用率 = 1 − 失败容量分钟/(测量分钟×容量);绑定资源才有值。 */
  uptimeFraction?: number;
  /** 平均在库件数;取自 nodeMetrics95.averageQueueLength.mean,仅库存要素。 */
  inventoryItems?: number;
  /** 计划产能口径利用率;取自 nodeMetrics95.utilization.mean,仅工序要素。 */
  utilization?: number;
}

export interface VsmElement {
  id: string;
  kind: VsmElementKind;
  /** 来源模型节点 id;supplier/customer 也来自 source/sink 节点,故恒有值。 */
  nodeId?: string;
  name?: string;
  metrics: VsmElementMetrics;
}

/** 有向物流:from/to 为 VsmElement.id;itemsPerHour 为该边近似通过率。 */
export interface VsmFlow {
  from: string;
  to: string;
  itemsPerHour: number;
}

export interface VsmAnalysisSummary {
  /** 平均交付期(分钟)= confidence95.averageLeadTimeMinutes.mean。 */
  totalLeadTimeMinutes: number;
  /** 工序时间(分钟)= Σ工序要素 cycleMinutes。 */
  processTimeMinutes: number;
  /** 流程效率 PCE = processTime / totalLeadTime;VSM 核心指标。 */
  pceRatio: number;
  /** 节拍(分钟/件)= 60 / 需求率;取自 source 到达率,无 source 时缺省。 */
  taktMinutes?: number;
}

export interface VsmAnalysis {
  elements: VsmElement[];
  flows: VsmFlow[];
  summary: VsmAnalysisSummary;
  /** 口径说明:各项取数来源,供审计对拍;不承载统计语义。 */
  basis: {
    leadTimeSource: "confidence95.averageLeadTimeMinutes.mean";
    /** 分流边按 split 节点 routeDelivered 份额折算;其余边按整体吞吐均摊。 */
    flowEstimation: "split-share-where-observed-else-total-throughput";
    /** 需求率(件/小时),takt = 60/需求率。 */
    demandItemsPerHour?: number;
  };
}
