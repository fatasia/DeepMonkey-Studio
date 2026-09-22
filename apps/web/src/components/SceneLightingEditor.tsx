import { SceneLightEditor } from "./SceneLightEditor";
import { Lightbulb } from "lucide-react";
import type {
  GlobalLightingState,
  SceneLightState,
} from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

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


export function SceneLightingEditor(props: SceneLightingEditorProps) {
  const { locale, lighting } = props;
  const selectedLight = lighting.lights?.find((light) => light.id === props.selectedLightId);

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
          title={tr(locale, "环境漫反射近似", "Environment diffuse approximation")}
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
          <SceneLightEditor
            locale={locale}
            lighting={lighting}
            light={selectedLight}
            onLightingChange={props.onLightingChange}
            onUpdate={(patch) => props.onUpdateLight(selectedLight.id, patch)}
            onRemove={() => props.onRemoveLight(selectedLight.id)}
          />
        )}
      </div>
    </>
  );
}
