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
 * 变换命令。批 0 的 applier 原样转交既有 `applySelectionTransform`(全量 TRS),
 * 因此字段是全量 ModelTransform 而非设计文档 §3 的 Partial 形态;
 * Partial 语义留待批 1 对接 SceneTransformGraph 时引入。
 */
export interface SetTransformCommand extends EngineEditCommandBase {
  readonly kind: "setTransform";
  readonly target: EngineEditCommandTarget;
  readonly transform: ModelTransform;
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
