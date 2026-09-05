import { Box, ChevronDown, ChevronRight, Eye, EyeOff, Gauge, Layers3, Lock, Pause, Play, ScanLine, Trash2, Unlock } from "lucide-react";
import type { ModelRecord, SceneFloorState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { statusText } from "../appPresentation";
import { LayerTree } from "./LayerTree";
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
  selectedLayerId: string | undefined;
  engine: ViewerEngine | undefined;
  onToggleTree: () => void;
  onLoadModel: () => void;
  onOptimize?: () => void;
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
  selectedLayerId,
  engine,
  onToggleTree,
  onLoadModel,
  onOptimize,
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
      <div className={`asset-row ${selectedModelId === model.id ? "selected" : ""}`}>
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
          title={loaded ? tr(locale, "单击选择，双击聚焦", "Click to select, double-click to focus") : tr(locale, "载入模型", "Load model")}
          onClick={() => (loaded ? engine?.select(model.id) : onLoadModel())}
          onDoubleClick={() => {
            if (loaded) engine?.focusModel(model.id);
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
            onClick={() => engine?.setVisible(model.id, !loaded.visible)}
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
              engine?.setModelLocked(model.id, !engine.isModelLocked(model.id));
              onSetRevision();
            }}
          >
            {engine?.isModelLocked(model.id) ? <Lock size={14} /> : <Unlock size={14} />}
          </button>
        )}
        {loaded && (
          <button
            className={`mini-button scene-row-optional-action collision-toggle ${engine?.isCollisionEnabled(model.id) ? "active" : ""} ${engine?.isColliding(model.id) ? "colliding" : ""}`}
            aria-label={engine?.isCollisionEnabled(model.id) ? tr(locale, "关闭碰撞检测", "Disable collision detection") : tr(locale, "开启碰撞检测", "Enable collision detection")}
            title={engine?.isCollisionEnabled(model.id) ? tr(locale, "关闭碰撞检测", "Disable collision detection") : tr(locale, "开启碰撞检测", "Enable collision detection")}
            onClick={() => engine?.setCollisionEnabled(model.id, !engine.isCollisionEnabled(model.id))}
          >
            <ScanLine size={15} />
          </button>
        )}
        {loaded && engine?.hasAnimation(model.id) && (
          <button
            className={`mini-button scene-row-optional-action ${engine.isAnimationEnabled(model.id) ? "active" : ""}`}
            aria-label={engine.isAnimationEnabled(model.id) ? tr(locale, "暂停模型动画", "Pause model animation") : tr(locale, "播放模型动画", "Play model animation")}
            title={engine.isAnimationEnabled(model.id) ? tr(locale, "暂停模型动画", "Pause model animation") : tr(locale, "播放模型动画", "Play model animation")}
            onClick={() => {
              engine.setAnimationEnabled(model.id, !engine.isAnimationEnabled(model.id));
              onSetRevision();
            }}
          >
            {engine.isAnimationEnabled(model.id) ? <Pause size={14} /> : <Play size={14} />}
          </button>
        )}
        {onOptimize && <button className="mini-button scene-row-optional-action" disabled={optimizing || model.status !== "ready"} onClick={onOptimize} aria-label={tr(locale, `保存并优化 ${model.name}`, `Save and optimize ${model.name}`)} title={tr(locale, "保存当前场景并优化此素材；不会覆盖原模型", "Save this scene and optimize this asset; source is preserved")}><Gauge size={15} /></button>}
        <button
          className="mini-button scene-row-optional-action danger"
          disabled={Boolean(loaded && engine?.isModelLocked(model.id))}
          aria-label={loaded && engine?.isModelLocked(model.id) ? tr(locale, "请先解锁模型", "Unlock the model first") : tr(locale, "删除模型", "Delete model")}
          title={loaded && engine?.isModelLocked(model.id) ? tr(locale, "请先解锁模型", "Unlock the model first") : tr(locale, "删除模型", "Delete model")}
          onClick={onDeleteModel}
        >
          <Trash2 size={15} />
        </button>
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
            engine?.selectLayer(model.id, node.id);
            onSetRevision();
          }}
          onVisibilityChange={(node, visible) => {
            engine?.setLayerVisible(model.id, node.id, visible);
            onSetRevision();
          }}
          onLockChange={(node, locked) => {
            engine?.setLayerLocked(model.id, node.id, locked);
            onSetRevision();
            onSetMessage(locked ? `已锁定“${node.name}”` : `已解锁“${node.name}”`);
          }}
          onDelete={(node) => {
            if (!window.confirm(`从当前场景删除图层“${node.name}”吗？`)) return;
            engine?.selectLayer(model.id, node.id);
            engine?.deleteSelectedLayer();
            onRemoveObjectInteractions(model.id, node.id);
            onSetRevision();
          }}
        />
      )}
    </div>
  );
}
