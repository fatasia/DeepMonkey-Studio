import type {
  SceneAnimationState,
  SceneAssetBindingState,
  SceneSelectionSetState,
  SceneRootLayerRef,
} from "@bim-studio/contracts";
import type { SimulationEntityState } from "@bim-studio/contracts";

/**
 * H-C7-P3 第三批 宿主引用清理 port:object.delete-primitive 的作者引用消费接缝。
 *
 * 浏览器端删除拒绝清单(primitiveDeletionReferenceError)枚举五域引用:selectionSets /
 * rootLayerOrder / assetBindings / 动画作者引用(轨道+状态机)/ simulationEntities。
 * 消费化进度:
 * - 第一子集(第三批)= selectionSets + rootLayerOrder 的**清理**(摘引用保留集合本身);
 * - 第二子集(第五批)= assetBindings 的**拒绝路** + 宿主显式解绑清理路(删除流对绑定
 *   引用只有拒绝一路,摘除须宿主显式决定:removeAssetBindingsFor);
 * - **第三子集(本批)= 动画域 + 仿真域消费化**:删除 port 图元时,动画时间线对象轨道
 *   (animation.models)、状态机引用该对象的状态(连同其转移与 clip 事件标记)、仿真
 *   实体(flowNode/path 的 targetModelId、flowLink 的 from/to、collisionPair 的 a/b)
 *   一并**摘除引用**——序列化容器不再携带悬空 ID。消费前先做全量检查:任何不可消费
 *   的引用(状态机初始/活动状态锚在被删对象的状态上、未知形状的仿真实体)在**任何
 *   变更之前**整批拒绝(fail-closed,不部分清理)。
 *
 * driver 合同:applyDelete 先 snapshotReferences 捕获 before 态,再 pruneDeletedObjectReferences
 * (先检查后清理);事务失败/回滚由 driver 经 restoreReferences 恢复。未注入本 port 时
 * 删除维持既有语义。
 */

/** 宿主作者引用容器(与 SceneSnapshot 对应字段的形状一致,driver 只经 port 触达)。 */
export interface SceneReferenceContainers {
  selectionSets: SceneSelectionSetState[];
  rootLayerOrder: SceneRootLayerRef[];
  assetBindings?: SceneAssetBindingState[];
  animation?: SceneAnimationState;
  simulationEntities?: SimulationEntityState[];
}

export interface SceneReferencePruneResult {
  /** 失去该引用的选择集 id(集合本身保留,只摘除 objectId)。 */
  readonly selectionSetsPruned: readonly string[];
  /** 从 rootLayerOrder 移除的根行引用数。 */
  readonly rootLayerOrderRemoved: number;
  /** 动画域消费:摘除的时间线对象关键帧数。 */
  readonly animationFramesRemoved: number;
  /** 动画域消费:被消费的状态机状态 id(连同触及它们的转移)。 */
  readonly animationStatesConsumed: readonly string[];
  /** 动画域消费:被摘除的转移数。 */
  readonly animationTransitionsRemoved: number;
  /** 动画域消费:被摘除的 clip 事件标记数(clip 属于被删对象)。 */
  readonly animationEventsRemoved: number;
  /** 仿真域消费:被移除的仿真实体 id。 */
  readonly simulationEntitiesRemoved: readonly string[];
}

/** 逆算子捕获的引用容器 before 态(深拷贝)。 */
export interface SceneReferenceSnapshot {
  readonly containers: SceneReferenceContainers;
}

/**
 * 引用解析失败的显式错误码(fail-closed,不静默丢弃)。加载/重开链的消费端据此
 * 精确报告是哪一类引用无法解析为运行时资源。
 */
