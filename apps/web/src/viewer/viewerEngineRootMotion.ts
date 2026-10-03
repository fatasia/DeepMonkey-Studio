import * as THREE from "three";
import type { ModelTransform } from "@bim-studio/contracts";
import { collectClipEvents, DEFAULT_MAX_EVENTS_PER_UPDATE, type GltfAnimationClipEventMarker, type GltfAnimationEvent } from "@bim-studio/deep-engine/gltf";
import { BehaviorTraceLog, MonotonicBehaviorClock, summarizeTraceValue, type BehaviorTraceEntry } from "../scripting/behaviorTraceLog";
import type { AnimationContext } from "./viewerEngineAnimation";
import { actionPlayhead } from "./viewerEngineAnimationPlayhead";
import { isIdentityRotation, sampleCycleCorrectedDelta } from "./viewerEngineRootMotionSampling";

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
 * 旋转增量:同一被跟踪节点的 `.quaternion` 轨道经 `viewerEngineRootMotionSampling` 做同口径回绕校正采样,
 * 增量由父链世界旋转共轭到世界空间后左乘实例旋转(绕实例原点),再把节点旋转钳回轨道起点——
 * 等价平移的"抽取+移除",避免实例与骨骼双重旋转;单位增量(无旋转轨道/本帧无转动)不写回,
 * 避免空转与欧拉往返噪声。位置与旋转合并为单次 `setModelTransform`;本模块帧内不分配(全部 scratch)。
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
  /** 启用以来累计应用到实例的世界旋转增量(四元数 x,y,z,w;无旋转为单位)。 */
  readonly appliedRotation: readonly [number, number, number, number];
  /** 最近一次前进应用的世界旋转增量;null 表示尚无非单位旋转被应用。 */
  readonly lastRotation: readonly [number, number, number, number] | null;
}

interface RootTrackResolution {
  readonly node: THREE.Object3D;
  /** 平移轨道插值器;被跟踪节点只有旋转轨道时为 null。 */
  readonly interpolant: THREE.Interpolant | null;
  /** 轨道起点平移(每帧钳回目标)。 */
  readonly rest: [number, number, number];
  /** 同节点 `.quaternion` 轨道插值器;无则 null(不应用旋转)。 */
  readonly rotationInterpolant: THREE.Interpolant | null;
  /** 轨道起点旋转(每帧钳回目标)。 */
  readonly restRotation: [number, number, number, number];
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
  lastTranslation: [number, number, number];
  hasLastTranslation: boolean;
  appliedRotation: THREE.Quaternion;
  lastRotation: THREE.Quaternion;
  hasLastRotation: boolean;
  trackResolved: boolean;
  /** 开关由关到开时的实例 transform 基线(弧度欧拉),供"复位"使用。 */
  baseline: { position: [number, number, number]; rotation: [number, number, number] } | null;
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
const scratchDeltaQuat = new THREE.Quaternion();
const scratchWorldQuat = new THREE.Quaternion();
const scratchWorldDelta = new THREE.Quaternion();
const scratchInstanceQuat = new THREE.Quaternion();
const scratchEuler = new THREE.Euler();
const scratchPosition = new THREE.Vector3();
const scratchScale = new THREE.Vector3();
// 引擎 setModelTransform 只读取并拷贝入参、不留引用,故可复用同一组 payload,保证帧内零分配。
const scratchPositionArray: [number, number, number] = [0, 0, 0];
const scratchRotationArray: [number, number, number] = [0, 0, 0];
const payloadPosition = { position: scratchPositionArray };
const payloadRotation = { rotation: scratchRotationArray };
const payloadBoth = { position: scratchPositionArray, rotation: scratchRotationArray };
const POSITION_SUFFIX = ".position";
const QUATERNION_SUFFIX = ".quaternion";

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
      appliedTranslation: [0, 0, 0], lastTranslation: [0, 0, 0], hasLastTranslation: false, appliedRotation: new THREE.Quaternion(),
      lastRotation: new THREE.Quaternion(), hasLastRotation: false, trackResolved: false, baseline: null, resolutions: new WeakMap() };
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

/** 被追踪 action 的当前有效播放头(与 getAnimationPlayback 同源,见 actionPlayhead)。 */
function effectivePlayhead(context: AnimationContext, id: string, clip: THREE.AnimationClip): number {
  const mixer = context.mixers.get(id);
  return mixer ? actionPlayhead(mixer, clip, loopModeOf(context, id)) : 0;
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
  const enabling = Boolean(options.enabled) && !state.rootMotion.enabled;
  if (enabling) captureBaseline(context, id, state);
  state.rootMotion = { enabled: Boolean(options.enabled), ...(options.rootNode !== undefined ? { rootNode: options.rootNode } : {}) };
  state.resolutions = new WeakMap();
  const active = activeClip(context, id);
  state.unwrapped = active ? effectivePlayhead(context, id, active.clip) : 0;
  return true;
}

