import type {
  PlantLiteAvailability,
  PlantLiteBufferNode,
  PlantLiteDistribution,
  PlantLiteEdge,
  PlantLiteFailureProfile,
  PlantLiteKanbanCard,
  PlantLiteModel,
  PlantLiteNode,
  PlantLiteProductType,
  PlantLiteProductionOrder,
  PlantLiteReplicationTrace,
  PlantLiteResource,
  PlantLiteShiftWindow,
  PlantLiteSimulationLimits,
  PlantLiteSinkNode,
  PlantLiteSourceNode,
  PlantLiteSplitNode,
  PlantLiteSplitRoute,
  PlantLiteStationNode,
  PlantLiteTraceCaptureOptions,
  PlantLiteTraceEvent,
  PlantLiteTraceLimits,
  PlantLiteTransportNode,
} from "@bim-studio/contracts";

export type Distribution = PlantLiteDistribution;
export type ShiftWindow = PlantLiteShiftWindow;
export type Availability = PlantLiteAvailability;
export type FailureProfile = PlantLiteFailureProfile;
export type SourceNode = PlantLiteSourceNode;
export type StationNode = PlantLiteStationNode;
export type TransportNode = PlantLiteTransportNode;
export type BufferNode = PlantLiteBufferNode;
export type SplitNode = PlantLiteSplitNode;
export type SplitRoute = PlantLiteSplitRoute;
export type KanbanCard = PlantLiteKanbanCard;
export type SinkNode = PlantLiteSinkNode;
export type SimulationLimits = PlantLiteSimulationLimits;
export type {
  PlantLiteEdge,
  PlantLiteKanbanCard,
  PlantLiteModel,
  PlantLiteNode,
  PlantLiteProductType,
  PlantLiteProductionOrder,
  PlantLiteReplicationTrace,
  PlantLiteResource,
  PlantLiteSplitNode,
  PlantLiteSplitRoute,
  PlantLiteTraceLimits,
  PlantLiteTraceEvent,
};

export interface PlantLiteExperiment {
  model: PlantLiteModel;
  seed: string | number;
  replications?: number;
  limits?: SimulationLimits;
  trace?: PlantLiteTraceOptions;
}

export type PlantLiteTraceOptions = PlantLiteTraceCaptureOptions;

export interface PlantLiteRunOptions {
  /** 调用方可在 worker、请求断开或协作调度器让出时返回 true。 */
  shouldCancel?: () => boolean;
  /** 每轮 replication 完成后回调,仅供端口层发进度;不参与任何统计语义。 */
  onReplicationCompleted?: (completedReplications: number, totalReplications: number) => void;
}

export type SimulationTermination = "completed" | "cancelled" | "limit-reached";

export interface NodeRunMetrics {
  nodeId: string;
  utilization: number;
  averageQueueLength: number;
  blockedMinutes: number;
  starvedMinutes: number;
  /** 该重复中实际触发的序列相关换型次数。 */
  changeoverCount: number;
  /** 该重复中资源被换型占用的实际分钟。 */
  changeoverMinutes: number;
  /** 仅 split 节点：按 routes.to 汇总本重复成功投递件数，用于验证份额路由分布。 */
  routeDelivered?: Array<{ to: string; items: number }>;
  /** 仅配置看板的缓冲区：本重复从在库流向下游的累计件数。 */
  kanbanWithdrawn?: number;
}

export interface ResourceRunMetrics {
  resourceId: string;
  /** 计划产能口径利用率；跨班继续完成的在制任务会计入分母。 */
  utilization: number;
  /** 故障容量损失，单位为台·分钟；capacity=1 时等于停机分钟。 */
  failedMinutes: number;
}

export interface ProductTypeRunMetrics {
  productTypeId: string;
  completedItems: number;
  completionShare: number;
  throughputPerHour: number;
}

export interface ProductionOrderRunMetrics {
  orderId: string;
  plannedItems: number;
  releasedItems: number;
  completedItems: number;
  scrappedItems: number;
  completedOnTimeItems: number;
  completionRate: number;
  /** 准交件数 / 计划数量；未完成件不会被排除。 */
  onTimeFulfillmentRate: number;
  fullyCompleted: boolean;
  completionMinute?: number;
  /** 完成后按末件完工计算；未完成订单按仿真终点计算当前已观测拖期。 */
  observedTardinessMinutes: number;
}

export interface StationQualityRunMetrics {
  nodeId: string;
  inspectedItems: number;
  goodItems: number;
  scrapItems: number;
  firstPassYield: number;
}

export interface QualityRunMetrics {
  goodOutputItems: number;
  scrapItems: number;
  /** 已形成合格产出或报废处置的工件数；仅用于避免把未处置在制品放进良率分母。 */
  dispositionItems: number;
  firstPassYield: number;
  stations: StationQualityRunMetrics[];
}

