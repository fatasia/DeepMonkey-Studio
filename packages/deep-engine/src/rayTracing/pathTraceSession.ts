/**
 * I-C16 / T10 离线路径追踪出图产品模式——CPU 状态机（记账切片）。
 *
 * == 状态与转移（全量规则见 docs/specs/i-c16-pathtrace-product-cpu-20261001.md） ==
 * idle --begin(accept)--> accumulating；begin(超预算) 停留 idle（零状态变更）。
 * accumulating --advanceBatch--> accumulating（收敛 true 但停留，出图才进 exported）。
 * accumulating|reaccumulating --invalidate--> invalidated（代际+1、记账清零、lease 复用）。
 * invalidated --begin--> reaccumulating（复用 lease，不重分配）。
 * accumulating|reaccumulating --export(收敛)--> exported；未收敛拒绝且状态不变。
 * exported --begin--> accumulating（重新分配新 lease；出图后改场景的合法路径）。
 * abort 命中或 cancel()：可推进态 → cancelled（lease 立即释放，记账冻结为只读收据）。
 * cancelled 为终态：一切推进/失效/导出拒绝；dispose() 任何状态合法且幂等。
 *
 * == 资源契约 ==
 * lease 由注入工厂创建（测试用 dispose-spy 钉死"恰一次"）；会话只做字节记账与
 * 就绪仲裁，像素平面归调用方持有（GPU 刀由 GPU 读回产生）。
 * AbortSignal 贯穿：begin 校验（assetBakeResidency 口径）、advanceBatch 每批先查，
 * 取消返回 cancelled 结果对象（状态推进是结果不是异常）。
 */

import { classifyIdentityInvalidation, estimateAccumulationBytes, evaluateConvergence,
  mergeBatchObservation, validatePathTraceConfig,
  type BrightnessAccumulator, type PathTraceAccumulationLease, type PathTraceBatchObservation,
  type PathTraceBatchOutcome, type PathTraceBeginOutcome, type PathTraceExportReceipt,
  type PathTraceInvalidationOutcome, type PathTraceInvalidationReason, type PathTracePhase,
  type PathTraceSceneIdentity, type PathTraceSessionConfig, type ResolvedPathTraceConfig } from "./pathTraceSessionTypes.js";

const EMPTY_ACCUMULATOR: BrightnessAccumulator = Object.freeze({ sampleCount: 0, sum: 0, sumSq: 0 });

/** lease 工厂：分配 bytes 驻留；测试注入 spy，产品由 GPU 刀提供真实平面。 */
export type PathTraceLeaseFactory = (bytes: number) => PathTraceAccumulationLease;

export interface PathTraceBeginOptions {
  /** AbortSignal（assetBakeResidency 口径校验）；已 aborted 的 signal 立即按取消处理。 */
  readonly signal?: AbortSignal;
}

export interface PathTraceAdvanceOptions {
  readonly signal?: AbortSignal;
}

export class PathTraceProductSession {
  private readonly config: ResolvedPathTraceConfig;
  private readonly leaseFactory: PathTraceLeaseFactory;
  private _phase: PathTracePhase = "idle";
  private _generation = 0;
  private _identity: PathTraceSceneIdentity | undefined;
  private _accumulator: BrightnessAccumulator = EMPTY_ACCUMULATOR;
  private _lease: PathTraceAccumulationLease | undefined;
  private _residentBytes = 0;
  private _disposed = false;

  constructor(config: PathTraceSessionConfig, leaseFactory: PathTraceLeaseFactory) {
    this.config = validatePathTraceConfig(config);
    if (typeof leaseFactory !== "function") {
      throw new TypeError("Path trace lease factory must be a function.");
    }
    this.leaseFactory = leaseFactory;
  }

