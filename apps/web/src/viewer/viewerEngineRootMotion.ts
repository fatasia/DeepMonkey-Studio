import * as THREE from "three";
import type { ModelTransform } from "@bim-studio/contracts";
import { collectClipEvents, DEFAULT_MAX_EVENTS_PER_UPDATE, type GltfAnimationClipEventMarker, type GltfAnimationEvent } from "@bim-studio/deep-engine/gltf";
import { BehaviorTraceLog, MonotonicBehaviorClock, summarizeTraceValue, type BehaviorTraceEntry } from "../scripting/behaviorTraceLog";
import type { AnimationContext } from "./viewerEngineAnimation";

/**
 * T14 编辑器消费切片:模型动画的根运动应用与 clip 事件动作消费。
 *
 * 贯通方式(增量消费,不重写 Three mixer 主链):
 * - Three mixer 仍负责姿态采样;本模块在每帧 mixer.update 之后,对活动 clip 的平移轨道
 *   做**回绕校正**的未包裹时间采样(复用 T14 合同的未包裹时间基与 `collectClipEvents`
 *   的 `(from,to]` 语义),得到被跟踪根节点在本次前进内的真实位移,经引擎公开接口
 *   (`getModelTransform`/`setModelTransform`)应用到场景实例 transform,并把被跟踪节点
 *   的动画平移钳回轨道起点(等价游戏引擎的"根运动抽取+移除",避免容器与骨骼双重位移)。
 *   回绕处按"段采样"求和(段端点取整圈末姿态),因此循环走路 clip 产生**持续前向**位移,
 *   而不是 T14 合同层如实记录的回绕不连续量——这是编辑器应用层策略,合同层未改动。
 * - 事件:按 `0 <= time < duration` fail-closed 预注册,推进命中 `(from,to]` 即触发动作。
 *   动作集三种:visible(可见性切换)/ opacity(透明度切换)/ notify(宿主自定义,如告警声)。
 * - 审计:复用 T31 `BehaviorTraceLog`(scripting 只读导入,不修改其文件);`graphId`
 *   映射为 `animation:<modelId>`,eventNodeId 即 eventId。取舍:不另建第二套环形日志。
 * - 开关:`setModelRootMotion` 默认关;未启用且未注册事件动作时本模块每帧零行为
 *   (不改 mixer、不写 transform、不产生日志、不推进时钟)。
 *
 * 旋转增量本切片只记录不应用(实例侧应用需同步抽除根骨骼旋转,留待下一切片);
 * 平移世界换算假设被跟踪节点与实例之间的父链在播放期间静态(标准角色层级成立)。
 */

/** 到达关键帧时触发的场景动作。targetId 缺省作用于动画所属模型自身。 */
export type ModelAnimationEventAction =
  | { readonly kind: "visible"; readonly targetId?: string; readonly value: boolean }
  | { readonly kind: "opacity"; readonly targetId?: string; readonly value: number }
  | { readonly kind: "notify"; readonly name: string };

/** 预注册的事件动作定义;time 为 clip 内秒数(未包裹时间基)。 */
export interface ModelAnimationEventActionDef {
  readonly clipId: string;
  readonly eventId: string;
  readonly time: number;
  readonly action: ModelAnimationEventAction;
}

/** notify 动作的宿主出口(编辑器/Play 模式订阅,如播放告警声)。 */
export type ModelAnimationEventActionSink = (action: {
  readonly modelId: string;
  readonly clipId: string;
  readonly eventId: string;
  readonly action: ModelAnimationEventAction;
  readonly unwrappedTime: number;
  readonly loop: number;
}) => void;

/** 根运动开关选项;rootNode 缺省取活动 clip 第一条平移轨道的目标节点。 */
export interface ModelRootMotionOptions {
  readonly enabled: boolean;
  readonly rootNode?: string;
}

/** 根运动消费状态快照(公开只读面)。 */
export interface ModelRootMotionSnapshot {
  readonly enabled: boolean;
  readonly rootNode?: string;
  /** false 表示活动 clip 无可解析的平移轨道(无位移可应用,事件不受影响)。 */
  readonly trackResolved: boolean;
  /** 未包裹镜像播放头(秒),与 mixer 动作播放头锁步。 */
  readonly unwrappedTime: number;
  /** 启用以来累计应用到实例的世界位移。 */
  readonly appliedTranslation: readonly [number, number, number];
  /** 最近一次前进应用的世界位移;null 表示尚无前进。 */
  readonly lastTranslation: readonly [number, number, number] | null;
}

