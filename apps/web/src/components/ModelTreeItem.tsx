import { Box, Check, ChevronDown, ChevronRight, Eye, EyeOff, Focus, Gauge, Layers3, Lock, Pause, Play, ScanLine, Settings2, Trash2, Unlock } from "lucide-react";
import type { ModelRecord, SceneFloorState } from "@bim-studio/contracts";
import { dispatchEngineEditCommand } from "../commands/engineCommandApplier";
import { layerLockCommand, layerVisibilityCommand, selectionDeleteCommand } from "../commands/engineEditCommand";
import { translate as tr, type AppLocale } from "../i18n";
import { statusText } from "../appPresentation";
import { LayerTree } from "./LayerTree";
import { SceneRowMenu } from "./SceneRowMenu";
import { focusSceneObjectRow, selectSceneObjectRow } from "./sceneObjectRowEvents";
import type { LayerTreeNode, LoadedSceneModel, ViewerEngine } from "../viewer/ViewerEngine";

/** 单个模型的目录行，集中承载可见性、锁定、碰撞、动画和图层操作。 */
export interface ModelTreeItemProps {
  locale: AppLocale;
  model: ModelRecord;
  loaded: LoadedSceneModel | undefined;
  tree: LayerTreeNode | undefined;
  expanded: boolean;
  modelFloors: readonly SceneFloorState[];
  floorExpansion: number;
  selectedModelId: string | undefined;
  selectedInBatch?: boolean;
  selectedLayerId: string | undefined;
  engine: ViewerEngine | undefined;
  onToggleTree: () => void;
  onSelectObject?: (id: string, options: { additive: boolean; range: boolean }) => void;
  onLoadModel: () => void;
  onOptimize?: () => void;
  onInstanceActions?: () => void;
  optimizing?: boolean;
  onSetRevision: () => void;
  onExpandFloors: (value: number) => void;
  onUpdateFloor: (state: SceneFloorState) => void;
  onRemoveObjectInteractions: (modelId: string, layerId: string) => void;
  onSetMessage: (message: string) => void;
  onDeleteModel: () => void;
}

