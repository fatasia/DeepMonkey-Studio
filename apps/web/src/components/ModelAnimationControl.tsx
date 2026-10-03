import { Pause, Play, RotateCcw, SkipBack, SkipForward, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";

const FRAME_SECONDS = 1 / 30;
const EPSILON = 1e-6;

/** 根运动开关不可用的原因(tooltip 文案);null 表示可用。 */
function rootMotionBlockReason(locale: AppLocale, locked: boolean, reason: "no-animation" | "no-root-track" | undefined): string | null {
  if (locked) return tr(locale, "模型已锁定,无法修改根运动", "Model is locked; root motion cannot be changed");
  if (reason === "no-animation") return tr(locale, "模型没有可播放的动画", "This model has no playable animation");
  if (reason === "no-root-track") return tr(locale, "当前片段没有根骨骼平移轨道,无位移可抽取", "The active clip has no root translation track to extract");
  return null;
}

export function ModelAnimationControl({
  locale,
  engine,
  modelId,
  disabled = false,
  onChange,
}: {
  locale: AppLocale;
  engine: ViewerEngine;
  modelId: string;
  disabled?: boolean;
  onChange: () => void;
}) {
  const clips = useMemo(() => engine.listAnimationClips(modelId), [engine, modelId]);
  const [clipId, setClipId] = useState(() => engine.getAnimationPlayback(modelId)?.clipId ?? clips[0]?.id ?? "");
  const [time, setTime] = useState(() => engine.getAnimationPlayback(modelId)?.time ?? 0);
  const playback = engine.getAnimationPlayback(modelId);
  const playbackPolicy = engine.getModelAnimationPlaybackState(modelId);
  const selectedClip = clips.find((clip) => clip.id === clipId) ?? clips[0];
  const duration = Math.max(FRAME_SECONDS, selectedClip?.duration ?? playback?.duration ?? FRAME_SECONDS);
  const rootMotion = engine.getModelRootMotionState(modelId);
  const availability = engine.getModelRootMotionAvailability(modelId);
  const rootMotionBlock = rootMotionBlockReason(locale, disabled, availability.reason);
  const [appliedX = 0, appliedY = 0, appliedZ = 0] = rootMotion.appliedTranslation;
  const appliedQw = rootMotion.appliedRotation[3] ?? 1;
  const appliedDistance = Math.hypot(appliedX, appliedY, appliedZ);
  // 任意轴旋转都以四元数偏离单位旋转衡量:1-|w| = 1-cos(θ/2);读数为总转角(不分轴)。
  const rotationOffset = 1 - Math.min(1, Math.abs(appliedQw));
  const appliedAngleDeg = (2 * Math.acos(Math.min(1, Math.abs(appliedQw))) * 180) / Math.PI;
  const hasApplied = appliedDistance > EPSILON || rotationOffset > EPSILON;
  const resetBlock = disabled
    ? tr(locale, "模型已锁定,无法复位", "Model is locked; cannot reset")
    : !hasApplied ? tr(locale, "尚无已应用的位移/旋转可复位", "No applied motion to reset") : null;

  useEffect(() => {
    if (!clips.some((clip) => clip.id === clipId)) setClipId(clips[0]?.id ?? "");
  }, [clipId, clips]);

  useEffect(() => {
    if (!engine.isAnimationEnabled(modelId)) return;
    let frame = 0;
    const update = () => {
      const state = engine.getAnimationPlayback(modelId);
      if (state) setTime(state.time);
      frame = window.requestAnimationFrame(update);
    };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [engine, modelId, playback?.playing]);

  function control(action: "play" | "pause" | "stop", nextClipId = clipId) {
    if (!engine.controlAnimation(modelId, { action, ...(nextClipId ? { clipId: nextClipId } : {}) })) return;
    if (action === "stop") setTime(0);
    onChange();
  }

  function seek(nextTime: number) {
    const clamped = Math.max(0, Math.min(duration, nextTime));
    if (!engine.controlAnimation(modelId, { action: "seek", time: clamped, ...(clipId ? { clipId } : {}) })) return;
    setTime(clamped);
    onChange();
  }

  function toggleRootMotion() {
    if (!engine.setModelRootMotion(modelId, { enabled: !rootMotion.enabled })) return;
    onChange();
  }

  function resetRootMotion() {
    if (!engine.resetModelRootMotion(modelId)) return;
    onChange();
  }

  function updatePlaybackPolicy(patch: Partial<typeof playbackPolicy>) {
    const next = { ...playbackPolicy, ...patch };
    engine.setModelAnimationPlaybackState(modelId, next);
    if (patch.autoplay === true) engine.controlAnimation(modelId, { action: "play", ...(clipId ? { clipId } : {}) });
    if (patch.autoplay === false) engine.controlAnimation(modelId, { action: "pause", ...(clipId ? { clipId } : {}) });
    onChange();
  }

  if (clips.length === 0) return null;
  return (
    <div className="model-animation-control">
      <header>
        <span>{tr(locale, "模型动画片段", "Model animation clips")}</span>
        <small>{clips.length} clips · 30 fps</small>
      </header>
      <label>
        <span>{tr(locale, "片段", "Clip")}</span>
        <select
          disabled={disabled}
          value={selectedClip?.id ?? ""}
          onChange={(event) => {
            const next = clips.find((clip) => clip.id === event.target.value);
            if (!next) return;
            setClipId(next.id);
            setTime(0);
            engine.controlAnimation(modelId, { action: "seek", clipId: next.id, time: 0 });
            onChange();
          }}
        >
          {clips.map((clip) => (
            <option key={clip.id} value={clip.id}>
              {clip.name} · {clip.duration.toFixed(2)}s
            </option>
          ))}
        </select>
      </label>
      <div className="model-animation-playback-settings">
        <label>
          <input
            type="checkbox"
            disabled={disabled}
            checked={playbackPolicy.autoplay}
            onChange={(event) => updatePlaybackPolicy({ autoplay: event.target.checked })}
          />
          <span>{tr(locale, "自动播放", "Autoplay")}</span>
        </label>
        <label>
          <span>{tr(locale, "播放方式", "Playback")}</span>
          <select
            disabled={disabled}
            value={playbackPolicy.loopMode}
            onChange={(event) => updatePlaybackPolicy({ loopMode: event.target.value as typeof playbackPolicy.loopMode })}
          >
            <option value="once">{tr(locale, "播放一次", "Play once")}</option>
            <option value="loop">{tr(locale, "循环播放", "Loop")}</option>
          </select>
        </label>
      </div>
      <div className="model-animation-root-motion" data-state={rootMotion.enabled ? "on" : "off"}>
        <span
          className="model-animation-root-motion-switch"
          title={rootMotionBlock ?? tr(locale, "把片段的根骨骼位移/旋转应用到模型实例(预览用,可复位)", "Apply the clip's root bone translation/rotation to the model instance (preview; resettable)")}
        >
          <button
            type="button"
            role="switch"
            aria-checked={rootMotion.enabled}
            className={`toggle ${rootMotion.enabled ? "on" : ""}`}
            disabled={rootMotionBlock !== null}
            onClick={toggleRootMotion}
          >
            <i />
            {tr(locale, "根运动", "Root motion")}
          </button>
        </span>
        <output aria-live="off">
          {rootMotion.enabled ? `Δ ${appliedDistance.toFixed(2)} m · ${appliedAngleDeg.toFixed(0)}°` : "—"}
        </output>
        <span title={resetBlock ?? tr(locale, "把模型复位到开启根运动前的位置与朝向", "Restore the position and heading from before root motion was enabled")}>
          <button
            type="button"
            className="model-animation-root-motion-reset"
            aria-label={tr(locale, "复位根运动位置", "Reset root motion pose")}
            disabled={resetBlock !== null}
            onClick={resetRootMotion}
          >
            <RotateCcw size={12} />
          </button>
        </span>
      </div>
      {hasApplied && (
        <p className="model-animation-root-motion-note" role="note">
          {tr(locale, "含根运动位移,保存前建议复位", "Includes root-motion offset; reset before saving")}
        </p>
      )}
      <div className="model-animation-transport">
        <button disabled={disabled} title={tr(locale, "上一帧", "Previous frame")} onClick={() => seek(time - FRAME_SECONDS)}>
          <SkipBack size={12} />
        </button>
        <button
          disabled={disabled}
          title={playback?.playing ? tr(locale, "暂停", "Pause") : tr(locale, "播放", "Play")}
          onClick={() => control(playback?.playing ? "pause" : "play")}
        >
          {playback?.playing ? <Pause size={13} /> : <Play size={13} />}
        </button>
        <button disabled={disabled} title={tr(locale, "停止并回到开头", "Stop and rewind")} onClick={() => control("stop")}>
          <Square size={11} />
        </button>
        <button disabled={disabled} title={tr(locale, "下一帧", "Next frame")} onClick={() => seek(time + FRAME_SECONDS)}>
          <SkipForward size={12} />
        </button>
        <output>
          {time.toFixed(2)} / {duration.toFixed(2)}s
        </output>
      </div>
      <input
        disabled={disabled}
        aria-label={tr(locale, "动画片段时间", "Animation clip time")}
        type="range"
        min="0"
        max={duration}
        step={FRAME_SECONDS}
        value={Math.min(time, duration)}
        onChange={(event) => seek(Number(event.target.value))}
      />
    </div>
  );
}
