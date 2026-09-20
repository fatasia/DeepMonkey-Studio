/**
 * 世界分区流送 → chunk residency 需求翻译合同（波次4 流送接线切片）。
 *
 * 把 rayTracing/worldChunkBridge 的单元级需求（planWorldChunkDemand 输出）翻译成
 * webgpu/sceneChunkResidency 的 chunk 期望集表达，并给出相机速度感知的流送节奏
 * （重算节流）合同。全部纯函数、确定性；实际 runtime 接线归后续真机波次。
 *
 * ── 接线点 1：AuthorChunkStream（threeBridge/authorChunkStream.ts，注释已就地标注）──
 * 世界单元 chunk 不进 author catalog 的 residency：author 生命周期跟随 RenderPacket
 * sync（create() 中 `for (const chunk of catalog.chunks) residency.registerChunk(...)`），
 * 世界单元生命周期跟随相机位姿。后续波次建第二个 SceneChunkResidency 实例
 * （WorldChunkStream 持有），帧循环为：
 *   1. decideWorldStreamingReplan：false 则复用上一帧期望集，跳过重算与 update；
 *   2. 通过则 planWorldChunkDemand(input, radius) → translateWorldChunkDemand；
 *   3. diffWorldChunkDesired(上一帧期望键集, 本帧期望集) 得增量（遥测/日志用）；
 *   4. residency.update({ frame, chunks: 全量期望集 })——发全量，不是只发 diff；
 *   5. acceptWorldStreamingPlan 固化节奏状态供下一帧判定。
 * 每个期望键的 PreparedPacket 由单元加载器波次合成后 registerChunk（`world|` 键）。
 *
 * ── 接线点 2：SceneChunkResidency.update（webgpu/sceneChunkResidency.ts）──
 * SceneChunkResidencyFrameInput.chunks 是全量期望集，契约语义为 "Omitted chunks
 * leave the desired set and become eligible for eviction"：滚出流送半径的单元从
 * 下一帧 chunks 数组省略即成为逐出候选，禁止为其调用 unregisterChunk（那会撕掉
 * 驻留帧的租约）；unregisterChunk 仅用于域销毁/单元永久退役。
 * mode 映射：visible 走投影路径（planFrame 的 project: true），prefetch 走
 * required=false 上传。`world|` 键前缀保证与 author 场景键空间永不冲突
 * （parseWorldChunkKey 对 author 键返回 undefined，本模块据此拒绝外来键）。
 */

import { worldCellOf, WORLD_CELL_SIZE, type WorldCellId, type WorldStreamingInput } from "../rayTracing/worldPartition.js";
import { parseWorldChunkKey, type WorldChunkDemand } from "../rayTracing/worldChunkBridge.js";
import type { SceneChunkResidencyMode } from "../webgpu/sceneChunkResidency.js";

/** 单个世界单元 chunk 的流送期望：结构与 SceneChunkResidencyDemand 的键/模式对齐。 */
export interface WorldStreamingChunkDemand {
  /** `world|<cx>|<cz>|lodN`（worldChunkKey 生成，parseWorldChunkKey 可解析）。 */
  readonly key: string;
  readonly cell: WorldCellId;
  readonly lod: number;
  /** 0..1，越小越紧迫（worldStreamingPriority 秩次归一，见 worldChunkBridge）。 */
  readonly urgency: number;
  readonly center: readonly [number, number, number];
  /** 直接映射 SceneChunkResidencyDemand.mode。 */
  readonly mode: SceneChunkResidencyMode;
}

export interface WorldStreamingTranslationOptions {
  /** urgency <= 该阈值的 chunk 进入 visible（投影）路径；默认 0 = 仅相机单元。 */
  readonly visibleUrgency?: number;
}

