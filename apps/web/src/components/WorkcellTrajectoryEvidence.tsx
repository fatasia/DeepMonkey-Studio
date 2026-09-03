import type { WorkcellRobotTrajectory, WorkcellTrajectoryAnalysis } from "@bim-studio/contracts";
import { ChevronLeft, ChevronRight, Crosshair, Pause, Play, Route } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  adjacentWorkcellTrajectoryEvent,
  buildWorkcellTrajectoryTracks,
  sampleWorkcellTrajectory,
  type WorkcellTrajectoryPlaybackEvent,
  type WorkcellTrajectoryTrack,
} from "./workcellTrajectoryPlayback";
import { WorkcellTrajectoryDeliveryActions } from "./WorkcellTrajectoryDeliveryActions";
import "./WorkcellTrajectoryEvidence.css";

interface WorkcellTrajectoryEvidenceProps {
  analysis: WorkcellTrajectoryAnalysis;
  trajectories?: readonly WorkcellRobotTrajectory[];
  onOpenObject?: (objectId: string) => void;
}

export function WorkcellTrajectoryEvidence({ analysis, trajectories = [], onOpenObject }: WorkcellTrajectoryEvidenceProps) {
  const potential = analysis.segmentChecks.reduce((total, item) => total + item.potentialObstacleIds.length, 0);
  const candidates = analysis.avoidanceCandidates.filter((item) => item.status === "candidate-found").length;
  const jointRisks = analysis.jointChecks.filter((item) =>
    item.positionStatus === "outside-limit"
    || item.positionStatus === "tolerance-overlap"
    || item.speedStatus === "outside-limit"
    || item.speedStatus === "tolerance-overlap").length;
  const tracks = useMemo(() => buildWorkcellTrajectoryTracks(trajectories, analysis), [analysis, trajectories]);
  const [selectedTrackId, setSelectedTrackId] = useState(tracks[0]?.id ?? "");
  const selectedTrack = tracks.find((item) => item.id === selectedTrackId) ?? tracks[0];

  return <section className="workcell-trajectory-evidence" aria-label="机器人轨迹证据">
    <header className="workcell-trajectory-heading">
      <span><Route size={14} /><strong>机器人轨迹快速初筛</strong></span>
      <div className="workcell-trajectory-heading-actions">
        <em className={analysis.precisionStatus}>{precisionLabel(analysis.precisionStatus)}</em>
        <WorkcellTrajectoryDeliveryActions analysis={analysis} trajectories={trajectories} />
      </div>
    </header>
    <div className="workcell-trajectory-metrics">
      <span><b>{potential}</b>潜在障碍</span>
      <span><b>{candidates}</b>避障候选</span>
      <span><b>{jointRisks}</b>关节约束风险</span>
      <span><b>{analysis.scheduleConflicts.length}</b>时段冲突</span>
      <span><b>{analysis.cycle.maxConcurrentRobots}</b>最大并行机器人</span>
      <span><b>{analysis.cycle.scheduleSpanSec.toFixed(1)}s</b>排程跨度</span>
    </div>
    <p className="workcell-trajectory-declaration">{analysis.declaration}</p>
    {selectedTrack
      ? <TrajectoryEvidencePlayback
          key={`${selectedTrack.id}:${selectedTrack.startTimeSec}:${selectedTrack.endTimeSec}`}
          track={selectedTrack}
          tracks={tracks}
          onSelectTrack={setSelectedTrackId}
          {...(onOpenObject ? { onOpenObject } : {})}
        />
      : <div className="workcell-trajectory-unavailable" role="status">
          <strong>当前结果不能回放</strong>
          <span>审计结果只有汇总，或轨迹点/时序与本次证据不一致。修复轨迹输入并重新运行快速验证后再查看。</span>
        </div>}
  </section>;
}

