/** Plant 工厂规划的稳定模型合同；求解器、API 与作者器共同复用。所有时间单位均为分钟。 */
export type PlantLiteDistribution =
  | { kind: "deterministic"; value: number }
  | { kind: "uniform"; minimum: number; maximum: number }
  | { kind: "normal"; mean: number; standardDeviation: number; minimum?: number }
  | { kind: "exponential"; mean: number };

export interface PlantLiteShiftWindow {
  startMinute: number;
  endMinute: number;
}

export interface PlantLiteAvailability {
  shifts?: PlantLiteShiftWindow[];
}

export interface PlantLiteFailureProfile {
  /** 每个资源单元独立采样；故障间隔按资源可用班次的运行分钟推进。 */
  timeToFailure: PlantLiteDistribution;
  /** 修复时间按连续日历分钟推进。 */
  repairTime: PlantLiteDistribution;
}

/** 全模型共用的产品类型与投放比例；share 使用 0..1，小数合计必须为 1。 */
export interface PlantLiteProductType {
  id: string;
  name: string;
  share: number;
}

/** 有限生产订单；计划数量从指定来料源按其既有到料节拍投放。 */
export interface PlantLiteProductionOrder {
  id: string;
  name: string;
  sourceNodeId: string;
  productTypeId?: string;
  quantity: number;
  /** 正式统计窗口开始后的计划释放分钟；配置预热时由引擎自动后移。 */
  releaseMinute: number;
  /** 正式统计窗口开始后的承诺完工分钟，必须不早于释放时间。 */
  dueMinute: number;
  /** 同时释放时数值越大越优先；省略按 0。 */
  priority?: number;
}

/** 有向换型规则；未列出的产品切换明确按 0 分钟处理。 */
export interface PlantLiteChangeoverRule {
  fromProductTypeId: string;
  toProductTypeId: string;
  minutes: number;
}

/**
 * 设备或无独立资源工位的单台功率模型。运行功率只在执行作业时计入，
 * 待机功率只在计划可用且既未运行也未故障的产能上计入。
 */
export interface PlantLitePowerProfile {
  activePowerKw: number;
  idlePowerKw: number;
  /** 省略按 estimate 处理，兼容旧模型且不把默认值冒充实测。 */
  source?: "estimate" | "nameplate" | "measured";
}

/** Study 使用的能源经济口径；价格按人民币计，排放因子由用户按项目口径填写。 */
export interface PlantLiteEnergyEconomics {
  electricityPricePerKwh: number;
  carbonEmissionFactorKgPerKwh: number;
  /** 电价与排放口径的依据；省略按 estimate 处理。 */
  source?: "estimate" | "project" | "measured";
}

interface PlantLiteNodeBase {
  id: string;
  name: string;
}

export interface PlantLiteSourceNode extends PlantLiteNodeBase {
  kind: "source";
  interarrivalTime: PlantLiteDistribution;
  initialDelay?: number;
  maxItems?: number;
}

export interface PlantLiteStationNode extends PlantLiteNodeBase {
  kind: "station";
  processingTime: PlantLiteDistribution;
  /**
   * 工位一次通过良率，使用 0..1。省略按 100% 处理并保持旧模型求解结果不变；
   * 当前只模拟报废退出，不模拟返工或维修循环。
   */
  yieldRate?: number;
  capacity?: number;
  queueCapacity?: number;
  /** 可选设备资源；与人工资源同时绑定时必须同时有可用容量才可派工。 */
  resourceId?: string;
  /** 可选人工资源池；可被多个工位共享，capacity 表示同班可派人数。 */
  workerResourceId?: string;
  availability?: PlantLiteAvailability;
  /** 仅用于没有 resourceId 的独立工位，避免与设备资源重复计量。 */
  power?: PlantLitePowerProfile;
  /** 单机工位的序列相关换型矩阵；同类型连续加工不会触发换型。 */
  changeovers?: PlantLiteChangeoverRule[];
}

export interface PlantLiteTransportNode extends PlantLiteNodeBase {
  kind: "transport";
  travelTime: PlantLiteDistribution;
  queueCapacity?: number;
  resourceId: string;
}

export interface PlantLiteBufferNode extends PlantLiteNodeBase {
  /** queue-buffer 是首选名称；buffer 保留为兼容别名。 */
  kind: "buffer" | "queue-buffer";
  capacity: number;
}

