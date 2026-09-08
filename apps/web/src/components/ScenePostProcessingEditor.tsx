import type { ScenePostProcessingState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

interface ScenePostProcessingEditorProps {
  locale: AppLocale;
  rendererBackend: "webgl" | "webgpu";
  value: ScenePostProcessingState;
  onChange: (next: ScenePostProcessingState) => void;
}

export function ScenePostProcessingEditor({
  locale,
  rendererBackend,
  value,
  onChange,
}: ScenePostProcessingEditorProps) {
  const available = rendererBackend === "webgl" || rendererBackend === "webgpu";
  const controlsEnabled = value.enabled;
  const update = (patch: Partial<ScenePostProcessingState>) =>
    onChange({ ...value, ...patch });

  return (
    <div className="post-processing-control" title={tr(locale,
      "GTAO、景深和残像开销较高；SMAA 与 FXAA 建议二选一",
      "GTAO, DOF and trails are costly; use either SMAA or FXAA")}>
      <div className="light-system-head">
        <span>{tr(locale, "后处理", "Post-processing")}</span>
        <button
          disabled={!available}
          className={value.enabled ? "active" : ""}
          onClick={() => update({ enabled: !value.enabled })}
        >
          {value.enabled
            ? tr(locale, "已启用", "Enabled")
            : tr(locale, "已关闭", "Disabled")}
        </button>
      </div>
      <div className="post-effect-grid">
        <button
          disabled={!controlsEnabled}
          className={value.smaa ? "active" : ""}
          onClick={() => update({ smaa: !value.smaa })}
        >
          SMAA
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.fxaa ? "active" : ""}
          onClick={() => update({ fxaa: !value.fxaa })}
        >
          FXAA
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.ssao ? "active" : ""}
          onClick={() => update({ ssao: !value.ssao })}
        >
          SSAO
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.gtao ? "active" : ""}
          onClick={() => update({ gtao: !value.gtao })}
        >
          GTAO
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.bloom ? "active" : ""}
          onClick={() => update({ bloom: !value.bloom })}
        >
          Bloom
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.outline ? "active" : ""}
          onClick={() => update({ outline: !value.outline })}
        >
          {tr(locale, "轮廓", "Outline")}
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.depthOfField ? "active" : ""}
          onClick={() => update({ depthOfField: !value.depthOfField })}
        >
          DOF
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.vignette ? "active" : ""}
          onClick={() => update({ vignette: !value.vignette })}
        >
          {tr(locale, "暗角", "Vignette")}
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.filmGrain ? "active" : ""}
          onClick={() => update({ filmGrain: !value.filmGrain })}
        >
          {tr(locale, "胶片", "Film")}
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.afterimage ? "active" : ""}
          onClick={() => update({ afterimage: !value.afterimage })}
        >
          {tr(locale, "残像", "Trail")}
        </button>
        <button
          disabled={!controlsEnabled}
          className={value.colorGrading ? "active" : ""}
          onClick={() => update({ colorGrading: !value.colorGrading })}
        >
          {tr(locale, "调色", "Color")}
        </button>
      </div>
      {value.ssao && (
        <EffectRange
          label={tr(locale, "遮蔽强度", "AO strength")}
          disabled={!value.enabled}
          min={0.1}
          max={4}
          step={0.1}
          value={value.ssaoIntensity}
          digits={1}
          onChange={(next) => update({ ssaoIntensity: next })}
        />
      )}
      {value.gtao && (
        <EffectRange
          label="GTAO"
          disabled={!value.enabled}
          min={0.1}
          max={4}
          step={0.1}
          value={value.gtaoIntensity ?? 1}
          digits={1}
          onChange={(next) => update({ gtaoIntensity: next })}
        />
      )}
      {value.bloom && (
        <>
          <EffectRange
            label={tr(locale, "辉光强度", "Bloom strength")}
            disabled={!value.enabled}
            min={0}
            max={3}
            step={0.05}
            value={value.bloomStrength}
            digits={2}
            onChange={(next) => update({ bloomStrength: next })}
          />
          <EffectRange
            label={tr(locale, "辉光阈值", "Bloom threshold")}
            disabled={!value.enabled}
            min={0}
            max={1}
            step={0.01}
            value={value.bloomThreshold}
            digits={2}
            onChange={(next) => update({ bloomThreshold: next })}
          />
        </>
      )}
      {value.outline && (
        <EffectRange
          label={tr(locale, "轮廓强度", "Outline")}
          disabled={!value.enabled}
          min={0}
          max={10}
          step={0.1}
          value={value.outlineStrength ?? 2.5}
          digits={1}
          onChange={(next) => update({ outlineStrength: next })}
        />
      )}
      {value.depthOfField && (
        <>
          <EffectRange
            label={tr(locale, "焦距", "Focus")}
            disabled={!value.enabled}
            min={0.1}
            max={200}
            step={0.5}
            value={value.focusDistance ?? 10}
            digits={1}
            onChange={(next) => update({ focusDistance: next })}
          />
          <EffectRange
            label={tr(locale, "虚化", "Blur")}
            disabled={!value.enabled}
            min={0}
            max={0.03}
            step={0.001}
            value={value.maxBlur ?? 0.006}
            digits={3}
            onChange={(next) => update({ maxBlur: next })}
          />
        </>
      )}
      {value.vignette && (
        <EffectRange
          label={tr(locale, "暗角强度", "Vignette")}
          disabled={!value.enabled}
          min={0}
          max={3}
          step={0.05}
          value={value.vignetteDarkness ?? 1.2}
          digits={2}
          onChange={(next) => update({ vignetteDarkness: next })}
        />
      )}
      {value.filmGrain && (
        <EffectRange
          label={tr(locale, "颗粒强度", "Grain")}
          disabled={!value.enabled}
          min={0}
          max={1}
          step={0.01}
          value={value.filmGrainIntensity ?? 0.18}
          digits={2}
          onChange={(next) => update({ filmGrainIntensity: next })}
        />
      )}
      {value.afterimage && (
        <EffectRange
          label={tr(locale, "残像衰减", "Trail damp")}
          disabled={!value.enabled}
          min={0}
          max={0.99}
          step={0.01}
          value={value.afterimageDamp ?? 0.9}
          digits={2}
          onChange={(next) => update({ afterimageDamp: next })}
        />
      )}
      {value.colorGrading && (
        <>
          <EffectRange label={tr(locale, "色相", "Hue")} disabled={!value.enabled} min={-180} max={180} step={1} value={value.hue ?? 0} digits={0} onChange={(next) => update({ hue: next })} />
          <EffectRange label={tr(locale, "饱和度", "Saturation")} disabled={!value.enabled} min={-1} max={1} step={0.01} value={value.saturation ?? 0} digits={2} onChange={(next) => update({ saturation: next })} />
          <EffectRange label={tr(locale, "亮度", "Brightness")} disabled={!value.enabled} min={-1} max={1} step={0.01} value={value.brightness ?? 0} digits={2} onChange={(next) => update({ brightness: next })} />
          <EffectRange label={tr(locale, "对比度", "Contrast")} disabled={!value.enabled} min={-1} max={1} step={0.01} value={value.contrast ?? 0} digits={2} onChange={(next) => update({ contrast: next })} />
        </>
      )}
    </div>
  );
}

interface EffectRangeProps {
  label: string;
  disabled: boolean;
  min: number;
  max: number;
  step: number;
  value: number;
  digits: number;
  onChange: (value: number) => void;
}

function EffectRange(props: EffectRangeProps) {
  return (
    <label className="light-parameter">
      <span>{props.label}</span>
      <input
        disabled={props.disabled}
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.target.value))}
      />
      <output>{props.value.toFixed(props.digits)}</output>
    </label>
  );
}
