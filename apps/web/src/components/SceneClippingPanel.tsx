import { X } from "lucide-react";
import type { ClippingState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

type Axis = "x" | "y" | "z";
type Bounds = { min: Record<Axis, number>; max: Record<Axis, number> };

interface SceneClippingPanelProps {
  locale: AppLocale;
  value: ClippingState;
  axisRange: { min: number; max: number };
  sceneBounds: Bounds;
  onModeChange: (mode: "axis" | "box" | "face") => void;
  onChange: (patch: Partial<ClippingState>) => void;
  onBoxChange: (axis: Axis, edge: "min" | "max", value: number) => void;
  onResetBounds: () => void;
  onClose: () => void;
}

const AXES: Axis[] = ["x", "y", "z"];

export function SceneClippingPanel(props: SceneClippingPanelProps) {
  const { locale, value, sceneBounds } = props;
  const mode = value.mode ?? "axis";

  return (
    <div
      className={`clipping-bar clipping-${mode}`}
      aria-label={tr(locale, "剖切设置", "Section settings")}
    >
      <div className="clipping-tabs">
        <span>{tr(locale, "剖切", "Section")}</span>
        <button
          className={mode === "box" ? "active" : ""}
          onClick={() => props.onModeChange("box")}
        >
          {tr(locale, "剖切盒", "Section box")}
        </button>
        <button
          className={mode === "axis" ? "active" : ""}
          onClick={() => props.onModeChange("axis")}
        >
          {tr(locale, "轴向剖切", "Axis section")}
        </button>
        <button
          className={mode === "face" ? "active" : ""}
          onClick={() => props.onModeChange("face")}
        >
          {tr(locale, "拾取面", "Pick face")}
        </button>
        <button
          title={tr(locale, "关闭剖切", "Close section tool")}
          onClick={props.onClose}
        >
          <X size={14} />
        </button>
      </div>
      {mode === "axis" && (
        <div className="clipping-axis-controls">
          {AXES.map((axis) => (
            <button
              key={axis}
              className={value.axis === axis ? "active" : ""}
              onClick={() => props.onChange({ axis })}
            >
              {axis.toUpperCase()}
            </button>
          ))}
          <input
            type="range"
            min={props.axisRange.min}
            max={props.axisRange.max}
            step={Math.max(
              (props.axisRange.max - props.axisRange.min) / 200,
              0.001,
            )}
            value={value.offset}
            onChange={(event) =>
              props.onChange({ offset: Number(event.target.value) })
            }
            aria-label={tr(locale, "剖切位置", "Section position")}
          />
          <output>{value.offset.toFixed(2)} m</output>
          <button
            className={value.inverted ? "active" : ""}
            onClick={() => props.onChange({ inverted: !value.inverted })}
          >
            {tr(locale, "反向", "Invert")}
          </button>
        </div>
      )}
      {mode === "box" && (
        <div className="clipping-box-controls">
          {AXES.map((axis) => (
            <div className="clipping-bound-row" key={axis}>
              <strong>{axis.toUpperCase()}</strong>
              <span>{tr(locale, "最小", "Min")}</span>
              <input
                type="range"
                min={sceneBounds.min[axis]}
                max={sceneBounds.max[axis]}
                step={Math.max(
                  (sceneBounds.max[axis] - sceneBounds.min[axis]) / 200,
                  0.001,
                )}
                value={(value.box ?? sceneBounds).min[axis]}
                onChange={(event) =>
                  props.onBoxChange(axis, "min", Number(event.target.value))
                }
              />
              <span>{tr(locale, "最大", "Max")}</span>
              <input
                type="range"
                min={sceneBounds.min[axis]}
                max={sceneBounds.max[axis]}
                step={Math.max(
                  (sceneBounds.max[axis] - sceneBounds.min[axis]) / 200,
                  0.001,
                )}
                value={(value.box ?? sceneBounds).max[axis]}
                onChange={(event) =>
                  props.onBoxChange(axis, "max", Number(event.target.value))
                }
              />
            </div>
          ))}
          <button onClick={props.onResetBounds}>
            {tr(locale, "重置边界", "Reset bounds")}
          </button>
          <button
            className={value.showHelper === false ? "" : "active"}
            onClick={() =>
              props.onChange({ showHelper: value.showHelper === false })
            }
          >
            {tr(locale, "显示边框", "Show outline")}
          </button>
        </div>
      )}
      {mode === "face" && (
        <div className="clipping-face-controls">
          <span>
            {value.face
              ? tr(locale, "剖切面已建立", "Section plane created")
              : tr(locale, "请在模型上点击一个面", "Click a face on the model")}
          </span>
          <button onClick={() => props.onModeChange("face")}>
            {tr(locale, "重新拾取", "Pick again")}
          </button>
          <button
            className={value.inverted ? "active" : ""}
            disabled={!value.face}
            onClick={() => props.onChange({ inverted: !value.inverted })}
          >
            {tr(locale, "反向", "Invert")}
          </button>
        </div>
      )}
    </div>
  );
}
