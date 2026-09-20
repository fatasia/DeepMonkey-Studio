import { computeProbeRelocation } from "./probeRelocation.js";
import {
  type ProbeAabb, type ProbeClipmapPlan, type ProbeUpdate, type ProbeVector3,
} from "./probeClipmapPlan.js";
import type { ProbeClipmapResourceUpdate } from "./probeClipmapResources.js";
import type {
  ProbeClipmapPlanPublisher, ProbeClipmapPublicationContext,
} from "./probeClipmapUpdateScheduler.js";

/**
 * 生产消费方：把 relocation 求解器接入 probe 更新调度与 surface cache 之间。
 *
 * 汇合形态（本卡决策）：CPU 求解 → `packIrradianceProbeRecord` 编码 →
 * `ProbeClipmapResources` 写入 `probeStorageBuffer`（storage 采样 ABI v1 的
 * relocation 通道）。纹理捕获路径（rgba16float）没有偏移通道且字节布局受本卡
 * 保护；GPU 纹理采样消费偏移需要专门的 ABI 批次，此处不冒进（理由与后置方案
 * 见任务卡复盘）。
 *
 * 更新触发：updates 列表里 pending/dirty/scroll/initial 四种 reason 全部求解；
 * 偏移变化量（欧氏，cell）小于 `DEEP_GI_RELOCATION_DEBOUNCE_CELLS` 不再触发，
 * dirty 证据链因此收敛。时域安全：偏移变化的探针从当帧 `dynamicUpdateIndices`
 * 中剔除（历史混合权重归零，等价按既有 revision 体系失效），并产出下一帧
 * dirtyBounds 证据，让这些探针按 dirty 类重新捕获。
 */
export const DEEP_GI_RELOCATION_DEBOUNCE_CELLS = 0.05;
export const DEEP_GI_RELOCATION_MAX_OFFSET_CELLS = 0.5;
export const DEEP_GI_RELOCATION_MARGIN_CELLS = 0.2;

/** Per-update relocation records aligned with `plan.updates`; absent entries skip the write. */
export interface ProbeRelocationWrite {
  readonly offsets: readonly (ProbeVector3 | undefined)[];
  readonly recordCount: number;
}
export interface ProbeRelocationFrameEvidence {
  readonly solvedCount: number;
  readonly changedCount: number;
  /** Indices into `plan.updates` whose committed offset changed this frame. */
  readonly changedIndices: readonly number[];
  readonly dirtyBounds: readonly ProbeAabb[];
  readonly write?: ProbeRelocationWrite;
}
export interface ProbeRelocationResolverOptions {
  /** Offset changes smaller than this (cells, Euclidean) do not raise dirty evidence. */
  readonly debounceCells?: number;
  readonly maxOffsetCells?: number;
  readonly marginCells?: number;
}
/** Capture publisher able to accept a relocation record write alongside the plan. */
export interface ProbeRelocationCaptureTarget extends ProbeClipmapPlanPublisher {
  setValidated(plan: ProbeClipmapPlan, deviceEpoch: string, signal?: AbortSignal,
    context?: ProbeClipmapPublicationContext, relocation?: ProbeRelocationWrite):
    Promise<ProbeClipmapResourceUpdate>;
}

interface ProbeRelocationState { committed: ProbeVector3; written: ProbeVector3 }

const ZERO: ProbeVector3 = Object.freeze([0, 0, 0]) as ProbeVector3;

/**
 * Owns committed per-probe relocation offsets with debounce and fail-closed validation.
 * Offsets are keyed by world cell, so clipmap scrolling keeps them stable; entries outside
 * every level window are pruned on each resolve.
 */
export class ProbeRelocationResolver {
  private readonly states = new Map<string, ProbeRelocationState>();
  private readonly options: Required<ProbeRelocationResolverOptions>;
  private last: ProbeRelocationFrameEvidence | undefined;

  constructor(options: ProbeRelocationResolverOptions = {}) {
    this.options = normalizeOptions(options);
  }

  get lastFrame(): ProbeRelocationFrameEvidence | undefined { return this.last; }

