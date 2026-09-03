import type { PlantLiteModel, PlantLiteProductionOrder, SimulationLimits } from "./model.js";
import type { Random } from "./random.js";
import type { PlantLiteTraceRecorder } from "./trace.js";
import type { SimulationEventQueue } from "./eventQueue.js";

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
  trace?: PlantLiteTraceRecorder;
  energy?: EnergyState;
}