export type SceneReferenceErrorCode =
  /** 动画时间线/状态机状态引用的对象 id 在运行时资源(图元注册表)中不存在。 */
  | "ANIMATION_REF_DANGLING"
  /** clip 事件标记引用的 clipId 不属于容器内任何已授权 clip。 */
  | "ANIMATION_CLIP_REF_DANGLING"
  /** 状态机内部引用(initialStateId/activeStateId/转移端点)悬空。 */
  | "STATE_MACHINE_STATE_REF_DANGLING"
  /** 删除将消费状态机的初始/活动状态锚——须宿主先迁移锚再删除。 */
  | "STATE_MACHINE_ANCHOR_CONSUMED"
  /** 仿真实体引用的对象 id 在运行时资源中不存在。 */
  | "SIMULATION_REF_DANGLING"
  /** 仿真实体形状(判别联合)无法识别——类型不匹配,拒绝而非静默跳过。 */
  | "SIMULATION_ENTITY_TYPE_MISMATCH";

export class SceneReferenceResolutionError extends Error {
  constructor(readonly code: SceneReferenceErrorCode, message: string) {
    super(message);
    this.name = "SceneReferenceResolutionError";
  }
}

export interface SceneReferenceCleanupPort {
  /** 删除前捕获引用容器 before 态(深拷贝,供回滚恢复)。 */
  snapshotReferences(): SceneReferenceSnapshot;
  /**
   * 删除引用消费:selectionSets/rootLayerOrder 摘引用;animation(时间线对象轨道+
   * 状态机状态/转移/clip 事件)与 simulationEntities 摘除命中实体;
   * assetBindings 存在引用时仍整批拒绝(第五批语义,删除流对绑定只有拒绝一路)。
   * 先检查后消费:任何拒绝(含状态机锚被消费、未知仿真实体形状)发生在任何变更之前。
   */
  pruneDeletedObjectReferences(objectId: string): SceneReferencePruneResult;
  /** 回滚恢复引用容器(深拷贝回写)。 */
  restoreReferences(snapshot: SceneReferenceSnapshot): void;
}

export interface SceneReferenceRegistryOptions {
  readonly sceneId: string;
  readonly containers?: SceneReferenceContainers;
}

/** 参考实现:宿主侧作者引用容器注册表(消费方注入,driver 只经 port 触达)。 */
export class SceneReferenceRegistry implements SceneReferenceCleanupPort {
  private containers: SceneReferenceContainers;

  constructor(private readonly options: SceneReferenceRegistryOptions) {
    if (!options || typeof options !== "object" || !options.sceneId?.trim()) {
      throw new TypeError("Scene reference registry requires a sceneId.");
    }
    this.containers = cloneContainers(options.containers ?? { selectionSets: [], rootLayerOrder: [] });
  }

  get state(): Readonly<SceneReferenceContainers> { return this.containers; }

  snapshotReferences(): SceneReferenceSnapshot {
    return { containers: cloneContainers(this.containers) };
  }