  reset(): void { this.states.clear(); this.last = undefined; }

  /**
   * Resolves relocation for every scheduled update against `occluders` (deterministic order
   * required — the solver lets the first deepest obstacle win ties). Throws RangeError on
   * invalid input: unknown/out-of-bounds offsets never reach the record write.
   */
  resolve(plan: ProbeClipmapPlan, occluders: readonly ProbeAabb[]): ProbeRelocationFrameEvidence {
    if (!plan || !Array.isArray(plan.levels) || !Array.isArray(plan.updates)) {
      throw new TypeError("Probe relocation plan is invalid.");
    }
    if (!Array.isArray(occluders)) throw new TypeError("Probe relocation occluders must be an array.");
    // Fail-closed boundary: invalid occluders are rejected outright instead of being
    // silently skipped by the reach prefilter.
    occluders.forEach((box, index) => {
      if (!box || !Array.isArray(box.min) || !Array.isArray(box.max) || box.min.length !== 3
        || box.max.length !== 3 || !box.min.every(Number.isFinite) || !box.max.every(Number.isFinite)
        || box.min.some((value: number, axis: number) => value > box.max[axis]!)) {
        throw new RangeError(`Probe relocation occluder ${index} has invalid bounds.`);
      }
    });
    const dirtyBounds: ProbeAabb[] = [], changedIndices: number[] = [];
    const offsets: (ProbeVector3 | undefined)[] = new Array(plan.updates.length).fill(undefined);
    let recordCount = 0;
    plan.updates.forEach((update, index) => {
      const level = plan.levels[update?.level];
      if (!level || level.level !== update.level) {
        throw new RangeError(`Probe relocation update ${index} references an unknown level.`);
      }
      const state = this.stateFor(update), committed = state.committed;
      const near = occluders.filter(box => withinReach(update, box,
        level.spacing * (this.options.maxOffsetCells + this.options.marginCells)));
      const push = near.length ? computeProbeRelocation({
        cellPosition: addVectors(update.position, committed), spacing: level.spacing,
        obstacles: near, maxOffset: level.spacing * this.options.maxOffsetCells,
        margin: level.spacing * this.options.marginCells,
      }) : ZERO;
      const candidate = clampVector(addVectors(committed, push),
        level.spacing * this.options.maxOffsetCells);
      if (offsetLength(subtractVectors(candidate, committed))
        >= this.options.debounceCells * level.spacing) {
        state.committed = candidate;
        changedIndices.push(index);
        dirtyBounds.push(relocationBounds(update, committed, candidate,
          level.spacing * this.options.marginCells));
      }
      if (!sameVector(state.written, candidate) || !sameVector(candidate, ZERO)) {
        // Nonzero offsets are rewritten on every scheduled update so a failed publication
        // can never leave the storage record stale; zero transitions write exactly once.
        state.written = candidate;
        offsets[index] = candidate;
        recordCount += 1;
      }
    });
    this.prune(plan);
    const write = recordCount ? Object.freeze({ offsets: Object.freeze(offsets), recordCount }) : undefined;
    this.last = Object.freeze({ solvedCount: plan.updates.length, changedCount: changedIndices.length,
      changedIndices: Object.freeze(changedIndices), dirtyBounds: Object.freeze(dirtyBounds),
      ...(write ? { write } : {}) });
    return this.last;
  }

  private stateFor(update: ProbeUpdate): ProbeRelocationState {
    const id = `${update.level}:${update.cell[0]}:${update.cell[1]}:${update.cell[2]}`;
    let state = this.states.get(id);
    if (!state) { state = { committed: ZERO, written: ZERO }; this.states.set(id, state); }
    return state;
  }

  private prune(plan: ProbeClipmapPlan): void {
    for (const id of [...this.states.keys()]) {
      const [levelText, x, y, z] = id.split(":"), level = plan.levels[Number(levelText)];
      const cell = [Number(x), Number(y), Number(z)];
      const resident = level !== undefined
        && cell.every((value, axis) => value >= level.originCell[axis]!
          && value < level.originCell[axis]! + level.gridSize[axis]!);
      if (!resident) this.states.delete(id);
    }
  }
}