interface RootTrackResolution {
  readonly node: THREE.Object3D;
  readonly interpolant: THREE.Interpolant;
  /** 轨道起点平移(每帧钳回目标)。 */
  readonly rest: [number, number, number];
}

/** 编辑器已加载模型的最小形状(引擎 LoadedSceneModel 的消费子集)。 */
interface LoadedModelLike {
  readonly object: THREE.Object3D;
  visible?: boolean;
  opacity?: number;
}

interface ModelConsumptionState {
  rootMotion: { enabled: boolean; rootNode?: string };
  eventActions: readonly ModelAnimationEventActionDef[];
  unwrapped: number;
  appliedTranslation: [number, number, number];
  lastTranslation: [number, number, number] | null;
  trackResolved: boolean;
  resolutions: WeakMap<THREE.AnimationClip, RootTrackResolution | null>;
}

interface ContextConsumption {
  readonly states: Map<string, ModelConsumptionState>;
  readonly trace: BehaviorTraceLog;
  readonly clock: MonotonicBehaviorClock;
  sink: ModelAnimationEventActionSink | null;
}

/** 引擎公开接口面(由 ViewerEngine 继承链提供;测试注入等价桩)。 */
interface EngineSurface {
  getModelTransform(id: string): ModelTransform | undefined;
  setModelTransform(id: string, transform: {
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
  }): boolean;
  setVisible(id: string, visible: boolean): void;
  setOpacity(id: string, opacity: number): void;
}

/** 消费状态挂在引擎实例(AnimationContext)上;引擎类字段不可扩,WeakMap 即状态槽。 */
const consumptions = new WeakMap<AnimationContext, ContextConsumption>();
const scratchMatrix = new THREE.Matrix4();
const scratchWorld = new THREE.Vector3();
const scratchDelta = new THREE.Vector3();
const POSITION_SUFFIX = ".position";

function consumptionOf(context: AnimationContext): ContextConsumption {
  let consumption = consumptions.get(context);
  if (!consumption) {
    const clock = new MonotonicBehaviorClock();
    consumption = { states: new Map(), trace: new BehaviorTraceLog({ clock }), clock, sink: null };
    consumptions.set(context, consumption);
  }
  return consumption;
}

function stateOf(consumption: ContextConsumption, id: string): ModelConsumptionState {
  let state = consumption.states.get(id);
  if (!state) {
    state = { rootMotion: { enabled: false }, eventActions: [], unwrapped: 0,
      appliedTranslation: [0, 0, 0], lastTranslation: null, trackResolved: false, resolutions: new WeakMap() };
    consumption.states.set(id, state);
  }
  return state;
}

function engineSurface(context: AnimationContext): EngineSurface {
  return context as unknown as EngineSurface;
}

function loadedModelOf(context: AnimationContext, id: string): LoadedModelLike | undefined {
  return context.models.get(id) as LoadedModelLike | undefined;
}

function activeClip(context: AnimationContext, id: string): { clip: THREE.AnimationClip; key: string } | undefined {
  const clips = context.animationClips.get(id) ?? [];
  if (clips.length === 0) return undefined;
  const selected = context.animationClipSelection.get(id);
  const clip = selected ? clips.find((item) => (item.name || item.uuid) === selected) : clips[0];
  return clip ? { clip, key: clip.name || clip.uuid } : undefined;
}

function loopModeOf(context: AnimationContext, id: string): "once" | "loop" {
  return context.modelAnimationPlaybackStates.get(id)?.loopMode === "once" ? "once" : "loop";
}

/** mixer.time 折算的当前有效播放头(loop 取模 / once 钳制),与 getAnimationPlayback 同式。 */
function effectivePlayhead(context: AnimationContext, id: string, clip: THREE.AnimationClip): number {
  const mixer = context.mixers.get(id);
  if (!mixer || !(clip.duration > 0)) return 0;
  const raw = Math.max(0, mixer.time);
  return loopModeOf(context, id) === "loop" ? raw % clip.duration : Math.min(raw, clip.duration);
}

/**
 * 启用/配置模型根运动。模型或 mixer 不存在、rootNode 在模型子树内找不到时拒绝并保持原状。
 * 配置变更时把镜像播放头重置为当前有效播放头——不因开启开关产生跨越性位移。
 */
