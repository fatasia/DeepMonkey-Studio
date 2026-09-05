import type { Dispatch, SetStateAction } from "react";
import { Lightbulb, Move3D, Plus, Rotate3D, Trash2 } from "lucide-react";
import { DEFAULT_BAKE_LIGHTS, type BakeLightState, type BakeLightType, type ModelOptimizationOptions } from "../optimizer/modelOptimizer";
import { translate as tr, type AppLocale } from "../i18n";
import { BakeVector, currentLightmapQuality, OptionSection } from "./ModelOptimizerFields";

interface Props {
  locale: AppLocale; options: ModelOptimizationOptions; setOptions: Dispatch<SetStateAction<ModelOptimizationOptions>>;
  selectedBakeLightId: string | undefined; setSelectedBakeLightId: Dispatch<SetStateAction<string | undefined>>;
  bakeTransformMode: "translate" | "rotate"; setBakeTransformMode: Dispatch<SetStateAction<"translate" | "rotate">>;
  updateBakeLight: (id: string, patch: Partial<BakeLightState>) => void;
}

/** 烘焙配置独立呈现；与视口共享选中光源和变换状态，不持有模型处理任务。 */
export function ModelOptimizerBaking({ locale, options, setOptions, selectedBakeLightId, setSelectedBakeLightId, bakeTransformMode, setBakeTransformMode, updateBakeLight }: Props) {
  function addBakeLight(type: BakeLightType) {
    const index = options.bakeLights.length + 1;
    const light: BakeLightState = {
      id: crypto.randomUUID(),
      name: type === "directional" ? `${tr(locale, "方向光", "Directional")} ${index}` : `${tr(locale, "点光源", "Point light")} ${index}`,
      type,
      enabled: true,
      color: "#ffffff",
      intensity: type === "directional" ? 0.75 : 1.4,
      direction: [0.35, 0.82, 0.45],
      position: [4, 8, 4],
      range: 20,
    };
    setOptions((current) => ({ ...current, bakeLights: [...current.bakeLights, light] }));
    setSelectedBakeLightId(light.id);
  }

  function applyBakePreset(preset: "outdoor" | "indoor") {
    const lights: BakeLightState[] =
      preset === "outdoor"
        ? structuredClone(DEFAULT_BAKE_LIGHTS)
        : [
            { ...structuredClone(DEFAULT_BAKE_LIGHTS[0]!), id: "bake-indoor-key", name: tr(locale, "室内主光", "Indoor key"), intensity: 0.65, direction: [0.45, 0.75, 0.48] },
            {
              ...structuredClone(DEFAULT_BAKE_LIGHTS[0]!),
              id: "bake-indoor-fill",
              name: tr(locale, "室内补光", "Indoor fill"),
              color: "#b8d8ff",
              intensity: 0.35,
              direction: [-0.55, 0.5, -0.35],
            },
          ];
    setOptions((current) => ({
      ...current,
      bakeEnabled: true,
      bakeStrength: preset === "outdoor" ? 0.35 : 0.45,
      bakeAmbient: preset === "outdoor" ? 0.28 : 0.42,
      bakeAmbientColor: preset === "outdoor" ? "#ffffff" : "#fff1dc",
      bakeLights: lights,
    }));
    setSelectedBakeLightId(lights[0]?.id);
    setBakeTransformMode("translate");
  }

  function applyLightmapQuality(quality: "draft" | "standard" | "high") {
    setOptions((current) => ({
      ...current,
      lightmapResolution: quality === "draft" ? 256 : quality === "standard" ? 512 : 1024,
      lightmapAoSamples: quality === "high" ? 8 : 4,
      lightmapShadowSamples: quality === "draft" ? 1 : quality === "standard" ? 4 : 8,
      lightmapIndirectSamples: quality === "draft" ? 0 : quality === "standard" ? 2 : 4,
      lightmapDenoise: quality !== "draft",
    }));
  }

  return (
  <OptionSection
    icon={<Lightbulb size={15} />}
    title={tr(locale, "轻量光照烘焙", "Lightweight light baking")}
    enabled={options.bakeEnabled}
    onToggle={(enabled) => setOptions({ ...options, bakeEnabled: enabled })}
  >
    <div className="optimizer-bake-mode">
      <button className={options.bakeMode === "vertex" ? "active" : ""} onClick={() => setOptions({ ...options, bakeMode: "vertex" })}>
        {tr(locale, "快速顶点色", "Vertex color")}
      </button>
      <button className={options.bakeMode === "lightmap" ? "active" : ""} onClick={() => setOptions({ ...options, bakeMode: "lightmap" })}>
        {tr(locale, "Web 光照贴图", "Web lightmap")}
      </button>
    </div>
    {options.bakeMode === "lightmap" && (
      <>
        <div className="optimizer-quality">
          <span>{tr(locale, "质量", "Quality")}</span>
          {(["draft", "standard", "high"] as const).map((quality) => (
            <button key={quality} className={currentLightmapQuality(options) === quality ? "active" : ""} onClick={() => applyLightmapQuality(quality)}>
              {quality === "draft" ? tr(locale, "草稿", "Draft") : quality === "standard" ? tr(locale, "标准", "Standard") : tr(locale, "高质量", "High")}
            </button>
          ))}
        </div>
        <div className="optimizer-lightmap-settings">
          <label>
            <span>{tr(locale, "贴图分辨率", "Resolution")}</span>
            <select
              value={options.lightmapResolution}
              onChange={(event) => setOptions({ ...options, lightmapResolution: Number(event.target.value) as ModelOptimizationOptions["lightmapResolution"] })}
            >
              <option value="256">256²</option>
              <option value="512">512²</option>
              <option value="1024">1024²</option>
            </select>
          </label>
          <label>
            <span>{tr(locale, "环境遮蔽 AO", "Ambient occlusion")}</span>
            <button
              className={options.lightmapAmbientOcclusion ? "active" : ""}
              onClick={() => setOptions({ ...options, lightmapAmbientOcclusion: !options.lightmapAmbientOcclusion })}
            >
              {options.lightmapAmbientOcclusion ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}
            </button>
          </label>
          <label>
            <span>{tr(locale, "静态阴影", "Static shadows")}</span>
            <button className={options.lightmapShadows ? "active" : ""} onClick={() => setOptions({ ...options, lightmapShadows: !options.lightmapShadows })}>
              {options.lightmapShadows ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}
            </button>
          </label>
          <label>
            <span>{tr(locale, "AO 采样", "AO samples")}</span>
            <select
              value={options.lightmapAoSamples}
              disabled={!options.lightmapAmbientOcclusion}
              onChange={(event) => setOptions({ ...options, lightmapAoSamples: Number(event.target.value) as ModelOptimizationOptions["lightmapAoSamples"] })}
            >
              <option value="4">4 · {tr(locale, "快速", "Fast")}</option>
              <option value="8">8 · {tr(locale, "精细", "Fine")}</option>
            </select>
          </label>
          <label>
            <span>{tr(locale, "软阴影采样", "Soft shadows")}</span>
            <select
              value={options.lightmapShadowSamples}
              disabled={!options.lightmapShadows}
              onChange={(event) => setOptions({ ...options, lightmapShadowSamples: Number(event.target.value) as ModelOptimizationOptions["lightmapShadowSamples"] })}
            >
              <option value="1">1 · {tr(locale, "硬阴影", "Hard")}</option>
              <option value="4">4</option>
              <option value="8">8</option>
            </select>
          </label>
          <label>
            <span>{tr(locale, "间接光反弹", "Indirect bounce")}</span>
            <select
              value={options.lightmapIndirectSamples}
              onChange={(event) => setOptions({ ...options, lightmapIndirectSamples: Number(event.target.value) as ModelOptimizationOptions["lightmapIndirectSamples"] })}
            >
              <option value="0">{tr(locale, "关闭", "Off")}</option>
              <option value="2">2 · {tr(locale, "快速", "Fast")}</option>
              <option value="4">4 · {tr(locale, "精细", "Fine")}</option>
            </select>
          </label>
          <label>
            <span>{tr(locale, "贴图降噪", "Denoise")}</span>
            <button className={options.lightmapDenoise ? "active" : ""} onClick={() => setOptions({ ...options, lightmapDenoise: !options.lightmapDenoise })}>
              {options.lightmapDenoise ? tr(locale, "开启", "On") : tr(locale, "关闭", "Off")}
            </button>
          </label>
        </div>
      </>
    )}
    <div className="optimizer-bake-presets">
      <span>{tr(locale, "快速预设", "Presets")}</span>
      <button onClick={() => applyBakePreset("outdoor")}>{tr(locale, "自然日光", "Daylight")}</button>
      <button onClick={() => applyBakePreset("indoor")}>{tr(locale, "室内均匀", "Indoor")}</button>
    </div>
    <label>
      <span>{tr(locale, "烘焙强度", "Bake strength")}</span>
      <output>{Math.round(options.bakeStrength * 100)}%</output>
      <input
        aria-label={tr(locale, "烘焙强度", "Bake strength")}
        type="range"
        min="0.05"
        max="0.8"
        step="0.05"
        value={options.bakeStrength}
        onChange={(event) => setOptions({ ...options, bakeStrength: Number(event.target.value) })}
      />
    </label>
    <label>
      <span>{tr(locale, "环境亮度", "Ambient level")}</span>
      <output>{Math.round(options.bakeAmbient * 100)}%</output>
      <input
        aria-label={tr(locale, "环境亮度", "Ambient level")}
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={options.bakeAmbient}
        onChange={(event) => setOptions({ ...options, bakeAmbient: Number(event.target.value) })}
      />
    </label>
    <div className="optimizer-ambient-color">
      <span>{tr(locale, "全局光颜色", "Global light color")}</span>
      <input aria-label={tr(locale, "全局光颜色", "Global light color")} type="color" value={options.bakeAmbientColor} onChange={(event) => setOptions({ ...options, bakeAmbientColor: event.target.value })} />
      <input
        className="optimizer-color-value"
        aria-label={tr(locale, "全局光颜色值", "Global light color value")}
        value={options.bakeAmbientColor}
        onChange={(event) => {
          if (/^#[0-9a-f]{6}$/i.test(event.target.value)) setOptions({ ...options, bakeAmbientColor: event.target.value });
        }}
      />
      <small>{tr(locale, "仅使用优化页配置", "Optimizer settings only")}</small>
    </div>
    <div className="optimizer-bake-head">
      <span>{tr(locale, "烘焙光源", "Bake lights")}</span>
      <div>
        <button onClick={() => addBakeLight("directional")}>
          <Plus size={11} />
          {tr(locale, "方向光", "Directional")}
        </button>
        <button onClick={() => addBakeLight("point")}>
          <Plus size={11} />
          {tr(locale, "点光", "Point")}
        </button>
      </div>
    </div>
    {selectedBakeLightId && (
      <div className="optimizer-bake-transform">
        <span>{tr(locale, "场景操控", "Gizmo")}</span>
        <button className={bakeTransformMode === "translate" ? "active" : ""} onClick={() => setBakeTransformMode("translate")}>
          <Move3D size={11} />
          {tr(locale, "移动", "Move")}
        </button>
        <button
          className={bakeTransformMode === "rotate" ? "active" : ""}
          disabled={options.bakeLights.find((light) => light.id === selectedBakeLightId)?.type !== "directional"}
          onClick={() => setBakeTransformMode("rotate")}
        >
          <Rotate3D size={11} />
          {tr(locale, "旋转", "Rotate")}
        </button>
      </div>
    )}
    <div className="optimizer-bake-list">
      {options.bakeLights.map((light) => (
        <article
          key={light.id}
          className={`${!light.enabled ? "disabled" : ""} ${selectedBakeLightId === light.id ? "selected" : ""}`}
          onClick={() => setSelectedBakeLightId(light.id)}
        >
          <header>
            <button aria-label={`${tr(locale, "启用光源", "Enable light")} ${light.name}`} aria-pressed={light.enabled} className={`optimizer-bake-enable ${light.enabled ? "active" : ""}`} onClick={() => updateBakeLight(light.id, { enabled: !light.enabled })}>
              <i />
            </button>
            <input aria-label={tr(locale, "光源名称", "Light name")} value={light.name} onChange={(event) => updateBakeLight(light.id, { name: event.target.value })} />
            <span>{light.type === "directional" ? tr(locale, "方向", "DIR") : tr(locale, "点光", "POINT")}</span>
            <button
              className="danger"
              aria-label={`${tr(locale, "删除光源", "Delete light")} ${light.name}`}
              onClick={(event) => {
                event.stopPropagation();
                setOptions((current) => ({ ...current, bakeLights: current.bakeLights.filter((item) => item.id !== light.id) }));
                if (selectedBakeLightId === light.id) setSelectedBakeLightId(undefined);
              }}
            >
              <Trash2 size={11} />
            </button>
          </header>
          <div className="optimizer-bake-main">
            <input aria-label={`${light.name} ${tr(locale, "颜色选择器", "color picker")}`} type="color" value={light.color} onChange={(event) => updateBakeLight(light.id, { color: event.target.value })} />
            <input
              className="optimizer-light-color-value"
              aria-label={`${light.name} ${tr(locale, "颜色", "color")}`}
              value={light.color}
              onChange={(event) => {
                if (/^#[0-9a-f]{6}$/i.test(event.target.value)) updateBakeLight(light.id, { color: event.target.value });
              }}
            />
            <label>
              <span>{tr(locale, "强度", "Intensity")}</span>
              <input
                type="number"
                min="0"
                max="8"
                step="0.05"
                value={light.intensity}
                onChange={(event) => updateBakeLight(light.id, { intensity: Number(event.target.value) })}
              />
            </label>
            {light.type === "point" && (
              <label>
                <span>{tr(locale, "范围", "Range")}</span>
                <input type="number" min="0.1" step="0.5" value={light.range} onChange={(event) => updateBakeLight(light.id, { range: Number(event.target.value) })} />
              </label>
            )}
          </div>
          <BakeVector
            locale={locale}
            label={light.type === "directional" ? tr(locale, "照射方向", "Direction") : tr(locale, "模型坐标", "Model position")}
            value={light.type === "directional" ? light.direction : light.position}
            onChange={(value) => updateBakeLight(light.id, light.type === "directional" ? { direction: value } : { position: value })}
          />
        </article>
      ))}
    </div>
    <p>
      {options.bakeMode === "vertex"
        ? tr(locale, "把环境光、方向光和点光漫反射写入顶点色，速度快、文件增量小。", "Writes diffuse lighting into vertex colors for fast, compact output.")
        : tr(
            locale,
            "自动展开 UV2，生成彩色直接光、软阴影、AO 与一次间接反弹；双贴图按标准 glTF 写入 GLB。",
            "Automatically unwraps UV2 and bakes colored direct light, soft shadows, AO, and one indirect bounce into standard glTF textures.",
          )}
    </p>
  </OptionSection>
  );
}
