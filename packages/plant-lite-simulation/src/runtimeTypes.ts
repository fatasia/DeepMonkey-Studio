import type { Availability, PlantLiteModel, PlantLiteNode, PlantLiteProductionOrder, PlantLiteResource, SimulationLimits } from "./model.js";
import type { Random } from "./random.js";
import type { PlantLiteTraceRecorder } from "./trace.js";
import type { SimulationEventQueue } from "./eventQueue.js";
import type { TransportNetworkScheduler } from "./transportNetwork.js";

export interface Item {
  id: string;
  createdAt: number;
  productTypeId?: string;
  orderId?: string;
}

export interface ProductionOrderState {
  releasedItems: number;
  completedItems: number;
  scrappedItems: number;
  completedOnTimeItems: number;
  firstCompletionMinute?: number;
  lastCompletionMinute?: number;
}

export interface NodeState {
  input: Item[];
  output: Item[];
  active: number;
  generated: number;
  busyArea: number;
  availableArea: number;
  queueArea: number;
  blocked: number;
  starved: number;
  lastProductTypeId?: string;
  changeoverCount: number;
  changeoverActive: number;
  changeoverArea: number;
  qualityInspected: number;
  qualityPassed: number;
  qualityScrapped: number;
  /** 仅 split 节点：按 routes 数组序累计各路成功投递件数，作为无随机轮转的记账状态。 */
  routeDelivered?: number[];
  /** 仅配置看板的缓冲区：累计从在库流向下游的件数（含预热期）。 */
  withdrawn?: number;
}

export interface ResourceState {
  busy: number;
  busyArea: number;
  availableArea: number;
  failedUnits: Set<number>;
  /** 故障容量损失，单位为台·分钟。 */
  failedArea: number;
}

export interface EnergyConsumerState {
  consumerId: string;
  consumerKind: "node" | "resource";
  activeEnergyKwh: number;
  idleEnergyKwh: number;
}

export interface EnergyState {
  activeEnergyKwh: number;
  idleEnergyKwh: number;
  peakDemandKw: number;
  consumers: Map<string, EnergyConsumerState>;
}

export interface ChangeoverEventData {
  fromProductTypeId: string;
  toProductTypeId: string;
  startMinute: number;
  durationMinutes: number;
}

export type EventType = "arrival" | "changeover-complete" | "complete" | "failure" | "repair" | "availability";

export interface SimulationEvent {
  at: number;
  sequence: number;
  type: EventType;
  id: string;
  item?: Item;
  unitIndex?: number;
  changeover?: ChangeoverEventData;
  orderId?: string;
}

export interface Runtime {
  model: PlantLiteModel;
  random: Random;
  /** 产品序列独立随机流，避免启用混流改变到料、加工或故障样本。 */
  productRandom: Random;
  /** 每个配置良率的工位使用独立流，避免质量判定改变加工、产品或故障采样序列。 */
  qualityRandoms: Map<string, Random>;
  qualityEnabled: boolean;
  limits: Required<SimulationLimits>;
  states: Map<string, NodeState>;
  resources: Map<string, ResourceState>;
  outgoing: Map<string, string[]>;
  events: SimulationEventQueue;
  now: number;
  sequence: number;
  eventsProcessed: number;
  created: number;
  /** 物理系统累计完工数；用于在制品状态，包含预热期。 */
  completed: number;
  /** 已在任一工位报废并从系统退出的物理工件数，包含预热期。 */
  scrapped: number;
  /** 仅统计预热结束后的完工件。 */
  measuredCompleted: number;
  measuredScrapped: number;
  completedByProductType: Map<string, number>;
  productionOrders: Map<string, ProductionOrderState>;
  /** 每个来料源共享一条待释放订单队列和一个到料节拍时钟。 */
  productionOrderQueues: Map<string, PlantLiteProductionOrder[]>;
  leadTotal: number;
  wipArea: number;
  /** 已被看板门控拦下、等待补货卡唤醒的 source id；拉动唤醒时从中移除并重排节拍。 */
  kanbanPullArmed: Set<string>;
  trace?: PlantLiteTraceRecorder;
  energy?: EnergyState;
  transport?: TransportNetworkScheduler;
  /**
   * 模型级预计算索引:以下字段全部由 createRuntime 一次性推导,内容在求解期不可变。
   * 求解循环热路径禁止 linear find、全量过滤与重复数组分配;
   * 索引必须保持 model.nodes/model.resources 的原顺序,遍历语义与旧实现逐位一致。
   */
  nodeIndex: Map<string, PlantLiteNode>;
  /** station+transport 节点,按模型顺序;派工与推进循环专用。 */
  processingNodes: Array<Extract<PlantLiteNode, { kind: "station" | "transport" }>>;
  sourceNodes: Array<Extract<PlantLiteNode, { kind: "source" }>>;
  resourceDefs: Map<string, PlantLiteResource>;
  requiredByNode: Map<string, string[]>;
  effectiveCapacityByNode: Map<string, number>;
  operatingAvailabilityByResource: Map<string, Availability | undefined>;
  hasWorkerPools: boolean;
  /** split 节点的路由计划：目标序、归一份额与兜底序，按模型顺序一次性推导。 */
  splitPlans: Map<string, SplitRoutePlan>;
  /** sourceId → 门控它的看板缓冲节点 id 列表（沿上游第一个 source）；无看板模型为空表。 */
  kanbanGatesBySource: Map<string, string[]>;
  /** 看板缓冲节点 id → 被其门控的 source id 列表；取走补卡时按此唤醒。 */
  kanbanGatedSourcesByNode: Map<string, string[]>;
}

/** split 路由的预计算形态；shareRoutes 参与份额轮转，fallbackRoutes 只作兜底。 */
export interface SplitRoutePlan {
  /** routes 数组序的目标节点 id。 */
  targets: string[];
  /** routes 数组序的归一份额；未配份额记 0，仅 shareRoutes 参与轮转。 */
  shares: number[];
  /** 配置了正份额的路下标，保持数组序。 */
  shareRoutes: number[];
  /** 未配份额的兜底路下标，按 priority 升序、数组序破平。 */
  fallbackRoutes: number[];
}