/** 开启时记录实例 transform 基线并清零累计量,使"启用以来累计"与复位口径一致。 */
function captureBaseline(context: AnimationContext, id: string, state: ModelConsumptionState): void {
  const current = engineSurface(context).getModelTransform(id);
  state.baseline = current
    ? { position: [current.position.x, current.position.y, current.position.z], rotation: [current.rotation.x, current.rotation.y, current.rotation.z] }
    : null;
  clearApplied(state);
}

function clearApplied(state: ModelConsumptionState): void {
  state.appliedTranslation[0] = 0;
  state.appliedTranslation[1] = 0;
  state.appliedTranslation[2] = 0;
  state.lastTranslation[0] = 0;
  state.lastTranslation[1] = 0;
  state.lastTranslation[2] = 0;
  state.hasLastTranslation = false;
  state.appliedRotation.identity();
  state.lastRotation.identity();
  state.hasLastRotation = false;
}

/**
 * 把实例 transform 复位到最近一次开启根运动时的基线并清零累计量(编辑器预览后的"回到原位")。
 * 无基线(从未开启过)或模型不存在时返回 false;不改变开关状态。
 */
export function resetModelRootMotionPose(context: AnimationContext, id: string): boolean {
  const state = consumptions.get(context)?.states.get(id);
  if (!state?.baseline || !loadedModelOf(context, id)) return false;
  const applied = engineSurface(context).setModelTransform(id, {
    position: [...state.baseline.position], rotation: [...state.baseline.rotation],
  });
  if (applied) clearApplied(state);
  return applied;
}

/** 活动 clip 的根运动能力探测(UI 开关可用性);无需先开启、无需推进帧。 */
export interface ModelRootMotionAvailability {
  readonly available: boolean;
  /** available=false 的原因:no-animation=模型无动画/无 mixer;no-root-track=活动 clip 无平移轨道。 */
  readonly reason?: "no-animation" | "no-root-track";
  /** 活动 clip 含平移轨道(可抽取位移)。 */
  readonly translation: boolean;
  /** 活动 clip 含旋转轨道(提供 rootNode 时可抽取旋转)。 */
  readonly rotation: boolean;
}

