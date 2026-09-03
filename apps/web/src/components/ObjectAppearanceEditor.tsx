import type {
  SceneMaterialState,
  SceneModelEffectsState,
  ProjectAssetRecord,
} from "@bim-studio/contracts";
import { useEffect, useState } from "react";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/ViewerEngine";
import { ModelScreenEditor } from "./ModelScreenEditor";
import { ModelEffectsEditor } from "./ModelEffectsEditor";
import { MaterialTextureSettings } from "./MaterialTextureSettings";
import { ProjectMaterialResourcePicker } from "./ProjectAppearanceResources";

export type MaterialTextureKind =
  | "baseColor"
  | "normal"
  | "emissive"
  | "ambientOcclusion"
  | "roughness"
  | "metalness";

interface ObjectAppearanceEditorProps {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  disabled: boolean;
  material: SceneMaterialState;
  effects?: SceneModelEffectsState;
  onMaterialChange: (patch: SceneMaterialState) => void;
  onEffectsChange: (patch: Partial<SceneModelEffectsState>) => void;
  onChooseTexture: (kind: MaterialTextureKind) => void;
  projectAssets?: ProjectAssetRecord[];
}

const MATERIAL_PRESETS: ReadonlyArray<{
  zh: string;
  en: string;
  value: SceneMaterialState;
}> = [
  {
    zh: "混凝土",
    en: "Concrete",
    value: { color: "#a8a39a", roughness: 0.9, metalness: 0 },
  },
  {
    zh: "拉丝金属",
    en: "Brushed metal",
    value: { color: "#9ba3aa", roughness: 0.28, metalness: 0.92 },
  },
  {
    zh: "亮面陶瓷",
    en: "Gloss ceramic",
    value: { color: "#d6e4e6", roughness: 0.08, metalness: 0 },
  },
  {
    zh: "工程塑料",
    en: "Engineering plastic",
    value: { color: "#d4a84f", roughness: 0.42, metalness: 0 },
  },
];

const TEXTURE_CONTROLS: ReadonlyArray<{
  kind: MaterialTextureKind;
  zh: string;
  en: string;
  nameKey: keyof SceneMaterialState;
  urlKey: keyof SceneMaterialState;
}> = [
  { kind: "baseColor", zh: "基础色贴图", en: "Base color", nameKey: "baseColorMapName", urlKey: "baseColorMapUrl" },
  { kind: "normal", zh: "法线贴图", en: "Normal map", nameKey: "normalMapName", urlKey: "normalMapUrl" },
  { kind: "emissive", zh: "自发光贴图", en: "Emissive map", nameKey: "emissiveMapName", urlKey: "emissiveMapUrl" },
  { kind: "ambientOcclusion", zh: "环境遮蔽贴图", en: "Ambient occlusion", nameKey: "ambientOcclusionMapName", urlKey: "ambientOcclusionMapUrl" },
  { kind: "roughness", zh: "粗糙度贴图", en: "Roughness map", nameKey: "roughnessMapName", urlKey: "roughnessMapUrl" },
  { kind: "metalness", zh: "金属度贴图", en: "Metalness map", nameKey: "metalnessMapName", urlKey: "metalnessMapUrl" },
];

