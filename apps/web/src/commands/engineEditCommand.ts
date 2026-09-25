import type { GlobalLightingState, ModelTransform, SceneEnvironmentState, SceneLayerState, SceneMaterialState, SceneModelEffectsState, ScenePhysicsState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

/**
 * 作者态编辑命令(引擎中立,批 0)。
 *
 * 合同留在仓内(apps/web/src/commands),按设计文档
 * docs/specs/engine-neutral-command-layer-design-2026-09-25.md §3 不进 packages/contracts;
 * 字段口径直接复用 contracts 的 ModelTransform / SceneLayerState,不另造形状。
 * 批 0 只含 SetTransform 与 SetVisibility 两个原语,其余原语按批次追加。
 * 批 2(SetVisibility 收编):SetVisibility 扩展 locked/name 字段与 selection 模式,
 * 其余原语(opacity/color/deleted 等)按批次追加。
 */

/** 命令公共字段:身份由总线分配,撤销/重放/日志共用。 */
export interface EngineEditCommandBase {
  /** 进程内单调 id(`editcmd-<seq>`);日志去重与幂等键。 */
  readonly id: string;
  /** 发出时所见文档 revision;批 0 同步串行队列下仅作记录,不做过期拒绝(设计文档 §3 目标态语义)。 */
  readonly baseRevision: number;
  /** 撤销菜单文案;批 0 无撤销 UI,仅入日志。 */
  readonly label: string;
  /** Optional inverse input. Undo applies it as a new monotonic command. */
  readonly inverse?: EngineEditCommandInput;
}

export interface EngineEditCommandTarget {
  readonly modelId: string;
  readonly layerId?: string;
}

/**
 * 变换命令。全量 TRS(非设计文档 §3 的 Partial 形态):Partial 的"未指定字段保持不变"
 * 需要可信基线,而 gizmo 拖拽流未收编、undo 是整快照直改 Three,基线不可信;
 * 全量覆盖下旧值不参与结果,这是批 1 保持全量的决定性理由(见 engineTransformGraph.ts)。
 *
 * 批 1 追加 `mode`(缺省 "selection",批 0 命令兼容):
 * - "selection":作用于引擎当前选中对象(等价既有 `applySelectionTransform`,含其内部
 *   锁定/图层守卫);target 是调用点记录的选择身份。
 * - "model":作用于 target.modelId 的模型根(等价既有 `setModelTransform`)。
 */
export interface SetTransformCommand extends EngineEditCommandBase {
  readonly kind: "setTransform";
  readonly target: EngineEditCommandTarget;
  readonly transform: ModelTransform;
  readonly mode?: "selection" | "model";
}

/**
 * 可见性/锁定/重命名命令(kind 名对齐设计文档 §3 的 "setLayerState")。
 * patch 字段口径 = SceneLayerState 去 nodeId;批 2 applier 消费 `visible`/`locked`/`name`,
 * 其余字段(opacity/color/material/transform/deleted)出现在 patch 中时 applier 显式拒绝
 * (见 engineCommandApplier)。
 *
 * 批 2 追加 `mode`(缺省 "target",批 0 命令兼容):
 * - "target"(缺省):按 target.layerId 有无分发——图层级 setLayerVisible/setLayerLocked,
 *   模型级 setVisible/setModelLocked,与调用点直调的逐参数形态一致。
 * - "selection":作用于引擎当前选中对象(等价既有 `setSelectionVisible`/`renameSelection`;
 *   引擎无 target 级的重命名 setter,重命名只能走 selection 模式)。target 是调用点记录的
 *   选择身份,applier 不据此定位(与批 1 setTransform selection 模式同口径)。
 */
export interface SetVisibilityCommand extends EngineEditCommandBase {
  readonly kind: "setLayerState";
  readonly target: EngineEditCommandTarget;
  readonly patch: Partial<Omit<SceneLayerState, "nodeId">>;
  readonly mode?: "selection";
}

/**
 * 外观命令(kind 对齐设计文档 §3 的 "setAppearance" 材质分支;批 3)。
 * patch 口径 = SceneMaterialState 的既有合并语义(引擎内部 mergeMaterialPatch,
 * 未指定字段保持现值)——与直调 setSelectionMaterial/setModelMaterial 的 patch
 * 形态逐字段一致;slotOverrides 递归结构由引擎内部处理,命令层原样透传。
 *
 * mode(缺省 "selection"):
 * - "selection":等价直调 setSelectionMaterial(patch)(含其内部锁定/构件分支语义)。
 * - "model":等价直调 setModelMaterial(modelId, patch)。
 */
export interface SetMaterialStateCommand extends EngineEditCommandBase {
  readonly kind: "setMaterialState";
  readonly target: EngineEditCommandTarget;
  readonly patch: SceneMaterialState;
  readonly mode?: "selection" | "model";
}

/**
 * 场景环境/全局灯光命令(批 4)。两条命令对应引擎仅有的两个全量态 setter:
 * 全量覆盖(非增量 patch)与 setter 合同一致;灯光 gizmo 拖拽的 position/target
 * 回写属交互流,批 4 不收编(等价 gizmo 拖拽流边界)。
 */
export interface SetSceneEnvironmentCommand extends EngineEditCommandBase {
  readonly kind: "setSceneEnv";
  readonly environment: SceneEnvironmentState;
}

export interface SetGlobalLightingCommand extends EngineEditCommandBase {
  readonly kind: "setLighting";
  readonly lighting: GlobalLightingState;
}

/** 模型效果命令(批 5 切片):全量态,等价直调 setModelEffects(modelId, state)。 */
export interface SetModelEffectsCommand extends EngineEditCommandBase {
  readonly kind: "setModelEffects";
  readonly target: EngineEditCommandTarget;
  readonly effects: SceneModelEffectsState;
}

/**
 * 物理场命令(批 5 切片):全量态,等价直调 setPhysicsState(state)。
 * 单体 body 状态 setter 是异步事务(setPhysicsBodyState Promise),命令层本轮
 * 不收编异步写点(同步串行总线合同),归后续切片。
 */
export interface SetPhysicsStateCommand extends EngineEditCommandBase {
  readonly kind: "setPhysicsState";
  readonly physics: ScenePhysicsState;
}

/** 机器人/骨骼姿态命令(批 5 切片):等价直调 setRobotPose(modelId, values)。 */
export interface SetRobotPoseCommand extends EngineEditCommandBase {
  readonly kind: "setRobotPose";
  readonly target: EngineEditCommandTarget;
  readonly values: Record<string, number>;
}

/**
 * 选中对象删除命令(批 6 结构命令切片;selection 作用域)。
 * 等价直调 deleteSelectedLayer():引擎内部含锁定守卫/fragment 分支/选中复位/连带;
 * boolean 结果在三个 UI 调用点均未消费,applier 按现状吞掉(失败也入日志——
 * 与直调"静默失败后调用点继续编排"逐点一致;undo 命令化后续批次再收紧)。
 * 调用点自身的编排(selectLayer 前置/removeObjectInteractions/revision)留在原地。
 */
export interface DeleteSelectionCommand extends EngineEditCommandBase {
  readonly kind: "deleteSelection";
  readonly target: EngineEditCommandTarget;
}

export type EngineEditCommand = SetTransformCommand | SetVisibilityCommand | SetMaterialStateCommand | SetSceneEnvironmentCommand | SetGlobalLightingCommand | SetModelEffectsCommand | SetPhysicsStateCommand | SetRobotPoseCommand | DeleteSelectionCommand;

/** 已应用命令的日志条目:revision 为该命令应用完成后的文档序位(1 起)。 */
export interface AppliedEngineEditCommand {
  readonly command: EngineEditCommand;
  readonly revision: number;
}

/** 裸类型参数触发分布式条件类型,保证 union 各成员的特有字段不被 Omit 塌缩。 */
type WithoutCommandIdentity<T> = T extends EngineEditCommandBase ? Omit<T, "id" | "baseRevision"> : never;

/** 发布输入:身份字段(id/baseRevision)由 CommandBus 分配,不允许调用方伪造。 */
export type EngineEditCommandInput = WithoutCommandIdentity<EngineEditCommand>;

/** 图层可见性切换命令工厂;接线点(ModelTreeItem 图层树)与未来调用方共用同一 label。 */
export function layerVisibilityCommand(
  locale: AppLocale,
  target: EngineEditCommandTarget,
  visible: boolean,
): EngineEditCommandInput {
  return {
    kind: "setLayerState",
    label: tr(locale, "切换图层可见性", "Toggle layer visibility"),
    target,
    patch: { visible },
  };
}

/**
 * 锁定切换命令工厂(target 模式):target.layerId 有无镜像调用点的分发条件——
 * 带图层的写点(图层树/检查器图层分支)传 layerId,模型/基础元素级写点不传;
 * applier 据此转交 setLayerLocked / setModelLocked,参数与直调逐项一致。
 */
export function layerLockCommand(
  locale: AppLocale,
  target: EngineEditCommandTarget,
  locked: boolean,
): EngineEditCommandInput {
  return {
    kind: "setLayerState",
    label: tr(locale, "切换对象锁定", "Toggle object lock"),
    target,
    patch: { locked },
  };
}

/** 选中对象可见性命令工厂(selection 模式):等价直调 `engine.setSelectionVisible(visible)`。 */
export function selectionVisibilityCommand(
  locale: AppLocale,
  target: EngineEditCommandTarget,
  visible: boolean,
): EngineEditCommandInput {
  return {
    kind: "setLayerState",
    mode: "selection",
    label: tr(locale, "切换对象可见性", "Toggle object visibility"),
    target,
    patch: { visible },
  };
}

/**
 * 选中对象重命名命令工厂(selection 模式):等价直调 `engine.renameSelection(name)`;
 * 引擎无 target 级重命名 setter,命令层如实沿用 selection 作用域。
 */
export function selectionRenameCommand(
  locale: AppLocale,
  target: EngineEditCommandTarget,
  name: string,
): EngineEditCommandInput {
  return {
    kind: "setLayerState",
    mode: "selection",
    label: tr(locale, "重命名对象", "Rename object"),
    target,
    patch: { name },
  };
}

/**
 * 单选/图层对象变换命令工厂(mode "selection"):作用于引擎当前选中,
 * applier 原样转交 applySelectionTransform 的选中语义与连带编排。
 */
export function selectionTransformCommand(
  locale: AppLocale,
  target: EngineEditCommandTarget,
  transform: ModelTransform,
): EngineEditCommandInput {
  return {
    kind: "setTransform",
    mode: "selection",
    label: tr(locale, "编辑三维对象", "Edit 3D object"),
    target,
    transform,
  };
}

/**
 * 选中对象材质命令工厂(mode "selection"):等价直调 setSelectionMaterial(patch);
 * 属性面板材质编辑与未来的材质选择器共用同一 label。
 */
export function selectionMaterialCommand(
  locale: AppLocale,
  target: EngineEditCommandTarget,
  patch: SetMaterialStateCommand["patch"],
): EngineEditCommandInput {
  return {
    kind: "setMaterialState",
    mode: "selection",
    label: tr(locale, "编辑对象材质", "Edit object material"),
    target,
    patch,
  };
}

/** 模型材质命令工厂(mode "model"):等价直调 setModelMaterial(modelId, patch)。 */
export function modelMaterialCommand(
  locale: AppLocale,
  modelId: string,
  patch: SetMaterialStateCommand["patch"],
): EngineEditCommandInput {
  return {
    kind: "setMaterialState",
    mode: "model",
    label: tr(locale, "编辑对象材质", "Edit object material"),
    target: { modelId },
    patch,
  };
}

/** 选中对象删除命令工厂:等价直调 deleteSelectedLayer()(编排留在调用点)。 */
export function selectionDeleteCommand(locale: AppLocale, target: EngineEditCommandTarget): EngineEditCommandInput {
  return { kind: "deleteSelection", label: tr(locale, "删除选中对象", "Delete selected object"), target };
}

/** 模型效果命令工厂:等价直调 setModelEffects(modelId, state)。 */
export function modelEffectsCommand(locale: AppLocale, modelId: string, effects: SceneModelEffectsState): EngineEditCommandInput {
  return { kind: "setModelEffects", label: tr(locale, "编辑模型效果", "Edit model effects"), target: { modelId }, effects };
}

/** 物理场命令工厂:等价直调 setPhysicsState(state)。 */
export function physicsStateCommand(locale: AppLocale, physics: ScenePhysicsState): EngineEditCommandInput {
  return { kind: "setPhysicsState", label: tr(locale, "编辑物理场", "Edit physics"), physics };
}

/** 机器人/骨骼姿态命令工厂:等价直调 setRobotPose(modelId, values)。 */
export function robotPoseCommand(locale: AppLocale, modelId: string, values: Record<string, number>): Omit<SetRobotPoseCommand, "id" | "baseRevision"> {
  return { kind: "setRobotPose", label: tr(locale, "编辑姿态", "Edit pose"), target: { modelId }, values };
}

/** 场景环境命令工厂:等价直调 setSceneEnvironment(state)。 */
export function sceneEnvironmentCommand(locale: AppLocale, environment: SceneEnvironmentState): EngineEditCommandInput {
  return { kind: "setSceneEnv", label: tr(locale, "编辑场景环境", "Edit scene environment"), environment };
}

/** 全局灯光命令工厂:等价直调 setGlobalLighting(state)。 */
export function globalLightingCommand(locale: AppLocale, lighting: GlobalLightingState): EngineEditCommandInput {
  return { kind: "setLighting", label: tr(locale, "编辑全局灯光", "Edit global lighting"), lighting };
}

/** 模型根变换命令工厂(mode "model"):等价 setModelTransform,按 target.modelId 定位。 */
export function modelTransformCommand(
  locale: AppLocale,
  modelId: string,
  transform: ModelTransform,
): EngineEditCommandInput {
  return {
    kind: "setTransform",
    mode: "model",
    label: tr(locale, "编辑三维对象", "Edit 3D object"),
    target: { modelId },
    transform,
  };
}
