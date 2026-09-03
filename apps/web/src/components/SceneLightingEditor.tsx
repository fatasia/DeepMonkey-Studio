import { Lightbulb, Trash2 } from "lucide-react";
import type {
  GlobalLightingState,
  SceneLightState,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";

interface SceneLightingEditorProps {
  locale: AppLocale;
  lighting: GlobalLightingState;
  selectedLightId: string;
  onLightingChange: (next: GlobalLightingState) => void;
  onSelectLight: (id: string) => void;
  onAddLight: (type: SceneLightState["type"]) => void;
  onUpdateLight: (id: string, patch: Partial<SceneLightState>) => void;
  onRemoveLight: (id: string) => void;
}

const AXES = ["x", "y", "z"] as const;

export function SceneLightingEditor(props: SceneLightingEditorProps) {
  const { locale, lighting } = props;
  const selectedLight =
    lighting.lights?.find((light) => light.id === props.selectedLightId) ??
    lighting.lights?.[0];

  return (
    <>
      <div className="environment-row environment-light-row">
        <span>{tr(locale, "灯光", "Lighting")}</span>
        <button
          className={`lighting-toggle ${lighting.enabled ? "active" : ""}`}
          aria-label={
            lighting.enabled
              ? tr(locale, "关闭全局灯光", "Disable global lighting")
              : tr(locale, "开启全局灯光", "Enable global lighting")
          }
          title={
            lighting.enabled
              ? tr(locale, "关闭全局灯光", "Disable global lighting")
              : tr(locale, "开启全局灯光", "Enable global lighting")
          }
          onClick={() =>
            props.onLightingChange({ ...lighting, enabled: !lighting.enabled })
          }
        >
          <Lightbulb size={15} />
        </button>
        <input
          type="range"
          min="0"
          max="2.5"
          step="0.05"
          value={lighting.intensity}
          disabled={!lighting.enabled}
          onChange={(event) =>
            props.onLightingChange({
              ...lighting,
              intensity: Number(event.target.value),
            })
          }
          aria-label={tr(locale, "全局灯光强度", "Global lighting intensity")}
        />
        <output>{Math.round(lighting.intensity * 100)}%</output>
      </div>
      <div className="environment-row environment-switches">
        <span>{tr(locale, "渲染", "Rendering")}</span>
        <button
          className={lighting.shadowsEnabled ? "active" : ""}
          onClick={() =>
            props.onLightingChange({
              ...lighting,
              shadowsEnabled: !lighting.shadowsEnabled,
            })
          }
        >
          {tr(locale, "阴影", "Shadows")}
        </button>
        <button
          className={lighting.reflectionsEnabled ? "active" : ""}
          onClick={() =>
            props.onLightingChange({
              ...lighting,
              reflectionsEnabled: !lighting.reflectionsEnabled,
            })
          }
        >
          {tr(locale, "反射", "Reflections")}
        </button>
      </div>
      <div className="environment-row environment-gi-row">
        <span>{tr(locale, "全局光照", "Global illumination")}</span>
        <button
          className={lighting.globalIlluminationEnabled ? "active" : ""}
          onClick={() =>
            props.onLightingChange({
              ...lighting,
              globalIlluminationEnabled: !lighting.globalIlluminationEnabled,
            })
          }
        >
          {lighting.globalIlluminationEnabled
            ? tr(locale, "已开启", "On")
            : tr(locale, "已关闭", "Off")}
        </button>
        <input
          type="range"
          min="0"
          max="2"
          step="0.05"
          value={lighting.globalIlluminationIntensity ?? 0.45}
          disabled={!lighting.globalIlluminationEnabled}
          onChange={(event) =>
            props.onLightingChange({
              ...lighting,
              globalIlluminationIntensity: Number(event.target.value),
            })
          }
        />
        <output>
          {(lighting.globalIlluminationIntensity ?? 0.45).toFixed(2)}
        </output>
        <small>
          {tr(
            locale,
            "环境漫反射近似，默认关闭",
            "Environment diffuse approximation, off by default",
          )}
        </small>
      </div>
      <div className="light-system">
        <div className="light-system-head">
          <span>{tr(locale, "光源", "Lights")}</span>
          <select
            value=""
            onChange={(event) =>
              event.target.value &&
              props.onAddLight(event.target.value as SceneLightState["type"])
            }
          >
            <option value="">+ {tr(locale, "添加光源", "Add light")}</option>
            <option value="ambient">{tr(locale, "环境光", "Ambient")}</option>
            <option value="hemisphere">
              {tr(locale, "半球光", "Hemisphere")}
            </option>
            <option value="directional">
              {tr(locale, "方向光", "Directional")}
            </option>
            <option value="point">{tr(locale, "点光源", "Point")}</option>
            <option value="spot">{tr(locale, "聚光灯", "Spot")}</option>
            <option value="rectArea">
              {tr(locale, "矩形区域光", "Rect area")}
            </option>
          </select>
        </div>
        <div className="light-tabs">
          {(lighting.lights ?? []).map((light) => (
            <button
              key={light.id}
              className={selectedLight?.id === light.id ? "active" : ""}
              onClick={() => props.onSelectLight(light.id)}
            >
              <i style={{ background: light.color }} />
              {light.name}
            </button>
          ))}
        </div>
        {selectedLight && (
          <LightEditor
            locale={locale}
            light={selectedLight}
            onUpdate={(patch) => props.onUpdateLight(selectedLight.id, patch)}
            onRemove={() => props.onRemoveLight(selectedLight.id)}
          />
        )}
      </div>
    </>
  );
}

function LightEditor({
  locale,
  light,
  onUpdate,
  onRemove,
}: {
  locale: AppLocale;
  light: SceneLightState;
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
        <label className="light-parameter">
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
        </label>
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
