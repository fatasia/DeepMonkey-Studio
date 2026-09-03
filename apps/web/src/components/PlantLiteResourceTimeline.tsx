import { AlertTriangle, GanttChartSquare } from "lucide-react";
import { useMemo, type CSSProperties } from "react";
import type { PlantLiteModel, PlantLiteReplicationTrace } from "@bim-studio/contracts";
import { formatPlantLiteMinute } from "./plantLitePlaybackModel";
import { derivePlantLiteResourceTimeline, type PlantLiteTimelineInterval } from "./plantLiteResourceTimelineModel";
import "./PlantLiteResourceTimeline.css";

export function PlantLiteResourceTimeline({ trace, model }: { trace: PlantLiteReplicationTrace; model: PlantLiteModel }) {
  const timeline = useMemo(() => derivePlantLiteResourceTimeline(trace, model), [model, trace]);
  if (!timeline.rows.length || timeline.durationMinutes <= 0) return null;
  return (
    <details className="plant-resource-timeline">
      <summary>
        <span><GanttChartSquare size={14} /><strong>资源甘特</strong></span>
        <small>代表性重复 · {timeline.rows.length} 行 · {timeline.intervalCount} 个时段</small>
      </summary>
      <div className="plant-resource-timeline-body">
        <div className="plant-resource-timeline-axis" aria-hidden="true">
          <span>00:00</span><span>{formatPlantLiteMinute(timeline.durationMinutes / 2)}</span><span>{formatPlantLiteMinute(timeline.durationMinutes)}</span>
        </div>
        <div className="plant-resource-timeline-rows" role="table" aria-label="代表性重复资源甘特图">
          {timeline.rows.map((row) => (
            <div className="plant-resource-timeline-row" role="row" key={row.id}>
              <span role="rowheader" title={row.label}>{row.label}</span>
              <div
                role="cell"
                className="plant-resource-timeline-track"
                style={{ "--timeline-lanes": row.laneCount } as CSSProperties}
              >
                {row.intervals.map((interval) => <TimelineBar key={interval.id} interval={interval} duration={timeline.durationMinutes} />)}
              </div>
            </div>
          ))}
        </div>
        <footer>
          <span><i className="processing" />加工</span><span><i className="transport" />搬运</span><span><i className="changeover" />换型</span><span><i className="failure" />故障</span>
          <small>该图来自 #{trace.replication + 1} 次代表性运行，不替代 95% 统计区间。</small>
        </footer>
        {(trace.truncated || timeline.omittedIntervalCount > 0) && <p className="plant-resource-timeline-warning"><AlertTriangle size={12} />
          {trace.truncated ? `源轨迹已截断，另有 ${trace.omittedEventCount} 个事件未记录。` : ""}
          {timeline.omittedIntervalCount > 0 ? ` 为控制浏览器负载，另有 ${timeline.omittedIntervalCount} 个时段未绘制。` : ""}
        </p>}
      </div>
    </details>
  );
}

function TimelineBar({ interval, duration }: { interval: PlantLiteTimelineInterval; duration: number }) {
  const start = clampPercent(interval.startMinute / duration * 100);
  const end = clampPercent(interval.endMinute / duration * 100);
  const width = Math.max(0.35, end - start);
  const title = `${interval.label} · ${formatPlantLiteMinute(interval.startMinute)}–${formatPlantLiteMinute(interval.endMinute)}${interval.incomplete ? " · 轨迹内未闭合" : ""}`;
  return <span
    className={`plant-resource-timeline-bar ${interval.kind}${interval.incomplete ? " incomplete" : ""}`}
    style={{ "--bar-start": `${start}%`, "--bar-width": `${width}%`, "--bar-lane": interval.lane } as CSSProperties}
    title={title}
    aria-label={title}
  />;
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));
}
