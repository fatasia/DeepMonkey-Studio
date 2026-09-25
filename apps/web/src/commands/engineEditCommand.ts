import type { ModelTransform, SceneLayerState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

/**
 * 作者态编辑命令(引擎中立,批 0)。
 *
 * 合同留在仓内(apps/web/src/commands),按设计文档
 * docs/specs/engine-neutral-command-layer-design-2026-09-25.md §3 不进 packages/contracts;
 * 字段口径直接复用 contracts 的 ModelTransform / SceneLayerState,不另造形状。
 * 批 0 只含 SetTransform 与 SetVisibility 两个原语,其余原语按批次追加。
 */

/** 命令公共字段:身份由总线分配,撤销/重放/日志共用。 */
export interface EngineEditCommandBase {
  /** 进程内单调 id(`editcmd-<seq>`);日志去重与幂等键。 */
  readonly id: string;
  /** 发出时所见文档 revision;批 0 同步串行队列下仅作记录,不做过期拒绝(设计文档 §3 目标态语义)。 */
  readonly baseRevision: number;
  /** 撤销菜单文案;批 0 无撤销 UI,仅入日志。 */
  readonly label: string;
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
 * 可见性/图层属性命令(kind 名对齐设计文档 §3 的 "setLayerState")。
 * patch 字段口径 = SceneLayerState 去 nodeId;批 0 applier 仅消费 `visible`,
 * 其余字段出现在 patch 中时 applier 显式拒绝(见 engineCommandApplier)。
 */
export interface SetVisibilityCommand extends EngineEditCommandBase {
  readonly kind: "setLayerState";
  readonly target: EngineEditCommandTarget;
  readonly patch: Partial<Omit<SceneLayerState, "nodeId">>;
}

export type EngineEditCommand = SetTransformCommand | SetVisibilityCommand;

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