/**
 * Publisher decorator that resolves relocation on the scheduled plan right before the
 * capture executor publishes it, strips offset-changed probes from the dynamic class so
 * their temporal history weight is zero this frame, and forwards the record write.
 * Fail-closed: a solver or validation error aborts the publication.
 */
export class ProbeRelocationPublisher implements ProbeClipmapPlanPublisher {
  private occluders: readonly ProbeAabb[] = [];

  constructor(private readonly upstream: ProbeRelocationCaptureTarget,
    private readonly resolver: ProbeRelocationResolver) {}

  /** Per-frame occluder set; must already be in a deterministic order. */
  setFrameOccluders(occluders: readonly ProbeAabb[]): void { this.occluders = occluders; }

  setValidated(plan: ProbeClipmapPlan, deviceEpoch: string, signal?: AbortSignal,
    context?: ProbeClipmapPublicationContext): Promise<ProbeClipmapResourceUpdate> {
    const relocation = this.resolver.resolve(plan, this.occluders);
    const changed = new Set(relocation.changedIndices);
    const filteredContext = context && relocation.changedIndices.length
      && context.dynamicUpdateIndices?.length
      ? Object.freeze({ ...context, dynamicUpdateIndices: Object.freeze(
        context.dynamicUpdateIndices.filter(index => !changed.has(index))) })
      : context;
    return this.upstream.setValidated(plan, deviceEpoch, signal, filteredContext, relocation.write);
  }
}

function normalizeOptions(options: ProbeRelocationResolverOptions): Required<ProbeRelocationResolverOptions> {
  const debounceCells = options.debounceCells ?? DEEP_GI_RELOCATION_DEBOUNCE_CELLS;
  const maxOffsetCells = options.maxOffsetCells ?? DEEP_GI_RELOCATION_MAX_OFFSET_CELLS;
  const marginCells = options.marginCells ?? DEEP_GI_RELOCATION_MARGIN_CELLS;
  if (![debounceCells, maxOffsetCells, marginCells].every(value =>
    Number.isFinite(value) && value >= 0) || maxOffsetCells > 1) {
    throw new RangeError("Probe relocation resolver options are invalid.");
  }
  return { debounceCells, maxOffsetCells, marginCells };
}

/** Only obstacles within the escape reach of the probe cell can move it; the rest are skipped. */
function withinReach(update: ProbeUpdate, box: ProbeAabb, reach: number): boolean {
  return box.min.every((value, axis) => value <= update.position[axis]! + reach)
    && box.max.every((value, axis) => value >= update.position[axis]! - reach);
}

function relocationBounds(update: ProbeUpdate, before: ProbeVector3, after: ProbeVector3,
  margin: number): ProbeAabb {
  const min: number[] = [], max: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    min.push(Math.min(update.position[axis]! + before[axis]!,
      update.position[axis]! + after[axis]!) - margin);
    max.push(Math.max(update.position[axis]! + before[axis]!,
      update.position[axis]! + after[axis]!) + margin);
  }
  return Object.freeze({ min: Object.freeze(min) as unknown as ProbeVector3,
    max: Object.freeze(max) as unknown as ProbeVector3 });
}

function addVectors(left: ProbeVector3, right: ProbeVector3): ProbeVector3 {
  return [left[0]! + right[0]!, left[1]! + right[1]!, left[2]! + right[2]!];
}
function subtractVectors(left: ProbeVector3, right: ProbeVector3): ProbeVector3 {
  return [left[0]! - right[0]!, left[1]! - right[1]!, left[2]! - right[2]!];
}
function offsetLength(offset: ProbeVector3): number {
  return Math.hypot(offset[0]!, offset[1]!, offset[2]!);
}
function clampVector(offset: ProbeVector3, cap: number): ProbeVector3 {
  return offset.map(value => Math.min(cap, Math.max(-cap, value))) as unknown as ProbeVector3;
}
function sameVector(left: ProbeVector3, right: ProbeVector3): boolean {
  return left.every((value, axis) => value === right[axis]);
}
