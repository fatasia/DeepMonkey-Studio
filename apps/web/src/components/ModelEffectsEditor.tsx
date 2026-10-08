import type { SceneFireCurveKey, SceneModelEffectsState, SceneVfxEffectState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/ViewerEngine";
import { DEFAULT_FIRE_EFFECT, type ModelEffectsPatch, type VfxEffectPatch } from "../viewer/modelEffectState";
import {
  DEFAULT_FIRE_CURVES, FIRE_CURVE_RANGE, FIRE_DEFAULT_MAX_PARTICLES, FIRE_MAX_PARTICLES_RANGE, fireBlendMode,
  fireRequestedParticles, type FireBudgetReport, type FireCurveChannel,
} from "../viewer/modelFireParticles";
import {
  VFX_CURVE_RANGE, VFX_DEFAULT_MAX_PARTICLES, VFX_MAX_PARTICLES_RANGE,
  vfxBlendMode, vfxRequestedParticles, withVfxCurve, type VfxBudgetReport, type VfxCurveChannel,
} from "../viewer/modelVfxParticles";
import { VFX_TEMPLATES, VFX_TEMPLATE_MAP } from "../viewer/vfxTemplates";
import { ParticleCurveEditor } from "./ParticleCurveEditor";
import { DraftRange } from "./DraftRange";

const FIRE_CURVE_CHANNELS: readonly { channel: FireCurveChannel; label: [string, string] }[] = [
  { channel: "size", label: ["尺寸", "Size"] },
  { channel: "alpha", label: ["不透明度", "Opacity"] },
  { channel: "color", label: ["热度色", "Heat color"] },
];

/** VFX 曲线只暴露尺寸/不透明度：色相由主色派生，热度色对蒸汽/灰尘等模板语义弱。 */
const VFX_CURVE_CHANNELS: readonly { channel: VfxCurveChannel; label: [string, string] }[] = [
  { channel: "size", label: ["尺寸", "Size"] },
  { channel: "alpha", label: ["不透明度", "Opacity"] },
];

const EFFECT_CONTROLS = [
  { key: "outline", zh: "轮廓", en: "Outline" },
  { key: "glow", zh: "辉光", en: "Glow" },
  { key: "xray", zh: "透视", en: "X-Ray" },
  { key: "scanline", zh: "扫描线", en: "Scanline" },
  { key: "heatmap", zh: "热力图", en: "Heatmap" },
  { key: "edgeLight", zh: "边缘光", en: "Rim light" },
] as const;

interface ModelEffectsEditorProps {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  disabled: boolean;
  effects: SceneModelEffectsState;
  /** 接受 fire/vfx 嵌套 patch;显式 vfx:undefined 卸载图层。 */
  onChange: (patch: ModelEffectsPatch, previewOnly?: boolean) => void;
  /** 场景火焰粒子预算报告与当前对象 id；缺省时不显示预算读数。 */
  particleBudget?: FireBudgetReport | undefined;
  particleEmitterId?: string | undefined;
  /** 场景 VFX 图层独立粒子预算报告；缺省时 VFX 区不显示预算读数。 */
  vfxBudget?: VfxBudgetReport | undefined;
}

export function ModelEffectsEditor({ locale, rendererBackend, disabled, effects, onChange, particleBudget, particleEmitterId, vfxBudget }: ModelEffectsEditorProps) {
  const fire = effects.fire ?? DEFAULT_FIRE_EFFECT;
  const updateFire = (patch: Partial<typeof fire>, previewOnly?: boolean) => onChange({ fire: { ...fire, ...patch } }, previewOnly);
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
      <EffectRange locale={locale} label={["强度", "Intensity"]} value={effects.intensity} min={0.1} max={4} step={0.1} disabled={disabled} onChange={(intensity, previewOnly) => onChange({ intensity }, previewOnly)} />
      <EffectRange locale={locale} label={["溶解", "Dissolve"]} value={effects.dissolve} min={0} max={0.95} step={0.01} disabled={disabled} format={(value) => `${Math.round(value * 100)}%`} onChange={(dissolve, previewOnly) => onChange({ dissolve }, previewOnly)} />
      <label>
        <span>{tr(locale, "特效颜色", "Effect color")}</span>
        <input disabled={disabled} type="color" value={effects.color} onChange={(event) => onChange({ color: event.target.value })} />
      </label>

      <VfxEditor locale={locale} disabled={disabled} vfx={effects.vfx} vfxBudget={vfxBudget} emitterId={particleEmitterId} onChange={onChange} />

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
            <EffectRange locale={locale} label={["强度", "Intensity"]} value={fire.intensity} min={0.1} max={5} step={0.1} disabled={disabled} onChange={(intensity, previewOnly) => updateFire({ intensity }, previewOnly)} />
            <EffectRange locale={locale} label={["高度", "Height"]} value={fire.height} min={0.1} max={50} step={0.1} disabled={disabled} format={(value) => `${value.toFixed(1)} m`} onChange={(height, previewOnly) => updateFire({ height }, previewOnly)} />
            <EffectRange locale={locale} label={["密度", "Density"]} value={fire.density} min={0.25} max={2} step={0.05} disabled={disabled} format={(value) => `${value.toFixed(2)}×`} onChange={(density, previewOnly) => updateFire({ density }, previewOnly)} />
            <EffectRange locale={locale} label={["粒子上限", "Max particles"]} value={fire.maxParticles ?? FIRE_DEFAULT_MAX_PARTICLES} min={FIRE_MAX_PARTICLES_RANGE.min} max={FIRE_MAX_PARTICLES_RANGE.max} step={8} disabled={disabled} format={(value) => `${Math.round(value)}`} onChange={(maxParticles, previewOnly) => updateFire({ maxParticles }, previewOnly)} />
            <BlendSegment locale={locale} disabled={disabled} value={blend} onChange={(blend) => updateFire({ blend })} />
            {particleBudget && (
              <BudgetReadout
                locale={locale}
                label={tr(locale, "本发射器", "This emitter")}
                emitterText={emitter ? `${emitter.allocated} / ${requested}` : `${requested} / ${requested}`}
                report={particleBudget}
                requestedText={tr(locale, `超出场景粒子预算：申请 ${particleBudget.requestedTotal}，实际绘制 ${particleBudget.allocatedTotal}（${Math.round(particleBudget.ratio * 100)}%），已按比例降级。`, `Scene particle budget exceeded: requested ${particleBudget.requestedTotal}, drawing ${particleBudget.allocatedTotal} (${Math.round(particleBudget.ratio * 100)}%); degraded proportionally.`)}
              />
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

/** VFX 模板库与参数编排：未挂载显示 8 张模板卡，挂载后暴露关键参数即时调整。 */
function VfxEditor({ locale, disabled, vfx, vfxBudget, emitterId, onChange }: {
  locale: AppLocale;
  disabled: boolean;
  vfx: SceneVfxEffectState | undefined;
  vfxBudget: VfxBudgetReport | undefined;
  emitterId: string | undefined;
  onChange: (patch: ModelEffectsPatch, previewOnly?: boolean) => void;
}) {
  const updateVfx = (patch: VfxEffectPatch, previewOnly?: boolean) => {
    if (!vfx) return;
    onChange({ vfx: { ...vfx, ...patch } }, previewOnly);
  };
  const attach = (templateId: SceneVfxEffectState["template"]) => {
    // 挂载/切换模板都写入该模板的完整默认参数,参数面板立即有合理基线。
    onChange({ vfx: { ...VFX_TEMPLATE_MAP[templateId].defaults } });
  };
  const detach = () => onChange({ vfx: undefined });
  const emitter = vfxBudget?.emitters.find((item) => item.id === emitterId);

  return (
    <section className="vfx-effect-editor" aria-label={tr(locale, "VFX 图层", "VFX layer")}>
      <div className="fire-effect-heading">
        <span>
          <strong>{tr(locale, "VFX 图层", "VFX layer")}</strong>
          <small>{tr(locale, "模板化轻量粒子：排气、泄漏、告警环等，随场景保存", "Templated light particles: exhaust, leaks, alarm rings; saved with the scene")}</small>
        </span>
        {vfx && (
          <button disabled={disabled} className={vfx.enabled ? "active" : ""} data-qa="vfx-toggle" onClick={() => updateVfx({ enabled: !vfx.enabled })}>
            {vfx.enabled ? tr(locale, "已启用", "Enabled") : tr(locale, "启用", "Enable")}
          </button>
        )}
      </div>
      <div className="vfx-template-grid" role="group" aria-label={tr(locale, "VFX 效果模板", "VFX effect templates")}>
        {VFX_TEMPLATES.map((template) => {
          const active = vfx?.template === template.id;
          return (
            <button
              key={template.id}
              type="button"
              disabled={disabled}
              className={`vfx-template-card${active ? " active" : ""}`}
              data-qa={`vfx-template-${template.id}`}
              aria-pressed={active}
              title={tr(locale, ...template.hint)}
              onClick={() => attach(template.id)}
            >
              <i className="vfx-template-swatch" style={{ background: template.defaults.color }} aria-hidden="true" />
              <span className="vfx-template-name">{tr(locale, ...template.label)}</span>
              <small className="vfx-template-hint">{tr(locale, ...template.hint)}</small>
            </button>
          );
        })}
      </div>
      {vfx && (
        <div className="fire-effect-fields" data-qa="vfx-fields">
          <EffectRange
            locale={locale}
            label={["强度", "Intensity"]}
            value={vfx.intensity}
            min={0.1}
            max={5}
            step={0.1}
            disabled={disabled}
            dataQa="vfx-intensity"
            onChange={(intensity, previewOnly) => updateVfx({ intensity }, previewOnly)}
          />
          <EffectRange locale={locale} label={["速率", "Rate"]} value={vfx.rate} min={0.25} max={2} step={0.05} disabled={disabled} format={(value) => `${value.toFixed(2)}×`} dataQa="vfx-rate" onChange={(rate, previewOnly) => updateVfx({ rate }, previewOnly)} />
          <EffectRange
            locale={locale}
            label={VFX_TEMPLATE_MAP[vfx.template]?.rangeLabel ?? ["范围", "Range"]}
            value={vfx.range}
            min={0.1}
            max={50}
            step={0.1}
            disabled={disabled}
            format={(value) => `${value.toFixed(1)} m`}
            onChange={(range, previewOnly) => updateVfx({ range }, previewOnly)}
          />
          <EffectRange locale={locale} label={["生命周期", "Lifetime"]} value={vfx.lifetime} min={0.2} max={8} step={0.1} disabled={disabled} format={(value) => `${value.toFixed(1)} s`} onChange={(lifetime, previewOnly) => updateVfx({ lifetime }, previewOnly)} />
          <EffectRange locale={locale} label={["粒子上限", "Max particles"]} value={vfx.maxParticles ?? VFX_DEFAULT_MAX_PARTICLES} min={VFX_MAX_PARTICLES_RANGE.min} max={VFX_MAX_PARTICLES_RANGE.max} step={8} disabled={disabled} format={(value) => `${Math.round(value)}`} onChange={(maxParticles, previewOnly) => updateVfx({ maxParticles }, previewOnly)} />
          <label>
            <span>{tr(locale, "颜色", "Color")}</span>
            <input disabled={disabled} type="color" value={vfx.color} onChange={(event) => updateVfx({ color: event.target.value })} />
          </label>
          <BlendSegment
            locale={locale}
            disabled={disabled}
            value={vfxBlendMode(vfx)}
            onChange={(blend) => updateVfx({ blend })}
          />
          {vfxBudget && (
            <BudgetReadout
              locale={locale}
              label={tr(locale, "本发射器", "This emitter")}
              emitterText={emitter ? `${emitter.allocated} / ${vfxRequestedParticles(vfx)}` : `${vfxRequestedParticles(vfx)} / ${vfxRequestedParticles(vfx)}`}
              report={vfxBudget}
              requestedText={tr(locale, `超出 VFX 场景粒子预算：申请 ${vfxBudget.requestedTotal}，实际绘制 ${vfxBudget.allocatedTotal}（${Math.round(vfxBudget.ratio * 100)}%），已按比例降级。`, `VFX scene particle budget exceeded: requested ${vfxBudget.requestedTotal}, drawing ${vfxBudget.allocatedTotal} (${Math.round(vfxBudget.ratio * 100)}%); degraded proportionally.`)}
            />
          )}
          <div className="fire-curves">
            {VFX_CURVE_CHANNELS.map(({ channel, label }) => {
              const fallback = VFX_TEMPLATE_MAP[vfx.template]?.defaults.curves?.[channel] ?? [];
              return (
                <ParticleCurveEditor
                  key={channel}
                  locale={locale}
                  label={label}
                  maximum={VFX_CURVE_RANGE[channel]}
                  keys={vfx.curves?.[channel] ?? fallback}
                  custom={Boolean(vfx.curves?.[channel])}
                  disabled={disabled}
                  onChange={(keys) => updateVfx({ curves: withVfxCurve(vfx, channel, keys) })}
                />
              );
            })}
          </div>
          <div className="vfx-detach-row">
            <button type="button" disabled={disabled} className="vfx-detach" data-qa="vfx-detach" onClick={detach}>
              {tr(locale, "移除 VFX 图层", "Remove VFX layer")}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function BlendSegment({ locale, disabled, value, onChange }: {
  locale: AppLocale;
  disabled: boolean;
  value: "additive" | "alpha";
  onChange: (blend: "additive" | "alpha") => void;
}) {
  return (
    <div className="fire-segment" role="group" aria-label={tr(locale, "混合模式", "Blend mode")}>
      <span>{tr(locale, "混合", "Blend")}</span>
      <button type="button" disabled={disabled} className={value === "additive" ? "active" : ""} aria-pressed={value === "additive"} onClick={() => onChange("additive")}>
        {tr(locale, "叠加", "Additive")}
      </button>
      <button
        type="button"
        disabled={disabled}
        className={value === "alpha" ? "active" : ""}
        aria-pressed={value === "alpha"}
        title={tr(locale, "透明混合：按相机距离由远到近排序绘制", "Alpha blend: drawn back-to-front by camera distance")}
        onClick={() => onChange("alpha")}
      >
        {tr(locale, "透明·排序", "Alpha · sorted")}
      </button>
    </div>
  );
}

function BudgetReadout({ locale, label, emitterText, report, requestedText }: {
  locale: AppLocale;
  label: string;
  emitterText: string;
  report: FireBudgetReport | VfxBudgetReport;
  requestedText: string;
}) {
  return (
    <div className="fire-budget" data-degraded={report.degraded ? "true" : "false"} role="status">
      <div className="fire-budget-row">
        <span>{label}</span>
        <output>{emitterText}</output>
      </div>
      <div className="fire-budget-row">
        <span>{tr(locale, "场景预算", "Scene budget")}</span>
        <output>{report.allocatedTotal} / {report.sceneBudget}</output>
      </div>
      <div className="fire-budget-bar" aria-hidden="true">
        <i style={{ width: `${Math.min(100, (report.requestedTotal / report.sceneBudget) * 100)}%` }} />
      </div>
      {report.degraded && <p className="fire-budget-warning">{requestedText}</p>}
    </div>
  );
}

function EffectRange({ locale, label, value, min, max, step, disabled, format, dataQa, onChange }: {
  locale: AppLocale;
  label: readonly [string, string];
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  format?: (value: number) => string;
  /** 浏览器验收钩子;省略时不输出。 */
  dataQa?: string | undefined;
  onChange: (value: number, previewOnly?: boolean) => void;
}) {
  return (
    <label {...(dataQa ? { "data-qa": dataQa } : {})}>
      <span>{tr(locale, ...label)}</span>
      <DraftRange label={tr(locale, ...label)} disabled={disabled} min={min} max={max} step={step} value={value}
        format={format ?? (next => next.toFixed(1))} onChange={next => onChange(next)} onPreview={next => onChange(next, true)} />
    </label>
  );
}