  get phase(): PathTracePhase { return this._phase; }
  get generation(): number { return this._generation; }
  get sampleCount(): number { return this._accumulator.sampleCount; }
  get converged(): boolean {
    return this._phase === "accumulating" || this._phase === "reaccumulating"
      ? evaluateConvergence(this._accumulator, this.config).converged : false;
  }
  get residentBytes(): number { return this._residentBytes; }
  get identity(): PathTraceSceneIdentity | undefined { return this._identity; }
  get disposed(): boolean { return this._disposed; }

  /**
   * 开始/恢复累积：idle 分配新 lease；invalidated 复用 lease 转 reaccumulating；
   * exported 重开（新 lease）。身份三元组任一变化的显式 begin 同样合法（调用方负责
   * 失效语义，会话按"身份已变化"记录）。预算超限返回 rejected-budget，零状态变更。
   */
  begin(identity: PathTraceSceneIdentity, options: PathTraceBeginOptions = {}): PathTraceBeginOutcome {
    this.assertAlive();
    this.validateSignal(options.signal);
    this.validateIdentity(identity);
    if (this._phase === "cancelled") {
      throw new Error("Path trace session is cancelled; cancellation is terminal.");
    }
    const invalidation = classifyIdentityInvalidation(this._identity, identity);
    if (this._phase === "idle" || this._phase === "exported") {
      const estimatedBytes = estimateAccumulationBytes(this.config);
      if (estimatedBytes > this.config.maxAccumulationBytes) {
        return Object.freeze({ status: "rejected-budget", phase: this._phase,
          generation: this._generation, estimatedBytes });
      }
      const lease = this.leaseFactory(estimatedBytes);
      if (!lease || typeof lease.dispose !== "function" || lease.bytes !== estimatedBytes) {
        if (lease && typeof lease.dispose === "function") lease.dispose();
        throw new TypeError("Path trace lease factory returned a malformed lease.");
      }
      this._lease = lease;
      this._residentBytes = lease.bytes;
      this._identity = identity;
      this._accumulator = EMPTY_ACCUMULATOR;
      this._generation += 1;
      this._phase = "accumulating";
      if (options.signal?.aborted) {
        this.releaseLease();
        this._phase = "cancelled";
        return Object.freeze({ status: "cancelled", phase: this._phase,
          generation: this._generation, estimatedBytes });
      }
      return Object.freeze({ status: "started", phase: this._phase,
        generation: this._generation, estimatedBytes });
    }
    if (this._phase === "invalidated") {
      // 复用 lease；若身份在失效之后又变化，以本次 begin 的身份为准（记录最新意图）。
      this._identity = invalidation === "identity" || invalidation === "initial" ? identity : this._identity;
      this._generation += 1;
      this._phase = "reaccumulating";
      return Object.freeze({ status: "started", phase: this._phase, generation: this._generation });
    }
    throw new Error(`Path trace begin is invalid in phase "${this._phase}".`);
  }

  /** 推进一批；abort 命中或超样本上限按结果对象返回（不抛）。其余非法相位抛。 */
  advanceBatch(observation: PathTraceBatchObservation,
    options: PathTraceAdvanceOptions = {}): PathTraceBatchOutcome {
    this.assertAlive();
    this.validateSignal(options.signal);
    if (this._phase !== "accumulating" && this._phase !== "reaccumulating") {
      throw new Error(`Path trace advance is invalid in phase "${this._phase}".`);
    }
    if (options.signal?.aborted) return this.transitionToCancelled();
    if (observation.generation !== undefined && observation.generation !== this._generation) {
      throw new RangeError(`Path trace batch generation ${observation.generation} is stale;`
        + ` session is at generation ${this._generation}.`);
    }
    const merged = mergeBatchObservation(this._accumulator, observation, this.config.maxSamples);
    if (merged === undefined) {
      return Object.freeze({ status: "rejected-limit", phase: this._phase,
        generation: this._generation, sampleCount: this._accumulator.sampleCount,
        converged: this.converged });
    }
    this._accumulator = merged;
    return Object.freeze({ status: "advanced", phase: this._phase, generation: this._generation,
      sampleCount: this._accumulator.sampleCount, converged: this.converged });
  }
  /** 材质/相机身份变化或显式请求：代际+1、记账清零、lease 保留复用。 */
  invalidate(reason: PathTraceInvalidationReason,
    nextIdentity?: PathTraceSceneIdentity): PathTraceInvalidationOutcome {
    this.assertAlive();
    if (reason !== "material-revision" && reason !== "explicit-request") {
      throw new TypeError(`Unknown path trace invalidation reason: ${String(reason)}.`);
    }
    if (this._phase !== "accumulating" && this._phase !== "reaccumulating") {
      throw new Error(`Path trace invalidation is invalid in phase "${this._phase}".`);
    }
    if (nextIdentity !== undefined) this.validateIdentity(nextIdentity);
    this._identity = nextIdentity ?? this._identity;
    this._generation += 1;
    this._accumulator = EMPTY_ACCUMULATOR;
    this._phase = "invalidated";
    return Object.freeze({ phase: this._phase, generation: this._generation, reason });
  }

