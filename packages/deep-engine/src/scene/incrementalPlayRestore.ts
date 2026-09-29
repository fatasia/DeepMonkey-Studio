/**
 * C25 · 增量域重载 / 近即时 Play（Unity Play Mode "incremental domain reload" 同族能力）。
 *
 * T30 的退出恢复走全量 applyScene：clearSceneModels 销毁全部实例（GPU 资源随之释放），
 * 随后逐模型 fetch/parse/upload 重建——而 Play 驱动（物理步进 + 场景动画）只改写了
 * 实例位姿、物理体状态与播放头。本模块对"进入前快照(enter)"与"退出时刻实况(live)"
 * 做域级差分，回答一个问题：退出恢复能否绕过昂贵的重建段（模型重载 / 图元重建 /
 * 测量与标注重建），只把逐实例状态写回（引擎 applyModelState 通道，零 GPU 重建）？
 *
 * 正确性合同（fail-closed）：
 * - 只有当全部四个重建域在 enter 与 live 之间"结构不变、仅逐实例可恢复字段可变"时
 *   才给出 fast 计划；任何一个域的结构身份变化（增删实例、换素材、换图元种类/颜色、
 *   测量/标注集合变化）→ full（全量 applyScene，与现状逐位一致）。
 * - 位姿/名称/可见性/材质/物理体等由引擎 applyModelState+rename 通道恢复，不参与
 *   资格判定；相机、天气、灯光、环境、后处理、物理全局、动画、剖切等廉价 setter 域
 *   由 applyScene 无条件从 enter 快照重放（与全量路径同一份代码），不依赖本计划。
 * - 模型动画 mixer 在 fast 路径不清零（全量路径经重载自然归零），调用方须补
 *   controlAnimation(seek 0) 对齐全量语义（见 applyScene 增量分支注释）。
 *
 * 本模块为纯函数、零依赖（本包不依赖 contracts；视图类型与 SceneSnapshot 结构兼容，
 * 调用方直接传 contracts 快照即可）。
 */

/** 模型实例的资产身份视图：替换素材/素材修订变化都会改变身份，必须走全量重载。 */
export interface PlayRestoreModelIdentity {
  /** 稳定场景实例 ID。 */
  readonly modelId: string;
  /** 项目模型资源 ID；缺省按 modelId 口径（与 applyScene 的资产解析同语义）。 */
  readonly assetModelId?: string;
  /** 素材修订快照；三项全等才算同一素材版本。 */
  readonly assetRevision?: {
    readonly packageId: string;
    readonly revision: number;
    readonly sourceHash: string;
  };
}

/** 图元实例视图：kind/color 决定 GPU 几何与共享材质，变化即需重建；name 走 rename 通道。 */
export interface PlayRestorePrimitiveIdentity {
  readonly modelId: string;
  readonly name: string;
  readonly kind?: string;
  readonly color: string;
}

/** 退出差分所需的快照窄视图（与 contracts SceneSnapshot 结构兼容）。 */
export interface PlayRestoreSnapshotView {
  /** 场景身份；进入/退出之间场景被替换属异常路径，直接判 full。 */
  readonly id: string;
  readonly models: readonly PlayRestoreModelIdentity[];
  readonly primitives: readonly PlayRestorePrimitiveIdentity[];
  /** 测量/标注集合按整域深等比较；不等即重建。 */
  readonly measurements?: readonly unknown[];
  readonly annotations?: readonly unknown[];
}

/** 需要整体重建（全量路径）的域；scene-identity 表示进入/退出之间场景被替换。 */
export type PlayReloadDomain = "models" | "primitives" | "measurements" | "annotations" | "scene-identity";

/** fast 计划：全部重建段为 0，逐实例状态直通；restored* 计数供分段账本/遥测消费。 */
export interface FastIncrementalPlayRestorePlan {
  readonly mode: "fast";
  /** enter 顺序的逐实例状态恢复清单长度（引擎 applyModelState 调用数）。 */
  readonly stateRestoredModels: number;
  readonly stateRestoredPrimitives: number;
  /** 缓存直通判定通过的重建域（全部为 0 重建）。 */
  readonly cacheHitDomains: readonly PlayReloadDomain[];
}