function TrajectoryEvidencePlayback({ track, tracks, onSelectTrack, onOpenObject }: {
  track: WorkcellTrajectoryTrack;
  tracks: WorkcellTrajectoryTrack[];
  onSelectTrack: (trajectoryId: string) => void;
  onOpenObject?: (objectId: string) => void;
}) {
  const [timeSec, setTimeSec] = useState(track.startTimeSec);
  const [speed, setSpeed] = useState<0.5 | 1 | 2>(1);
  const [playing, setPlaying] = useState(false);
  const [selectedEventId, setSelectedEventId] = useState<string>();
  const animationFrame = useRef<number | undefined>(undefined);
  const lastTick = useRef<number | undefined>(undefined);
  const playhead = useRef(track.startTimeSec);
  const frame = sampleWorkcellTrajectory(track, timeSec);
  const selectedEvent = track.events.find((item) => item.id === selectedEventId);
  const eventsAtTime = track.events.filter((item) => eventIsActive(item, timeSec)).sort((left, right) => eventPriority(right) - eventPriority(left));
  const activeEvent = selectedEvent && eventIsActive(selectedEvent, timeSec)
    ? selectedEvent
    : eventsAtTime.find((item) => item.kind !== "waypoint") ?? eventsAtTime[0];
  const duration = track.endTimeSec - track.startTimeSec;

  useEffect(() => {
    if (!playing) return;
    lastTick.current = undefined;
    const tick = (timestamp: number) => {
      const previous = lastTick.current;
      lastTick.current = timestamp;
      if (previous !== undefined) {
        const elapsed = Math.max(0, timestamp - previous) / 1_000 * speed;
        const next = Math.min(track.endTimeSec, playhead.current + elapsed);
        playhead.current = next;
        setTimeSec(next);
        if (next >= track.endTimeSec) {
          setPlaying(false);
          return;
        }
      }
      animationFrame.current = requestAnimationFrame(tick);
    };
    animationFrame.current = requestAnimationFrame(tick);
    return () => {
      if (animationFrame.current !== undefined) cancelAnimationFrame(animationFrame.current);
      animationFrame.current = undefined;
      lastTick.current = undefined;
    };
  }, [playing, speed, track.endTimeSec]);

  function togglePlayback() {
    setSelectedEventId(undefined);
    if (playing) {
      setPlaying(false);
      return;
    }
    if (timeSec >= track.endTimeSec - 1e-6) {
      playhead.current = track.startTimeSec;
      setTimeSec(track.startTimeSec);
    }
    setPlaying(true);
  }
  function seek(nextTime: number, event?: WorkcellTrajectoryPlaybackEvent) {
    setPlaying(false);
    playhead.current = nextTime;
    setTimeSec(nextTime);
    setSelectedEventId(event?.id);
  }
  function seekAdjacent(direction: -1 | 1) {
    const event = adjacentWorkcellTrajectoryEvent(track.events, timeSec, direction);
    if (event) seek(event.timeSec, event);
  }

  const focusIds = activeEvent?.objectIds.filter((item) => item !== track.robotId) ?? [];
  return <div className="workcell-trajectory-player">
    <div className="workcell-trajectory-playerbar">
      {tracks.length > 1
        ? <label><span>轨迹</span><select value={track.id} onChange={(event) => onSelectTrack(event.target.value)}>{tracks.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        : <div className="workcell-trajectory-track-name"><span>轨迹</span><strong>{track.name}</strong></div>}
      <div className="workcell-trajectory-transport">
        <button type="button" className="transport-main" onClick={togglePlayback} aria-label={playing ? "暂停轨迹" : "播放轨迹"}>
          {playing ? <Pause size={14} /> : <Play size={14} />}{playing ? "暂停" : "播放"}
        </button>
        <button type="button" onClick={() => seekAdjacent(-1)} disabled={!adjacentWorkcellTrajectoryEvent(track.events, timeSec, -1)} aria-label="上一个证据点"><ChevronLeft size={14} /></button>
        <button type="button" onClick={() => seekAdjacent(1)} disabled={!adjacentWorkcellTrajectoryEvent(track.events, timeSec, 1)} aria-label="下一个证据点"><ChevronRight size={14} /></button>
      </div>
      <div className="workcell-trajectory-speed" aria-label="回放速度">
        {([0.5, 1, 2] as const).map((value) => <button type="button" key={value} className={speed === value ? "active" : ""} onClick={() => setSpeed(value)}>{value}x</button>)}
      </div>
    </div>

    <div className="workcell-trajectory-timeline">
      <div className="workcell-trajectory-time"><strong>{formatTime(timeSec)}</strong><span>/ {formatTime(track.endTimeSec)}</span></div>
      <div className="workcell-trajectory-range-wrap">
        <input
          type="range"
          min={track.startTimeSec}
          max={track.endTimeSec}
          step={Math.max(duration / 1_000, .001)}
          value={timeSec}
          aria-label="轨迹时间轴"
          onChange={(event) => seek(Number(event.target.value))}
        />
        <div className="workcell-trajectory-markers" aria-label="轨迹证据点">
          {track.events.map((event) => <button
            type="button"
            key={event.id}
            className={`${event.kind} ${event.severity}${activeEvent?.id === event.id ? " active" : ""}`}
            style={{
              left: `${eventPosition(event.timeSec, track)}%`,
              ...(event.endTimeSec !== undefined ? { width: `${eventSpan(event, track)}%` } : {}),
            }}
            title={`${formatEventTime(event)} · ${event.label}`}
            aria-label={`${formatEventTime(event)} ${event.label}`}
            onClick={() => seek(event.timeSec, event)}
          />)}
        </div>
      </div>
    </div>

    <div className="workcell-trajectory-frame">
      <div className="workcell-trajectory-position">
        <span>TCP 候选坐标</span>
        <code>X {formatCoordinate(frame.position.x)}</code>
        <code>Y {formatCoordinate(frame.position.y)}</code>
        <code>Z {formatCoordinate(frame.position.z)}</code>
        <small>{frame.source === "waypoint" ? `关键帧 ${frame.waypointId}` : `线性段 ${(frame.segmentProgress * 100).toFixed(0)}%`}</small>
      </div>
      <div className={`workcell-trajectory-current-event ${activeEvent?.severity ?? "info"}`}>
        <span>当前证据</span>
        <strong>{activeEvent?.label ?? "当前时刻没有风险标记"}</strong>
        <small>{activeEvent ? eventKindLabel(activeEvent.kind) : "拖动时间轴或选择标记查看证据"}</small>
      </div>
      {onOpenObject && <div className="workcell-trajectory-focus-actions">
        <button type="button" onClick={() => onOpenObject(track.robotId)}><Crosshair size={13} />定位机器人</button>
        {focusIds.length === 1 && <button type="button" onClick={() => onOpenObject(focusIds[0]!)}><Crosshair size={13} />定位 {focusIds[0]}</button>}
        {focusIds.length > 1 && <select aria-label="选择并定位风险对象" value="" onChange={(event) => event.target.value && onOpenObject(event.target.value)}>
          <option value="">定位风险对象…</option>
          {focusIds.map((objectId) => <option key={objectId} value={objectId}>{objectId}</option>)}
        </select>}
      </div>}
    </div>
    <p className="workcell-trajectory-boundary">
      回放按本次审计输入的分段线性 TCP 候选轨迹插值，并逐帧显示坐标、定位关联对象。当前版本尚不驱动机器人骨骼或三维轨迹覆盖；它也不替代 IK、网格碰撞或控制器动画。
    </p>
  </div>;
}

function precisionLabel(value: WorkcellTrajectoryAnalysis["precisionStatus"]): string {
  return ({ declared: "精度已声明", partial: "精度部分声明", undeclared: "精度未声明" })[value];
}
function eventKindLabel(value: WorkcellTrajectoryPlaybackEvent["kind"]): string {
  return ({ waypoint: "真实输入关键帧", "potential-collision": "TCP 包围球 / AABB 广相位", "joint-constraint": "已声明关节约束", "schedule-conflict": "多机器人时段证据" })[value];
}
function eventPosition(timeSec: number, track: WorkcellTrajectoryTrack): number {
  const duration = track.endTimeSec - track.startTimeSec;
  return duration > 0 ? Math.max(0, Math.min(100, (timeSec - track.startTimeSec) / duration * 100)) : 0;
}
function eventSpan(event: WorkcellTrajectoryPlaybackEvent, track: WorkcellTrajectoryTrack): number {
  return event.endTimeSec === undefined ? 0 : Math.max(0, eventPosition(event.endTimeSec, track) - eventPosition(event.timeSec, track));
}
function eventIsActive(event: WorkcellTrajectoryPlaybackEvent, timeSec: number): boolean {
  return event.endTimeSec === undefined
    ? Math.abs(event.timeSec - timeSec) <= 1e-6
    : timeSec >= event.timeSec - 1e-6 && timeSec <= event.endTimeSec + 1e-6;
}
function eventPriority(event: WorkcellTrajectoryPlaybackEvent): number {
  return ({ info: 0, warning: 1, error: 2 })[event.severity] * 10
    + ({ waypoint: 0, "potential-collision": 1, "schedule-conflict": 2, "joint-constraint": 3 })[event.kind];
}
function formatEventTime(event: WorkcellTrajectoryPlaybackEvent): string {
  return event.endTimeSec === undefined ? formatTime(event.timeSec) : `${formatTime(event.timeSec)} – ${formatTime(event.endTimeSec)}`;
}
function formatTime(value: number): string { return `${value.toFixed(2)} s`; }
function formatCoordinate(value: number): string { return `${value.toFixed(3)} m`; }
