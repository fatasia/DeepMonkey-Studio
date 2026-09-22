import { Trash2 } from "lucide-react";
import type { GlobalLightingState, SceneLightState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";
import { SceneIesEditor } from "./SceneIesEditor";
import { SceneSpotShadowEditor } from "./SceneSpotShadowEditor";
import { SceneLightParameters } from "./SceneLightParameters";
import "./SceneLightEditor.css";
const AXES = ["x", "y", "z"] as const;
export function SceneLightEditor({
  locale,
  lighting,
  light,
  onLightingChange,
  onUpdate,
  onRemove,
}: {
  locale: AppLocale;
  lighting: GlobalLightingState;
  light: SceneLightState;
  onLightingChange: (next: GlobalLightingState) => void;
  onUpdate: (patch: Partial<SceneLightState>) => void;
  onRemove: () => void;
}) {
  return (
    <div className="light-editor">
      <label>
        <span>{tr(locale, "名称", "Name")}</span>
        <input
          value={light.name}
          onChange={(event) => onUpdate({ name: event.target.value })}
        />
      </label>
      <label>
        <span>{tr(locale, "颜色", "Color")}</span>
        <input
          type="color"
          value={light.color}
          onChange={(event) => onUpdate({ color: event.target.value })}
        />
      </label>
      <label className="light-intensity">
        <span>{tr(locale, "强度", "Intensity")}</span>
        <input
          type="range"
          min="0"
          max="20"
          step="0.05"
          value={light.intensity}
          onChange={(event) =>
            onUpdate({ intensity: Number(event.target.value) })
          }
        />
        <output>{light.intensity.toFixed(2)}</output>
      </label>
      <SceneLightParameters locale={locale} light={light} onUpdate={onUpdate} />
      {light.position && (
        <LightVector
          label={tr(locale, "位置", "Position")}
          value={light.position}
          onChange={(position) => onUpdate({ position })}
        />
      )}
      {["directional", "spot", "rectArea"].includes(light.type) &&
        light.target && (
          <LightVector
            label={tr(locale, "照射目标", "Target")}
            value={light.target}
            onChange={(target) => onUpdate({ target })}
          />
        )}
      {light.type === "spot" && (
        <><label className="light-parameter">
          <span>{tr(locale, "锥角", "Cone")}</span>
          <input
            type="range"
            min="5"
            max="90"
            step="1"
            value={((light.angle ?? Math.PI / 6) * 180) / Math.PI}
            onChange={(event) =>
              onUpdate({ angle: (Number(event.target.value) * Math.PI) / 180 })
            }
          />
          <output>
            {Math.round(((light.angle ?? Math.PI / 6) * 180) / Math.PI)}°
          </output>
        </label></>
      )}
      {light.type === "rectArea" && (
        <div className="light-size">
          <label>
            <span>{tr(locale, "宽", "Width")}</span>
            <DeferredNumberInput
              min={0.1}
              step={0.5}
              value={light.width ?? 6}
              onCommit={(width) => onUpdate({ width })}
            />
          </label>
          <label>
            <span>{tr(locale, "高", "Height")}</span>
            <DeferredNumberInput
              min={0.1}
              step={0.5}
              value={light.height ?? 4}
              onCommit={(height) => onUpdate({ height })}
            />
          </label>
        </div>
      )}
      <button
        className={light.enabled ? "active" : ""}
        onClick={() => onUpdate({ enabled: !light.enabled })}
      >
        {light.enabled
          ? tr(locale, "已启用", "Enabled")
          : tr(locale, "已关闭", "Disabled")}
      </button>
      {["directional", "point", "spot"].includes(light.type) && (
        <button
          className={light.castShadow ? "active" : ""}
          onClick={() => onUpdate({ castShadow: !light.castShadow })}
        >
          {tr(locale, "投射阴影", "Cast shadow")}
        </button>
      )}
      {light.type === "spot" && <details className="light-advanced">
        <summary>{tr(locale, "高级灯光", "Advanced lighting")}</summary>
        <div className="light-advanced-fields">
          <SceneIesEditor locale={locale} lighting={lighting} light={light} onLightingChange={onLightingChange} onUpdate={onUpdate} />
          <SceneSpotShadowEditor locale={locale} light={light} onUpdate={onUpdate} />
        </div>
      </details>}
      <button
        className="danger"
        aria-label={tr(locale, "删除光源", "Delete light")}
        title={tr(locale, "删除光源", "Delete light")}
        onClick={onRemove}
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

function LightVector({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { x: number; y: number; z: number };
  onChange: (value: { x: number; y: number; z: number }) => void;
}) {
  return (
    <div className="light-vector">
      <span>{label}</span>
      {AXES.map((axis) => (
        <label key={axis}>
          <i>{axis.toUpperCase()}</i>
          <DeferredNumberInput
            step={0.5}
            value={value[axis]}
            onCommit={(next) => onChange({ ...value, [axis]: next })}
          />
        </label>
      ))}
    </div>
  );
}
