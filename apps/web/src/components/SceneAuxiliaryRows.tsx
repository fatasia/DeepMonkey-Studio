import { Eye, EyeOff, Lightbulb, LocateFixed, Lock, MapPin, Move, Ruler, Trash2, Unlock } from "lucide-react";
import type { MeasurementState, SceneAnnotationState, SceneLightState } from "@bim-studio/contracts";
import { formatMeasurementValue, lightTypeEnglishName, lightTypeName, measureModeName } from "../appPresentation";
import { translate as tr, type AppLocale } from "../i18n";
import { SceneRowMenu } from "./SceneRowMenu";
import type { FlatSceneObjectListProps } from "./sceneObjectListTypes";

type LightProps = Pick<FlatSceneObjectListProps, "locale" | "engine" | "selectedLightId" | "onLightSelect" | "onEnvironmentOpen" | "onLightUpdate" | "onLightTransform" | "onLightRemove">;
type AnnotationProps = Pick<FlatSceneObjectListProps, "locale" | "engine" | "selectedAnnotationId" | "selectedLightId" | "onAnnotationUpdate" | "onAnnotationRemove">;

export function LightRow(
  props: LightProps & { light: SceneLightState },
) {
  const { light, locale } = props;
  const canMove = !["ambient", "hemisphere"].includes(light.type);
  const canAim = ["directional", "spot", "rectArea"].includes(light.type);
  return (
    <div data-layer-keyboard-row=""
      className={`asset-row scene-object-row ${props.selectedLightId === light.id ? "selected" : ""}`}
    >
      <span className="scene-row-selection-mark" aria-hidden="true" />
      <button
        className="asset-main"
        title={tr(locale, "选择光源", "Select light")}
        aria-pressed={props.selectedLightId === light.id}
        onClick={() => {
          const selected = props.selectedLightId === light.id;
          if (!selected) props.engine?.select(undefined);
          props.onLightSelect(light.id);
          props.onEnvironmentOpen();
        }}
      >
        <span
          className="scene-object-badge light-layer-badge"
          style={{ color: light.color }}
        >
          <Lightbulb size={15} />
        </span>
        <span className="asset-copy">
          <strong>{light.name}</strong>
          <small>
            {tr(
              locale,
              lightTypeName(light.type),
              lightTypeEnglishName(light.type),
            )}
          </small>
        </span>
      </button>
      <button
        className="mini-button"
        aria-label={light.enabled ? tr(locale, "关闭光源", "Disable light") : tr(locale, "开启光源", "Enable light")}
        title={
          light.enabled
            ? tr(locale, "关闭光源", "Disable light")
            : tr(locale, "开启光源", "Enable light")
        }
        onClick={() =>
          props.onLightUpdate(light.id, { enabled: !light.enabled })
        }
      >
        {light.enabled ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <SceneRowMenu locale={locale}>
      {canMove && (
        <button
          aria-label={tr(locale, "移动光源", "Move light")}
          title={tr(locale, "移动光源", "Move light")}
          onClick={() => props.onLightTransform(light, "position")}
        >
          <Move size={14} /><span>{tr(locale, "移动", "Move")}</span>
        </button>
      )}
      {canAim && (
        <button
          aria-label={tr(locale, "改变光照方向", "Change light direction")}
          title={tr(locale, "改变光照方向", "Change light direction")}
          onClick={() => props.onLightTransform(light, "target")}
        >
          <LocateFixed size={14} /><span>{tr(locale, "调整方向", "Aim")}</span>
        </button>
      )}
      <button
        className="danger"
        data-layer-action="delete"
        aria-label={tr(locale, "删除光源", "Delete light")}
        title={tr(locale, "删除光源", "Delete light")}
        onClick={() => props.onLightRemove(light.id)}
      >
        <Trash2 size={15} /><span>{tr(locale, "删除", "Delete")}</span>
      </button>
      </SceneRowMenu>
    </div>
  );
}

export function MeasurementRow({
  locale,
  measurement,
  index,
  onFocus,
  onRemove,
}: {
  locale: AppLocale;
  measurement: MeasurementState;
  index: number;
  onFocus: () => void;
  onRemove: () => void;
}) {
  return (
    <div data-layer-keyboard-row="" className="asset-row scene-object-row">
      <button className="asset-main" title={tr(locale, "定位测量", "Locate measurement")} onClick={onFocus}>
        <span className="scene-object-badge">
          <Ruler size={15} />
        </span>
        <span className="asset-copy">
          <strong>
            {tr(locale, "测量", "Measurement")} {index + 1}
          </strong>
          <small>
            {measureModeName(measurement.kind ?? "distance", locale)} ·{" "}
            {formatMeasurementValue(measurement)}
          </small>
        </span>
      </button>
      <SceneRowMenu locale={locale}>
      <button
        className="danger"
        data-layer-action="delete"
        aria-label={`${tr(locale, "删除标尺", "Delete measurement")} ${index + 1}`}
        title={`${tr(locale, "删除标尺", "Delete measurement")} ${index + 1}`}
        onClick={onRemove}
      >
        <Trash2 size={15} /><span>{tr(locale, "删除", "Delete")}</span>
      </button>
      </SceneRowMenu>
    </div>
  );
}

export function AnnotationRow(
  props: AnnotationProps & { annotation: SceneAnnotationState },
) {
  const { annotation, locale } = props;
  return (
    <div data-layer-keyboard-row=""
      className={`asset-row scene-object-row ${props.selectedAnnotationId === annotation.id ? "selected" : ""}`}
    >
      <button
        className="asset-main"
        title={tr(locale, "单击选择标签；双击聚焦", "Click to select annotation; double-click to focus")}
        aria-pressed={props.selectedAnnotationId === annotation.id}
        onClick={() => {
          if (props.selectedLightId) props.engine?.select(undefined);
          props.engine?.selectAnnotation(annotation.id);
        }}
        onDoubleClick={() => props.engine?.focusAnnotation(annotation.id)}
      >
        <span
          className="scene-object-badge annotation-badge"
          style={{ color: annotation.color }}
        >
          <MapPin size={15} />
        </span>
        <span className="asset-copy">
          <strong>{annotation.name}</strong>
          <small>
            {annotation.anchorName ||
              tr(locale, "场景标签", "Scene annotation")}
          </small>
        </span>
      </button>
      <button
        className="mini-button"
        aria-label={annotation.visible ? tr(locale, "隐藏标签", "Hide annotation") : tr(locale, "显示标签", "Show annotation")}
        title={
          annotation.visible
            ? tr(locale, "隐藏标签", "Hide annotation")
            : tr(locale, "显示标签", "Show annotation")
        }
        onClick={() =>
          props.onAnnotationUpdate(annotation.id, {
            visible: !annotation.visible,
          })
        }
      >
        {annotation.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <button
        className={`mini-button ${annotation.locked ? "active" : ""}`}
        aria-label={annotation.locked ? tr(locale, "解锁标签", "Unlock annotation") : tr(locale, "锁定标签", "Lock annotation")}
        title={
          annotation.locked
            ? tr(locale, "解锁标签", "Unlock annotation")
            : tr(locale, "锁定标签", "Lock annotation")
        }
        onClick={() =>
          props.onAnnotationUpdate(annotation.id, {
            locked: !annotation.locked,
          })
        }
      >
        {annotation.locked ? <Lock size={14} /> : <Unlock size={14} />}
      </button>
      <SceneRowMenu locale={locale}>
        <button
          className="danger"
          data-layer-action="delete"
          disabled={annotation.locked}
          aria-label={annotation.locked ? tr(locale, "请先解锁标签", "Unlock the annotation first") : tr(locale, "删除标签", "Delete annotation")}
          title={
            annotation.locked
              ? tr(locale, "请先解锁标签", "Unlock the annotation first")
              : tr(locale, "删除标签", "Delete annotation")
          }
          onClick={() => props.onAnnotationRemove(annotation.id)}
        >
          <Trash2 size={15} /><span>{tr(locale, "删除", "Delete")}</span>
        </button>
      </SceneRowMenu>
    </div>
  );
}
