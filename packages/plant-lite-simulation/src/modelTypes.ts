/** Plant Lite 离散事件仿真的稳定输入/输出合同；所有时间单位均为分钟。 */
export type Distribution =
  | { kind: "deterministic"; value: number }
  | { kind: "uniform"; minimum: number; maximum: number }
  | { kind: "normal"; mean: number; standardDeviation: number; minimum?: number }
  | { kind: "exponential"; mean: number };

export interface ShiftWindow {
  startMinute: number;
  endMinute: number;
}

export interface Availability {
  shifts?: ShiftWindow[];
}

/** 最小切片按逻辑资源组整体失效建模；逐车/逐台独立可靠性留给后续扩展。 */
export interface FailureProfile {
  timeToFailure: Distribution;
  repairTime: Distribution;
}

interface NodeBase {
  id: string;
  name: string;
}

export interface SourceNode extends NodeBase {
  kind: "source";
  interarrivalTime: Distribution;
  initialDelay?: number;
  maxItems?: number;
}

export interface StationNode extends NodeBase {
  kind: "station";
  processingTime: Distribution;
  capacity?: number;
  queueCapacity?: number;
  resourceId?: string;
  availability?: Availability;
}

export interface TransportNode extends NodeBase {
  kind: "transport";
  travelTime: Distribution;
  queueCapacity?: number;
  resourceId: string;
}

/** queue-buffer 是首选名称；buffer 保留为兼容别名。 */
export interface BufferNode extends NodeBase {
  kind: "buffer" | "queue-buffer";
  capacity: number;
}

export interface SinkNode extends NodeBase {
  kind: "sink";
}

export type PlantLiteNode = SourceNode | StationNode | TransportNode | BufferNode | SinkNode;

export interface PlantLiteEdge {
  id: string;
  from: string;
  to: string;
  priority?: number;
}

export interface PlantLiteResource {
  id: string;
  name: string;
  kind: "agv" | "transport";
  capacity: number;
  availability?: Availability;
  failure?: FailureProfile;
}

export interface PlantLiteModel {
  id: string;
  name: string;
  nodes: PlantLiteNode[];
  edges: PlantLiteEdge[];
  resources?: PlantLiteResource[];
}

export interface SimulationLimits {
  /** 单次运行的模拟时长上限，默认 480 分钟，最大 52,560 分钟。 */
  durationMinutes?: number;
  /** 单次运行处理事件上限，默认 100,000，最大 1,000,000。 */
  maxEvents?: number;
  /** 资源对象上限，默认 100，保护浏览器/API 工作线程。 */
  maxResources?: number;
}

export interface PlantLiteExperiment {
  model: PlantLiteModel;
  seed: string | number;
  replications?: number;
  limits?: SimulationLimits;
}

export interface PlantLiteRunOptions {
  /** 调用方可在 worker、请求断开或协作调度器让出时返回 true。 */
  shouldCancel?: () => boolean;
}

export type SimulationTermination = "completed" | "cancelled" | "limit-reached";

export interface NodeRunMetrics {
  nodeId: string;
  utilization: number;
  averageQueueLength: number;
  blockedMinutes: number;
  starvedMinutes: number;
}

export interface ResourceRunMetrics {
  resourceId: string;
  utilization: number;
  failedMinutes: number;
}

export interface PlantLiteReplication {
  replication: number;
  seed: number;
  termination: SimulationTermination;
  reason?: "cancelled" | "max-events";
  simulatedMinutes: number;
  processedEvents: number;
  completedItems: number;
  throughputPerHour: number;
  averageWip: number;
  averageLeadTimeMinutes: number;
  bottleneckNodeId?: string;
  nodes: NodeRunMetrics[];
  resources: ResourceRunMetrics[];
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
  bottlenecks: BottleneckFrequency[];
}

export interface PlantLiteModelIssue {
  path: string;
  message: string;
}

export type PlantLiteModelValidation =
  | { valid: true; model: PlantLiteModel; issues: [] }
  | { valid: false; issues: PlantLiteModelIssue[] };
