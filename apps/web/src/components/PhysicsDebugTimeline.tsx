import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Download } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import type { PhysicsPoseFrame } from "../viewer/physicsPoseRecorder";
import type { PoseCompareResult } from "../viewer/physicsPoseCompare";
import "./PhysicsDebugTimeline.css";

/**
 * Brief-PhysDbg 物理调试时间线(Brief-PhysDbg 实施要点 2/4,2026-10-03)。
 *
 * tick 刻度 + 播放头 + 逐帧步进 + 对象位姿包络小图;跨端比对超差帧以红点标在
 * 刻度轨上并可一键跳转(验收③的 UI 面)。样式全部走 base.css 令牌
 * (pdtl- 前缀,与 PhysicsDebugPanel.css 的 pdbg- 家族同纪律:禁硬编码色)。
 *
 * 语义图例与引擎侧录制器通道合同同源
 * (`@bim-studio/deep-engine/physics` PHYSICS_DEBUG_SEMANTIC_COLORS:
 * 接触=青/穿透=红/约束=黄;UI 面分别映射 --info/--danger/--warning 令牌,
 * 3D 覆盖层挂载点在 viewer 领地,合同先行钉死防漂移)。
 */

export type PhysicsTimelineMetric = "position" | "rotation";

export interface PhysicsTimelineSectionProps {
  locale: AppLocale;
  /** T28 录制帧(时间升序);空数组时整段显示引导空态。 */
  frames: readonly PhysicsPoseFrame[];
  isReplaying: boolean;
  replayStep: number | null;
  onApplyReplayFrame: (step: number) => void;
  onExitReplay: () => void;
  /** 跨端比对结果(T17 双槽),超差帧标红与跳转的数据源;未比对时为 undefined。 */
  comparison: PoseCompareResult | undefined;
  onExportDebugHashJson: () => void;
  /** 引擎哈希 JSON 导出是否可用(有录制数据且处理器已接线)。 */
  debugHashExportAvailable: boolean;
}

const CHART_WIDTH = 268;
const CHART_HEIGHT = 64;

/** 与首帧的包络:全刚体取最大的位移(m)或短弧旋转角(rad)。 */
export function computePoseEnvelope(frames: readonly PhysicsPoseFrame[], metric: PhysicsTimelineMetric): number[] {
  if (frames.length === 0) return [];
  const first = frames[0]!.bodies;
  const quaternionAngle = (a: readonly number[], b: readonly number[]): number =>
    2 * Math.acos(Math.min(1, Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!)));
  return frames.map((frame) => {
    let envelope = 0;
    for (const pose of frame.bodies) {
      const reference = first.find((entry) => entry.id === pose.id);
      if (!reference) continue;
      const value = metric === "position"
        ? Math.hypot(pose.p[0] - reference.p[0], pose.p[1] - reference.p[1], pose.p[2] - reference.p[2])
        : quaternionAngle(pose.q, reference.q);
      envelope = Math.max(envelope, value);
    }
    return envelope;
  });
}

/** 刻度步长自适应:≤10 个主刻度的 1/2/5 系列值。 */
export function timelineLabelStep(total: number): number {
  for (const candidate of [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000]) {
    if (total / candidate <= 10) return candidate;
  }
  return 2000;
}

