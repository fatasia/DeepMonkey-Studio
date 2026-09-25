import { Cloud, CloudFog, CloudLightning, CloudRain, Eye, EyeOff, Snowflake, Sun, X } from "lucide-react";
import type { ProbeGridBakeGrid } from "@bim-studio/deep-engine";
import type {
  GlobalLightingState,
  SceneCoordinateSystemState,
  SceneEnvironmentState,
  SceneLightState,
  ScenePostProcessingState,
  WeatherMode,
  ProjectAssetRecord,
} from "@bim-studio/contracts";
import { SKYBOX_OPTIONS } from "../appDefaults";
import { skyboxEnglishLabel } from "../appPresentation";
import { applySceneEnvironmentPreset, SCENE_ENVIRONMENT_PRESETS } from "../environment/sceneEnvironmentPresets";
import { translate as tr, type AppLocale } from "../i18n";
import { SceneCoordinateEditor } from "./SceneCoordinateEditor";
import { SceneLightingEditor } from "./SceneLightingEditor";
import type { ProbeGridBakeUiState } from "./SceneProbeGridBakePanel";
import { ScenePostProcessingEditor } from "./ScenePostProcessingEditor";
import { ProjectEnvironmentResourcePicker } from "./ProjectAppearanceResources";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import type { RendererBackend } from "../viewer/ViewerEngine";

interface SceneEnvironmentPanelProps {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  coordinates: SceneCoordinateSystemState;
  weather: WeatherMode;
  environment: SceneEnvironmentState;
  lighting: GlobalLightingState;
  postProcessing: ScenePostProcessingState;
  selectedLightId: string;
  onCoordinatesChange: (next: SceneCoordinateSystemState) => void;
  onWeatherChange: (next: WeatherMode) => void;
  onEnvironmentChange: (next: SceneEnvironmentState) => void;
  onLightingChange: (next: GlobalLightingState) => void;
  onPostProcessingChange: (next: ScenePostProcessingState) => void;
  onChooseEnvironmentMap: () => void;
  onSelectLight: (id: string) => void;
  onAddLight: (type: SceneLightState["type"]) => void;
  onUpdateLight: (id: string, patch: Partial<SceneLightState>) => void;
  onRemoveLight: (id: string) => void;
  /** F3 探针网格烘焙：可选；透传给灯光编辑器的 GI 区块。 */
  probeBakeState?: ProbeGridBakeUiState;
  onBakeProbeGrid?: (grid: ProbeGridBakeGrid) => void;
  projectAssets?: ProjectAssetRecord[];
  onClose?: () => void;
}