export interface EnergyConsumerRunMetrics {
  consumerId: string;
  consumerKind: "node" | "resource";
  activeEnergyKwh: number;
  idleEnergyKwh: number;
  totalEnergyKwh: number;
}

export interface EnergyRunMetrics {
  activeEnergyKwh: number;
  idleEnergyKwh: number;
  totalEnergyKwh: number;
  energyPerCompletedItemKwh: number;
  electricityCost: number;
  electricityCostPerCompletedItem: number;
  carbonEmissionKg: number;
  carbonEmissionPerCompletedItemKg: number;
  peakDemandKw: number;
  consumers: EnergyConsumerRunMetrics[];
}

export interface PlantLiteReplication {
  replication: number;
  seed: number;
  termination: SimulationTermination;
  reason?: "cancelled" | "max-events";
  simulatedMinutes: number;
  /** 正式统计窗口的实际分钟数；总运行时长减去预热期。 */
  measurementMinutes: number;
  processedEvents: number;
  completedItems: number;
  throughputPerHour: number;
  averageWip: number;
  averageLeadTimeMinutes: number;
  bottleneckNodeId?: string;
  nodes: NodeRunMetrics[];
  resources: ResourceRunMetrics[];
  productTypes: ProductTypeRunMetrics[];
  productionOrders: ProductionOrderRunMetrics[];
  /** 只有模型显式配置了工位良率时生成。 */
  quality?: QualityRunMetrics;
  energy?: EnergyRunMetrics;
}

export interface ConfidenceInterval {
  mean: number;
  sampleStandardDeviation: number;
  lower95: number;
  upper95: number;
  samples: number;
}

export interface NodeMetricConfidence {
  utilization: ConfidenceInterval;
  averageQueueLength: ConfidenceInterval;
  blockedMinutes: ConfidenceInterval;
  starvedMinutes: ConfidenceInterval;
  changeoverCount: ConfidenceInterval;
  changeoverMinutes: ConfidenceInterval;
}

export interface BottleneckFrequency {
  nodeId: string;
  occurrences: number;
  probability: number;
}

export interface PlantLiteExperimentResult {
  engineId: "plant-lite-des";
  engineVersion: "1.0.0";
  deterministic: true;
  seed: string | number;
  replications: PlantLiteReplication[];
  confidence95: {
    throughputPerHour: ConfidenceInterval;
    averageWip: ConfidenceInterval;
    averageLeadTimeMinutes: ConfidenceInterval;
  };
  nodeMetrics95: Record<string, NodeMetricConfidence>;
  resourceUtilization95: Record<string, ConfidenceInterval>;
  resourceFailedMinutes95: Record<string, ConfidenceInterval>;
  productTypeMetrics95: Record<string, {
    completedItems: ConfidenceInterval;
    completionShare: ConfidenceInterval;
    throughputPerHour: ConfidenceInterval;
  }>;
  productionOrderMetrics95: Record<string, {
    completedItems: ConfidenceInterval;
    completionRate: ConfidenceInterval;
    onTimeFulfillmentRate: ConfidenceInterval;
    fullyCompletedRate: ConfidenceInterval;
    observedTardinessMinutes: ConfidenceInterval;
  }>;
  quality95?: {
    goodOutputItems: ConfidenceInterval;
    scrapItems: ConfidenceInterval;
    firstPassYield: ConfidenceInterval;
    stationMetrics95: Record<string, {
      inspectedItems: ConfidenceInterval;
      goodItems: ConfidenceInterval;
      scrapItems: ConfidenceInterval;
      firstPassYield: ConfidenceInterval;
    }>;
  };
  energy95?: {
    activeEnergyKwh: ConfidenceInterval;
    idleEnergyKwh: ConfidenceInterval;
    totalEnergyKwh: ConfidenceInterval;
    energyPerCompletedItemKwh: ConfidenceInterval;
    electricityCost: ConfidenceInterval;
    electricityCostPerCompletedItem: ConfidenceInterval;
    carbonEmissionKg: ConfidenceInterval;
    carbonEmissionPerCompletedItemKg: ConfidenceInterval;
    peakDemandKw: ConfidenceInterval;
    consumerEnergyKwh: Record<string, ConfidenceInterval>;
  };
  bottlenecks: BottleneckFrequency[];
  representativeTrace?: PlantLiteReplicationTrace;
}

export interface PlantLiteModelIssue {
  path: string;
  message: string;
}

export type PlantLiteModelValidation =
  | { valid: true; model: PlantLiteModel; issues: [] }
  | { valid: false; issues: PlantLiteModelIssue[] };