  pruneDeletedObjectReferences(objectId: string): SceneReferencePruneResult {
    // ===== 检查阶段(零变更):先算出完整消费计划,任何拒绝在变更之前抛出 =====
    // assetBindings:拒绝删除并列出全部命中绑定 id——不自动摘绑定(第五批语义)。
    const boundIds = (this.containers.assetBindings ?? [])
      .filter(binding => binding.sceneObjectId === objectId)
      .map(binding => binding.id);
    if (boundIds.length) {
      throw new Error(`对象 ${objectId} 的设备资产引用(${boundIds.join("、")})尚未接入删除，请先移除该引用。`);
    }
    // 仿真域:未知形状如实拒绝(可能以未知形态引用该对象,不能静默跳过);命中→计划移除。
    const simulationEntitiesRemoved: string[] = [];
    for (const entity of this.containers.simulationEntities ?? []) {
      const refs = simulationEntityModelReferences(entity);
      if (refs.includes(objectId)) simulationEntitiesRemoved.push(entity.id);
    }
    // 动画域:时间线对象轨道帧 + 状态机命中状态(连同转移)。
    const animation = this.containers.animation;
    const framesRemoved = animation ? animation.models.filter(frame => frame.modelId === objectId).length : 0;
    const statesConsumed: string[] = [];
    const transitionsRemoved: string[] = [];
    let consumedClips = new Set<string>();
    let eventsRemoved = 0;
    if (animation?.stateMachine) {
      const machine = animation.stateMachine;
      for (const state of machine.states) {
        if (state.modelId === objectId) statesConsumed.push(state.id);
      }
      if (statesConsumed.length) {
        const remaining = new Set(machine.states.map(state => state.id).filter(id => !statesConsumed.includes(id)));
        // 锚守卫:初始/活动状态锚在被删对象的状态上时,删除无法保持状态机语义,如实拒绝——
        // 不静默改锚(那是宿主作者决策),错误码 STATE_MACHINE_ANCHOR_CONSUMED。
        if (!remaining.has(machine.initialStateId) || !remaining.has(machine.activeStateId)) {
          throw new SceneReferenceResolutionError("STATE_MACHINE_ANCHOR_CONSUMED",
            `对象 ${objectId} 的删除将消费状态机的初始/活动状态(${machine.initialStateId}/${machine.activeStateId})；请先迁移状态机锚再删除（fail-closed）。`);
        }
        for (const transition of machine.transitions ?? []) {
          if (!remaining.has(transition.fromStateId) || !remaining.has(transition.toStateId)) transitionsRemoved.push(transition.id);
        }
      }
      const candidates = consumedClipIds(animation, objectId, statesConsumed);
      const retained = new Set<string>(machine.states.filter(state => state.modelId !== objectId).map(state => state.clipId));
      for (const frame of animation.models) {
        if (frame.modelId !== objectId && frame.animation?.clipId) retained.add(frame.animation.clipId);
      }
      consumedClips = new Set([...candidates].filter(clip => !retained.has(clip)));
      eventsRemoved = (machine.events ?? []).filter(event => consumedClips.has(event.clipId)).length;
    }

    // ===== 消费阶段:按计划就地变异(回滚由 driver 的 before 快照恢复) =====
    const selectionSetsPruned: string[] = [];
    for (const set of this.containers.selectionSets) {
      if (!set.objectIds.includes(objectId)) continue;
      set.objectIds = set.objectIds.filter(id => id !== objectId);
      selectionSetsPruned.push(set.id);
    }
    const rootLayerBefore = this.containers.rootLayerOrder.length;
    this.containers.rootLayerOrder = this.containers.rootLayerOrder.filter(
      ref => !(ref.kind === "object" && ref.id === objectId));
    if (animation) {
      const models = animation.models.filter(frame => frame.modelId !== objectId);
      if (models.length !== animation.models.length) animation.models = models;
      const machine = animation.stateMachine;
      if (machine && statesConsumed.length) {
        machine.states = machine.states.filter(state => state.modelId !== objectId);
        if (machine.transitions) machine.transitions = machine.transitions.filter(transition => !transitionsRemoved.includes(transition.id));
      }
      if (machine?.events && consumedClips.size) {
        machine.events = machine.events.filter(event => !consumedClips.has(event.clipId));
      }
    }
    if (simulationEntitiesRemoved.length) {
      this.containers.simulationEntities = (this.containers.simulationEntities ?? [])
        .filter(entity => !simulationEntitiesRemoved.includes(entity.id));
    }
    return {
      selectionSetsPruned,
      rootLayerOrderRemoved: rootLayerBefore - this.containers.rootLayerOrder.length,
      animationFramesRemoved: framesRemoved,
      animationStatesConsumed: statesConsumed,
      animationTransitionsRemoved: transitionsRemoved.length,
      animationEventsRemoved: eventsRemoved,
      simulationEntitiesRemoved,
    };
  }

