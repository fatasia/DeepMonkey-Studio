import { MapPin, Maximize, Trash2 } from "lucide-react";
import type { SceneAnnotationState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { TransformFields } from "./AppFormControls";

interface SceneAnnotationInspectorProps {
  locale: AppLocale;
  annotation: SceneAnnotationState;
  onChange: (patch: Partial<SceneAnnotationState>) => void;
  onPositionChange: (axis: "x" | "y" | "z", value: string) => void;
  onFocus: () => void;
  onDelete: () => void;
}

export function SceneAnnotationInspector(props: SceneAnnotationInspectorProps) {
  const { locale, annotation } = props;
  return (
    <div className="inspector-content annotation-inspector">
      <div className="annotation-inspector-title">
        <span style={{ background: annotation.color }}>
          <MapPin size={15} />
        </span>
        <div>
          <strong>{tr(locale, "标签标记", "Annotation")}</strong>
          <small>
            {annotation.anchorName ||
              tr(locale, "场景坐标", "Scene coordinates")}
          </small>
        </div>
        <button
          title={tr(locale, "定位标签", "Focus annotation")}
          onClick={props.onFocus}
        >
          <Maximize size={14} />
        </button>
      </div>
      <label className="field">
        <span>{tr(locale, "标签名称", "Annotation name")}</span>
        <input
          disabled={annotation.locked}
          value={annotation.name}
          onChange={(event) => props.onChange({ name: event.target.value })}
        />
      </label>
      <label className="field">
        <span>{tr(locale, "说明内容", "Description")}</span>
        <textarea
          disabled={annotation.locked}
          rows={4}
          value={annotation.description ?? ""}
          onChange={(event) =>
            props.onChange({ description: event.target.value })
          }
          placeholder={tr(
            locale,
            "填写巡检事项、设备状态或问题说明",
            "Describe an inspection item, device status, or issue",
          )}
        />
      </label>
      <label className="field color-field">
        <span>{tr(locale, "标签颜色", "Annotation color")}</span>
        <div>
          <input
            disabled={annotation.locked}
            type="color"
            value={annotation.color}
            onChange={(event) => props.onChange({ color: event.target.value })}
          />
          <output>{annotation.color.toUpperCase()}</output>
        </div>
      </label>
      <div className="two-column">
        <label className="field">
          <span>{tr(locale, "可见性", "Visibility")}</span>
          <button
            className={`toggle ${annotation.visible ? "on" : ""}`}
            onClick={() => props.onChange({ visible: !annotation.visible })}
          >
            <i />
            {annotation.visible
              ? tr(locale, "显示", "Visible")
              : tr(locale, "隐藏", "Hidden")}
          </button>
        </label>
        <label className="field">
          <span>{tr(locale, "锁定", "Lock")}</span>
          <button
            className={`toggle ${annotation.locked ? "on" : ""}`}
            onClick={() => props.onChange({ locked: !annotation.locked })}
          >
            <i />
            {annotation.locked
              ? tr(locale, "已锁定", "Locked")
              : tr(locale, "未锁定", "Unlocked")}
          </button>
        </label>
      </div>
      <label className="field compact-opacity">
        <span>{tr(locale, "标签尺寸", "Annotation size")}</span>
        <output>{Math.round((annotation.size ?? 1) * 100)}%</output>
      </label>
      <input
        disabled={annotation.locked}
        className="range"
        type="range"
        min="0.35"
        max="3"
        step="0.05"
        value={annotation.size ?? 1}
        onChange={(event) =>
          props.onChange({ size: Number(event.target.value) })
        }
      />
      <TransformFields
        disabled={annotation.locked}
        title={tr(locale, "锚点位置", "Anchor position")}
        transform={annotation.position}
        onChange={props.onPositionChange}
      />
      <div className="annotation-binding">
        <span>{tr(locale, "绑定对象", "Bound object")}</span>
        <strong>
          {annotation.anchorName ||
            tr(locale, "未绑定构件", "No component bound")}
        </strong>
        {annotation.modelId && (
          <small>
            {tr(locale, "模型", "Model")} {annotation.modelId}
            {annotation.layerId
              ? ` · ${tr(locale, "图层", "Layer")} ${annotation.layerId}`
              : ""}
            {` · ${tr(locale, "随对象移动", "Follows object")}`}
          </small>
        )}
      </div>
      <button
        className="button remove-scene"
        disabled={annotation.locked}
        onClick={props.onDelete}
      >
        <Trash2 size={16} />
        {tr(locale, "删除标签", "Delete annotation")}
      </button>
    </div>
  );
}
