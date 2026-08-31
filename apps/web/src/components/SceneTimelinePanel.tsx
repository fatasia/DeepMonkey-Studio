import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Box, Camera, ChevronDown, Copy, Pause, Play, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { CameraKeyframe, ModelKeyframe, SceneAnimationState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { normalizeAnimationFrameRate, snapAnimationTime } from "../viewer/timeline";

type TimelineFrame = (CameraKeyframe & { kind: "camera" }) | (ModelKeyframe & { kind: "model" });

interface Props {
  locale: AppLocale;
  animation: SceneAnimationState;
  currentTime: number;
  playing: boolean;
  selectedObjectName: string | undefined;
  selectedObjectLocked: boolean;
  modelNames: ReadonlyMap<string, string>;
  onClose: () => void;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
  onChange: (animation: SceneAnimationState) => void;
  onRecordCamera: () => void;
  onRecordObject: () => void;
  onDeleteFrame: (id: string) => void;
}

export function SceneTimelinePanel(props: Props) {
  const [selectedFrameId, setSelectedFrameId] = useState<string>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const duration = Math.max(props.animation.duration, 0.1);
  const frameRate = normalizeAnimationFrameRate(props.animation.frameRate);
  const frameStep = props.animation.snapToFrames ? 1 / frameRate : 0.05;
  const frames = useMemo<TimelineFrame[]>(
    () =>
      [...props.animation.camera.map((frame) => ({ ...frame, kind: "camera" as const })), ...props.animation.models.map((frame) => ({ ...frame, kind: "model" as const }))].sort(
        (a, b) => a.time - b.time,
      ),
    [props.animation.camera, props.animation.models],
  );
  const objectTracks = useMemo(() => {
    const tracks = new Map<string, ModelKeyframe[]>();
    for (const frame of props.animation.models) tracks.set(frame.modelId, [...(tracks.get(frame.modelId) ?? []), frame]);
    return [...tracks].map(([modelId, items]) => ({ modelId, name: props.modelNames.get(modelId) ?? modelId, frames: items.sort((a, b) => a.time - b.time) }));
  }, [props.animation.models, props.modelNames]);
  const selectedFrame = frames.find((frame) => frame.id === selectedFrameId);

  useEffect(() => {
    if (selectedFrameId && !frames.some((frame) => frame.id === selectedFrameId)) setSelectedFrameId(undefined);
  }, [frames, selectedFrameId]);

  function update(patch: Partial<SceneAnimationState>) {
    props.onChange({ ...props.animation, ...patch });
  }

  function frameMarker(frame: TimelineFrame) {
    const left = `${Math.min(100, Math.max(0, (frame.time / duration) * 100))}%`;
    const frameLabel = props.animation.snapToFrames ? ` · F${Math.round(frame.time * frameRate)}` : "";
    const label =
      frame.kind === "camera"
        ? tr(props.locale, `相机关键帧 ${frame.time.toFixed(2)} 秒${frameLabel}`, `Camera keyframe at ${frame.time.toFixed(2)} seconds${frameLabel}`)
        : tr(
            props.locale,
            `${props.modelNames.get(frame.modelId) ?? "对象"}关键帧 ${frame.time.toFixed(2)} 秒${frameLabel}${frame.animation?.clipId ? ` · ${frame.animation.clipId}` : ""}`,
            `${props.modelNames.get(frame.modelId) ?? "Object"} keyframe at ${frame.time.toFixed(2)} seconds${frameLabel}${frame.animation?.clipId ? ` · ${frame.animation.clipId}` : ""}`,
          );
    return (
      <button
        key={frame.id}
        className={`timeline-marker ${selectedFrameId === frame.id ? "selected" : ""}`}
        style={{ left }}
        title={label}
        aria-label={label}
        onClick={() => {
          setSelectedFrameId(frame.id);
          props.onSeek(frame.time);
        }}
      />
    );
  }

  function moveSelectedFrame(time: number) {
    if (!selectedFrame) return;
    const nextTime = Math.min(duration, Math.max(0, snapAnimationTime(time, frameRate, props.animation.snapToFrames)));
    if (selectedFrame.kind === "camera")
      update({ camera: props.animation.camera.map((frame) => (frame.id === selectedFrame.id ? { ...frame, time: nextTime } : frame)).sort((a, b) => a.time - b.time) });
    else update({ models: props.animation.models.map((frame) => (frame.id === selectedFrame.id ? { ...frame, time: nextTime } : frame)).sort((a, b) => a.time - b.time) });
    props.onSeek(nextTime);
  }

  function duplicateSelectedFrame() {
    if (!selectedFrame) return;
    const id = crypto.randomUUID();
    const time = Math.min(
      duration,
      snapAnimationTime(selectedFrame.time + (props.animation.snapToFrames ? frameStep : Math.max(0.1, duration / 50)), frameRate, props.animation.snapToFrames),
    );
    if (selectedFrame.kind === "camera")
      update({ camera: [...props.animation.camera, { id, time, camera: structuredClone(selectedFrame.camera) }].sort((a, b) => a.time - b.time) });
    else
      update({
        models: [
          ...props.animation.models,
          {
            id,
            time,
            modelId: selectedFrame.modelId,
            transform: structuredClone(selectedFrame.transform),
            ...(selectedFrame.animation ? { animation: structuredClone(selectedFrame.animation) } : {}),
          },
        ].sort((a, b) => a.time - b.time),
      });
    setSelectedFrameId(id);
    props.onSeek(time);
  }

  return (
    <section className="timeline-panel" aria-label={tr(props.locale, "场景动画编辑器", "Scene animation editor")}>
      <header className="timeline-heading">
        <div>
          <strong>{tr(props.locale, "动画时间线", "Animation timeline")}</strong>
          <small>{tr(props.locale, "记录相机与对象状态，按轨道编排场景演示", "Record camera and object states on separate tracks")}</small>
        </div>
        <div className="timeline-heading-summary">
          <span>
            {objectTracks.length + 1} {tr(props.locale, "条轨道", "tracks")}
          </span>
          <span>
            {frames.length} {tr(props.locale, "个关键帧", "keyframes")}
          </span>
          <button aria-label={tr(props.locale, "关闭时间线", "Close timeline")} onClick={props.onClose}>
            <X size={14} />
          </button>
        </div>
      </header>

      <div className="timeline-transport">
        <button className="timeline-jump" title={tr(props.locale, "回到开始", "Go to start")} onClick={() => props.onSeek(0)}>
          <RotateCcw size={13} />
        </button>
        <button className="timeline-play" title={props.playing ? tr(props.locale, "暂停", "Pause") : tr(props.locale, "播放", "Play")} onClick={props.onPlayPause}>
          {props.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span className="timeline-time">{props.animation.snapToFrames ? `F${Math.round(props.currentTime * frameRate)}` : `${props.currentTime.toFixed(2)}s`}</span>
        <input
          className="timeline-range"
          type="range"
          min="0"
          max={duration}
          step={frameStep}
          value={props.currentTime}
          onChange={(event) => props.onSeek(snapAnimationTime(Number(event.target.value), frameRate, props.animation.snapToFrames))}
          aria-label={tr(props.locale, "动画时间", "Animation time")}
        />
        <span className="timeline-end">{duration.toFixed(1)}s</span>
      </div>

      <div className="timeline-record-bar">
        <div>
          <strong>{tr(props.locale, "记录当前状态", "Record current state")}</strong>
          <small>
            {props.selectedObjectName
              ? tr(props.locale, `已选择：${props.selectedObjectName}`, `Selected: ${props.selectedObjectName}`)
              : tr(props.locale, "选择一个场景对象后可记录对象轨道", "Select a scene object to record an object track")}
          </small>
        </div>
        <button onClick={props.onRecordCamera}>
          <Camera size={14} />
          <span>{tr(props.locale, "记录相机", "Record camera")}</span>
        </button>
        <button
          onClick={props.onRecordObject}
          disabled={!props.selectedObjectName || props.selectedObjectLocked}
          title={props.selectedObjectLocked ? tr(props.locale, "对象已锁定", "Object is locked") : undefined}
        >
          <Box size={14} />
          <span>{tr(props.locale, "记录对象 / 片段", "Record object / clip")}</span>
        </button>
      </div>

      <div className="timeline-track-list">
        {frames.length === 0 && (
          <div className="timeline-empty">
            <span>
              <Plus size={16} />
            </span>
            <div>
              <strong>{tr(props.locale, "从第一个关键帧开始", "Start with the first keyframe")}</strong>
              <p>
                {tr(
                  props.locale,
                  "先调整相机或对象，再点击“记录相机”或“记录对象”；移动到另一时间点后重复操作。",
                  "Position the camera or object, record it, move to another time, and record again.",
                )}
              </p>
            </div>
          </div>
        )}
        <TimelineTrack icon={<Camera size={13} />} name={tr(props.locale, "相机", "Camera")} count={props.animation.camera.length}>
          {props.animation.camera.map((frame) => frameMarker({ ...frame, kind: "camera" }))}
        </TimelineTrack>
        {objectTracks.map((track) => (
          <TimelineTrack key={track.modelId} icon={<Box size={13} />} name={track.name} count={track.frames.length}>
            {track.frames.map((frame) => frameMarker({ ...frame, kind: "model" }))}
          </TimelineTrack>
        ))}
      </div>

      <footer className="timeline-footer">
        <button className={`timeline-settings-toggle ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((value) => !value)}>
          <ChevronDown size={13} />
          {tr(props.locale, "播放设置", "Playback settings")}
        </button>
        {selectedFrame ? (
          <div className="timeline-selected-frame">
            <span>
              {selectedFrame.kind === "camera"
                ? tr(props.locale, "相机帧", "Camera frame")
                : (props.modelNames.get(selectedFrame.modelId) ?? tr(props.locale, "对象帧", "Object frame"))}
              {selectedFrame.kind === "model" && selectedFrame.animation && (
                <small>
                  {selectedFrame.animation.clipId ?? tr(props.locale, "默认片段", "Default clip")} · {selectedFrame.animation.time.toFixed(2)}s
                </small>
              )}
            </span>
            <label>
              <input
                aria-label={tr(props.locale, "关键帧时间", "Keyframe time")}
                type="number"
                min="0"
                max={duration}
                step={frameStep}
                value={selectedFrame.time}
                onChange={(event) => moveSelectedFrame(Number(event.target.value))}
              />
              {props.animation.snapToFrames ? `F${Math.round(selectedFrame.time * frameRate)}` : "s"}
            </label>
            <button onClick={duplicateSelectedFrame}>
              <Copy size={13} />
              {tr(props.locale, "复制", "Duplicate")}
            </button>
            <button onClick={() => props.onDeleteFrame(selectedFrame.id)}>
              <Trash2 size={13} />
              {tr(props.locale, "删除关键帧", "Delete keyframe")}
            </button>
          </div>
        ) : (
          <small>{tr(props.locale, "点击菱形关键帧可定位并管理", "Select a diamond keyframe to seek and manage it")}</small>
        )}
      </footer>

      {settingsOpen && (
        <div className="timeline-settings">
          <label>
            <span>{tr(props.locale, "总时长", "Duration")}</span>
            <input
              type="number"
              min="0.1"
              step="0.5"
              value={props.animation.duration}
              onChange={(event) => update({ duration: Math.max(0.1, Number(event.target.value) || 0.1) })}
            />
            <i>s</i>
          </label>
          <label>
            <span>{tr(props.locale, "相机插值", "Camera interpolation")}</span>
            <select
              value={props.animation.cameraInterpolation ?? "smooth"}
              onChange={(event) => update({ cameraInterpolation: event.target.value as NonNullable<SceneAnimationState["cameraInterpolation"]> })}
            >
              <option value="linear">{tr(props.locale, "线性", "Linear")}</option>
              <option value="smooth">{tr(props.locale, "平滑", "Smooth")}</option>
              <option value="spline">{tr(props.locale, "曲线路径", "Spline")}</option>
            </select>
          </label>
          <label>
            <span>{tr(props.locale, "对象插值", "Object interpolation")}</span>
            <select
              value={props.animation.modelInterpolation ?? "smooth"}
              onChange={(event) => update({ modelInterpolation: event.target.value as NonNullable<SceneAnimationState["modelInterpolation"]> })}
            >
              <option value="linear">{tr(props.locale, "线性", "Linear")}</option>
              <option value="smooth">{tr(props.locale, "平滑缓动", "Smooth easing")}</option>
            </select>
          </label>
          <label>
            <span>{tr(props.locale, "播放速度", "Playback speed")}</span>
            <select value={props.animation.playbackSpeed ?? 1} onChange={(event) => update({ playbackSpeed: Number(event.target.value) })}>
              <option value="0.25">0.25×</option>
              <option value="0.5">0.5×</option>
              <option value="1">1×</option>
              <option value="1.5">1.5×</option>
              <option value="2">2×</option>
              <option value="4">4×</option>
            </select>
          </label>
          <label>
            <span>{tr(props.locale, "帧率", "Frame rate")}</span>
            <select value={frameRate} onChange={(event) => update({ frameRate: Number(event.target.value) })}>
              {[24, 25, 30, 50, 60].map((fps) => (
                <option key={fps} value={fps}>
                  {fps} fps
                </option>
              ))}
            </select>
          </label>
          <label className="timeline-check">
            <input type="checkbox" checked={props.animation.snapToFrames ?? false} onChange={(event) => update({ snapToFrames: event.target.checked, frameRate })} />
            {tr(props.locale, "按帧吸附", "Snap to frames")}
          </label>
          <label className="timeline-check">
            <input type="checkbox" checked={props.animation.autoplay !== false} onChange={(event) => update({ autoplay: event.target.checked })} />
            {tr(props.locale, "进入预览时自动播放", "Autoplay in preview")}
          </label>
          <label className="timeline-check">
            <input type="checkbox" checked={props.animation.loop} onChange={(event) => update({ loop: event.target.checked })} />
            {tr(props.locale, "循环播放（关闭即播放一次）", "Loop playback (off plays once)")}
          </label>
          <label className="timeline-check">
            <input type="checkbox" checked={props.animation.pingPong ?? false} onChange={(event) => update({ pingPong: event.target.checked })} />
            {tr(props.locale, "往返", "Ping-pong")}
          </label>
          <label className="timeline-check">
            <input type="checkbox" checked={props.animation.showCameraPath ?? true} onChange={(event) => update({ showCameraPath: event.target.checked })} />
            {tr(props.locale, "显示相机轨迹", "Show camera path")}
          </label>
        </div>
      )}
    </section>
  );
}

function TimelineTrack(props: { icon: ReactNode; name: string; count: number; children: ReactNode }) {
  return (
    <div className="timeline-track-row">
      <div className="timeline-track-label">
        {props.icon}
        <span title={props.name}>{props.name}</span>
        <small>{props.count}</small>
      </div>
      <div className="timeline-track-rail">
        <i className="timeline-track-line" />
        {props.children}
      </div>
    </div>
  );
}
