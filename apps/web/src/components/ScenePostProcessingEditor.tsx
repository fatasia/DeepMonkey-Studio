import type { ScenePostProcessingState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { RendererBackend } from "../viewer/ViewerEngine";

interface ScenePostProcessingEditorProps {
  locale: AppLocale;
  rendererBackend: RendererBackend;
  value: ScenePostProcessingState;
  onChange: (next: ScenePostProcessingState) => void;
}

export function ScenePostProcessingEditor({
  locale,
  rendererBackend,
  value,
  onChange,
}: ScenePostProcessingEditorProps) {
  const available = rendererBackend === "webgl" || rendererBackend === "webgpu" || rendererBackend === "wasm";
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
        <label className="post-quality-select">
          <span>{tr(locale, "质量档", "Quality profile")}</span>
          <select
            disabled={!controlsEnabled}
            value={value.qualityProfile ?? "adaptive"}
            onChange={(event) => {
              const next = event.target.value;
              if (next === "adaptive") {
                const { qualityProfile: _qualityProfile, ...withoutProfile } = value;
                onChange(withoutProfile);
              } else {
                onChange({ ...value, qualityProfile: next as NonNullable<ScenePostProcessingState["qualityProfile"]> });
              }
            }}
          >
            <option value="adaptive">{tr(locale, "自适应", "Adaptive")}</option>
            <option value="performance">{tr(locale, "性能", "Performance")}</option>
            <option value="balanced">{tr(locale, "均衡", "Balanced")}</option>
            <option value="quality">{tr(locale, "质量", "Quality")}</option>
            <option value="ultra">{tr(locale, "极高", "Ultra")}</option>
          </select>
        </label>
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
        <button disabled={!controlsEnabled} className={value.screenSpaceReflection ? "active" : ""}
          title={tr(locale, "仅 Deep WebGPU 消费；Three WebView 与 Deep Native 暂不支持", "Deep WebGPU only; Three WebView and Deep Native are not supported")}
          onClick={() => update({ screenSpaceReflection: !value.screenSpaceReflection })}>SSR</button>
        <button disabled={!controlsEnabled} className={value.volumetricFog ? "active" : ""}
          title={tr(locale, "Deep WebGPU 完整消费；Deep Native 使用受限 8 步屏幕空间积分；Three WebView 降级为作者雾", "Deep WebGPU uses the full profile; Deep Native uses bounded 8-step screen-space integration; Three WebView falls back to author fog")}
          onClick={() => update({ volumetricFog: !value.volumetricFog })}>{tr(locale, "体积雾", "Volumetric fog")}</button>
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
      {value.screenSpaceReflection && <>
        <EffectRange label={tr(locale, "SSR 步数", "SSR steps")} disabled={!value.enabled}
          min={8} max={128} step={1} value={value.ssrSteps ?? 32} digits={0} onChange={ssrSteps => update({ ssrSteps })} />
        <EffectRange label={tr(locale, "命中厚度", "Hit thickness")} disabled={!value.enabled}
          min={0.001} max={0.1} step={0.001} value={value.ssrThickness ?? 0.01} digits={3} onChange={ssrThickness => update({ ssrThickness })} />
        <EffectRange label={tr(locale, "追踪距离", "Trace distance")} disabled={!value.enabled}
          min={0.25} max={4} step={0.05} value={value.ssrMaxDistance ?? 2} digits={2} onChange={ssrMaxDistance => update({ ssrMaxDistance })} />
        <small>{tr(locale, "仅 Deep WebGPU 运行；Three WebView 与 Deep Native 会在发布检查中明确阻断。",
          "Deep WebGPU only; publication checks block Three WebView and Deep Native explicitly.")}</small>
      </>}
      {value.volumetricFog && <>
        <EffectRange label={tr(locale, "雾采样步数", "Fog steps")} disabled={!value.enabled}
          min={32} max={64} step={1} value={value.volumetricFogSteps ?? 48} digits={0}
          onChange={volumetricFogSteps => update({ volumetricFogSteps })} />
        <EffectRange label={tr(locale, "雾密度", "Fog density")} disabled={!value.enabled}
          min={0} max={0.1} step={0.001} value={value.volumetricFogDensity ?? 0.006} digits={3}
          onChange={volumetricFogDensity => update({ volumetricFogDensity })} />
        <EffectRange label={tr(locale, "高度尺度", "Height scale")} disabled={!value.enabled}
          min={1} max={256} step={1} value={value.volumetricFogHeight ?? 64} digits={0}
          onChange={volumetricFogHeight => update({ volumetricFogHeight })} />
        <EffectRange label={tr(locale, "各向异性", "Anisotropy")} disabled={!value.enabled}
          min={-0.9} max={0.9} step={0.01} value={value.volumetricFogAnisotropy ?? 0.3} digits={2}
          onChange={volumetricFogAnisotropy => update({ volumetricFogAnisotropy })} />
        <small>{tr(locale, "Deep WebGPU 使用完整参数；Deep Native 使用受限 8 步积分；Three WebView 发布时降级为作者雾。", "Deep WebGPU uses the full profile; Deep Native uses bounded 8-step integration; Three WebView falls back to author fog at publication.")}</small>
      </>}
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
          <EffectRange label={tr(locale, "色温", "Temperature")} disabled={!value.enabled} min={-1} max={1} step={0.01} value={value.temperature ?? 0} digits={2} onChange={(next) => update({ temperature: next })} />
          <EffectRange label={tr(locale, "色调偏移", "Tint")} disabled={!value.enabled} min={-1} max={1} step={0.01} value={value.tint ?? 0} digits={2} onChange={(next) => update({ tint: next })} />
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
