import type { SceneFireCurveKey, SceneModelEffectsState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/ViewerEngine";
import { DEFAULT_FIRE_EFFECT } from "../viewer/modelEffectState";
import {
  DEFAULT_FIRE_CURVES, FIRE_CURVE_RANGE, FIRE_DEFAULT_MAX_PARTICLES, FIRE_MAX_PARTICLES_RANGE, fireBlendMode,
  fireRequestedParticles, type FireBudgetReport, type FireCurveChannel,
} from "../viewer/modelFireParticles";
import { ParticleCurveEditor } from "./ParticleCurveEditor";

interface ModelEffectsEditorProps {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  disabled: boolean;
  effects: SceneModelEffectsState;
  onChange: (patch: Partial<SceneModelEffectsState>) => void;
  /** 场景火焰粒子预算报告与当前对象 id；缺省时不显示预算读数。 */
  particleBudget?: FireBudgetReport | undefined;
  particleEmitterId?: string | undefined;
}

const FIRE_CURVE_CHANNELS: readonly { channel: FireCurveChannel; label: [string, string] }[] = [
  { channel: "size", label: ["尺寸", "Size"] },
  { channel: "alpha", label: ["不透明度", "Opacity"] },
  { channel: "color", label: ["热度色", "Heat color"] },
];

const EFFECT_CONTROLS = [
  { key: "outline", zh: "轮廓", en: "Outline" },
  { key: "glow", zh: "辉光", en: "Glow" },
  { key: "xray", zh: "透视", en: "X-Ray" },
  { key: "scanline", zh: "扫描线", en: "Scanline" },
  { key: "heatmap", zh: "热力图", en: "Heatmap" },
  { key: "edgeLight", zh: "边缘光", en: "Rim light" },
] as const;

export function ModelEffectsEditor({ locale, rendererBackend, disabled, effects, onChange, particleBudget, particleEmitterId }: ModelEffectsEditorProps) {
  const fire = effects.fire ?? DEFAULT_FIRE_EFFECT;
  const updateFire = (patch: Partial<typeof fire>) => onChange({ fire: { ...fire, ...patch } });
  const updateCurve = (channel: FireCurveChannel, keys: SceneFireCurveKey[] | undefined) => {
    const { [channel]: _removed, ...rest } = fire.curves ?? {};
    const curves = keys ? { ...rest, [channel]: keys } : rest;
    const { curves: _previous, ...withoutCurves } = fire;
    onChange({ fire: Object.keys(curves).length ? { ...withoutCurves, curves } : withoutCurves });
  };
  const blend = fireBlendMode(fire);
  const requested = fireRequestedParticles(fire);
  const emitter = particleBudget?.emitters.find((item) => item.id === particleEmitterId);

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
            <EffectRange locale={locale} label={["粒子上限", "Max particles"]} value={fire.maxParticles ?? FIRE_DEFAULT_MAX_PARTICLES} min={FIRE_MAX_PARTICLES_RANGE.min} max={FIRE_MAX_PARTICLES_RANGE.max} step={8} disabled={disabled} format={(value) => `${Math.round(value)}`} onChange={(maxParticles) => updateFire({ maxParticles })} />
            <div className="fire-segment" role="group" aria-label={tr(locale, "混合模式", "Blend mode")}>
              <span>{tr(locale, "混合", "Blend")}</span>
              <button type="button" disabled={disabled} className={blend === "additive" ? "active" : ""} aria-pressed={blend === "additive"} onClick={() => updateFire({ blend: "additive" })}>
                {tr(locale, "叠加", "Additive")}
              </button>
              <button
                type="button"
                disabled={disabled}
                className={blend === "alpha" ? "active" : ""}
                aria-pressed={blend === "alpha"}
                title={tr(locale, "透明混合：按相机距离由远到近排序绘制", "Alpha blend: drawn back-to-front by camera distance")}
                onClick={() => updateFire({ blend: "alpha" })}
              >
                {tr(locale, "透明·排序", "Alpha · sorted")}
              </button>
            </div>
            {particleBudget && (
              <div className="fire-budget" data-degraded={particleBudget.degraded ? "true" : "false"} role="status">
                <div className="fire-budget-row">
                  <span>{tr(locale, "本发射器", "This emitter")}</span>
                  <output>{emitter ? emitter.allocated : requested} / {requested}</output>
                </div>
                <div className="fire-budget-row">
                  <span>{tr(locale, "场景预算", "Scene budget")}</span>
                  <output>{particleBudget.allocatedTotal} / {particleBudget.sceneBudget}</output>
                </div>
                <div className="fire-budget-bar" aria-hidden="true">
                  <i style={{ width: `${Math.min(100, (particleBudget.requestedTotal / particleBudget.sceneBudget) * 100)}%` }} />
                </div>
                {particleBudget.degraded && (
                  <p className="fire-budget-warning">
                    {tr(
                      locale,
                      `超出场景粒子预算：申请 ${particleBudget.requestedTotal}，实际绘制 ${particleBudget.allocatedTotal}（${Math.round(particleBudget.ratio * 100)}%），已按比例降级。`,
                      `Scene particle budget exceeded: requested ${particleBudget.requestedTotal}, drawing ${particleBudget.allocatedTotal} (${Math.round(particleBudget.ratio * 100)}%); degraded proportionally.`,
                    )}
                  </p>
                )}
              </div>
            )}
            <div className="fire-curves">
              {FIRE_CURVE_CHANNELS.map(({ channel, label }) => (
                <ParticleCurveEditor
                  key={channel}
                  locale={locale}
                  label={label}
                  maximum={FIRE_CURVE_RANGE[channel]}
                  keys={fire.curves?.[channel] ?? DEFAULT_FIRE_CURVES[channel]}
                  custom={Boolean(fire.curves?.[channel])}
                  disabled={disabled}
                  onChange={(keys) => updateCurve(channel, keys)}
                />
              ))}
            </div>          </div>
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