export function setModelRootMotion(context: AnimationContext, id: string, options: ModelRootMotionOptions): boolean {
  const model = loadedModelOf(context, id);
  if (!context.mixers.has(id) || !model) return false;
  const rootNodeOk = options.rootNode === undefined
    || (typeof options.rootNode === "string" && options.rootNode.length > 0 && Boolean(model.object.getObjectByName(options.rootNode)));
  if (!rootNodeOk) return false;
  const state = stateOf(consumptionOf(context), id);
  state.rootMotion = { enabled: Boolean(options.enabled), ...(options.rootNode !== undefined ? { rootNode: options.rootNode } : {}) };
  state.resolutions = new WeakMap();
  const active = activeClip(context, id);
  state.unwrapped = active ? effectivePlayhead(context, id, active.clip) : 0;
  return true;
}

/** 只读快照;未配置过时返回缺省关闭状态。 */
export function getModelRootMotionState(context: AnimationContext, id: string): ModelRootMotionSnapshot {
  const state = consumptions.get(context)?.states.get(id);
  return Object.freeze({
    enabled: state?.rootMotion.enabled ?? false,
    ...(state?.rootMotion.rootNode !== undefined ? { rootNode: state.rootMotion.rootNode } : {}),
    trackResolved: state?.trackResolved ?? false,
    unwrappedTime: state?.unwrapped ?? 0,
    appliedTranslation: Object.freeze([...(state?.appliedTranslation ?? [0, 0, 0])] as [number, number, number]),
    lastTranslation: state?.lastTranslation ? Object.freeze([...state.lastTranslation] as [number, number, number]) : null,
  });
}

function isValidAction(action: unknown): action is ModelAnimationEventAction {
  if (!action || typeof action !== "object") return false;
  const candidate = action as ModelAnimationEventAction;
  const targetOk = candidate.kind === "notify" || (candidate.targetId === undefined
    || (typeof candidate.targetId === "string" && candidate.targetId.length > 0));
  if (candidate.kind === "visible") return typeof candidate.value === "boolean" && targetOk;
  if (candidate.kind === "opacity") {
    return typeof candidate.value === "number" && Number.isFinite(candidate.value) && candidate.value >= 0 && candidate.value <= 1 && targetOk;
  }
  if (candidate.kind === "notify") return typeof candidate.name === "string" && candidate.name.length > 0;
  return false;
}

/**
 * 整组替换模型的事件动作定义(空数组即清除)。fail-closed:任一条非法(未知 clip、
 * time 越界、(clipId,eventId) 重复、动作形状非法)则整体拒绝并保留原注册。
 */