export function getModelRootMotionAvailability(context: AnimationContext, id: string): ModelRootMotionAvailability {
  const active = context.mixers.has(id) ? activeClip(context, id) : undefined;
  if (!active) return { available: false, reason: "no-animation", translation: false, rotation: false };
  const translation = active.clip.tracks.some((track) => track.name.endsWith(POSITION_SUFFIX));
  const rotation = active.clip.tracks.some((track) => track.name.endsWith(QUATERNION_SUFFIX));
  return translation
    ? { available: true, translation, rotation }
    : { available: false, reason: "no-root-track", translation, rotation };
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
    lastTranslation: state?.hasLastTranslation ? Object.freeze([...state.lastTranslation] as [number, number, number]) : null,
    appliedRotation: Object.freeze((state?.appliedRotation.toArray() ?? [0, 0, 0, 1]) as [number, number, number, number]),
    lastRotation: state?.hasLastRotation ? Object.freeze(state.lastRotation.toArray() as [number, number, number, number]) : null,
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

function createInterpolant(track: THREE.KeyframeTrack): THREE.Interpolant {
  // three 的 KeyframeTrack 类型声明未含 createInterpolant,运行时存在。
  return (track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant();
}

function resolveRootTrack(state: ModelConsumptionState, root: THREE.Object3D, clip: THREE.AnimationClip): RootTrackResolution | null {
  const cached = state.resolutions.get(clip);
  if (cached !== undefined) return cached;
  const wanted = state.rootMotion.rootNode;
  const matches = (trackName: string, suffix: string): boolean => trackName.endsWith(suffix)
    && (wanted === undefined || trackName === `${wanted}${suffix}` || trackName.endsWith(`${wanted}${suffix}`));
  // 平移轨道优先定位节点;仅有旋转轨道时(转台类)须显式 rootNode 才以旋转轨道定位,
  // 避免缺省把任意骨骼的旋转当作根运动。
  const positionTrack = clip.tracks.find((item) => matches(item.name, POSITION_SUFFIX));
  const anchorTrack = positionTrack ?? (wanted !== undefined ? clip.tracks.find((item) => matches(item.name, QUATERNION_SUFFIX)) : undefined);
  let resolved: RootTrackResolution | null = null;
  if (anchorTrack) {
    const suffix = positionTrack ? POSITION_SUFFIX : QUATERNION_SUFFIX;
    const nodeName = anchorTrack.name.slice(0, anchorTrack.name.length - suffix.length);
    const node = (wanted ?? nodeName).length > 0 ? root.getObjectByName(wanted ?? nodeName) : undefined;
    if (node) {
      const rotationTrack = clip.tracks.find((item) => item.name === `${nodeName}${QUATERNION_SUFFIX}`);
      const interpolant = positionTrack ? createInterpolant(positionTrack) : null;
      const rotationInterpolant = rotationTrack ? createInterpolant(rotationTrack) : null;
      const rest = interpolant?.evaluate(0) as ArrayLike<number> | undefined;
      const restRotation = rotationInterpolant?.evaluate(0) as ArrayLike<number> | undefined;
      resolved = {
        node, interpolant, rotationInterpolant,
        rest: [rest?.[0] ?? 0, rest?.[1] ?? 0, rest?.[2] ?? 0],
        restRotation: [restRotation?.[0] ?? 0, restRotation?.[1] ?? 0, restRotation?.[2] ?? 0, restRotation?.[3] ?? 1],
      };
    }
  }
  state.resolutions.set(clip, resolved);
  return resolved;
}

/**
 * 一次前进的根运动应用:clip 采样平移/旋转增量 → 父链世界变换 → 实例 position 累加、
 * rotation 左乘(经引擎公开 transform 接口,单次调用)→ 被跟踪节点动画平移/旋转钳回轨道起点。
 * 单位旋转增量不写回 rotation;无平移增量(仅旋转轨道)不写回 position。
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
  scratchDelta.set(0, 0, 0);
  scratchDeltaQuat.identity();
  sampleCycleCorrectedDelta(resolution.interpolant, resolution.rotationInterpolant, from, to, clip.duration, scratchDelta, scratchDeltaQuat);
  const engine = engineSurface(context);
  const current = engine.getModelTransform(id);
  if (current) {
    const parent = resolution.node.parent ?? model.object;
    parent.updateWorldMatrix(true, false);
    parent.matrixWorld.decompose(scratchPosition, scratchWorldQuat, scratchScale);
    let hasPosition = false;
    let hasRotation = false;
    if (resolution.interpolant) {
      scratchMatrix.copy(parent.matrixWorld).setPosition(0, 0, 0);
      const world = scratchWorld.copy(scratchDelta).applyMatrix4(scratchMatrix);
      scratchPositionArray[0] = current.position.x + world.x;
      scratchPositionArray[1] = current.position.y + world.y;
      scratchPositionArray[2] = current.position.z + world.z;
      hasPosition = true;
      state.appliedTranslation[0] += world.x;
      state.appliedTranslation[1] += world.y;
      state.appliedTranslation[2] += world.z;
      state.lastTranslation[0] = world.x;
      state.lastTranslation[1] = world.y;
      state.lastTranslation[2] = world.z;
      state.hasLastTranslation = true;
    }
    if (resolution.rotationInterpolant && !isIdentityRotation(scratchDeltaQuat)) {
      // 父空间增量 δ 共轭到世界:W·δ·W⁻¹,再左乘实例旋转(绕实例原点)。
      scratchWorldDelta.copy(scratchWorldQuat).multiply(scratchDeltaQuat).multiply(scratchWorldQuat.invert());
      const order = model.object.rotation.order;
      scratchEuler.set(current.rotation.x, current.rotation.y, current.rotation.z, order);
      scratchInstanceQuat.setFromEuler(scratchEuler).premultiply(scratchWorldDelta).normalize();
      scratchEuler.setFromQuaternion(scratchInstanceQuat, order);
      scratchRotationArray[0] = scratchEuler.x;
      scratchRotationArray[1] = scratchEuler.y;
      scratchRotationArray[2] = scratchEuler.z;
      hasRotation = true;
      state.appliedRotation.premultiply(scratchWorldDelta).normalize();
      state.lastRotation.copy(scratchWorldDelta);
      state.hasLastRotation = true;
    }
    if (hasPosition || hasRotation) engine.setModelTransform(id, hasPosition && hasRotation ? payloadBoth : hasPosition ? payloadPosition : payloadRotation);
  }
  if (resolution.interpolant) resolution.node.position.set(resolution.rest[0], resolution.rest[1], resolution.rest[2]);
  if (resolution.rotationInterpolant) {
    resolution.node.quaternion.set(resolution.restRotation[0], resolution.restRotation[1], resolution.restRotation[2], resolution.restRotation[3]);
  }
}