export function PhysicsTimelineSection(props: PhysicsTimelineSectionProps) {
  const { locale, frames, comparison } = props;
  const [metric, setMetric] = useState<PhysicsTimelineMetric>("position");
  const total = frames.length;
  const current = props.replayStep ?? total;
  const exceededSteps = useMemo(
    () => new Set(comparison?.perStep.filter((row) => row.exceeded).map((row) => row.step) ?? []),
    [comparison],
  );
  const envelope = useMemo(() => computePoseEnvelope(frames, metric), [frames, metric]);
  const envelopeMax = envelope.length ? Math.max(...envelope, 1e-12) : 1;
  const labelStep = timelineLabelStep(Math.max(total, 1));
  const ratioOf = (step: number): number => (total <= 1 ? 0 : (step - 1) / (total - 1));
  const seekFromEvent = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (total === 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0;
    props.onApplyReplayFrame(Math.min(Math.max(Math.round(ratio * (total - 1)) + 1, 1), total));
  };
  const seekFromKeyboard = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (total === 0) return;
    const stepDelta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    const anchor = props.replayStep ?? total;
    if (stepDelta !== 0) {
      event.preventDefault();
      props.onApplyReplayFrame(Math.min(Math.max(anchor + stepDelta, 1), total));
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      props.onApplyReplayFrame(event.key === "Home" ? 1 : total);
    }
  };
  const chartPoints = envelope.map((value, index) => {
    const x = envelope.length === 1 ? CHART_WIDTH : (index / (envelope.length - 1)) * CHART_WIDTH;
    const y = CHART_HEIGHT - 4 - (value / envelopeMax) * (CHART_HEIGHT - 10);
    return { x, y, exceeded: exceededSteps.has(frames[index]!.step) };
  });
  const firstExceeded = comparison?.firstExceededStep ?? null;

  return (
    <section className="pdbg-section pdtl-section" aria-label={tr(locale, "物理调试时间线", "Physics debug timeline")}>
      <strong>{tr(locale, "时间线", "Timeline")}</strong>
      {total === 0 ? (
        <div className="pdbg-empty">
          {tr(locale, "开始录制后,这里给出 tick 刻度、逐帧步进与位姿包络", "Start recording to get tick ruler, frame stepping and pose envelope")}
        </div>
      ) : (
        <>
          <div className="pdtl-transport">
            <button
              disabled={!props.isReplaying || current <= 1}
              title={props.isReplaying ? tr(locale, "上一帧", "Previous frame") : tr(locale, "先进入回放(拖动时间轴)", "Enter replay first (drag the ruler)")}
              onClick={() => props.onApplyReplayFrame(current - 1)}
              aria-label={tr(locale, "上一帧", "Previous frame")}
            >
              <ChevronLeft size={12} />
            </button>
            <button
              disabled={!props.isReplaying || current >= total}
              title={props.isReplaying ? tr(locale, "下一帧", "Next frame") : tr(locale, "先进入回放(拖动时间轴)", "Enter replay first (drag the ruler)")}
              onClick={() => props.onApplyReplayFrame(current + 1)}
              aria-label={tr(locale, "下一帧", "Next frame")}
            >
              <ChevronRight size={12} />
            </button>
            <output className="pdtl-counter" title={tr(locale, "当前帧 / 总帧数", "Current / total frames")}>
              {props.isReplaying ? current : tr(locale, "实况", "live")} · {total}
            </output>
            <button
              disabled={!props.isReplaying}
              title={props.isReplaying ? tr(locale, "回到实况(清除回放覆盖)", "Back to live (clear replay override)") : tr(locale, "当前不在回放", "Not replaying")}
              onClick={props.onExitReplay}
            >
              {tr(locale, "实况", "Live")}
            </button>
          </div>

          <div
            className={`pdtl-ruler ${props.isReplaying ? "replaying" : ""}`}
            role="slider"
            aria-label={tr(locale, "回放刻度轨(点击定位帧)", "Replay ruler (click to seek a frame)")}
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={current}
            tabIndex={0}
            title={props.isReplaying
              ? tr(locale, "点击任意位置跳转该帧;←/→ 逐帧,Home/End 跳两端", "Click to jump to a frame; ←/→ step, Home/End for edges")
              : tr(locale, "点击进入回放并定位该帧", "Click to enter replay at a frame")}
            onPointerDown={seekFromEvent}
            onKeyDown={seekFromKeyboard}
          >
            {Array.from({ length: Math.floor((total - 1) / labelStep) + 1 }, (_, index) => index * labelStep + 1).map((step) => (
              <i key={step} className="pdtl-tick" style={{ left: `${ratioOf(step) * 100}%` }}>
                {step}
              </i>
            ))}
            {frames.map((frame) => exceededSteps.has(frame.step) ? (
              <i key={`x-${frame.step}`} className="pdtl-exceed" style={{ left: `${ratioOf(frame.step) * 100}%` }} title={tr(locale, `帧 ${frame.step} 跨端超差`, `Frame ${frame.step} exceeds cross-end tolerance`)} />
            ) : null)}
            <b className="pdtl-playhead" style={{ left: `${ratioOf(Math.min(current, total)) * 100}%` }} />
          </div>

          <div className="pdbg-row pdbg-curvehead">
            <button className={metric === "position" ? "active" : ""} onClick={() => setMetric("position")}>
              {tr(locale, "位移包络", "Position")}
            </button>
            <button className={metric === "rotation" ? "active" : ""} onClick={() => setMetric("rotation")}>
              {tr(locale, "旋转包络", "Rotation")}
            </button>
            <span className="pdbg-num">
              {metric === "position" ? "mm" : "mrad"} · {tr(locale, "峰", "peak")}{" "}
              {(envelopeMax * 1000).toFixed(1)}
            </span>
          </div>
          <svg
            className="pdbg-curve pdtl-curve"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
            role="img"
            aria-label={tr(locale, "全刚体位姿包络(相对首帧)", "All-body pose envelope (relative to first frame)")}
          >
            <line x1={0} y1={CHART_HEIGHT - 4} x2={CHART_WIDTH} y2={CHART_HEIGHT - 4} className="pdbg-axis" />
            <polyline className="pdbg-line" points={chartPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")} />
            {props.isReplaying && <line x1={chartPoints[Math.min(current, total) - 1]?.x ?? 0} y1={0} x2={chartPoints[Math.min(current, total) - 1]?.x ?? 0} y2={CHART_HEIGHT} className="pdtl-cursor" />}
            {chartPoints.map((point, index) => point.exceeded ? (
              <circle key={index} cx={point.x} cy={point.y} r={2} className="pdbg-exceed" />
            ) : null)}
          </svg>

          {firstExceeded !== null && (
            <button className="pdtl-jump" onClick={() => props.onApplyReplayFrame(firstExceeded)}>
              {tr(locale, `跳转首超差帧 ${firstExceeded}`, `Jump to first exceeded frame ${firstExceeded}`)}
            </button>
          )}

          <div className="pdtl-legend" title={tr(locale, "引擎侧录制器通道语义(3D 覆盖层同源合同)", "Engine recorder channel semantics (shared with the 3D overlay contract)")}>
            <span className="pdtl-chip pdtl-contact">{tr(locale, "接触", "Contact")}</span>
            <span className="pdtl-chip pdtl-penetration">{tr(locale, "穿透", "Penetration")}</span>
            <span className="pdtl-chip pdtl-constraint">{tr(locale, "约束力", "Constraint")}</span>
          </div>

          <button
            className="pdbg-wide"
            disabled={!props.debugHashExportAvailable}
            title={props.debugHashExportAvailable
              ? tr(locale, "导出引擎哈希 JSON(f32 量化 + 逐 tick 哈希链,供 native 对拍)", "Export engine hash JSON (f32 quantized + per-tick hash chain, for native parity)")
              : tr(locale, "需要已录制数据", "Requires recorded data")}
            onClick={props.onExportDebugHashJson}
          >
            <Download size={12} />
            {tr(locale, "导出调试哈希 JSON", "Export debug hash JSON")}
          </button>
        </>
      )}
    </section>
  );
}
