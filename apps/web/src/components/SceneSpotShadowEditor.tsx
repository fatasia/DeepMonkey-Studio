import type { SceneLightState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function SceneSpotShadowEditor({ locale, light, onUpdate }: { locale: AppLocale; light: SceneLightState;
  onUpdate: (patch: Partial<SceneLightState>) => void }) {
  if (!light.castShadow) return null;
  return <><label className="light-parameter">
    <span>{tr(locale, "阴影柔化", "Shadow softness")}</span>
    <input type="range" min={0} max={1} step={0.05} value={light.shadowSoftness ?? 0}
      onChange={event => onUpdate({ shadowSoftness: Number(event.target.value) })} />
    <output>{(light.shadowSoftness ?? 0).toFixed(2)}</output>
  </label><small>{tr(locale, "Deep WebGPU PCSS / Deep Native PCSS；Three WebView 暂不支持。",
    "Deep WebGPU PCSS / Deep Native PCSS; Three WebView is not supported.")}</small></>;
}