/** planWorldChunkDemand 输出 → residency 期望集表达（保序；urgency 升序）。 */
export function translateWorldChunkDemand(demands: readonly WorldChunkDemand[],
  options: WorldStreamingTranslationOptions = {}): readonly WorldStreamingChunkDemand[] {
  const visibleUrgency = options.visibleUrgency ?? 0;
  if (!Number.isFinite(visibleUrgency) || visibleUrgency < 0 || visibleUrgency > 1) {
    throw new RangeError("visibleUrgency must be a finite number in [0,1].");
  }
  assertUniqueWorldDemands(demands);
  return demands.map(demand => Object.freeze({
    key: demand.key, cell: demand.cell, lod: demand.lod, urgency: demand.urgency,
    center: demand.center,
    mode: demand.urgency <= visibleUrgency ? "visible" as const : "prefetch" as const,
  }));
}

/** 期望集键集（供 diffWorldChunkDesired 的 previous 与节奏状态存储）。 */
export function worldStreamingDesiredKeys(demands: readonly WorldStreamingChunkDemand[]): ReadonlySet<string> {
  return new Set(demands.map(demand => demand.key));
}

export interface WorldChunkDesiredDiff {
  /** 新进入期望集的 chunk，urgency 升序、key 字典序兜底。 */
  readonly added: readonly WorldStreamingChunkDemand[];
  /** 离开期望集的键 = residency 逐出候选（下一帧省略即可，key 字典序）。 */
  readonly removed: readonly string[];
  readonly unchangedCount: number;
}

/**
 * 期望集增量：previous 是上一帧的全量键集，next 是本帧全量期望集。
 * removed 键正是"滚出半径即逐出候选"的表达——residency 语义下省略即逐出。
 */
export function diffWorldChunkDesired(previous: ReadonlySet<string>,
  next: readonly WorldStreamingChunkDemand[]): WorldChunkDesiredDiff {
  if (!(previous instanceof Set)) throw new TypeError("Previous desired keys must be a ReadonlySet<string>.");
  assertUniqueWorldDemands(next);
  const added = next.filter(demand => !previous.has(demand.key))
    .sort((a, b) => a.urgency - b.urgency || (a.key < b.key ? -1 : 1));
  const removed = [...previous].filter(key => !next.some(demand => demand.key === key)).sort();
  return Object.freeze({ added: Object.freeze(added), removed: Object.freeze(removed),
    unchangedCount: next.length - added.length });
}

/** 节奏状态：上次采纳计划时的相机位姿单元与帧号（acceptWorldStreamingPlan 构造）。 */
export interface WorldStreamingPacingState {
  readonly cell: WorldCellId;
  readonly cameraX: number;
  readonly cameraZ: number;
  readonly lastReplanFrame: number;
}

export interface WorldStreamingPacingOptions {
  /** 同一单元内位移低于该阈值（米）不重算；默认 WORLD_CELL_SIZE / 8 = 64。 */
  readonly minDisplacement?: number;
  /** 同一单元内位移触发的重算冷却帧数（重算预算上限）；默认 15。 */
  readonly replanCooldownFrames?: number;
}

export type WorldStreamingPacingReason = "first-plan" | "cell-changed" | "displacement-threshold"
  | "throttled-cooldown" | "within-threshold";

export interface WorldStreamingPacingDecision {
  readonly replan: boolean;
  readonly reason: WorldStreamingPacingReason;
}

const DEFAULT_MIN_DISPLACEMENT = WORLD_CELL_SIZE / 8;
const DEFAULT_REPLAN_COOLDOWN_FRAMES = 15;

/**
 * 相机速度感知重算判定：单元变更必然重算（跨越单元即天然的重算预算，冷却不拦截，
 * 否则逐帧穿越单元时会被永久饿死）；同单元内位移 < 阈值不重算（计划只依赖相机位姿，
 * 结果必然相同）；达到阈值还须过冷却帧预算。forward/speed 不参与判定，其校验由
 * planWorldChunkDemand 在真正重算时执行。帧号必须单调不减（与 residency 一致的
 * fail-closed 立场）。
 */