export function ModelTreeItem({
  locale,
  model,
  loaded,
  tree,
  expanded,
  modelFloors,
  floorExpansion,
  selectedModelId,
  selectedInBatch = false,
  selectedLayerId,
  engine,
  onToggleTree,
  onSelectObject,
  onLoadModel,
  onOptimize,
  onInstanceActions,
  optimizing,
  onSetRevision,
  onExpandFloors,
  onUpdateFloor,
  onRemoveObjectInteractions,
  onSetMessage,
  onDeleteModel,
}: ModelTreeItemProps) {
  return (
    <div className="model-tree-item" data-model-id={model.id}>
      <div className={`asset-row ${loaded && selectedModelId === model.id ? "selected" : ""} ${loaded && selectedInBatch ? "batch-selected" : ""}`}>
        <span className="scene-row-selection-mark" aria-hidden="true">{loaded && selectedInBatch ? <Check size={12} strokeWidth={3} /> : null}</span>
        <button
          className="model-expander"
          disabled={!loaded}
          aria-label={expanded ? tr(locale, "收起模型结构", "Collapse model structure") : tr(locale, "展开模型结构", "Expand model structure")}
          title={expanded ? tr(locale, "收起模型结构", "Collapse model structure") : tr(locale, "展开模型结构", "Expand model structure")}
          onClick={() => loaded && onToggleTree()}
        >
          {loaded ? expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : <span />}
        </button>
        <button
          className="asset-main"
          title={loaded ? tr(locale, "单击选择；Ctrl/⌘ 单击切换多选；Shift 连续选择；双击聚焦", "Click to select; Ctrl/⌘-click to toggle selection; Shift-click for a range; double-click to focus") : tr(locale, "载入模型", "Load model")}
          onClick={(event) => {
            if (!loaded) return onLoadModel();
            selectSceneObjectRow(event, model.id, engine, onSelectObject);
          }}
          onDoubleClick={() => {
            if (loaded) focusSceneObjectRow(model.id, engine);
          }}
        >
          <span className={`format-badge format-${model.format}`}>{model.format.toUpperCase()}</span>
          <span className="asset-copy">
            <strong title={model.name}>{model.name}</strong>
            <small>{statusText(model, Boolean(loaded), locale)}</small>
          </span>
        </button>
        {loaded && (
          <button
            className="mini-button"
            aria-label={loaded.visible ? tr(locale, "隐藏", "Hide") : tr(locale, "显示", "Show")}
            title={loaded.visible ? tr(locale, "隐藏", "Hide") : tr(locale, "显示", "Show")}
            onClick={() => {
              // 批 2 收编:模型级显隐走命令总线(engine 为空时 dispatch 静默跳过,与 engine?. 直调一致)。
              dispatchEngineEditCommand(engine, layerVisibilityCommand(locale, { modelId: model.id }, !loaded.visible));
            }}
          >
            {loaded.visible ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
        )}
        {loaded && (
          <button
            className={`mini-button ${engine?.isModelLocked(model.id) ? "active" : ""}`}
            aria-label={engine?.isModelLocked(model.id) ? tr(locale, "解锁模型", "Unlock model") : tr(locale, "锁定模型", "Lock model")}
            title={engine?.isModelLocked(model.id) ? tr(locale, "解锁模型", "Unlock model") : tr(locale, "锁定模型", "Lock model")}
            onClick={() => {
              // 批 2 收编:模型级锁定走命令总线;engine 为空时保持直调的短路语义(不发命令)且 onSetRevision 照常执行。
              if (engine) dispatchEngineEditCommand(engine, layerLockCommand(locale, { modelId: model.id }, !engine.isModelLocked(model.id)));
              onSetRevision();
            }}
          >
            {engine?.isModelLocked(model.id) ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
        )}
        <SceneRowMenu locale={locale}>
          {loaded && <button
            aria-label={tr(locale, "隔离当前模型", "Isolate current model")}
            title={tr(locale, "仅显示当前模型", "Show only this model")}
            onClick={() => {
              engine?.isolateModels([model.id]);
              onSetRevision();
            }}
          >
            <Focus size={15} /><span>{tr(locale, "隔离", "Isolate")}</span>
          </button>}
          {loaded && <button
            className={`collision-toggle ${engine?.isCollisionEnabled(model.id) ? "active" : ""} ${engine?.isColliding(model.id) ? "colliding" : ""}`}
            aria-label={engine?.isCollisionEnabled(model.id) ? tr(locale, "关闭碰撞检测", "Disable collision detection") : tr(locale, "开启碰撞检测", "Enable collision detection")}
            title={engine?.isCollisionEnabled(model.id) ? tr(locale, "关闭碰撞检测", "Disable collision detection") : tr(locale, "开启碰撞检测", "Enable collision detection")}
            onClick={() => {
              engine?.setCollisionEnabled(model.id, !engine.isCollisionEnabled(model.id));
              onSetRevision();
            }}
          >
            <ScanLine size={15} /><span>{engine?.isCollisionEnabled(model.id) ? tr(locale, "关闭碰撞", "Disable collision") : tr(locale, "开启碰撞", "Enable collision")}</span>
          </button>}
        {loaded && engine?.hasAnimation(model.id) && (
          <button
            className={engine.isAnimationEnabled(model.id) ? "active" : ""}
            aria-label={engine.isAnimationEnabled(model.id) ? tr(locale, "暂停模型动画", "Pause model animation") : tr(locale, "播放模型动画", "Play model animation")}
            title={engine.isAnimationEnabled(model.id) ? tr(locale, "暂停模型动画", "Pause model animation") : tr(locale, "播放模型动画", "Play model animation")}
            onClick={() => {
              engine.setAnimationEnabled(model.id, !engine.isAnimationEnabled(model.id));
              onSetRevision();
            }}
          >
            {engine.isAnimationEnabled(model.id) ? <Pause size={14} /> : <Play size={14} />}<span>{engine.isAnimationEnabled(model.id) ? tr(locale, "暂停动画", "Pause animation") : tr(locale, "播放动画", "Play animation")}</span>
          </button>
        )}
        {onOptimize && <button disabled={optimizing || model.status !== "ready"} onClick={onOptimize}><Gauge size={15} /><span>{tr(locale, "优化素材", "Optimize asset")}</span></button>}
        {loaded && onInstanceActions && <button disabled={optimizing} onClick={onInstanceActions}><Settings2 size={15} /><span>{tr(locale, "实例管理", "Instances")}</span></button>}
        <button
          className="danger"
          data-layer-action="delete"
          disabled={Boolean(loaded && engine?.isModelLocked(model.id))}
          aria-label={loaded && engine?.isModelLocked(model.id) ? tr(locale, "请先解锁模型", "Unlock the model first") : loaded ? tr(locale, "移除实例", "Remove instance") : tr(locale, "删除素材", "Delete asset")}
          title={loaded && engine?.isModelLocked(model.id) ? tr(locale, "请先解锁模型", "Unlock the model first") : loaded ? tr(locale, "从场景移除，素材保留；可撤销", "Remove from scene, keep asset; undo available") : tr(locale, "删除未使用的素材", "Delete unused asset")}
          onClick={onDeleteModel}
        >
          <Trash2 size={15} /><span>{loaded ? tr(locale, "移除实例", "Remove instance") : tr(locale, "删除素材", "Delete asset")}</span>
        </button>
        </SceneRowMenu>
      </div>
      {expanded && modelFloors.length > 0 && (
        <section className="floor-control model-floor-control" aria-label={`${model.name} ${tr(locale, "楼层控制", "floor controls")}`}>
          <div className="floor-control-head">
            <span>{tr(locale, "楼层", "Floors")}</span>
            <small>{modelFloors.length}</small>
            <label>
              <span>{tr(locale, "向上展开", "Expand upward")}</span>
              <input type="range" min="0" max="12" step="0.25" value={floorExpansion} onChange={(event) => onExpandFloors(Number(event.target.value))} />
              <output>{floorExpansion.toFixed(1)}m</output>
            </label>
          </div>
          <div className="floor-list">
            {modelFloors.map((floor) => (
              <button
                key={`${floor.modelId}:${floor.level}`}
                className={floor.visible ? "active" : ""}
                aria-label={floor.visible ? tr(locale, "隐藏该楼层", "Hide floor") : tr(locale, "显示该楼层", "Show floor")}
                title={floor.visible ? tr(locale, "隐藏该楼层", "Hide floor") : tr(locale, "显示该楼层", "Show floor")}
                onClick={() => onUpdateFloor({ ...floor, visible: !floor.visible })}
              >
                {floor.visible ? <Eye size={13} /> : <EyeOff size={13} />}
                <span>{floor.level}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {expanded && tree && (
        <LayerTree
          locale={locale}
          root={tree}
          selectedNodeId={selectedModelId === model.id ? selectedLayerId : undefined}
          onSelect={(node) => {
            if (selectedModelId === model.id && selectedLayerId === node.id) engine?.select(undefined);
            else engine?.selectLayer(model.id, node.id);
            onSetRevision();
          }}
          onVisibilityChange={(node, visible) => {
            // 批 0 接线:发命令 → 总线同步冲刷 → applier 原样调 engine.setLayerVisible(行为零变化)。
            dispatchEngineEditCommand(engine, layerVisibilityCommand(locale, { modelId: model.id, layerId: node.id }, visible));
            onSetRevision();
          }}
          onLockChange={(node, locked) => {
            // 批 2 收编:图层锁定走命令总线(layerId 原样透传,含 "root" 时 setter 内部转委模型锁定的既有语义)。
            dispatchEngineEditCommand(engine, layerLockCommand(locale, { modelId: model.id, layerId: node.id }, locked));
            onSetRevision();
            onSetMessage(locked ? `已锁定“${node.name}”` : `已解锁“${node.name}”`);
          }}
          onDelete={(node) => {
            if (!window.confirm(`从当前场景删除图层“${node.name}”吗？`)) return;
            engine?.selectLayer(model.id, node.id);
            dispatchEngineEditCommand(engine, selectionDeleteCommand(locale, { modelId: model.id }));
            onRemoveObjectInteractions(model.id, node.id);
            onSetRevision();
          }}
        />
      )}
    </div>
  );
}