export function setModelAnimationEventActions(context: AnimationContext, id: string, actions: readonly ModelAnimationEventActionDef[]): boolean {
  if (!context.mixers.has(id) || !Array.isArray(actions)) return false;
  const clips = context.animationClips.get(id) ?? [];
  const durations = new Map(clips.map((clip) => [clip.name || clip.uuid, clip.duration]));
  const seen = new Set<string>();
  for (const def of actions) {
    if (!def || typeof def !== "object") return false;
    if (typeof def.clipId !== "string" || def.clipId.length === 0 || typeof def.eventId !== "string" || def.eventId.length === 0) return false;
    const key = `${def.clipId}\u0000${def.eventId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const duration = durations.get(def.clipId);
    if (duration === undefined || !(duration > 0)) return false;
    if (!Number.isFinite(def.time) || def.time < 0 || def.time >= duration) return false;
    if (!isValidAction(def.action)) return false;
  }
  stateOf(consumptionOf(context), id).eventActions = Object.freeze([...actions]);
  return true;
}

/** 注册/清除 notify 动作的宿主出口;null 即清除。 */
export function setModelAnimationEventSink(context: AnimationContext, sink: ModelAnimationEventActionSink | null): void {
  consumptionOf(context).sink = sink;
}

/** 只读轨迹快照(T31 BehaviorTraceLog 深拷贝,旧→新)。 */
export function snapshotModelAnimationEventTrace(context: AnimationContext): BehaviorTraceEntry[] {
  return consumptions.get(context)?.trace.snapshot() ?? [];
}

/**
 * play/stop/动作重启后镜像与事件水位归零;seek 传显式目标时间(once 钳到 clip 末,
 * loop 按未包裹时间保留)。瞬移区间不发射事件、不入账根运动——与 T14 合同 seek 语义一致。
 */
export function rearmModelAnimationConsumption(context: AnimationContext, id: string, seekTime?: number): void {
  const state = consumptions.get(context)?.states.get(id);
  if (!state) return;
  if (seekTime === undefined) {
    state.unwrapped = 0;
    return;
  }
  if (!Number.isFinite(seekTime) || seekTime < 0) return;
  const duration = activeClip(context, id)?.clip.duration ?? 0;
  state.unwrapped = loopModeOf(context, id) === "once" && duration > 0 ? Math.min(seekTime, duration) : seekTime;
}

/**
 * 帧循环入口:对每个播放中的模型结算事件与根运动。必须在 `mixer.update` 之后、
 * `updateCompletedModelAnimations` 之前调用(once 完成帧要吃到最后一段)。
 */
export function updateModelAnimationConsumption(context: AnimationContext, delta: number): void {
  if (!(delta > 0) || !Number.isFinite(delta)) return;
  const consumption = consumptions.get(context);
  if (!consumption || consumption.states.size === 0) return;
  // 时钟先于结算推进:轨迹 atMs 反映发射帧的帧末时刻(同帧序列同值,确定性口径)。
  // 时钟值本身不可观测,只有轨迹条目是行为——空闲帧推进时钟不构成副作用。
  consumption.clock.advance(delta * 1000);
  for (const id of context.animationEnabledIds) {
    const state = consumption.states.get(id);
    if (!state) continue;
    if (!context.mixers.has(id)) continue;
    const hasEvents = state.eventActions.length > 0;
    const rootMotion = state.rootMotion.enabled;
    if (!hasEvents && !rootMotion) continue;
    const active = activeClip(context, id);
    if (!active || !(active.clip.duration > 0)) continue;
    const from = state.unwrapped;
    let to = from + delta;
    if (loopModeOf(context, id) === "once") to = Math.min(to, active.clip.duration);
    if (!(to > from)) continue;
    if (hasEvents) {
      const markers: readonly GltfAnimationClipEventMarker[] = state.eventActions;
      const batch = collectClipEvents(markers, active.key, active.clip.duration, from, to, DEFAULT_MAX_EVENTS_PER_UPDATE);
      for (const event of batch.events) dispatchConsumedEvent(context, id, state, event);
    }
    if (rootMotion) applyRootMotionAdvance(context, id, active.clip, state, from, to);
    state.unwrapped = to;
  }
}

function dispatchConsumedEvent(context: AnimationContext, modelId: string, state: ModelConsumptionState, event: GltfAnimationEvent): void {
  const def = state.eventActions.find((item) => item.clipId === event.clipId && item.eventId === event.eventId);
  if (!def) return;
  const action = def.action;
  if (action.kind === "notify") {
    if (!consumptionOf(context).sink) { appendTrace(context, modelId, event, def, "skipped", "no-sink"); return; }
    consumptionOf(context).sink!(
      { modelId, clipId: event.clipId, eventId: event.eventId, action, unwrappedTime: event.unwrappedTime, loop: event.loop });
    appendTrace(context, modelId, event, def, "applied");
    return;
  }
  const target = action.targetId ?? modelId;
  const targetModel = loadedModelOf(context, target);
  if (!targetModel) { appendTrace(context, modelId, event, def, "rejected", "unknown-target"); return; }
  const before = action.kind === "visible" ? summarizeTraceValue(targetModel.visible) : summarizeTraceValue(targetModel.opacity);
  if (action.kind === "visible") engineSurface(context).setVisible(target, action.value);
  else engineSurface(context).setOpacity(target, action.value);
  appendTrace(context, modelId, event, def, "applied", undefined, before, summarizeTraceValue(action.value));
}

function appendTrace(context: AnimationContext, modelId: string, event: GltfAnimationEvent, def: ModelAnimationEventActionDef,
  outcome: BehaviorTraceEntry["outcome"], reason?: string, before?: string, after?: string): void {
  const consumption = consumptionOf(context);
  consumption.trace.append({
    atMs: consumption.trace.nowMs(),
    graphId: `animation:${modelId}`,
    eventNodeId: event.eventId,
    action: def.action.kind,
    target: def.action.kind === "notify" ? def.action.name : (def.action.targetId ?? modelId),
    ...(before !== undefined ? { before } : {}),
    ...(after !== undefined ? { after } : {}),
    outcome,
    ...(reason !== undefined ? { reason } : {}),
  });
}

function resolveRootTrack(state: ModelConsumptionState, root: THREE.Object3D, clip: THREE.AnimationClip): RootTrackResolution | null {
  const cached = state.resolutions.get(clip);
  if (cached !== undefined) return cached;
  const wanted = state.rootMotion.rootNode;
  const track = clip.tracks.find((item) => item.name.endsWith(POSITION_SUFFIX)
    && (wanted === undefined || item.name === `${wanted}${POSITION_SUFFIX}` || item.name.endsWith(`${wanted}${POSITION_SUFFIX}`)));
  let resolved: RootTrackResolution | null = null;
  if (track) {
    const nodeName = track.name.slice(0, track.name.length - POSITION_SUFFIX.length);
    const node = (wanted ?? nodeName).length > 0 ? root.getObjectByName(wanted ?? nodeName) : undefined;
    if (node) {
      // three 的 KeyframeTrack 类型声明未含 createInterpolant,运行时存在。
      const interpolant = (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
      const rest = interpolant.evaluate(0) as ArrayLike<number>;
      resolved = { node, interpolant, rest: [rest[0] ?? 0, rest[1] ?? 0, rest[2] ?? 0] };
    }
  }
  state.resolutions.set(clip, resolved);
  return resolved;
}

/** 回绕校正的未包裹时间平移采样:逐段求和,段端点取该段包裹末姿态。 */
function cycleCorrectedTranslation(interpolant: THREE.Interpolant, from: number, to: number, duration: number): THREE.Vector3 {
  scratchDelta.set(0, 0, 0);
  const wrapEpsilon = duration * 1e-9;
  let cursor = from;
  while (cursor < to - wrapEpsilon) {
    const segEnd = Math.min(to, (Math.floor(cursor / duration) + 1) * duration);
    const startWrapped = cursor % duration;
    const rawEnd = segEnd % duration;
    // 段端点落在回绕边界时取"整圈末姿态"(evaluate(duration) 钳到末关键帧),而非下一圈起点。
    const endWrapped = rawEnd <= wrapEpsilon || duration - rawEnd <= wrapEpsilon ? duration : rawEnd;
    const start = interpolant.evaluate(startWrapped) as ArrayLike<number>;
    // evaluate 复用同一 resultBuffer:两次调用别名同一数组,必须在第二次求值前拷贝首样本。
    const startX = start[0] ?? 0;
    const startY = start[1] ?? 0;
    const startZ = start[2] ?? 0;
    const end = interpolant.evaluate(endWrapped) as ArrayLike<number>;
    scratchDelta.x += (end[0] ?? 0) - startX;
    scratchDelta.y += (end[1] ?? 0) - startY;
    scratchDelta.z += (end[2] ?? 0) - startZ;
    cursor = segEnd;
  }
  return scratchDelta;
}

/**
 * 一次前进的根运动应用:clip 采样位移 → 父链世界线性变换 → 实例 position 累加
 * (经引擎公开 transform 接口)→ 被跟踪节点动画平移钳回轨道起点。
 */
function applyRootMotionAdvance(context: AnimationContext, id: string, clip: THREE.AnimationClip, state: ModelConsumptionState,
  from: number, to: number): void {
  const model = loadedModelOf(context, id);
  if (!model) return;
  const resolution = resolveRootTrack(state, model.object, clip);
  if (!resolution) {
    state.trackResolved = false;
    return;
  }
  state.trackResolved = true;
  const local = cycleCorrectedTranslation(resolution.interpolant, from, to, clip.duration);
  const parent = resolution.node.parent ?? model.object;
  parent.updateWorldMatrix(true, false);
  scratchMatrix.copy(parent.matrixWorld).setPosition(0, 0, 0);
  const world = scratchWorld.copy(local).applyMatrix4(scratchMatrix);
  const current = engineSurface(context).getModelTransform(id);
  if (current) {
    engineSurface(context).setModelTransform(id, {
      position: [current.position.x + world.x, current.position.y + world.y, current.position.z + world.z],
    });
    state.appliedTranslation[0] += world.x;
    state.appliedTranslation[1] += world.y;
    state.appliedTranslation[2] += world.z;
    state.lastTranslation = [world.x, world.y, world.z];
  }
  resolution.node.position.set(resolution.rest[0], resolution.rest[1], resolution.rest[2]);
}
