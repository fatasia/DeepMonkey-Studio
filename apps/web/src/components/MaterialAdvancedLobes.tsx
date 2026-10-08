import { useState } from "react";
import type { SceneMaterialState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/viewerTypes";
import { PHYSICAL_LOBE_COLOR_NEUTRAL, PHYSICAL_LOBE_SCALARS, physicalLobeField, stateActivatesPhysicalLobes,
  type PhysicalLobeColorKey, type PhysicalLobeScalarKey } from "../viewer/materialPhysicalLobeFields";
import { DeferredNumberInput } from "./AppFormControls";
import { DraftRange } from "./DraftRange";
import "./MaterialAdvancedLobes.css";

interface Props {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  disabled: boolean;
  material: SceneMaterialState;
  onChange: (patch: SceneMaterialState, previewOnly?: boolean) => void;
}

const scalar = (material: SceneMaterialState, key: PhysicalLobeScalarKey): number => material[key] ?? physicalLobeField(key).neutral;
const color = (material: SceneMaterialState, key: PhysicalLobeColorKey): string => material[key] ?? PHYSICAL_LOBE_COLOR_NEUTRAL[key];
const activeGroups = (material: SceneMaterialState): number => [
  scalar(material, "clearcoat") > 0,
  scalar(material, "sheen") > 0 && color(material, "sheenColor").toLowerCase() !== PHYSICAL_LOBE_COLOR_NEUTRAL.sheenColor,
  scalar(material, "iridescence") > 0,
  scalar(material, "transmission") > 0,
].filter(Boolean).length;

/** 高级材质(clearcoat / sheen / iridescence / 透射体积):折叠分组,默认收起;范围/单位/小数位来自 materialPhysicalLobeFields。 */
export function MaterialAdvancedLobes({ locale, rendererBackend, disabled, material, onChange }: Props) {
  const active = activeGroups(material);
  const [open, setOpen] = useState(active > 0);
  const pbr = material.roughness !== undefined;
  const blocked = disabled || !pbr;
  const reason = disabled ? tr(locale, "当前不可编辑", "Editing is unavailable")
    : !pbr ? tr(locale, "该材质不是 PBR 材质，不支持高级材质", "This is not a PBR material; advanced lobes are unavailable") : undefined;
  const status = rendererBackend === "wasm"
    ? { tone: "warning", text: tr(locale, "Wasm 渲染路径暂不渲染高级材质；参数会保存，并在 three / Deep 路径生效。", "The Wasm path does not render advanced materials yet; values are saved and apply on the three / Deep paths.") }
    : rendererBackend === "webgpu"
      ? { tone: "info", text: tr(locale, "Deep 路径显示场景编译快照：新增或修改高级材质后，重新切换到 Deep 即生效；渲染器会按场景自动启用对应着色变体。", "The Deep path shows a compiled scene snapshot: re-enter Deep to apply advanced-material edits; the renderer enables the matching shader variant automatically.") }
      : { tone: "info", text: tr(locale, "three 路径原生支持，按 three r185 物理材质渲染。", "Natively supported on the three path (three r185 physical material).") };

  const row = (key: PhysicalLobeScalarKey, gate?: { off: boolean; why: [string, string] }) => {
    const field = physicalLobeField(key);
    const value = scalar(material, key);
    const off = blocked || gate?.off === true;
    const label = tr(locale, field.zh, field.en);
    const title = blocked ? reason : gate?.off ? tr(locale, ...gate.why) : undefined;
    return (
      <label className="material-lobe-row" key={key} title={title} data-disabled={off || undefined}>
        <span>{label}{field.unit ? <small>{field.unit}</small> : null}</span>
        <DraftRange disabled={off} min={field.min} max={field.max} step={field.step} label={label}
          value={Number(value.toFixed(field.decimals))} numeric numericClassName="material-lobe-value"
          numericLabel={`${label} ${tr(locale, "数值", "value")}`} numericMin={field.limit[0]} numericMax={field.limit[1]}
          onPreview={next => onChange(patchFor(key, next), true)} onChange={next => onChange(patchFor(key, next))} />
      </label>
    );
  };
  const patchFor = (key: PhysicalLobeScalarKey, value: number): SceneMaterialState => {
    const patch: SceneMaterialState = { [key]: value };
    // 光泽色缺省为黑(three 默认):首次拉起光泽强度时给出可见的白色,避免"有强度无效果"。
    if (key === "sheen" && value > 0 && color(material, "sheenColor").toLowerCase() === PHYSICAL_LOBE_COLOR_NEUTRAL.sheenColor) patch.sheenColor = "#ffffff";
    return patch;
  };
  const colorRow = (key: PhysicalLobeColorKey, zh: string, en: string, gate: { off: boolean; why: [string, string] }) => {
    const off = blocked || gate.off;
    const label = tr(locale, zh, en);
    return (
      <label className="material-lobe-row material-lobe-color" key={key} data-disabled={off || undefined}
        title={blocked ? reason : gate.off ? tr(locale, ...gate.why) : undefined}>
        <span>{label}</span>
        <input type="color" disabled={off} aria-label={label} value={color(material, key)} onChange={event => onChange({ [key]: event.target.value })} />
        <output>{color(material, key).toUpperCase()}</output>
      </label>
    );
  };

  const clearcoatOff = { off: scalar(material, "clearcoat") === 0, why: ["清漆强度为 0 时不生效", "Has no effect while clearcoat is 0"] as [string, string] };
  const sheenOff = { off: scalar(material, "sheen") === 0, why: ["光泽强度为 0 时不生效", "Has no effect while sheen is 0"] as [string, string] };
  const filmOff = { off: scalar(material, "iridescence") === 0, why: ["薄膜干涉为 0 时不生效", "Has no effect while iridescence is 0"] as [string, string] };
  const volumeOff = { off: scalar(material, "transmission") === 0, why: ["需先启用透射", "Enable transmission first"] as [string, string] };
  const distance = material.attenuationDistance;
  const resetPatch: SceneMaterialState = { clearcoat: 0, clearcoatRoughness: 0, sheen: 0, sheenRoughness: 1, sheenColor: PHYSICAL_LOBE_COLOR_NEUTRAL.sheenColor,
    iridescence: 0, iridescenceIOR: 1.3, iridescenceThicknessMax: 400, transmission: 0, thickness: 0,
    attenuationColor: PHYSICAL_LOBE_COLOR_NEUTRAL.attenuationColor, attenuationDistance: undefined };

  return (
    <details className="material-advanced-lobes" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>
        <span>{tr(locale, "高级材质", "Advanced material")}</span>
        <small data-state={active > 0 ? "on" : "off"}>{active > 0 ? tr(locale, `已启用 ${active} 项`, `${active} active`) : tr(locale, "默认关闭", "Off by default")}</small>
      </summary>
      <p className="material-lobe-status" data-tone={status.tone} role="note">{status.text}</p>
      {!pbr && !disabled && <p className="material-lobe-status" data-tone="warning" role="note">{reason}</p>}
      <fieldset className="material-lobe-group" disabled={blocked}>
        <legend>{tr(locale, "清漆", "Clearcoat")}</legend>
        {row("clearcoat")}{row("clearcoatRoughness", clearcoatOff)}
      </fieldset>
      <fieldset className="material-lobe-group" disabled={blocked}>
        <legend>{tr(locale, "光泽（织物）", "Sheen (fabric)")}</legend>
        {row("sheen")}{colorRow("sheenColor", "光泽色", "Sheen color", sheenOff)}{row("sheenRoughness", sheenOff)}
      </fieldset>
      <fieldset className="material-lobe-group" disabled={blocked}>
        <legend>{tr(locale, "薄膜干涉", "Iridescence")}</legend>
        {row("iridescence")}{row("iridescenceIOR", filmOff)}{row("iridescenceThicknessMax", filmOff)}
      </fieldset>
      <fieldset className="material-lobe-group" disabled={blocked}>
        <legend>{tr(locale, "透射与体积", "Transmission & volume")}</legend>
        {row("transmission")}{row("thickness", volumeOff)}{colorRow("attenuationColor", "衰减色", "Attenuation color", volumeOff)}
        <label className="material-lobe-row" data-disabled={blocked || volumeOff.off || undefined}
          title={blocked ? reason : volumeOff.off ? tr(locale, ...volumeOff.why) : undefined}>
          <span>{tr(locale, "衰减距离", "Attenuation distance")}<small>m</small></span>
          <span className="material-lobe-none">{distance === undefined ? tr(locale, "不衰减", "None") : tr(locale, "已限定", "Limited")}</span>
          <DeferredNumberInput className="material-lobe-value" ariaLabel={tr(locale, "衰减距离 数值", "Attenuation distance value")}
            min={physicalLobeField("attenuationDistance").min} step={0.01} placeholder="∞" disabled={blocked || volumeOff.off}
            value={distance === undefined ? undefined : Number(distance.toFixed(2))} onCommit={next => { if (next > 0) onChange({ attenuationDistance: next }); }} />
        </label>
        <button type="button" className="material-lobe-clear" disabled={blocked || volumeOff.off || distance === undefined}
          title={distance === undefined ? tr(locale, "已是不衰减", "Already unattenuated") : undefined}
          onClick={() => onChange({ attenuationDistance: undefined })}>{tr(locale, "恢复不衰减", "Remove limit")}</button>
      </fieldset>
      <button type="button" className="material-lobe-reset" disabled={blocked || !stateActivatesPhysicalLobes(material)}
        title={!stateActivatesPhysicalLobes(material) ? tr(locale, "当前均为默认值", "All values are default") : undefined}
        onClick={() => onChange(resetPatch)}>{tr(locale, "重置高级材质", "Reset advanced material")}</button>
    </details>
  );
}

export { PHYSICAL_LOBE_SCALARS };