  /**
   * 宿主显式解绑(第五批第二子集清理路):移除 objectId 的全部设备资产绑定并按原序返回
   * 深拷贝(供宿主记账/事件回放)。**driver 删除流不调用本方法**——删除流对绑定引用只有
   * 拒绝一路(浏览器同形);解绑是宿主在事务外的显式决定,对应浏览器『请先移除该引用』。
   * 解绑后删除照常走引用消费与既有逆算子;删除被回滚时绑定随 before 态恢复。
   */
  removeAssetBindingsFor(objectId: string): readonly SceneAssetBindingState[] {
    const bindings = this.containers.assetBindings;
    if (!bindings?.length) return [];
    const removed: SceneAssetBindingState[] = [];
    const kept: SceneAssetBindingState[] = [];
    for (const binding of bindings) {
      if (binding.sceneObjectId === objectId) removed.push(structuredClone(binding));
      else kept.push(binding);
    }
    if (removed.length) this.containers.assetBindings = kept;
    return removed;
  }

  restoreReferences(snapshot: SceneReferenceSnapshot): void {
    this.containers = cloneContainers(snapshot.containers);
  }
}

/**
 * 加载/重开解析门:场景文档中的动画与仿真引用逐条解析到运行时资源
 * (`isKnownObject`——本线的运行时资源即 port 图元注册表/graph 节点),任何悬空引用
 * 以显式错误码 fail-closed 拒绝,不静默丢弃。循环引用防护:状态机转移图的可达性
 * 遍历带 visited 集,环形转移(A→B→A)是合法语义、不会挂死解析。
 *
 * 检查域:
 * - simulationEntities:判别联合形状可识别(未知→SIMULATION_ENTITY_TYPE_MISMATCH);
 *   全部对象引用可解析(悬空→SIMULATION_REF_DANGLING);
 * - animation.models[].modelId 可解析(悬空→ANIMATION_REF_DANGLING);
 * - 状态机:initialStateId/activeStateId/转移端点都解析到已有状态(悬空→
 *   STATE_MACHINE_STATE_REF_DANGLING);clip 事件标记的 clipId 解析到容器内任一
 *   已授权 clip(状态 clipId ∪ 时间线帧 animation.clipId;悬空→ANIMATION_CLIP_REF_DANGLING);
 * - 时间线帧/状态机上无法在此层解析的导入 clipId(clip 活在模型资产里)不属文档级
 *   引用,其运行时解析在播放层(引擎 controlAnimation 对缺失 clip 返回 false,fail-closed)。
 */
