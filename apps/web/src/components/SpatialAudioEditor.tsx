import type { SceneSpatialAudioState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import type { ViewerEngineContract } from "../viewer/viewerEngineContract";

interface SpatialAudioEditorProps {
  locale: AppLocale;
  engine: ViewerEngineContract;
  modelId: string;
  disabled: boolean;
  onChange: () => void;
}

const DEFAULT_AUDIO: SceneSpatialAudioState = {
  enabled: false,
  url: "",
  autoplay: true,
  loopMode: "loop",
  muted: false,
  volume: 0.7,
  refDistance: 2,
  maxDistance: 50,
  rolloffFactor: 1,
};

/** 模型级空间音频编辑器；所有修改立即进入可保存的场景状态。 */
export function SpatialAudioEditor({ locale, engine, modelId, disabled, onChange }: SpatialAudioEditorProps) {
  const value = engine.getSpatialAudioState(modelId) ?? DEFAULT_AUDIO;
  const update = (patch: Partial<SceneSpatialAudioState>) => {
    engine.setSpatialAudioState(modelId, { ...value, ...patch });
    onChange();
  };
  const control = (action: "play" | "pause" | "stop" | "replay") => {
    engine.controlSpatialAudio(modelId, action);
    onChange();
  };

  return (
    <div className="spatial-audio-editor">
      <div className="section-label">
        <span>{tr(locale, "空间音频", "Spatial audio")}</span>
        <small>3D</small>
      </div>
      <label className="material-toggle-row">
        <input type="checkbox" disabled={disabled} checked={value.enabled} onChange={(event) => update({ enabled: event.target.checked })} />
        <span>{tr(locale, "挂载到当前模型", "Attach to this model")}</span>
      </label>
      {value.enabled && (
        <>
          <label>
            <span>{tr(locale, "音频地址", "Audio URL")}</span>
            <input disabled={disabled} value={value.url} placeholder="/assets/audio/motor.ogg" onChange={(event) => update({ url: event.target.value.trim() })} />
          </label>
          <label className="material-toggle-row">
            <input type="checkbox" disabled={disabled} checked={value.autoplay} onChange={(event) => update({ autoplay: event.target.checked })} />
            <span>{tr(locale, "自动播放", "Autoplay")}</span>
          </label>
          <label>
            <span>{tr(locale, "播放方式", "Playback")}</span>
            <select disabled={disabled} value={value.loopMode} onChange={(event) => update({ loopMode: event.target.value as SceneSpatialAudioState["loopMode"] })}>
              <option value="once">{tr(locale, "播放一次", "Play once")}</option>
              <option value="loop">{tr(locale, "循环播放", "Loop")}</option>
            </select>
          </label>
          <label className="material-toggle-row">
            <input type="checkbox" disabled={disabled} checked={value.muted} onChange={(event) => update({ muted: event.target.checked })} />
            <span>{tr(locale, "静音", "Muted")}</span>
          </label>
          <AudioRange locale={locale} label={["音量", "Volume"]} value={value.volume} min={0} max={1} step={0.01} disabled={disabled} onChange={(volume) => update({ volume })} />
          <AudioRange locale={locale} label={["起始衰减距离", "Reference distance"]} value={value.refDistance} min={0.1} max={100} step={0.1} disabled={disabled} onChange={(refDistance) => update({ refDistance, maxDistance: Math.max(refDistance, value.maxDistance) })} />
          <AudioRange locale={locale} label={["最大距离", "Maximum distance"]} value={value.maxDistance} min={value.refDistance} max={1000} step={1} disabled={disabled} onChange={(maxDistance) => update({ maxDistance })} />
          <AudioRange locale={locale} label={["衰减系数", "Rolloff"]} value={value.rolloffFactor} min={0} max={10} step={0.1} disabled={disabled} onChange={(rolloffFactor) => update({ rolloffFactor })} />
          <div className="spatial-audio-actions">
            <button disabled={disabled || !value.url} onClick={() => control("play")}>{tr(locale, "播放", "Play")}</button>
            <button disabled={disabled || !value.url} onClick={() => control("pause")}>{tr(locale, "暂停", "Pause")}</button>
            <button disabled={disabled || !value.url} onClick={() => control("replay")}>{tr(locale, "重播", "Replay")}</button>
            <button disabled={disabled || !value.url} onClick={() => control("stop")}>{tr(locale, "停止", "Stop")}</button>
          </div>
          <small>{tr(locale, "浏览器会在用户首次点击三维视口后解锁声音。", "Sound unlocks after the first user click in the 3D viewport.")}</small>
        </>
      )}
    </div>
  );
}

function AudioRange({ locale, label, value, min, max, step, disabled, onChange }: {
  locale: AppLocale;
  label: [string, string];
  value: number;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{tr(locale, ...label)}</span>
      <input type="range" min={min} max={max} step={step} disabled={disabled} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <output>{value.toFixed(step < 1 ? 1 : 0)}</output>
    </label>
  );
}