/** 对象外观编辑器仅处理材质和视觉特效，不承担选择、数据绑定或场景保存。 */
export function ObjectAppearanceEditor({
  locale,
  rendererBackend,
  disabled,
  material,
  effects,
  onMaterialChange,
  onEffectsChange,
  onChooseTexture,
  projectAssets = [],
}: ObjectAppearanceEditorProps) {
  const hasTexture = TEXTURE_CONTROLS.some(({ urlKey }) => Boolean(material[urlKey]));
  const [textureSettingsOpen, setTextureSettingsOpen] = useState(hasTexture);
  useEffect(() => {
    if (hasTexture) setTextureSettingsOpen(true);
  }, [hasTexture]);

  return (
    <>
      <div className="material-editor">
        <div className="section-label">
          <span>{tr(locale, "材质", "Material")}</span>
          <small>PBR</small>
        </div>

        <div className="material-preset-grid">
          {MATERIAL_PRESETS.map((preset) => (
            <button
              key={preset.zh}
              disabled={disabled}
              onClick={() => onMaterialChange(preset.value)}
            >
              {tr(locale, preset.zh, preset.en)}
            </button>
          ))}
        </div>

        <ProjectMaterialResourcePicker locale={locale} assets={projectAssets} disabled={disabled} value={material} onApply={onMaterialChange} />

        <details className="material-color-adjustment" open>
          <summary>
            <span>{tr(locale, "颜色调整", "Color adjustment")}</span>
            <small>{tr(locale, "实例级 · 不修改原资源", "Per instance · source preserved")}</small>
          </summary>
          <MaterialAdjustmentRange locale={locale} label={["色相", "Hue"]} value={material.hue ?? 0} min={-180} max={180} step={1} unit="°" disabled={disabled} onChange={(value) => onMaterialChange({ hue: value })} />
          <MaterialAdjustmentRange locale={locale} label={["饱和度", "Saturation"]} value={material.saturation ?? 0} min={-1} max={1} step={0.01} disabled={disabled} onChange={(value) => onMaterialChange({ saturation: value })} />
          <MaterialAdjustmentRange locale={locale} label={["亮度", "Brightness"]} value={material.brightness ?? 0} min={-1} max={1} step={0.01} disabled={disabled} onChange={(value) => onMaterialChange({ brightness: value })} />
          <MaterialAdjustmentRange locale={locale} label={["对比度", "Contrast"]} value={material.contrast ?? 0} min={-1} max={1} step={0.01} disabled={disabled} onChange={(value) => onMaterialChange({ contrast: value })} />
          <button
            type="button"
            disabled={disabled || !materialColorAdjustmentActive(material)}
            onClick={() => onMaterialChange({ hue: 0, saturation: 0, brightness: 0, contrast: 0 })}
          >
            {tr(locale, "重置颜色调整", "Reset color adjustment")}
          </button>
        </details>

        <MaterialRange
          locale={locale}
          label={["粗糙度", "Roughness"]}
          value={material.roughness}
          disabled={disabled}
          onChange={(value) => onMaterialChange({ roughness: value })}
        />
        <MaterialRange
          locale={locale}
          label={["金属度", "Metalness"]}
          value={material.metalness}
          disabled={disabled}
          onChange={(value) => onMaterialChange({ metalness: value })}
        />

        <label className="material-emissive">
          <span>{tr(locale, "自发光", "Emissive")}</span>
          <input
            disabled={disabled || material.emissive === undefined}
            type="color"
            value={material.emissive ?? "#000000"}
            onChange={(event) => onMaterialChange({ emissive: event.target.value })}
          />
          <input
            disabled={disabled || material.emissiveIntensity === undefined}
            type="range"
            min="0"
            max="5"
            step="0.05"
            value={material.emissiveIntensity ?? 0}
            onChange={(event) => onMaterialChange({ emissiveIntensity: Number(event.target.value) })}
          />
        </label>

        <div className="material-texture-grid">
          {TEXTURE_CONTROLS.map((control) => (
            <button
              key={control.kind}
              disabled={disabled}
              onClick={() => onChooseTexture(control.kind)}
            >
              <span>{tr(locale, control.zh, control.en)}</span>
              <small>
                {String(material[control.nameKey] ?? "") ||
                  (material[control.urlKey]
                    ? tr(locale, "已设置", "Set")
                    : tr(locale, "上传", "Upload"))}
              </small>
            </button>
          ))}
        </div>

        <details
          className="material-texture-settings"
          open={textureSettingsOpen}
          onToggle={(event) => setTextureSettingsOpen(event.currentTarget.open)}
        >
          <summary>
            <span>{tr(locale, "贴图变换", "Texture transform")}</span>
            <small>{hasTexture ? tr(locale, "已配置", "Configured") : tr(locale, "高级", "Advanced")}</small>
          </summary>
          <MaterialTextureSettings
            locale={locale}
            disabled={disabled}
            material={material}
            onChange={onMaterialChange}
          />
        </details>

        <div className="material-toggles">
          <button
            disabled={disabled}
            className={material.wireframe ? "active" : ""}
            onClick={() => onMaterialChange({ wireframe: !material.wireframe })}
          >
            {tr(locale, "线框", "Wireframe")}
          </button>
          <button
            disabled={disabled}
            className={material.doubleSided ? "active" : ""}
            onClick={() => onMaterialChange({ doubleSided: !material.doubleSided })}
          >
            {tr(locale, "双面", "Double-sided")}
          </button>
        </div>
      </div>

      <ModelScreenEditor locale={locale} disabled={disabled} screen={material.screen} onChange={onMaterialChange} />

      {effects && <ModelEffectsEditor locale={locale} rendererBackend={rendererBackend} disabled={disabled} effects={effects} onChange={onEffectsChange} />}
    </>
  );
}

function MaterialRange({
  locale,
  label,
  value,
  disabled,
  onChange,
}: {
  locale: AppLocale;
  label: [string, string];
  value: number | undefined;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{tr(locale, ...label)}</span>
      <input
        disabled={disabled || value === undefined}
        type="range"
        min="0"
        max="1"
        step="0.01"
        value={value ?? 0}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <output>{value?.toFixed(2) ?? "—"}</output>
    </label>
  );
}

function MaterialAdjustmentRange({
  locale,
  label,
  value,
  min,
  max,
  step,
  unit = "",
  disabled,
  onChange,
}: {
  locale: AppLocale;
  label: [string, string];
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{tr(locale, ...label)}</span>
      <input disabled={disabled} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <output>{step >= 1 ? value.toFixed(0) : value.toFixed(2)}{unit}</output>
    </label>
  );
}

function materialColorAdjustmentActive(material: SceneMaterialState): boolean {
  return Boolean(material.hue || material.saturation || material.brightness || material.contrast);
}