export function resolveSceneReferenceIntegrity(input: {
  readonly animation?: SceneAnimationState;
  readonly simulationEntities?: readonly SimulationEntityState[];
  /** 运行时资源解析器:id 是否解析为当前加载域内的对象(本线=图元注册表/graph 节点)。 */
  readonly isKnownObject: (objectId: string) => boolean;
}): void {
  for (const entity of input.simulationEntities ?? []) {
    for (const modelId of simulationEntityModelReferences(entity)) {
      if (!input.isKnownObject(modelId)) {
        throw new SceneReferenceResolutionError("SIMULATION_REF_DANGLING",
          `仿真实体 ${entity.id} 引用的对象 ${modelId} 在场景中不存在（悬空引用）；加载拒绝（fail-closed）。`);
      }
    }
  }
  const animation = input.animation;
  if (!animation) return;
  const assertKnown = (modelId: string, origin: string): void => {
    if (!input.isKnownObject(modelId)) {
      throw new SceneReferenceResolutionError("ANIMATION_REF_DANGLING",
        `动画${origin}引用的对象 ${modelId} 在场景中不存在（悬空引用）；加载拒绝（fail-closed）。`);
    }
  };
  for (const frame of animation.models) assertKnown(frame.modelId, "时间线关键帧");
  const machine = animation.stateMachine;
  if (!machine) return;
  const stateIds = new Set(machine.states.map(state => state.id));
  for (const state of machine.states) assertKnown(state.modelId, "状态机状态");
  if (!stateIds.has(machine.initialStateId) || !stateIds.has(machine.activeStateId)) {
    throw new SceneReferenceResolutionError("STATE_MACHINE_STATE_REF_DANGLING",
      `状态机初始/活动状态(${machine.initialStateId}/${machine.activeStateId})不指向任何已声明状态；加载拒绝（fail-closed）。`);
  }
  for (const transition of machine.transitions ?? []) {
    if (!stateIds.has(transition.fromStateId) || !stateIds.has(transition.toStateId)) {
      throw new SceneReferenceResolutionError("STATE_MACHINE_STATE_REF_DANGLING",
        `状态机转移 ${transition.id} 的端点(${transition.fromStateId}→${transition.toStateId})不都指向已声明状态；加载拒绝（fail-closed）。`);
    }
  }
  const authoredClips = new Set<string>();
  for (const state of machine.states) authoredClips.add(state.clipId);
  for (const frame of animation.models) {
    if (frame.animation?.clipId) authoredClips.add(frame.animation.clipId);
  }
  for (const event of machine.events ?? []) {
    if (!authoredClips.has(event.clipId)) {
      throw new SceneReferenceResolutionError("ANIMATION_CLIP_REF_DANGLING",
        `clip 事件标记 ${event.eventId} 引用的 clip ${event.clipId} 不属于容器内任何已授权动画片段；加载拒绝（fail-closed）。`);
    }
  }
  // 循环引用防护:从初始状态沿转移遍历,visited 集保证环形转移图(A→B→A)终止——
  // 环是状态机的合法语义,遍历只用于确保解析完成,不做无限递归。
  const adjacency = new Map<string, string[]>();
  for (const transition of machine.transitions ?? []) {
    adjacency.set(transition.fromStateId, [...(adjacency.get(transition.fromStateId) ?? []), transition.toStateId]);
  }
  const visited = new Set<string>([machine.initialStateId]);
  const queue = [machine.initialStateId];
  while (queue.length) {
    const current = queue.pop()!;
    for (const next of adjacency.get(current) ?? []) {
      if (visited.has(next)) continue;
      visited.add(next);
      queue.push(next);
    }
  }
}

/** 仿真实体的全部对象引用;判别联合之外的形状如实抛错(类型不匹配,不静默跳过)。 */
export function simulationEntityModelReferences(entity: SimulationEntityState): readonly string[] {
  if (entity.kind === "flowNode" || entity.kind === "path") return [entity.targetModelId];
  if (entity.kind === "flowLink") return [entity.fromModelId, entity.toModelId];
  if (entity.kind === "collisionPair") return [entity.a.modelId, entity.b.modelId];
  throw new SceneReferenceResolutionError("SIMULATION_ENTITY_TYPE_MISMATCH",
    `仿真实体 ${String((entity as { id?: unknown }).id ?? "<unknown>")} 的形状(kind=${String((entity as { kind?: unknown }).kind ?? "<missing>")})无法识别；引用检查拒绝（fail-closed）。`);
}

/** 被删对象名下的 clipId 集:被消费状态 + 被摘时间线帧的 animation.clipId。 */
function consumedClipIds(animation: SceneAnimationState, objectId: string, consumedStateIds: readonly string[]): Set<string> {
  const clips = new Set<string>();
  for (const state of animation.stateMachine?.states ?? []) {
    if (consumedStateIds.includes(state.id)) clips.add(state.clipId);
  }
  for (const frame of animation.models) {
    if (frame.modelId === objectId && frame.animation?.clipId) clips.add(frame.animation.clipId);
  }
  return clips;
}

function cloneContainers(containers: SceneReferenceContainers): SceneReferenceContainers {
  return {
    selectionSets: containers.selectionSets.map(set => ({ ...set, objectIds: [...set.objectIds] })),
    rootLayerOrder: containers.rootLayerOrder.map(ref => ({ ...ref })),
    ...(containers.assetBindings ? { assetBindings: containers.assetBindings.map(binding => ({ ...binding })) } : {}),
    ...(containers.animation ? { animation: structuredClone(containers.animation) } : {}),
    ...(containers.simulationEntities ? { simulationEntities: structuredClone(containers.simulationEntities) } : {}),
  };
}
