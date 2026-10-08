import type { SceneLightState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { DraftRange } from "./DraftRange";

export function SceneSpotShadowEditor({ locale, light, onUpdate }: { locale: AppLocale; light: SceneLightState;
  onUpdate: (patch: Partial<SceneLightState>, previewOnly?: boolean) => void }) {
  if (!light.castShadow) return null;
  return <><label className="light-parameter">
    <span>{tr(locale, "阴影柔化", "Shadow softness")}</span>
    <DraftRange label={tr(locale, "阴影柔化", "Shadow softness")} min={0} max={1} step={0.05}
      value={light.shadowSoftness ?? 0} onPreview={shadowSoftness => onUpdate({ shadowSoftness }, true)}
      onChange={shadowSoftness => onUpdate({ shadowSoftness })} />
  </label><small>{tr(locale, "Deep WebGPU PCSS / Deep Native PCSS；Three WebView 暂不支持。",
    "Deep WebGPU PCSS / Deep Native PCSS; Three WebView is not supported.")}</small></>;
}
