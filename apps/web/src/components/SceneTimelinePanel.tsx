import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Box, Camera, ChevronDown, CircleDot, Film, Footprints, Pause, Play, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { ModelKeyframe, SceneAnimationState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { normalizeAnimationFrameRate, snapAnimationTime } from "../viewer/timeline";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { ScenePlantPlayback } from "./ScenePlantPlayback";
import type { PlantLitePlaybackFrame } from "./plantLitePlaybackModel";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { SceneTimelineFrameInspector, type TimelineFrame } from "./SceneTimelineFrameInspector";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { useTimelineCameraRecording } from "./useTimelineCameraRecording";
import { useTimelineModelRecording } from "./useTimelineModelRecording";
import { removeTimelineTrack, type TimelineTrackId } from "./timelineTrackEditing";

export type SceneDirectorWorkspace = "timeline" | "shots" | "navigation";

interface Props {
  engine?: ViewerEngine | undefined;
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
  onRecordCamera: (time?: number) => string | void;
  onRecordObject: (modelId?: string, time?: number) => string | void;
  onDeleteFrame: (id: string) => void;
  simulationStudy?: PlantLiteStudyRecord;
  onSimulationFrame?: (frame: PlantLitePlaybackFrame | null) => void;
  onAnimationTrack?: () => void;
  workspace?: SceneDirectorWorkspace;
  onWorkspaceChange?: (workspace: SceneDirectorWorkspace) => void;
  cameraWorkspace?: ReactNode;
  /** @deprecated Camera and navigation now live inside the director workspaces. */
  onCameraNavigation?: () => void;
}

export function SceneTimelinePanel(props: Props) {
  const drag = useFloatingPanelDrag<HTMLElement>();
  const workspace = props.workspace ?? "timeline";
  if (workspace !== "timeline" && props.cameraWorkspace) return (
    <section ref={drag.panelRef} style={drag.style} className="timeline-panel timeline-panel-resizable scene-director-camera" aria-label={tr(props.locale, "场景导演台", "Scene director")}>
      <DirectorHeading locale={props.locale} drag={drag} subtitle={tr(props.locale, "镜头与漫游", "Shots & navigation")} onClose={props.onClose} />
      <DirectorTabs locale={props.locale} workspace={workspace} {...(props.onWorkspaceChange ? { onChange: props.onWorkspaceChange } : {})} />
      {props.cameraWorkspace}
    </section>
  );
  const study = props.simulationStudy;
  if (study?.trace && study.model) return <section ref={drag.panelRef} style={drag.style} className="timeline-panel timeline-panel-resizable scene-simulation-timeline" aria-label="场景仿真时间线">
    <DirectorHeading locale={props.locale} drag={drag} subtitle={`仿真轨道 · ${study.name}`} onClose={props.onClose} extra={<button className="timeline-heading-link" type="button" onClick={props.onAnimationTrack}>{tr(props.locale, "动画轨道", "Animation track")}</button>} />
    <DirectorTabs locale={props.locale} workspace={workspace} {...(props.onWorkspaceChange ? { onChange: props.onWorkspaceChange } : {})} />
    <ScenePlantPlayback key={study.id} locale={props.locale} model={study.model} trace={study.trace} {...(props.onSimulationFrame ? { onFrame: props.onSimulationFrame } : {})} />
  </section>;
  return <SceneAnimationTimeline {...props} />;
}

function SceneAnimationTimeline(props: Props) {
  const drag = useFloatingPanelDrag<HTMLElement>();
  const [selectedFrameId, setSelectedFrameId] = useState<string>();
  const [selectedTrackId, setSelectedTrackId] = useState<TimelineTrackId>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);
  const trackMenuRef = useRef<HTMLDivElement>(null);
  const draggedFrameRef = useRef<string | undefined>(undefined);
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
  const trackCount = objectTracks.length + Number(props.animation.camera.length > 0);
  const selectedFrame = frames.find((frame) => frame.id === selectedFrameId);
  const recordingFrame = !props.playing && selectedFrame?.kind === "camera" && Math.abs(selectedFrame.time - props.currentTime) < 0.001 ? selectedFrame : undefined;
  useTimelineCameraRecording(props.engine, props.playing ? undefined : "auto-key", camera => {
    const current = props.animation.camera.find(frame => Math.abs(frame.time - props.currentTime) < 0.001);
    if (current) {
      update({ camera: props.animation.camera.map(frame => frame.id === current.id ? { ...frame, camera } : frame) });
      setSelectedFrameId(current.id);
      setSelectedTrackId("camera");
    } else recordFrame("camera");
  });
  useTimelineModelRecording(props.engine, props.playing ? undefined : "auto-key", modelId => recordFrame("model", props.currentTime, modelId));

  function recordFrame(kind: "camera" | "model", time = props.currentTime, modelId?: string) {
    const frameTime = Math.min(duration, Math.max(0, snapAnimationTime(time, frameRate, props.animation.snapToFrames)));
    const id = kind === "camera" ? props.onRecordCamera(frameTime) : props.onRecordObject(modelId, frameTime);
    if (id) {
      setSelectedFrameId(id);
      setSelectedTrackId(kind === "camera" ? "camera" : `model:${modelId ?? props.engine?.getSelected()?.id ?? ""}`);
    }
    props.onSeek(frameTime);
  }

  function seekTimeline(time: number) {
    props.onSeek(snapAnimationTime(Math.min(duration, Math.max(0, time)), frameRate, props.animation.snapToFrames));
  }

  function deleteFrame(id: string) {
    props.onDeleteFrame(id);
    setSelectedFrameId(undefined);
  }

  function deleteTrack(id: TimelineTrackId) {
    props.onChange(removeTimelineTrack(props.animation, id));
    setSelectedFrameId(undefined);
    setSelectedTrackId(undefined);
  }

  useEffect(() => {
    if (selectedFrameId && !frames.some((frame) => frame.id === selectedFrameId)) setSelectedFrameId(undefined);
  }, [frames, selectedFrameId]);

  useEffect(() => {
    if (!trackMenuOpen) return;
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !trackMenuRef.current?.contains(event.target)) setTrackMenuOpen(false);
    };
    document.addEventListener("pointerdown", dismiss, true);
    return () => document.removeEventListener("pointerdown", dismiss, true);
  }, [trackMenuOpen]);

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
          if (draggedFrameRef.current === frame.id) { draggedFrameRef.current = undefined; return; }
          setSelectedFrameId(frame.id);
          setSelectedTrackId(frame.kind === "camera" ? "camera" : `model:${frame.modelId}`);
          props.onSeek(frame.time);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          const rail = event.currentTarget.parentElement?.getBoundingClientRect();
          if (!rail) return;
          event.preventDefault();
          event.stopPropagation();
          setSelectedFrameId(frame.id);
          setSelectedTrackId(frame.kind === "camera" ? "camera" : `model:${frame.modelId}`);
          props.onSeek(frame.time);
          const move = (pointer: PointerEvent) => {
            draggedFrameRef.current = frame.id;
            moveFrame(frame, ((pointer.clientX - rail.left) / rail.width) * duration);
          };
          const stop = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", stop);
            window.removeEventListener("pointercancel", stop);
          };
          window.addEventListener("pointermove", move);
          window.addEventListener("pointerup", stop, { once: true });
          window.addEventListener("pointercancel", stop, { once: true });
        }}
      />
    );
  }

  function moveFrame(frameToMove: TimelineFrame, time: number) {
    const nextTime = Math.min(duration, Math.max(0, snapAnimationTime(time, frameRate, props.animation.snapToFrames)));
    if (frameToMove.kind === "camera") update({ camera: props.animation.camera.map((frame) => (frame.id === frameToMove.id ? { ...frame, time: nextTime } : frame)).sort((a, b) => a.time - b.time) });
    else update({ models: props.animation.models.map((frame) => (frame.id === frameToMove.id ? { ...frame, time: nextTime } : frame)).sort((a, b) => a.time - b.time) });
    props.onSeek(nextTime);
  }

  function moveSelectedFrame(time: number) {
    if (selectedFrame) moveFrame(selectedFrame, time);
  }

  function updateSelectedFrame(next: TimelineFrame) {
    const { kind, ...value } = next;
    if (kind === "camera") update({ camera: props.animation.camera.map((frame) => frame.id === next.id ? value as typeof frame : frame) });
    else update({ models: props.animation.models.map((frame) => frame.id === next.id ? value as typeof frame : frame) });
    if (Math.abs(next.time - props.currentTime) < 0.001) props.onSeek(next.time);
  }

  function duplicateSelectedFrame() {
    if (!selectedFrame) return;
    const id = crypto.randomUUID();
    const time = Math.min(
      duration,
      snapAnimationTime(selectedFrame.time + (props.animation.snapToFrames ? frameStep : Math.max(0.1, duration / 50)), frameRate, props.animation.snapToFrames),
    );
    if (selectedFrame.kind === "camera")
      update({ camera: [...props.animation.camera, { ...structuredClone(selectedFrame), id, time }].sort((a, b) => a.time - b.time) });
    else
      update({
        models: [
          ...props.animation.models,
          {
            ...structuredClone(selectedFrame),
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
    <section ref={drag.panelRef} style={drag.style} className="timeline-panel timeline-panel-resizable scene-animation-director" aria-label={tr(props.locale, "场景导演台", "Scene director")} onKeyDown={(event) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))) return;
      if (event.key === "Delete" || event.key === "Backspace") {
        if (!selectedFrame && !selectedTrackId) return;
        event.preventDefault();
        event.stopPropagation();
        if (selectedFrame) deleteFrame(selectedFrame.id);
        else if (selectedTrackId) deleteTrack(selectedTrackId);
      }
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "d") { event.preventDefault(); event.stopPropagation(); duplicateSelectedFrame(); }
    }}>
      <header className="timeline-heading" data-drag-handle="true" title={tr(props.locale, "拖动标题栏移动时间线；右下角可缩放", "Drag the title bar; resize from the lower-right corner")} onPointerDown={drag.onPointerDown} onPointerMove={drag.onPointerMove} onPointerUp={drag.onPointerUp} onPointerCancel={drag.onPointerCancel}>
        <div>
          <strong>{tr(props.locale, "场景导演台", "Scene director")}</strong>
          <small>{tr(props.locale, "镜头、对象与漫游统一编排", "Sequence shots, objects and navigation")}</small>
        </div>
        <div className="timeline-heading-summary">
          <span>
            {trackCount} {tr(props.locale, "条轨道", "tracks")}
          </span>
          <span>
            {frames.length} {tr(props.locale, "个关键帧", "keyframes")}
          </span>
          <button aria-label={tr(props.locale, "关闭时间线", "Close timeline")} onClick={props.onClose}>
            <X size={14} />
          </button>
        </div>
      </header>

      <DirectorTabs locale={props.locale} workspace={props.workspace ?? "timeline"} {...(props.onWorkspaceChange ? { onChange: props.onWorkspaceChange } : {})} />

      <div className="timeline-transport">
        <button className="timeline-jump" title={tr(props.locale, "回到开始", "Go to start")} onClick={() => props.onSeek(0)}>
          <RotateCcw size={13} />
        </button>
        <button className="timeline-play" title={props.playing ? tr(props.locale, "暂停", "Pause") : tr(props.locale, "播放", "Play")} onClick={props.onPlayPause}>
          {props.playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <span className="timeline-time">{props.animation.snapToFrames ? `F${Math.round(props.currentTime * frameRate)}` : `${props.currentTime.toFixed(2)}s`}</span>
        <span className="timeline-transport-space" />
        <span className="timeline-auto-key" title={tr(props.locale, "移动镜头或拖动对象后，在播放头自动建立或更新关键帧", "Moving the camera or an object creates or updates a keyframe at the playhead")}><CircleDot size={12} />{tr(props.locale, "自动关键帧", "Auto Key")}</span>
        <span className="timeline-end">{duration.toFixed(1)}s</span>
      </div>

      <div className="timeline-record-bar">
        <div>
          <strong>{tr(props.locale, "关键帧", "Keyframes")}</strong>
          <small className="timeline-selection-name">
            {props.selectedObjectName
              ? tr(props.locale, `已选择：${props.selectedObjectName}`, `Selected: ${props.selectedObjectName}`)
              : tr(props.locale, "选择一个场景对象后可记录对象轨道", "Select a scene object to record an object track")}
          </small>
        </div>
        <div ref={trackMenuRef} className="timeline-track-create">
          <button className="timeline-add-track" type="button" aria-expanded={trackMenuOpen} onClick={() => setTrackMenuOpen((value) => !value)}>
            <Plus size={14} />
            <span>{tr(props.locale, "新增轨道", "Add track")}</span>
          </button>
          {trackMenuOpen && <div className="timeline-track-create-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { recordFrame("camera"); setTrackMenuOpen(false); }}><Camera size={13} /><span><strong>{tr(props.locale, "相机轨道", "Camera track")}</strong><small>{tr(props.locale, "记录当前位置为首帧", "Record current view as first frame")}</small></span></button>
            <button type="button" role="menuitem" disabled={!props.selectedObjectName || props.selectedObjectLocked} title={props.selectedObjectLocked ? tr(props.locale, "对象已锁定", "Object is locked") : undefined} onClick={() => { recordFrame("model"); setTrackMenuOpen(false); }}><Box size={13} /><span><strong>{tr(props.locale, "对象轨道", "Object track")}</strong><small>{tr(props.locale, "记录所选对象为首帧", "Record selected object as first frame")}</small></span></button>
          </div>}
        </div>
      </div>

      <div className={`timeline-editor-body ${selectedFrame ? "has-inspector" : ""}`}>
        <div className="timeline-track-list">
          <TimelineRuler locale={props.locale} duration={duration} currentTime={props.currentTime} onSeek={seekTimeline} />
          {frames.length === 0 && <div className="timeline-empty"><Plus size={14} /><span><strong>{tr(props.locale, "建立第一条轨道", "Create the first track")}</strong><small>{tr(props.locale, "新增轨道会把当前镜头或所选对象记录到播放头位置。", "Adding a track records the current shot or selected object at the playhead.")}</small></span></div>}
          {props.animation.camera.length > 0 && <TimelineTrack icon={<Camera size={13} />} name={tr(props.locale, "相机", "Camera")} count={props.animation.camera.length} duration={duration} currentTime={props.currentTime} selected={selectedTrackId === "camera"} selectLabel={tr(props.locale, "选择相机轨道", "Select camera track")} addLabel={tr(props.locale, "在播放头记录相机帧", "Record camera frame at playhead")} deleteLabel={tr(props.locale, "删除相机轨道", "Delete camera track")} hint={tr(props.locale, "单击定位播放头；双击添加关键帧", "Click to seek; double-click to add a keyframe")} onSelect={() => { setSelectedFrameId(undefined); setSelectedTrackId("camera"); }} onSeek={seekTimeline} onDelete={() => deleteTrack("camera")} onAdd={time => recordFrame("camera", time)}>
            {props.animation.camera.map((frame) => frameMarker({ ...frame, kind: "camera" }))}
          </TimelineTrack>}
          {objectTracks.map((track) => <TimelineTrack key={track.modelId} icon={<Box size={13} />} name={track.name} count={track.frames.length} duration={duration} currentTime={props.currentTime} selected={selectedTrackId === `model:${track.modelId}`} selectLabel={tr(props.locale, `选择 ${track.name} 轨道`, `Select ${track.name} track`)} addLabel={tr(props.locale, `为 ${track.name} 记录关键帧`, `Record a keyframe for ${track.name}`)} deleteLabel={tr(props.locale, `删除 ${track.name} 轨道`, `Delete ${track.name} track`)} hint={tr(props.locale, "单击定位播放头；双击添加关键帧", "Click to seek; double-click to add a keyframe")} onSelect={() => { setSelectedFrameId(undefined); setSelectedTrackId(`model:${track.modelId}`); }} onSeek={seekTimeline} onDelete={() => deleteTrack(`model:${track.modelId}`)} onAdd={time => recordFrame("model", time, track.modelId)}>
            {track.frames.map((frame) => frameMarker({ ...frame, kind: "model" }))}
          </TimelineTrack>)}
        </div>
        {selectedFrame && <SceneTimelineFrameInspector
          locale={props.locale}
          frame={selectedFrame}
          duration={duration}
          frameRate={frameRate}
          snapToFrames={props.animation.snapToFrames ?? false}
          {...(selectedFrame.kind === "model" && props.modelNames.get(selectedFrame.modelId) ? { modelName: props.modelNames.get(selectedFrame.modelId)! } : {})}
          onTimeChange={moveSelectedFrame}
          onUpdate={updateSelectedFrame}
          onPreview={() => props.onSeek(selectedFrame.time)}
          recording={Boolean(recordingFrame)}
          onCaptureCamera={props.engine && selectedFrame.kind === "camera" ? () => updateSelectedFrame({ ...selectedFrame, camera: props.engine!.getCameraState() }) : undefined}
          onDuplicate={duplicateSelectedFrame}
          onDelete={() => deleteFrame(selectedFrame.id)}
        />}
      </div>

      <footer className="timeline-footer">
        <button className={`timeline-settings-toggle ${settingsOpen ? "active" : ""}`} onClick={() => setSettingsOpen((value) => !value)}><ChevronDown size={13} />{tr(props.locale, "播放设置", "Playback settings")}</button>
        <small>{selectedFrame ? tr(props.locale, "正在编辑所选关键帧", "Editing selected keyframe") : tr(props.locale, "点击菱形关键帧编辑位置、镜头与动画属性", "Select a diamond keyframe to edit its shot, transform and animation properties")}</small>
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

function DirectorHeading({ locale, drag, subtitle, onClose, extra }: {
  locale: AppLocale;
  drag: ReturnType<typeof useFloatingPanelDrag<HTMLElement>>;
  subtitle: string;
  onClose: () => void;
  extra?: ReactNode;
}) {
  return <header className="timeline-heading" data-drag-handle="true" title={tr(locale, "拖动标题栏移动导演台；右下角可缩放", "Drag the director; resize from the lower-right corner")} onPointerDown={drag.onPointerDown} onPointerMove={drag.onPointerMove} onPointerUp={drag.onPointerUp} onPointerCancel={drag.onPointerCancel}>
    <div><strong>{tr(locale, "场景导演台", "Scene director")}</strong><small>{subtitle}</small></div>
    <div className="timeline-heading-summary">{extra}<button type="button" aria-label={tr(locale, "关闭导演台", "Close director")} onClick={onClose}><X size={14} /></button></div>
  </header>;
}

function DirectorTabs({ locale, workspace, onChange }: { locale: AppLocale; workspace: SceneDirectorWorkspace; onChange?: (workspace: SceneDirectorWorkspace) => void }) {
  if (!onChange) return null;
  const items: Array<{ id: SceneDirectorWorkspace; icon: ReactNode; zh: string; en: string }> = [
    { id: "timeline", icon: <Film size={14} />, zh: "时间线", en: "Timeline" },
    { id: "shots", icon: <Camera size={14} />, zh: "镜头", en: "Shots" },
    { id: "navigation", icon: <Footprints size={14} />, zh: "漫游", en: "Navigation" },
  ];
  return <nav className="scene-director-tabs" aria-label={tr(locale, "导演台工作区", "Director workspaces")}>
    {items.map((item) => <button type="button" key={item.id} className={workspace === item.id ? "active" : ""} aria-current={workspace === item.id ? "page" : undefined} onClick={() => onChange(item.id)}>{item.icon}<span>{tr(locale, item.zh, item.en)}</span></button>)}
  </nav>;
}

function TimelineRuler({ locale, duration, currentTime, onSeek }: { locale: AppLocale; duration: number; currentTime: number; onSeek: (time: number) => void }) {
  const ticks = [0, .25, .5, .75, 1];
  const playhead = `${Math.min(100, Math.max(0, (currentTime / duration) * 100))}%`;
  return <div className="timeline-ruler" aria-label={tr(locale, "时间标尺", "Time ruler")}><span>{tr(locale, "轨道", "Tracks")}</span><div className="timeline-ruler-rail" title={tr(locale, "拖动播放头定位时间", "Drag to seek")} onPointerDown={event => beginTimelineScrub(event, duration, onSeek)}>{ticks.map((ratio) => <i key={ratio} style={{ left: `${ratio * 100}%` }}>{(duration * ratio).toFixed(ratio === 0 ? 0 : 1)}s</i>)}<b className="timeline-playhead" style={{ left: playhead }} /></div></div>;
}

function TimelineTrack(props: {
  icon: ReactNode;
  name: string;
  count: number;
  duration: number;
  currentTime: number;
  selected: boolean;
  selectLabel: string;
  addLabel: string;
  deleteLabel: string;
  hint: string;
  onSelect: () => void;
  onSeek: (time: number) => void;
  onDelete: () => void;
  onAdd: (time?: number) => void;
  children: ReactNode;
}) {
  const playhead = `${Math.min(100, Math.max(0, (props.currentTime / props.duration) * 100))}%`;
  return (
    <div className={`timeline-track-row ${props.selected ? "selected" : ""}`} tabIndex={0} role="group" aria-label={props.selectLabel} data-selected={props.selected || undefined} onFocus={event => { if (event.target === event.currentTarget) props.onSelect(); }} onPointerDown={event => { if (!(event.target as HTMLElement).closest("button")) props.onSelect(); }}>
      <div className="timeline-track-label">
        {props.icon}
        <span title={props.name}>{props.name}</span>
        <small>{props.count}</small>
        <button type="button" aria-label={props.addLabel} title={props.addLabel} onClick={() => props.onAdd()}><Plus size={12} /></button>
        <button type="button" className="timeline-track-delete" aria-label={props.deleteLabel} title={props.deleteLabel} onClick={props.onDelete}><Trash2 size={12} /></button>
      </div>
      <div className="timeline-track-rail" title={props.hint} onPointerDown={event => beginTimelineScrub(event, props.duration, props.onSeek)} onDoubleClick={event => { if ((event.target as HTMLElement).closest("button")) return; const rect = event.currentTarget.getBoundingClientRect(); props.onAdd((event.clientX - rect.left) / rect.width * props.duration); }}>
        <i className="timeline-track-line" />
        <i className="timeline-playhead" style={{ left: playhead }} />
        {props.children}
      </div>
    </div>
  );
}

function beginTimelineScrub(event: ReactPointerEvent<HTMLDivElement>, duration: number, onSeek: (time: number) => void) {
  if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
  event.preventDefault();
  const rect = event.currentTarget.getBoundingClientRect();
  const seek = (clientX: number) => onSeek(Math.min(duration, Math.max(0, ((clientX - rect.left) / rect.width) * duration)));
  seek(event.clientX);
  const move = (pointer: PointerEvent) => seek(pointer.clientX);
  const stop = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", stop);
    window.removeEventListener("pointercancel", stop);
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", stop, { once: true });
  window.addEventListener("pointercancel", stop, { once: true });
}
