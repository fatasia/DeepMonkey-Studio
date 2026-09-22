import { sourceMaterialPatch } from "../viewer/sourceMaterialReset";
import { useState, type ReactNode } from "react";
import type { SceneMaterialState } from "@bim-studio/contracts";
import type { SelectionMaterialSlot } from "../viewer/materialSlots";
import { translate as tr, type AppLocale } from "../i18n";

interface Props {
  locale: AppLocale;
  disabled: boolean;
  material: SceneMaterialState;
  slots: readonly SelectionMaterialSlot[];
  onChange: (patch: SceneMaterialState) => void;
  children: (material: SceneMaterialState, onChange: (patch: SceneMaterialState) => void, slotId: string | undefined) => ReactNode;
}
/** Scope stays local to the Inspector; persisted overrides use stable source material identities. */
export function MaterialScopeEditor({ locale, disabled, material, slots, onChange, children }: Props) {
  const [selectedId, select] = useState("");
  const slot = slots.find(item => item.id === selectedId);
  const effective = slot ? { ...slot.material, ...material.slotOverrides?.[slot.id] } : material;
  const change = (patch: SceneMaterialState) => {
    if (!slot) { onChange(patch); return; }
    const { slotOverrides: _nested, ...values } = patch;
    if (["color", "hue", "saturation", "brightness", "contrast"].some(key => key in values)) values.sourceColor = false;
    if (values.emissive !== undefined) values.sourceEmissive = false;
    onChange({ slotOverrides: { ...material.slotOverrides,
      [slot.id]: { ...material.slotOverrides?.[slot.id], ...values } } });
  };
  const sourceSlots = slot ? [slot] : slots;
  const restorable = sourceSlots.length > 0 && sourceSlots.every(item => item.sourceMaterial);
  const reset = (field?: keyof SceneMaterialState) => {
    if (!restorable || disabled) return;
    const next = { ...material.slotOverrides };
    for (const item of sourceSlots) {
      const source = item.sourceMaterial!;
      next[item.id] = { ...next[item.id], ...(field ? { [field]: source[field], ...(field === "color" ? { sourceColor: true } : field === "emissive" ? { sourceEmissive: true } : {}) } : sourceMaterialPatch(source)) };
    }
    onChange({ slotOverrides: next });
  };
  return <>
    {slots.length > 0 && <label className="material-scope-control">
      <span>{tr(locale, "材质范围", "Material scope")}</span>
      <select disabled={disabled} value={slot?.id ?? ""} onChange={event => select(event.target.value)}>
        <option value="">{tr(locale, "全部材质", "All materials")}</option>
        {slots.map((item, index) => <option key={item.id} value={item.id}>{`${index + 1} · ${item.name}`}</option>)}
      </select>
    </label>}
    {slot && effective.color && <label className="material-scope-control">
      <span>{tr(locale, "基础色", "Base color")}</span>
      <input type="color" disabled={disabled} value={effective.color} onChange={event => change({ color: event.target.value })} />
    </label>}
    {restorable && <div className="material-source-actions">
      <button type="button" disabled={disabled} onClick={() => reset()}>{tr(locale, "恢复源材质", "Restore source material")}</button>
      <select aria-label={tr(locale, "恢复单项源参数", "Restore one source parameter")} disabled={disabled} value=""
        onChange={event => { if (event.target.value) reset(event.target.value as keyof SceneMaterialState); }}>
        <option value="">{tr(locale, "恢复单项…", "Restore property…")}</option>
        {([["color", "基础色", "Base color"], ["roughness", "粗糙度", "Roughness"], ["metalness", "金属度", "Metalness"],
          ["emissive", "自发光颜色", "Emissive color"], ["emissiveIntensity", "自发光强度", "Emissive intensity"],
          ["normalScale", "法线强度", "Normal strength"], ["ior", "折射率", "Index of refraction"], ["doubleSided", "双面", "Double-sided"]] as const)
          .filter(([key]) => sourceSlots.every(item => item.sourceMaterial?.[key] !== undefined))
          .map(([key, zh, en]) => <option key={key} value={key}>{tr(locale, zh, en)}</option>)}
      </select>
    </div>}
    {children(effective, change, slot?.id)}
  </>;
}