export interface PlantLiteSinkNode extends PlantLiteNodeBase {
  kind: "sink";
}

export type PlantLiteNode = PlantLiteSourceNode | PlantLiteStationNode | PlantLiteTransportNode | PlantLiteBufferNode | PlantLiteSinkNode;

export interface PlantLiteEdge {
  id: string;
  from: string;
  to: string;
  priority?: number;
}

export interface PlantLiteResource {
  id: string;
  name: string;
  /** equipment 供工位共享或独占；worker 是人工资源池；agv / transport 供搬运节点使用。 */
  kind: "agv" | "transport" | "equipment" | "worker";
  capacity: number;
  availability?: PlantLiteAvailability;
  failure?: PlantLiteFailureProfile;
  /** 每个资源单元的运行/待机功率。共享资源只在资源层累计一次。 */
  power?: PlantLitePowerProfile;
}

export interface PlantLiteModel {
  id: string;
  name: string;
  /** 编辑器运行时绑定快照；仅用于证据追溯与轨迹定位，不改变 DES 计算。 */
  sceneBinding?: { sceneId: string; nodes: Array<{ nodeId: string; objectId: string; position: [number, number, number] }> };
  nodes: PlantLiteNode[];
  edges: PlantLiteEdge[];
  resources?: PlantLiteResource[];
  /** 省略时保持旧模型的单一未分类物料语义。 */
  productTypes?: PlantLiteProductType[];
  /** 配置后替代来料源的无限随机投放，用于验证订单数量与交期。 */
  productionOrders?: PlantLiteProductionOrder[];
  /** 省略时仍可运行物流仿真，但不会产生能耗、成本或碳排决策证据。 */
  energyEconomics?: PlantLiteEnergyEconomics;
}

export interface PlantLiteSimulationLimits {
  /**
   * 从空系统开始运行的总日历时长，包含预热期。正式统计窗口为
   * durationMinutes - warmupMinutes。
   */
  durationMinutes?: number;
  /**
   * 预热期只建立系统状态。吞吐与交付期只采集随后完工的工件；WIP、利用率、
   * 队列、故障停机和能耗只积分正式窗口。跨边界完工件仍保留完整系统交付期。
   */
  warmupMinutes?: number;
  maxEvents?: number;
  maxResources?: number;
}

export interface PlantLiteTraceLimits {
  maxEvents: number;
  maxItems: number;
}

/** Study 可选的代表性重复轨迹采集参数；省略时由 API 使用有界默认值。 */
export interface PlantLiteTraceCaptureOptions {
  replication?: number;
  maxEvents?: number;
  maxItems?: number;
}

export type PlantLiteTraceEvent =
  | {
    sequence: number;
    atMinute: number;
    type: "item-enter" | "item-changeover-start" | "item-changeover-complete" | "item-start" | "item-complete" | "item-scrap" | "item-exit";
    itemId: string;
    nodeId: string;
    productTypeId?: string;
    orderId?: string;
    /** 仅换型事件携带；记录本次加工前的有向换型区间。 */
    changeover?: {
      fromProductTypeId: string;
      toProductTypeId: string;
      startMinute: number;
      durationMinutes: number;
    };
    /** 仅 item-scrap 携带；记录作出报废判定时使用的工位良率。 */
    quality?: {
      configuredYieldRate: number;
      disposition: "scrap";
    };
  }
  | {
    sequence: number;
    atMinute: number;
    type: "resource-failure" | "resource-repair";
    resourceId: string;
    /** 新轨迹按资源单元记录故障；旧轨迹省略时仍按整项资源回放。 */
    unitIndex?: number;
    /** 该事件完成后不可用的资源单元数，供回放正确表达部分降级。 */
    unavailableUnits?: number;
  };

/** 代表性重复的有界事件轨迹；truncated=true 表示播放器不得宣称它是完整轨迹。 */
export interface PlantLiteReplicationTrace {
  engineId: "plant-lite-des";
  engineVersion: "1.0.0";
  replication: number;
  seed: number;
  events: PlantLiteTraceEvent[];
  capturedItemCount: number;
  omittedEventCount: number;
  truncated: boolean;
  limits: PlantLiteTraceLimits;
}
