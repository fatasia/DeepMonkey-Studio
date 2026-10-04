import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, WheelEvent as ReactWheelEvent, ReactNode } from "react";
import { Box, Camera, ChevronDown, CircleDot, Clapperboard, Film, Footprints, History, Pause, Play, Plus, RotateCcw, Trash2, X } from "lucide-react";
import type { ModelKeyframe, SceneAnimationState } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { normalizeAnimationFrameRate, snapAnimationTime } from "../viewer/timeline";
import type { PlantLiteStudyRecord } from "@bim-studio/contracts";
import { ScenePlantPlayback } from "./ScenePlantPlayback";
import type { PlantLitePlaybackFrame } from "./plantLitePlaybackModel";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { useTransientValue } from "../hooks/useTransientValue";
import { SceneTimelineFrameInspector, type TimelineFrame } from "./SceneTimelineFrameInspector";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { useTimelineCameraRecording } from "./useTimelineCameraRecording";
import { useTimelineModelRecording } from "./useTimelineModelRecording";
import { removeTimelineTrack, type TimelineTrackId } from "./timelineTrackEditing";
import { SceneAnimationStateMachineEditor } from "./SceneAnimationStateMachineEditor";
import { BehaviorTraceReplay } from "./BehaviorTraceReplay";

