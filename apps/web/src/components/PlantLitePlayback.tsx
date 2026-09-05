import {
  AlertTriangle,
  Boxes,
  CircleCheck,
  Factory,
  PackagePlus,
  Pause,
  Play,
  RotateCcw,
  Truck,
} from "lucide-react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import {
  describePlantLiteTraceEvent,
  formatPlantLiteMinute,
  preparePlantLitePlayback,
  selectPlantLitePlaybackFrame,
  type PlantLitePlaybackFrame,
} from "./plantLitePlaybackModel";

const BASE_SIMULATION_MINUTES_PER_SECOND = 12;
const SPEEDS = [0.5, 1, 2, 4] as const;

export function PlantLitePlayback({ trace, model, onFrame }: { trace: PlantLiteReplicationTrace; model: PlantLiteModel; onFrame?: (frame: PlantLitePlaybackFrame | null) => void }) {
  const prepared = useMemo(() => preparePlantLitePlayback(trace, model), [model, trace]);
  const duration = prepared.duration;
  const [minute, setMinute] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const frame = useMemo(() => selectPlantLitePlaybackFrame(prepared, minute), [minute, prepared]);
  useEffect(() => { onFrame?.(frame); }, [frame, onFrame]);
  useEffect(() => () => { onFrame?.(null); }, [onFrame]);

  useEffect(() => {
    setMinute(0);
    setPlaying(false);
  }, [trace]);

  useEffect(() => {
    if (!playing || duration <= 0) return undefined;
    let animationFrame = 0;
    let previous = performance.now();
    const advance = (now: number) => {
      const elapsedSeconds = Math.min(0.1, (now - previous) / 1_000);
      previous = now;
      setMinute((current) => {
        const next = current + elapsedSeconds * BASE_SIMULATION_MINUTES_PER_SECOND * speed;
        return next >= duration ? duration : next;
      });
      animationFrame = requestAnimationFrame(advance);
    };
    animationFrame = requestAnimationFrame(advance);
    return () => cancelAnimationFrame(animationFrame);
  }, [duration, playing, speed]);

  useEffect(() => {
    if (playing && minute >= duration) setPlaying(false);
  }, [duration, minute, playing]);

  const restartOrToggle = () => {
    if (minute >= duration) setMinute(0);
    setPlaying((current) => !current);
  };
  const latestEvent = describePlantLiteTraceEvent(frame.latestEvent, model);

  return (
    <section className="plant-playback" aria-label="物流轨迹回放">
      <header>
        <span>
          <strong>物流轨迹回放</strong>
          <small>代表性重复 #{trace.replication + 1} · seed {trace.seed} · {trace.capturedItemCount} 个物料的真实 DES 事件</small>
        </span>
        <span className="plant-playback-clock">{formatPlantLiteMinute(frame.atMinute)} <small>/ {formatPlantLiteMinute(duration)}</small></span>
      </header>

      <div className="plant-playback-stage" role="img" aria-label={`轨迹内当前 ${frame.activeItems} 个在制品，完成 ${frame.completedItems} 个，报废 ${frame.scrappedItems} 个`}>
        <div className="plant-playback-track" />
        {model.nodes.map((node, index) => {
          const resourceId = node.kind === "transport" || node.kind === "station" ? node.resourceId : undefined;
          const unavailable = resourceId ? frame.unavailableResourceUnits[resourceId] ?? 0 : 0;
          const capacity = resourceId ? model.resources?.find((resource) => resource.id === resourceId)?.capacity ?? 1 : 1;
          const failed = unavailable >= capacity;
          const degraded = unavailable > 0 && !failed;
          return (
            <div
              key={node.id}
              className={`plant-playback-node ${failed ? "failed" : degraded ? "degraded" : ""}`}
              style={{ "--node-x": `${nodePosition(index, model.nodes.length)}%` } as CSSProperties}
              title={unavailable ? `${node.name}：${unavailable}/${capacity} 台关联资源不可用` : node.name}
            >
              <NodeIcon kind={node.kind} />
              <span>{node.name}</span>
              {unavailable ? <AlertTriangle size={12} aria-label={`${unavailable}/${capacity} 台资源不可用`} /> : null}
            </div>
          );
        })}
        {frame.items.map((item) => (
          <span
            key={item.itemId}
            className={`plant-playback-item ${item.state}`}
            style={{ "--item-x": `${item.xPercent}%`, "--item-y": `${18 + item.lane * 9}px` } as CSSProperties}
            title={`${item.itemId} · ${item.state}`}
          />
        ))}
      </div>

      <input
        className="plant-playback-timeline"
        type="range"
        min={0}
        max={Math.max(duration, 0.01)}
        step={0.02}
        value={Math.min(minute, Math.max(duration, 0.01))}
        aria-label="仿真时间轴"
        onChange={(event) => {
          setMinute(Number(event.target.value));
          setPlaying(false);
        }}
      />

      <footer>
        <div className="plant-playback-controls">
          <button type="button" onClick={restartOrToggle} disabled={duration <= 0} aria-label={playing ? "暂停回放" : "播放回放"}>
            {playing ? <Pause size={13} /> : <Play size={13} />}
          </button>
          <button type="button" onClick={() => { setMinute(0); setPlaying(false); }} disabled={minute === 0} aria-label="回到开始">
            <RotateCcw size={13} />
          </button>
          <span className="plant-playback-speeds" aria-label="回放速度">
            {SPEEDS.map((value) => <button type="button" key={value} className={speed === value ? "active" : ""} aria-pressed={speed === value} onClick={() => setSpeed(value)}>{value}×</button>)}
          </span>
        </div>
        <span className="plant-playback-status"><b>{frame.activeItems}</b> 在制 · <b>{frame.completedItems}</b> 完成 · <b>{frame.scrappedItems}</b> 报废 · {latestEvent}</span>
      </footer>
      {trace.truncated ? (
        <p className="plant-playback-warning"><AlertTriangle size={13} />轨迹已按上限截断：显示前 {trace.limits.maxItems} 个物料、{trace.limits.maxEvents} 个事件，另有 {trace.omittedEventCount} 个事件未记录；统计结果不受影响。</p>
      ) : null}
    </section>
  );
}

function NodeIcon({ kind }: { kind: PlantLiteModel["nodes"][number]["kind"] }) {
  if (kind === "source") return <PackagePlus size={15} />;
  if (kind === "station") return <Factory size={15} />;
  if (kind === "transport") return <Truck size={15} />;
  if (kind === "sink") return <CircleCheck size={15} />;
  return <Boxes size={15} />;
}

function nodePosition(index: number, count: number): number {
  if (count <= 1) return 50;
  return 5 + (index / (count - 1)) * 90;
}