export function SceneEnvironmentPanel(props: SceneEnvironmentPanelProps) {
  const { locale, environment } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();

  const applyPreset = (preset: (typeof SCENE_ENVIRONMENT_PRESETS)[number]) => {
    const next = applySceneEnvironmentPreset(preset, {
      environment: props.environment,
      lighting: props.lighting,
      postProcessing: props.postProcessing
    });
    props.onWeatherChange(next.weather);
    props.onEnvironmentChange(next.environment);
    props.onLightingChange(next.lighting);
    props.onPostProcessingChange(next.postProcessing);
  };

  return (
    <div
      ref={drag.panelRef}
      style={drag.style}
      className="environment-control"
      aria-label={tr(
        locale,
        "环境与全局灯光",
        "Environment and global lighting",
      )}
    >
      <div
        className="environment-heading"
        data-drag-handle="true"
        title={tr(locale, "拖动标题栏移动环境面板", "Drag the title bar to move the environment panel")}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      >
        <strong title={tr(locale, "随场景保存", "Saved with scene")}>{tr(locale, "场景环境", "Scene environment")}</strong>
        {props.onClose && <button type="button" onClick={props.onClose} aria-label={tr(locale, "关闭环境与灯光", "Close environment and lighting")} title={tr(locale, "关闭环境与灯光", "Close environment and lighting")}><X size={15} /></button>}
      </div>
      <section className="environment-preset-library" aria-label={tr(locale, "快速环境", "Environment looks")}>
        <div className="environment-preset-title">
          <div>
            <strong>{tr(locale, "快速环境", "Environment looks")}</strong>
            <small>{tr(locale, "一键获得完整光照与氛围", "Lighting and atmosphere in one click")}</small>
          </div>
          <span>{SCENE_ENVIRONMENT_PRESETS.length}</span>
        </div>
        <div className="environment-preset-strip">
          {SCENE_ENVIRONMENT_PRESETS.map((preset) => (
            <button
              key={preset.id}
              className={props.weather === preset.weather && environment.skybox === preset.skybox ? "active" : ""}
              title={tr(locale, preset.description, preset.englishDescription)}
              onClick={() => applyPreset(preset)}
            >
              <i style={{ background: `linear-gradient(160deg, ${preset.preview.join(", ")})` }} />
              <span>
                <strong>{tr(locale, preset.name, preset.englishName)}</strong>
                <small>{tr(locale, preset.cost === "low" ? "轻量" : "均衡", preset.cost === "low" ? "Light" : "Balanced")}</small>
              </span>
            </button>
          ))}
        </div>
      </section>
      <SceneCoordinateEditor
        locale={locale}
        value={props.coordinates}
        onChange={props.onCoordinatesChange}
      />
      <div className="environment-row">
        <span>{tr(locale, "天气", "Weather")}</span>
        <div className="environment-weather">
          <button
            className={props.weather === "sunny" ? "active" : ""}
            title={tr(locale, "晴天", "Sunny")}
            aria-label={tr(locale, "晴天", "Sunny")}
            onClick={() => props.onWeatherChange("sunny")}
          >
            <Sun size={15} />
          </button>
          <button
            className={props.weather === "cloudy" ? "active" : ""}
            title={tr(locale, "阴天", "Cloudy")}
            aria-label={tr(locale, "阴天", "Cloudy")}
            onClick={() => props.onWeatherChange("cloudy")}
          >
            <Cloud size={15} />
          </button>
          <button
            className={props.weather === "rain" ? "active" : ""}
            title={tr(locale, "下雨", "Rain")}
            aria-label={tr(locale, "下雨", "Rain")}
            onClick={() => props.onWeatherChange("rain")}
          >
            <CloudRain size={15} />
          </button>
          <button
            className={props.weather === "snow" ? "active" : ""}
            title={tr(locale, "下雪", "Snow")}
            aria-label={tr(locale, "下雪", "Snow")}
            onClick={() => props.onWeatherChange("snow")}
          >
            <Snowflake size={15} />
          </button>
          <button
            className={props.weather === "fog" ? "active" : ""}
            title={tr(locale, "雾天", "Fog")}
            aria-label={tr(locale, "雾天", "Fog")}
            onClick={() => props.onWeatherChange("fog")}
          >
            <CloudFog size={15} />
          </button>
          <button
            className={props.weather === "storm" ? "active" : ""}
            title={tr(locale, "暴雨", "Storm")}
            aria-label={tr(locale, "暴雨", "Storm")}
            onClick={() => props.onWeatherChange("storm")}
          >
            <CloudLightning size={15} />
          </button>
        </div>
      </div>
      <div className="environment-row">
        <span>{tr(locale, "天空", "Sky")}</span>
        <div className="skybox-presets">
          {SKYBOX_OPTIONS.map((option) => (
            <button
              key={option.value}
              className={`${environment.skybox === option.value ? "active " : ""}skybox-${option.value}`}
              onClick={() =>
                props.onEnvironmentChange({
                  ...environment,
                  skybox: option.value,
                })
              }
            >
              {tr(locale, option.label, skyboxEnglishLabel(option.value))}
            </button>
          ))}
        </div>
      </div>
      <div className="environment-row environment-compact-row">
        <span>{tr(locale, "背景", "Background")}</span>
        <label
          className={
            environment.skybox === "none"
              ? "environment-color"
              : "environment-color disabled"
          }
          title={
            environment.skybox === "none"
              ? tr(locale, "设置纯色背景", "Set solid background")
              : tr(
                  locale,
                  "选择纯色天空后可设置背景颜色",
                  "Choose solid sky to set the background color",
                )
          }
        >
          <input
            type="color"
            value={environment.backgroundColor}
            disabled={environment.skybox !== "none"}
            onChange={(event) =>
              props.onEnvironmentChange({
                ...environment,
                backgroundColor: event.target.value,
              })
            }
            aria-label={tr(locale, "场景背景颜色", "Scene background color")}
          />
          <output>{environment.backgroundColor.toUpperCase()}</output>
        </label>
        <button
          className={`grid-toggle ${environment.gridVisible ? "active" : ""}`}
          title={
            environment.gridVisible
              ? tr(locale, "隐藏网格", "Hide grid")
              : tr(locale, "显示网格", "Show grid")
          }
          onClick={() =>
            props.onEnvironmentChange({
              ...environment,
              gridVisible: !environment.gridVisible,
            })
          }
        >
          {environment.gridVisible ? <Eye size={14} /> : <EyeOff size={14} />}
          {tr(locale, "网格", "Grid")}
        </button>
      </div>
      <SceneLightingEditor
        locale={locale}
        lighting={props.lighting}
        selectedLightId={props.selectedLightId}
        onLightingChange={props.onLightingChange}
        onSelectLight={props.onSelectLight}
        onAddLight={props.onAddLight}
        onUpdateLight={props.onUpdateLight}
        onRemoveLight={props.onRemoveLight}
        {...(props.probeBakeState && props.onBakeProbeGrid
          ? { probeBakeState: props.probeBakeState, onBakeProbeGrid: props.onBakeProbeGrid } : {})}
      />
      <ScenePostProcessingEditor
        locale={locale}
        rendererBackend={props.rendererBackend}
        value={props.postProcessing}
        onChange={props.onPostProcessingChange}
      />
      <div className="environment-map-row">
        <div>
          <span>{tr(locale, "环境贴图", "Environment map")}</span>
          <small title={environment.environmentMapName}>
            {environment.environmentMapName ??
              tr(locale, "未选择 HDR / EXR", "No HDR / EXR selected")}
          </small>
        </div>
        <button onClick={props.onChooseEnvironmentMap}>
          {tr(locale, "上传", "Upload")}
        </button>
        {environment.environmentMapUrl && (
          <button
            onClick={() => {
              const next = { ...environment };
              delete next.environmentMapUrl;
              delete next.environmentMapName;
              props.onEnvironmentChange(next);
            }}
          >
            {tr(locale, "清除", "Clear")}
          </button>
        )}
        <label>
          <input
            type="checkbox"
            checked={environment.environmentAsBackground ?? false}
            onChange={(event) =>
              props.onEnvironmentChange({
                ...environment,
                environmentAsBackground: event.target.checked,
              })
            }
          />
          {tr(locale, "作为背景", "Use as background")}
        </label>
      </div>
      <ProjectEnvironmentResourcePicker locale={locale} assets={props.projectAssets ?? []} value={environment} onApply={props.onEnvironmentChange} />
    </div>
  );
}
