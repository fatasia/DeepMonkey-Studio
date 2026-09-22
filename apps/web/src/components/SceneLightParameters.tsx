import type { SceneLightState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DeferredNumberInput } from "./AppFormControls";

export function SceneLightParameters({ locale, light, onUpdate }: {
  locale: AppLocale; light: SceneLightState; onUpdate: (patch: Partial<SceneLightState>) => void;
}) {
  const local = light.type === "point" || light.type === "spot";
  return <>
    {light.type === "hemisphere" && <label className="light-author-parameter">
      <span>{tr(locale, "地面颜色", "Ground color")}</span>
      <input type="color" aria-label={tr(locale, "地面颜色", "Ground color")} value={light.groundColor ?? "#3b4249"}
        onChange={event => onUpdate({ groundColor: event.target.value })} />
    </label>}
    {local && <>
      <label className="light-author-parameter" title={tr(locale, "0 表示不限距离。", "0 means unlimited range.")}>
        <span>{tr(locale, "照射距离", "Range")}</span>
        <DeferredNumberInput ariaLabel={tr(locale, "照射距离（米）", "Range (m)")} min={0} max={1_000_000} step={0.5}
          value={light.distance ?? 0} onCommit={distance => onUpdate({ distance })} /><small>m</small>
      </label>
      <label className="light-author-parameter" title={tr(locale, "2 为物理平方衰减。", "2 is inverse-square attenuation.")}>
        <span>{tr(locale, "衰减指数", "Decay")}</span>
        <DeferredNumberInput ariaLabel={tr(locale, "衰减指数", "Decay")} min={0} max={4} step={0.1}
          value={light.decay ?? 2} onCommit={decay => onUpdate({ decay })} />
      </label>
    </>}
    {light.type === "spot" && <label className="light-author-parameter">
      <span>{tr(locale, "光锥柔边", "Penumbra")}</span>
      <DeferredNumberInput ariaLabel={tr(locale, "光锥柔边", "Penumbra")} min={0} max={1} step={0.05}
        value={light.penumbra ?? 0.25} onCommit={penumbra => onUpdate({ penumbra })} />
    </label>}
  </>;
}
