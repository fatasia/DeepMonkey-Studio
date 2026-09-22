/** 完整兼容键;唯一复用判据,序列化口径与 renderGraph aliasKey 一致。 */
export interface PbrTransientTextureKey {
  readonly format: GPUTextureFormat;
  readonly width: number;
  readonly height: number;
  readonly sampleCount: number;
  readonly usage: GPUTextureUsageFlags;
}

/** 池的获取请求:resourceId 用于 history 排除与诊断,兼容键字段必须逐项给出。 */
export interface PbrTransientRequest extends PbrTransientTextureKey {
  readonly resourceId: string;
}

export interface PbrTransientTextureHandle {
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly key: PbrTransientTextureKey;
  readonly resourceId: string;
}

export type PbrTransientPoolInvalidationReason = "surface-resize" | "device-lost" | "epoch-advance";

/** 冻结快照,形态对齐 EnginePerformanceTelemetrySnapshot;分配计数/字节均以真实 GPU 分配为口径。 */
export interface PbrTransientTexturePoolStats {
  readonly budgetBytes: number;
  readonly residentBytes: number;
  readonly budgetRejectedCount: number;
  readonly budgetEvictedBytes: number;
  readonly epoch: number;
  readonly frameOpen: boolean;
  readonly lastInvalidation: readonly [PbrTransientPoolInvalidationReason, number] | undefined;
  readonly acquireCount: number;
  readonly hits: number;
  /** Same-frame physical allocations avoided by the compiled render-graph alias plan. */
  readonly frameAliasHits: number;
  /** 真实 GPU 新分配次数(无池基线对比的下降判据)。 */
  readonly misses: number;
  /** 真实新分配的累计字节估算。 */
  readonly allocatedBytes: number;
  /** 命中复用的字节估算(相对无池基线的节省量)。 */
  readonly reusedBytes: number;
  readonly freeCount: number;
  readonly freeBytes: number;
  readonly inFlightCount: number;
  readonly inFlightBytes: number;
  readonly pendingReturnCount: number;
  readonly pendingReturnBytes: number;
  /** 池驻留峰值 = 空闲 + 挂起回池 + 在途；不包含外部上传 staging。 */
  readonly peakResidentBytes: number;
  /** 失败提交销毁的本帧纹理数。 */
  readonly discardedCount: number;
  /** 预算驱逐与 resize / 设备丢失 / epoch 更迭销毁的空闲纹理数。 */
  readonly evictedCount: number;
}