  /** 显式取消（无需 signal）：可推进态转 cancelled，lease 立即释放；其余返回 false。 */
  cancel(): boolean {
    this.assertAlive();
    if (this._phase !== "accumulating" && this._phase !== "reaccumulating"
      && this._phase !== "invalidated") return false;
    this.transitionToCancelled();
    return true;
  }

  /** 导出：仅收敛后的可推进态允许；释放 lease 并产出收据（像素由调用方在此之前取出）。 */
  export(): PathTraceExportReceipt {
    this.assertAlive();
    if (this._phase !== "accumulating" && this._phase !== "reaccumulating") {
      throw new Error(`Path trace export is invalid in phase "${this._phase}".`);
    }
    const evaluation = evaluateConvergence(this._accumulator, this.config);
    if (!evaluation.converged) {
      throw new Error(`Path trace export requires convergence; samples=${evaluation.sampleCount},`
        + ` relativeStandardError=${evaluation.relativeStandardError}`);
    }
    const receipt: PathTraceExportReceipt = Object.freeze({ width: this.config.width,
      height: this.config.height, generation: this._generation,
      sampleCount: evaluation.sampleCount, variance: evaluation.variance,
      relativeStandardError: evaluation.relativeStandardError, format: "radiance-hdr-rgbe",
      seed: this.config.sampleSeed });
    this.releaseLease();
    this._phase = "exported";
    return receipt;
  }

  /** 任何状态合法；未释放 lease 释放恰一次；聚合回收失败照常标记 disposed（fail-closed）。 */
  dispose(): void {
    if (this._disposed) return;
    const lease = this._lease;
    this._lease = undefined;
    this._disposed = true;
    if (lease === undefined) return;
    try {
      lease.dispose();
    } catch (error) {
      this._residentBytes = 0;
      throw new AggregateError([error], "Path trace lease disposal failed during dispose().");
    }
    this._residentBytes = 0;
  }

  private transitionToCancelled(): PathTraceBatchOutcome {
    this.releaseLease();
    this._phase = "cancelled";
    return Object.freeze({ status: "cancelled", phase: this._phase,
      generation: this._generation, sampleCount: this._accumulator.sampleCount,
      converged: false });
  }

  private releaseLease(): void {
    const lease = this._lease;
    this._lease = undefined;
    if (lease === undefined) return;
    lease.dispose();
    this._residentBytes = 0;
  }

  private assertAlive(): void {
    if (this._disposed) throw new Error("Path trace session is disposed.");
  }

  private validateSignal(signal: AbortSignal | undefined): void {
    if (signal === undefined) return;
    if (!signal || typeof signal.aborted !== "boolean" || typeof signal.addEventListener !== "function") {
      throw new TypeError("Invalid path trace AbortSignal.");
    }
  }

  private validateIdentity(identity: PathTraceSceneIdentity): void {
    // classifyIdentityInvalidation 对非 undefined 输入做完整校验；这里借一次空判定走同一路径。
    classifyIdentityInvalidation(undefined, identity);
  }
}