export function decideWorldStreamingReplan(state: WorldStreamingPacingState | undefined,
  input: WorldStreamingInput, frame: number, options: WorldStreamingPacingOptions = {}): WorldStreamingPacingDecision {
  const minDisplacement = options.minDisplacement ?? DEFAULT_MIN_DISPLACEMENT;
  const cooldown = options.replanCooldownFrames ?? DEFAULT_REPLAN_COOLDOWN_FRAMES;
  if (!Number.isFinite(minDisplacement) || minDisplacement <= 0) {
    throw new RangeError("minDisplacement must be a positive finite number of metres.");
  }
  if (!Number.isSafeInteger(cooldown) || cooldown < 1) {
    throw new RangeError("replanCooldownFrames must be a positive integer.");
  }
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("frame must be a non-negative safe integer.");
  if (state !== undefined) {
    validatePacingState(state);
    if (frame < state.lastReplanFrame) {
      throw new RangeError(`Streaming frame regressed from ${state.lastReplanFrame} to ${frame}.`);
    }
  }
  // worldCellOf 对非有限相机坐标抛 RangeError（fail-closed，先于任何分支）。
  const cell = worldCellOf(input.cameraX, input.cameraZ);
  if (state === undefined) return { replan: true, reason: "first-plan" };
  if (cell.cx !== state.cell.cx || cell.cz !== state.cell.cz) return { replan: true, reason: "cell-changed" };
  const displacement = Math.hypot(input.cameraX - state.cameraX, input.cameraZ - state.cameraZ);
  if (displacement < minDisplacement) return { replan: false, reason: "within-threshold" };
  if (frame - state.lastReplanFrame < cooldown) return { replan: false, reason: "throttled-cooldown" };
  return { replan: true, reason: "displacement-threshold" };
}

/** 采纳一次重算后的新节奏状态（纯构造；调用方持有并在下一帧回传）。 */
export function acceptWorldStreamingPlan(input: WorldStreamingInput, frame: number): WorldStreamingPacingState {
  if (!Number.isSafeInteger(frame) || frame < 0) throw new RangeError("frame must be a non-negative safe integer.");
  const cell = worldCellOf(input.cameraX, input.cameraZ);
  return Object.freeze({ cell: Object.freeze({ ...cell }),
    cameraX: input.cameraX, cameraZ: input.cameraZ, lastReplanFrame: frame });
}

function assertUniqueWorldDemands(demands: readonly WorldChunkDemand[]): void {
  const seen = new Set<string>();
  for (const demand of demands) {
    if (!demand || typeof demand !== "object" || Array.isArray(demand)) {
      throw new TypeError("World chunk demand entry must be an object.");
    }
    if (typeof demand.key !== "string" || !parseWorldChunkKey(demand.key)) {
      throw new TypeError(`World chunk demand key is not a world| key: ${String(demand.key)}.`);
    }
    if (!Number.isFinite(demand.urgency) || demand.urgency < 0 || demand.urgency > 1
      || !Number.isSafeInteger(demand.lod) || demand.lod < 0
      || !Number.isSafeInteger(demand.cell?.cx) || !Number.isSafeInteger(demand.cell?.cz)
      || !Array.isArray(demand.center) || demand.center.length !== 3
      || !demand.center.every(value => Number.isFinite(value))) {
      throw new TypeError(`World chunk demand entry is invalid: ${demand.key}.`);
    }
    if (seen.has(demand.key)) throw new TypeError(`Duplicate world chunk demand key: ${demand.key}.`);
    seen.add(demand.key);
  }
}

function validatePacingState(state: WorldStreamingPacingState): void {
  if (!state || typeof state !== "object" || Array.isArray(state)
    || !Number.isSafeInteger(state.cell?.cx) || !Number.isSafeInteger(state.cell?.cz)
    || !Number.isFinite(state.cameraX) || !Number.isFinite(state.cameraZ)
    || !Number.isSafeInteger(state.lastReplanFrame) || state.lastReplanFrame < 0) {
    throw new TypeError("World streaming pacing state is invalid.");
  }
}