/** full 计划：与现状全量 applyScene 逐位一致；blockedBy 列出阻断域供诊断。 */
export interface FullIncrementalPlayRestorePlan {
  readonly mode: "full";
  readonly blockedBy: readonly PlayReloadDomain[];
}

export type IncrementalPlayRestorePlan = FastIncrementalPlayRestorePlan | FullIncrementalPlayRestorePlan;

/**
 * 对比 enter（进入 Play 前快照）与 live（退出时刻实况快照）。
 * live 缺失（快照工厂拒绝）时由调用方直接走 full；本函数假定两者非空。
 */
export function planIncrementalPlayRestore(enter: PlayRestoreSnapshotView, live: PlayRestoreSnapshotView): IncrementalPlayRestorePlan {
  if (enter.id !== live.id) return { mode: "full", blockedBy: ["scene-identity"] };
  const blockedBy: PlayReloadDomain[] = [];
  if (!modelsCacheHit(enter.models, live.models)) blockedBy.push("models");
  if (!primitivesCacheHit(enter.primitives, live.primitives)) blockedBy.push("primitives");
  if (!deepEquals(enter.measurements ?? [], live.measurements ?? [])) blockedBy.push("measurements");
  if (!deepEquals(enter.annotations ?? [], live.annotations ?? [])) blockedBy.push("annotations");
  if (blockedBy.length) return { mode: "full", blockedBy };
  return {
    mode: "fast",
    stateRestoredModels: enter.models.length,
    stateRestoredPrimitives: enter.primitives.length,
    cacheHitDomains: ["models", "primitives", "measurements", "annotations"],
  };
}

/**
 * 实例集合与资产身份逐一同索引位相等（enter 顺序即恢复顺序；数量不等即增删）。
 * assetModelId 缺省回退 modelId；assetRevision 三元组全等才算同一素材版本。
 */
function modelsCacheHit(enter: readonly PlayRestoreModelIdentity[], live: readonly PlayRestoreModelIdentity[]): boolean {
  if (enter.length !== live.length) return false;
  for (const [index, before] of enter.entries()) {
    const after = live[index];
    if (!after || before.modelId !== after.modelId) return false;
    if ((before.assetModelId ?? before.modelId) !== (after.assetModelId ?? after.modelId)) return false;
    if (!sameAssetRevision(before.assetRevision, after.assetRevision)) return false;
  }
  return true;
}

function sameAssetRevision(
  before: PlayRestoreModelIdentity["assetRevision"],
  after: PlayRestoreModelIdentity["assetRevision"],
): boolean {
  if (!before || !after) return before === after;
  return before.packageId === after.packageId && before.revision === after.revision && before.sourceHash === after.sourceHash;
}

/** 图元集合资格：同索引位 modelId/kind/color 全等（kind 缺省 box，与 createPrimitive 同语义）。 */
function primitivesCacheHit(enter: readonly PlayRestorePrimitiveIdentity[], live: readonly PlayRestorePrimitiveIdentity[]): boolean {
  if (enter.length !== live.length) return false;
  for (const [index, before] of enter.entries()) {
    const after = live[index];
    if (!after || before.modelId !== after.modelId) return false;
    if ((before.kind ?? "box") !== (after.kind ?? "box")) return false;
    if (before.color !== after.color) return false;
  }
  return true;
}

/**
 * 有界结构深等：面向快照内 JSON 形数据（对象/数组/原始值）。快照可 JSON 持久化、
 * 无环；NaN/undefined 按同值处理（NaN !== NaN 但语义等价，undefined 省略字段）。
 */
export function deepEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (typeof left !== "object" || left === null || right === null || typeof right !== "object") {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    return left.every((item, index) => deepEquals(item, right[index]));
  }
  const leftKeys = Object.keys(left as Record<string, unknown>).filter((key) => (left as Record<string, unknown>)[key] !== undefined);
  const rightKeys = Object.keys(right as Record<string, unknown>).filter((key) => (right as Record<string, unknown>)[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(right, key) && deepEquals((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]),
  );
}
