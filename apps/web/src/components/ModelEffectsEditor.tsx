import type { SceneModelEffectsState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/ViewerEngine";
import { DEFAULT_FIRE_EFFECT } from "../viewer/modelEffectState";

interface ModelEffectsEditorProps {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  disabled: boolean;
  effects: SceneModelEffectsState;
  onChange: (patch: Partial<SceneModelEffectsState>) => void;
}

const EFFECT_CONTROLS = [
  { key: "outline", zh: "轮廓", en: "Outline" },
  { key: "glow", zh: "辉光", en: "Glow" },
  { key: "xray", zh: "透视", en: "X-Ray" },
  { key: "scanline", zh: "扫描线", en: "Scanline" },
  { key: "heatmap", zh: "热力图", en: "Heatmap" },
  { key: "edgeLight", zh: "边缘光", en: "Rim light" },
] as const;

export function ModelEffectsEditor({ locale, rendererBackend, disabled, effects, onChange }: ModelEffectsEditorProps) {
  const fire = effects.fire ?? DEFAULT_FIRE_EFFECT;
  const updateFire = (patch: Partial<typeof fire>) => onChange({ fire: { ...fire, ...patch } });

  return (
    <div className="model-effects-editor">
      <div className="section-label">
        <span>{tr(locale, "高级表现", "Advanced visuals")}</span>
        <small>{rendererBackend === "webgpu" ? "WebGPU" : "WebGL"}</small>
      </div>
      <div className="effect-toggles">
        {EFFECT_CONTROLS.map((control) => (
          <button
            key={control.key}
            disabled={disabled}
            className={effects[control.key] ? "active" : ""}
            onClick={() => onChange({ [control.key]: !effects[control.key] })}
          >
            {tr(locale, control.zh, control.en)}
          </button>
        ))}
      </div>
      <EffectRange locale={locale} label={["强度", "Intensity"]} value={effects.intensity} min={0.1} max={4} step={0.1} disabled={disabled} onChange={(intensity) => onChange({ intensity })} />
      <EffectRange locale={locale} label={["溶解", "Dissolve"]} value={effects.dissolve} min={0} max={0.95} step={0.01} disabled={disabled} format={(value) => `${Math.round(value * 100)}%`} onChange={(dissolve) => onChange({ dissolve })} />
      <label>
        <span>{tr(locale, "特效颜色", "Effect color")}</span>
        <input disabled={disabled} type="color" value={effects.color} onChange={(event) => onChange({ color: event.target.value })} />
      </label>

      <section className="fire-effect-editor" aria-label={tr(locale, "火焰图层", "Fire layer")}>
        <div className="fire-effect-heading">
          <span>
            <strong>{tr(locale, "火焰图层", "Fire layer")}</strong>
            <small>{tr(locale, "单批次轻量粒子，模型与基础体通用", "One-batch particles for models and primitives")}</small>
          </span>
          <button disabled={disabled} className={fire.enabled ? "active" : ""} onClick={() => updateFire({ enabled: !fire.enabled })}>
            {fire.enabled ? tr(locale, "已启用", "Enabled") : tr(locale, "启用", "Enable")}
          </button>
        </div>
        {fire.enabled && (
          <div className="fire-effect-fields">
            <label>
              <span>{tr(locale, "颜色", "Color")}</span>
              <input disabled={disabled} type="color" value={fire.color} onChange={(event) => updateFire({ color: event.target.value })} />
            </label>
            <EffectRange locale={locale} label={["强度", "Intensity"]} value={fire.intensity} min={0.1} max={5} step={0.1} disabled={disabled} onChange={(intensity) => updateFire({ intensity })} />
            <EffectRange locale={locale} label={["高度", "Height"]} value={fire.height} min={0.1} max={50} step={0.1} disabled={disabled} format={(value) => `${value.toFixed(1)} m`} onChange={(height) => updateFire({ height })} />
            <EffectRange locale={locale} label={["密度", "Density"]} value={fire.density} min={0.25} max={2} step={0.05} disabled={disabled} format={(value) => `${value.toFixed(2)}×`} onChange={(density) => updateFire({ density })} />
          </div>
        )}
      </section>
    </div>
  );
}

function EffectRange({ locale, label, value, min, max, step, disabled, format, onChange }: {
  locale: AppLocale;
  label: [string, string];
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{tr(locale, ...label)}</span>
      <input disabled={disabled} type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <output>{format ? format(value) : value.toFixed(1)}</output>
    </label>
  );
}
