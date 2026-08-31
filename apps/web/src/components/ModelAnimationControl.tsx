import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { ViewerEngine } from "../viewer/ViewerEngine";

const FRAME_SECONDS = 1 / 30;

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
