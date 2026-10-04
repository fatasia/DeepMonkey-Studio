import { useMemo, useState } from "react";
import type { SceneMaterialState, UserMaterialPresetDefinition } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { BUILTIN_MATERIAL_PRESETS, PRESET_GROUPS, shadeHexColor,
  type IndustrialMaterialPreset, type MaterialPresetGroup, type PresetMaterialValues } from "../materials/industrialMaterialPresets";
import "./MaterialPresetLibrary.css";

interface MaterialPresetLibraryProps {
  locale: AppLocale;
  disabled: boolean;
  /** 当前对象材质的标量外观域(存为预设的数据源)。 */
  capture: () => PresetMaterialValues;
  onApply: (values: PresetMaterialValues, label: string) => void;
  onSave?: ((name: string, values: PresetMaterialValues) => void) | undefined;
  onDelete?: ((id: string) => void) | undefined;
  customPresets?: readonly UserMaterialPresetDefinition[] | undefined;
}

/** 内置/自定义预设的统一卡片形态;套用走 onApply(既有材质写路径),不在此发渲染调用。 */
export function MaterialPresetLibrary({ locale, disabled, capture, onApply, onSave, onDelete, customPresets = [] }: MaterialPresetLibraryProps) {
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const customCards = useMemo(
    () => customPresets.map(preset => ({
      id: preset.id, zh: preset.name, en: preset.name, group: "custom" as const,
      // 契约允许缺 color;卡片形态需要必填基线,缺省给中性灰(套用走 expand 全量 patch,不受影响)。
      values: { color: "#888888", metalness: 0, roughness: 0.5, ...preset.values },
    })),
    [customPresets],
  );

  const commitSave = () => {
    if (!onSave || !name.trim()) return;
    onSave(name, capture());
    setName("");
    setSaving(false);
  };

  return (
    <details className="material-preset-library" open>
      <summary>
        <span>{tr(locale, "材质预设", "Material presets")}</span>
        <small>{tr(locale, "点击套用", "Click to apply")}</small>
      </summary>
      {PRESET_GROUPS.map(group => (
        <PresetGroupBlock key={group.key} locale={locale} label={[group.zh, group.en]} disabled={disabled}
          presets={BUILTIN_MATERIAL_PRESETS.filter(preset => preset.group === group.key)} onApply={onApply} />
      ))}
      {(customCards.length > 0 || saving) && <PresetGroupBlock locale={locale} label={[tr(locale, "自定义", "Custom"), "Custom"]} disabled={disabled}
        presets={customCards} onApply={onApply} onDelete={onDelete} />}
      <div className="material-preset-save">
        {saving ? (
          <>
            <input
              value={name}
              autoFocus
              disabled={disabled}
              maxLength={40}
              placeholder={tr(locale, "预设名称", "Preset name")}
              aria-label={tr(locale, "预设名称", "Preset name")}
              onChange={event => setName(event.target.value)}
              onKeyDown={event => { if (event.key === "Enter") commitSave(); if (event.key === "Escape") setSaving(false); }}
            />
            <button type="button" disabled={disabled || !name.trim()} onClick={commitSave}>
              {tr(locale, "保存", "Save")}
            </button>
            <button type="button" disabled={disabled} onClick={() => setSaving(false)}>
              {tr(locale, "取消", "Cancel")}
            </button>
          </>
        ) : (
          <button type="button" disabled={disabled || !onSave} onClick={() => setSaving(true)}>
            {tr(locale, "存为预设", "Save as preset")}
          </button>
        )}
      </div>
    </details>
  );
}

type PresetCard = Pick<IndustrialMaterialPreset, "id" | "zh" | "en" | "values"> & { group: MaterialPresetGroup | "custom" };

function PresetGroupBlock({ locale, label, disabled, presets, onApply, onDelete }: {
  locale: AppLocale;
  label: [string, string];
  disabled: boolean;
  presets: readonly PresetCard[];
  onApply: (values: PresetMaterialValues, label: string) => void;
  onDelete?: ((id: string) => void) | undefined;
}) {
  if (!presets.length) return null;
  return (
    <div className="material-preset-group">
      <span className="material-preset-group-label">{tr(locale, ...label)}</span>
      <div className="material-preset-grid">
        {presets.map(preset => (
          <div key={preset.id} className="material-preset-card-wrap">
            <button
              type="button"
              disabled={disabled}
              title={presetSummary(locale, preset.values)}
              onClick={() => onApply(preset.values, tr(locale, preset.zh, preset.en))}
            >
              <PresetSwatch values={preset.values} />
              <span>{tr(locale, preset.zh, preset.en)}</span>
            </button>
            {onDelete && (
              <button
                type="button"
                className="material-preset-delete"
                aria-label={tr(locale, `删除预设 ${preset.zh}`, `Delete preset ${preset.en}`)}
                title={tr(locale, "删除预设", "Delete preset")}
                disabled={disabled}
                onClick={() => onDelete(preset.id)}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** 缩略色块:基色 + 明暗派生渐变;金属加高光斜条,自发光叠 emissive 内芯,透射加棋盘衬底。 */
function PresetSwatch({ values }: { values: PresetMaterialValues }) {
  const base = values.color ?? "#888888";
  const metal = (values.metalness ?? 0) > 0.5;
  const emissive = values.emissive !== undefined && (values.emissiveIntensity ?? 0) > 0;
  const glass = (values.transmission ?? 0) > 0;
  const light = shadeHexColor(base, metal ? 0.28 : 0.12);
  const dark = shadeHexColor(base, metal ? -0.34 : -0.16);
  const background = metal
    ? `linear-gradient(115deg, ${dark} 0%, ${light} 32%, ${base} 52%, ${light} 66%, ${dark} 100%)`
    : `linear-gradient(135deg, ${light} 0%, ${base} 55%, ${dark} 100%)`;
  return (
    <span className={`material-preset-swatch${glass ? " glass" : ""}`} style={{ background }} aria-hidden>
      {glass && <i className="material-preset-swatch-glass" />}
      {emissive && <i className="material-preset-swatch-emissive" style={{ background: values.emissive }} />}
    </span>
  );
}

function presetSummary(locale: AppLocale, values: PresetMaterialValues): string {
  const parts = [
    `${tr(locale, "金属度", "Metalness")} ${(values.metalness ?? 0).toFixed(2)}`,
    `${tr(locale, "粗糙度", "Roughness")} ${(values.roughness ?? 0.5).toFixed(2)}`,
  ];
  if (values.transmission) parts.push(`${tr(locale, "透射", "Transmission")} ${values.transmission.toFixed(2)}`);
  if (values.emissive && values.emissiveIntensity) parts.push(`${tr(locale, "自发光", "Emissive")} ${values.emissiveIntensity.toFixed(1)}`);
  if (values.clearcoat) parts.push(`${tr(locale, "清漆", "Clearcoat")} ${values.clearcoat.toFixed(2)}`);
  return parts.join(" · ");
}