export type SceneDirectorWorkspace = "timeline" | "shots" | "navigation" | "trace";
const selectAnimationTime = (snapshot: { time: number; playing: boolean }) => snapshot.time;

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
  onReversePlay?: () => void;
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
  // S2d 行为轨迹审阅器:T31 日志的只读回放面,与动画时间线/镜头/漫游并列的第四工作区。
  if (workspace === "trace") return (
    <section ref={drag.panelRef} style={drag.style} className="timeline-panel timeline-panel-resizable scene-behavior-trace" aria-label={tr(props.locale, "行为轨迹回放", "Behavior trace replay")}>
      <DirectorHeading locale={props.locale} drag={drag} subtitle={tr(props.locale, "行为轨迹 · 确定性回放审阅", "Behavior trace · deterministic review")} onClose={props.onClose} />
      <DirectorTabs locale={props.locale} workspace={workspace} {...(props.onWorkspaceChange ? { onChange: props.onWorkspaceChange } : {})} />
      <BehaviorTraceReplay locale={props.locale} {...(props.engine ? { engine: props.engine } : {})} />
    </section>
  );
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
  const animationChannel = useMemo(() => props.engine?.transientChannels?.channel<{ time: number; playing: boolean }>("animation", { shallow: true }), [props.engine]);
  const currentTime = useTransientValue(animationChannel, selectAnimationTime, { fallback: props.currentTime }) ?? props.currentTime;
  const [selectedFrameId, setSelectedFrameId] = useState<string>();
  const [selectedTrackId, setSelectedTrackId] = useState<TimelineTrackId>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [trackMenuOpen, setTrackMenuOpen] = useState(false);
  // 时间线缩放：1 = 整条时间线铺满面板，放大后经水平滚动查看；ruler 滚轮以鼠标位置为锚点。
  const [zoom, setZoom] = useState(1);
  const trackListRef = useRef<HTMLDivElement>(null);
  const zoomAnchorRef = useRef<{ timeRatio: number; viewportLeft: number } | undefined>(undefined);
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
  const recordingFrame = !props.playing && selectedFrame?.kind === "camera" && Math.abs(selectedFrame.time - currentTime) < 0.001 ? selectedFrame : undefined;
  useTimelineCameraRecording(props.engine, props.playing ? undefined : "auto-key", camera => {
    const current = props.animation.camera.find(frame => Math.abs(frame.time - currentTime) < 0.001);
    if (current) {
      update({ camera: props.animation.camera.map(frame => frame.id === current.id ? { ...frame, camera } : frame) });
      setSelectedFrameId(current.id);
      setSelectedTrackId("camera");
    } else recordFrame("camera");
  });
  useTimelineModelRecording(props.engine, props.playing ? undefined : "auto-key", modelId => recordFrame("model", currentTime, modelId));

  function recordFrame(kind: "camera" | "model", time = currentTime, modelId?: string) {
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

  function updatePlaybackRange(inPoint: number, outPoint: number) {
    const next = {
      inPoint: Math.min(Math.max(Number.isFinite(inPoint) ? inPoint : 0, 0), duration),
      outPoint: Math.min(Math.max(Number.isFinite(outPoint) ? outPoint : duration, 0), duration),
    };
    if (next.outPoint <= next.inPoint || (next.inPoint <= 0 && next.outPoint >= duration)) {
      // 退化或恢复整条时间线时清除区间，避免场景文档携带无效果字段。
      const { playbackRange: _cleared, ...rest } = props.animation;
      props.onChange(rest);
      return;
    }
    update({ playbackRange: next });
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

  // 全局键盘流：K 打帧 / 空格播放 / 方向键 scrub / Home·End 跳转。
  // 经 liveRef 消费最新闭包值，listener 只挂一次，播放中不随 60fps 时间刷新重挂。
  const liveRef = useRef({ props, recordFrame, seekTimeline, currentTime, duration, frameRate });
  liveRef.current = { props, recordFrame, seekTimeline, currentTime, duration, frameRate };
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const live = liveRef.current;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT", "BUTTON"].includes(target.tagName))) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const step = live.props.animation.snapToFrames ? 1 / live.frameRate : 0.1;
      if (event.key === "k" || event.key === "K") {
        // K 上下文感知：选中未锁定对象打对象帧，否则打相机帧（无选中也能一步建相机轨道）。
        event.preventDefault();
        live.recordFrame(live.props.selectedObjectName && !live.props.selectedObjectLocked ? "model" : "camera");
      } else if (event.key === " ") {
        event.preventDefault();
        live.props.onPlayPause();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        live.seekTimeline(live.currentTime - (event.shiftKey ? 1 : step));
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        live.seekTimeline(live.currentTime + (event.shiftKey ? 1 : step));
      } else if (event.key === "Home") {
        event.preventDefault();
        live.seekTimeline(0);
      } else if (event.key === "End") {
        event.preventDefault();
        live.seekTimeline(live.duration);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 缩放锚点：新宽度渲染后把缩放前鼠标下的时间点留在原视口位置，滚轮缩放不漂移。
  useEffect(() => {
    const anchor = zoomAnchorRef.current;
    const container = trackListRef.current;
    if (!anchor || !container) return;
    zoomAnchorRef.current = undefined;
    const rail = container.querySelector<HTMLElement>(".timeline-ruler-rail");
    if (!rail) return;
    // rail 宽与时长线性对应：锚点时间在 rail 上的像素位置 − 视口内偏移 = 新 scrollLeft。
    container.scrollLeft = Math.max(0, anchor.timeRatio * rail.offsetWidth - anchor.viewportLeft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom]);

  function changeTimelineZoom(scale: number, anchorClientX?: number) {
    const next = Math.min(8, Math.max(1, Number(scale.toFixed(3))));
    setZoom((previous) => {
      if (previous === next) return previous;
      const container = trackListRef.current;
      const rail = container?.querySelector<HTMLElement>(".timeline-ruler-rail");
      if (container && rail && anchorClientX !== undefined) {
        const railRect = rail.getBoundingClientRect();
        zoomAnchorRef.current = {
          timeRatio: Math.min(1, Math.max(0, (anchorClientX - railRect.left) / Math.max(railRect.width, 1))),
          viewportLeft: anchorClientX - container.getBoundingClientRect().left,
        };
      }
      return next;
    });
  }

  function onTimelineWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!event.deltaY) return;
    event.preventDefault();
    changeTimelineZoom(zoom * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX);
  }

  function playPatrol() {
    // 一键巡检：回到时间线起点后从相机路径播放，作为演示招牌动线。
    props.onSeek(0);
    if (!props.playing) props.onPlayPause();
  }

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
    if (Math.abs(next.time - currentTime) < 0.001) props.onSeek(next.time);
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
        {/* 倒放按钮固定占位，未接处理器时禁用，保证 transport 网格列数稳定。 */}
        <button className="timeline-reverse" title={tr(props.locale, "倒放", "Reverse play")} disabled={!props.onReversePlay} onClick={() => props.onReversePlay?.()}>
          <Play size={13} style={{ transform: "scaleX(-1)" }} />
        </button>
        <button className="timeline-reverse timeline-patrol" title={tr(props.locale, "一键巡检：从头播放相机路径", "One-click patrol: play camera path from start")} disabled={props.animation.camera.length < 2} onClick={playPatrol}>
          <Clapperboard size={13} />
        </button>
        <span className="timeline-time">{props.animation.snapToFrames ? `F${Math.round(currentTime * frameRate)}` : `${currentTime.toFixed(2)}s`}</span>
        <span className="timeline-transport-space" />
        <span className="timeline-auto-key" title={tr(props.locale, "移动镜头或拖动对象后，在播放头自动建立或更新关键帧", "Moving the camera or an object creates or updates a keyframe at the playhead")}><CircleDot size={12} />{tr(props.locale, "自动关键帧", "Auto Key")}</span>
        <span className="timeline-end">{duration.toFixed(1)}s</span>
      </div>

      <div className="timeline-record-bar">
        <div>
          <strong>{tr(props.locale, "关键帧", "Keyframes")}</strong>
          <small className="timeline-selection-name">
            {props.selectedObjectName
              ? tr(props.locale, `已选择：${props.selectedObjectName} · K 打对象帧 · 空格播放`, `Selected: ${props.selectedObjectName} · K records it · Space plays`)
              : tr(props.locale, "K 记录相机帧 · 选中对象后 K 记录对象帧 · 空格播放", "K records camera · select an object and K records it · Space plays")}
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
        <div className="timeline-track-list" ref={trackListRef} onWheel={onTimelineWheel}>
          <TimelineRuler locale={props.locale} duration={duration} currentTime={currentTime} onSeek={seekTimeline} zoom={zoom} onZoomReset={() => changeTimelineZoom(1)} />
          {frames.length === 0 && <div className="timeline-empty"><Plus size={14} /><span><strong>{tr(props.locale, "建立第一条轨道", "Create the first track")}</strong><small>{tr(props.locale, "新增轨道或按 K，把当前镜头/所选对象记录到播放头位置。", "Add a track or press K to record the current shot or selected object at the playhead.")}</small></span></div>}
          {props.animation.camera.length > 0 && <TimelineTrack icon={<Camera size={13} />} name={tr(props.locale, "相机", "Camera")} count={props.animation.camera.length} duration={duration} currentTime={currentTime} zoom={zoom} selected={selectedTrackId === "camera"} selectLabel={tr(props.locale, "选择相机轨道", "Select camera track")} addLabel={tr(props.locale, "在播放头记录相机帧", "Record camera frame at playhead")} deleteLabel={tr(props.locale, "删除相机轨道", "Delete camera track")} hint={tr(props.locale, "单击定位播放头；双击添加关键帧；滚轮缩放", "Click to seek; double-click to add a keyframe; wheel to zoom")} onSelect={() => { setSelectedFrameId(undefined); setSelectedTrackId("camera"); }} onSeek={seekTimeline} onDelete={() => deleteTrack("camera")} onAdd={time => recordFrame("camera", time)}>
            {props.animation.camera.map((frame) => frameMarker({ ...frame, kind: "camera" }))}
          </TimelineTrack>}
          {objectTracks.map((track) => <TimelineTrack key={track.modelId} icon={<Box size={13} />} name={track.name} count={track.frames.length} duration={duration} currentTime={currentTime} zoom={zoom} selected={selectedTrackId === `model:${track.modelId}`} selectLabel={tr(props.locale, `选择 ${track.name} 轨道`, `Select ${track.name} track`)} addLabel={tr(props.locale, `为 ${track.name} 记录关键帧`, `Record a keyframe for ${track.name}`)} deleteLabel={tr(props.locale, `删除 ${track.name} 轨道`, `Delete ${track.name} track`)} hint={tr(props.locale, "单击定位播放头；双击添加关键帧；滚轮缩放", "Click to seek; double-click to add a keyframe; wheel to zoom")} onSelect={() => { setSelectedFrameId(undefined); setSelectedTrackId(`model:${track.modelId}`); }} onSeek={seekTimeline} onDelete={() => deleteTrack(`model:${track.modelId}`)} onAdd={time => recordFrame("model", time, track.modelId)}>
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
          <SceneAnimationStateMachineEditor {...(props.engine ? { engine: props.engine } : {})} locale={props.locale} animation={props.animation} onChange={props.onChange} />
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
            <span>{tr(props.locale, "区间入点", "Range in point")}</span>
            <input
              type="number"
              min="0"
              max={Math.max(0, (props.animation.playbackRange?.outPoint ?? duration) - 0.1)}
              step="0.1"
              value={props.animation.playbackRange?.inPoint ?? 0}
              onChange={(event) => updatePlaybackRange(Number(event.target.value), props.animation.playbackRange?.outPoint ?? duration)}
            />
            <i>s</i>
          </label>
          <label>
            <span>{tr(props.locale, "区间出点", "Range out point")}</span>
            <input
              type="number"
              min={Math.min(duration, (props.animation.playbackRange?.inPoint ?? 0) + 0.1)}
              max={duration}
              step="0.1"
              value={props.animation.playbackRange?.outPoint ?? duration}
              onChange={(event) => updatePlaybackRange(props.animation.playbackRange?.inPoint ?? 0, Number(event.target.value))}
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
              <option value="ease-in-out">{tr(props.locale, "缓入缓出", "Ease in-out")}</option>
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
    { id: "trace", icon: <History size={14} />, zh: "行为轨迹", en: "Behavior trace" },
  ];
  return <nav className="scene-director-tabs" aria-label={tr(locale, "导演台工作区", "Director workspaces")}>
    {items.map((item) => <button type="button" key={item.id} className={workspace === item.id ? "active" : ""} aria-current={workspace === item.id ? "page" : undefined} onClick={() => onChange(item.id)}>{item.icon}<span>{tr(locale, item.zh, item.en)}</span></button>)}
  </nav>;
}

function TimelineRuler({ locale, duration, currentTime, onSeek, zoom = 1, onZoomReset }: { locale: AppLocale; duration: number; currentTime: number; onSeek: (time: number) => void; zoom?: number; onZoomReset?: () => void }) {
  // 刻度数量随缩放加密：可视密度恒定，标签按 0.1s 精度渲染避免拥挤。
  const tickCount = Math.min(25, Math.max(4, Math.round(zoom * 4)));
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => index / tickCount);
  const playhead = `${Math.min(100, Math.max(0, (currentTime / duration) * 100))}%`;
  // 放大时加宽第二列，让滚动容器出现真实横向滚动；rail 百分比坐标不变。
  const rulerStyle = zoom !== 1 ? { gridTemplateColumns: `155px calc(${zoom} * (100% - 155px))` } : undefined;
  return <div className="timeline-ruler" style={rulerStyle} aria-label={tr(locale, "时间标尺", "Time ruler")}><span title={onZoomReset ? tr(locale, `缩放 ${zoom.toFixed(1)}×；双击重置`, `Zoom ${zoom.toFixed(1)}×; double-click to reset`) : undefined} onDoubleClick={onZoomReset}>{zoom > 1.001 ? <button type="button" className="timeline-zoom-badge" onClick={onZoomReset} title={tr(locale, "重置缩放", "Reset zoom")}>{zoom.toFixed(1)}×</button> : tr(locale, "轨道", "Tracks")}</span><div className="timeline-ruler-rail" title={tr(locale, "拖动定位；滚轮缩放", "Drag to seek; wheel to zoom")} onPointerDown={event => beginTimelineScrub(event, duration, onSeek)}>{ticks.map((ratio) => <i key={ratio} style={{ left: `${ratio * 100}%` }}>{(duration * ratio).toFixed(ratio === 0 ? 0 : 1)}s</i>)}<b className="timeline-playhead" style={{ left: playhead }} /></div></div>;
}

function TimelineTrack(props: {
  icon: ReactNode;
  name: string;
  count: number;
  duration: number;
  currentTime: number;
  zoom?: number;
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
  // 放大时与 ruler 同公式加宽第二列；rail 内百分比坐标相对变宽后的 rail，scrub/拖拽换算自动成立。
  const rowStyle = props.zoom && props.zoom !== 1 ? { gridTemplateColumns: `155px calc(${props.zoom} * (100% - 155px))` } : undefined;
  return (
    <div className={`timeline-track-row ${props.selected ? "selected" : ""}`} style={rowStyle} tabIndex={0} role="group" aria-label={props.selectLabel} data-selected={props.selected || undefined} onFocus={event => { if (event.target === event.currentTarget) props.onSelect(); }} onPointerDown={event => { if (!(event.target as HTMLElement).closest("button")) props.onSelect(); }}>
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
