import { Box, Check, Eye, EyeOff, Focus, Lock, ScanLine, Trash2, Unlock } from "lucide-react";
import { translate as tr } from "../i18n";
import type { LoadedSceneModel } from "../viewer/ViewerEngine";
import { SceneRowMenu } from "./SceneRowMenu";
import { focusSceneObjectRow, selectSceneObjectRow } from "./sceneObjectRowEvents";
import type { FlatSceneObjectListProps } from "./sceneObjectListTypes";

type PrimitiveProps = Pick<FlatSceneObjectListProps, "locale" | "engine" | "selectedObjectIds" | "selectedObjectId" | "onObjectSelect" | "onRevision" | "onPrimitiveRemove">;

export function PrimitiveRow(
  props: PrimitiveProps & { primitive: LoadedSceneModel },
) {
  const { primitive, engine, locale } = props;
  const locked = engine?.isModelLocked(primitive.id) ?? false;
  const selectedInBatch = props.selectedObjectIds?.has(primitive.id) ?? props.selectedObjectId === primitive.id;
  return (
    <div
      className={`asset-row scene-object-row ${props.selectedObjectId === primitive.id ? "selected" : ""} ${selectedInBatch ? "batch-selected" : ""}`}
    >
      <span className="scene-row-selection-mark" aria-hidden="true">{selectedInBatch ? <Check size={12} strokeWidth={3} /> : null}</span>
      <button
        className="asset-main"
        title={tr(locale, "单击选择；Ctrl/⌘ 单击切换多选；Shift 连续选择；双击聚焦", "Click to select; Ctrl/⌘-click to toggle selection; Shift-click for a range; double-click to focus")}
        onClick={(event) => selectSceneObjectRow(event, primitive.id, engine, props.onObjectSelect)}
        onDoubleClick={() => focusSceneObjectRow(primitive.id, engine)}
      >
        <span className="scene-object-badge">
          <Box size={15} />
        </span>
        <span className="asset-copy">
          <strong>{primitive.name}</strong>
          <small>
            {tr(locale, "基础元素 · 可编辑", "Primitive · Editable")}
          </small>
        </span>
      </button>
      <button
        className="mini-button"
        aria-label={primitive.visible ? tr(locale, "隐藏基础元素", "Hide primitive") : tr(locale, "显示基础元素", "Show primitive")}
        title={
          primitive.visible
            ? tr(locale, "隐藏基础元素", "Hide primitive")
            : tr(locale, "显示基础元素", "Show primitive")
        }
        onClick={() => engine?.setVisible(primitive.id, !primitive.visible)}
      >
        {primitive.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <button
        className={`mini-button ${locked ? "active" : ""}`}
        aria-label={locked ? tr(locale, "解锁基础元素", "Unlock primitive") : tr(locale, "锁定基础元素", "Lock primitive")}
        title={
          locked
            ? tr(locale, "解锁基础元素", "Unlock primitive")
            : tr(locale, "锁定基础元素", "Lock primitive")
        }
        onClick={() => {
          engine?.setModelLocked(primitive.id, !locked);
          props.onRevision();
        }}
      >
        {locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <SceneRowMenu locale={locale}>
      <button
        aria-label={tr(locale, "隔离当前基础元素", "Isolate current primitive")}
        title={tr(locale, "仅显示当前基础元素", "Show only this primitive")}
        onClick={() => {
          engine?.isolateModels([primitive.id]);
          props.onRevision();
        }}
      >
        <Focus size={15} /><span>{tr(locale, "隔离", "Isolate")}</span>
      </button>
      <button
        className={`collision-toggle ${engine?.isCollisionEnabled(primitive.id) ? "active" : ""} ${engine?.isColliding(primitive.id) ? "colliding" : ""}`}
        aria-label={engine?.isCollisionEnabled(primitive.id) ? tr(locale, "关闭碰撞检测", "Disable collision detection") : tr(locale, "开启碰撞检测", "Enable collision detection")}
        title={
          engine?.isCollisionEnabled(primitive.id)
            ? tr(locale, "关闭碰撞检测", "Disable collision detection")
            : tr(locale, "开启碰撞检测", "Enable collision detection")
        }
        onClick={() => {
          engine?.setCollisionEnabled(
            primitive.id,
            !engine.isCollisionEnabled(primitive.id),
          );
          props.onRevision();
        }}
      >
        <ScanLine size={15} /><span>{engine?.isCollisionEnabled(primitive.id) ? tr(locale, "关闭碰撞", "Disable collision") : tr(locale, "开启碰撞", "Enable collision")}</span>
      </button>
      <button
        className="danger"
        data-layer-action="delete"
        disabled={locked}
        aria-label={locked ? tr(locale, "请先解锁基础元素", "Unlock the primitive first") : tr(locale, "删除基础元素", "Delete primitive")}
        title={
          locked
            ? tr(locale, "请先解锁基础元素", "Unlock the primitive first")
            : tr(locale, "删除基础元素", "Delete primitive")
        }
        onClick={() => props.onPrimitiveRemove(primitive.id)}
      >
        <Trash2 size={15} /><span>{tr(locale, "删除", "Delete")}</span>
      </button>
      </SceneRowMenu>
    </div>
  );
}

