import { useEffect, useId, useRef, useState } from "react";
import { Activity, ChevronDown, ChevronRight, TriangleAlert, Trash2, X } from "lucide-react";
import type { FrameMetrics } from "@bim-studio/deep-engine/webgpu";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { readStudioQualityTelemetry } from "../viewer/StudioDeepQualityTelemetry";
import { translate as tr, type AppLocale } from "../i18n";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import {
  ProfilerSwimlaneCollector,
  buildSwimlaneView,
  type ProfilerSwimlaneView,
} from "./profilerSwimlaneModel";
import "./ProfilerSwimlanePanel.css";

/**
 * 六引擎对标 P2:作者级 Profiler 泳道面板。
 *
 * 与 QualityTelemetryPanel(最新一帧 Top-8 列表)互补:本面板给跨帧泳道——
 * 行 = pass 名(窗口总耗时降序,截前 N),列 = 实测帧,横条 = 帧内耗时
 * (全表共享归一化上限,Unity Profiler 口径),并附 GPU 跨度 / CPU 提交 /
 * A2 rendererRebuilds 重建增量标记;窗口内单帧最贵 pass 直接点名。
 *
 * 数据单源见 profilerSwimlaneModel.ts 头注;采样走 rAF、仅面板开启时运行,
 * 关闭即停——不给渲染帧循环增加任何负担(面板开销≤0.5ms 口径为构造性满足)。
 */

/** 泳道重绘节奏:与家族面板(250ms)一致;采样与重绘分离,采样不触发 React。 */
const REFRESH_INTERVAL_MS = 250;
/** 泳道默认窗口帧数与行数(与模型默认一致,显式写出便于调参)。 */
const WINDOW_CAPACITY = 48;
const LANE_LIMIT = 10;

interface ProfilerPanelMeta {
  readonly attached: boolean;
  readonly timings: "detached" | "off" | "unavailable" | "measured";
  readonly fps: number | undefined;
  readonly sampleCount: number;
}

interface ProfilerSwimlanePanelProps {
  locale: AppLocale;
  engine: ViewerEngine | undefined;
  onClose: () => void;
}

export function ProfilerSwimlanePanel(props: ProfilerSwimlanePanelProps) {
  const { locale, engine } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const collectorRef = useRef<ProfilerSwimlaneCollector | undefined>(undefined);
  if (!collectorRef.current) collectorRef.current = new ProfilerSwimlaneCollector({ capacity: WINDOW_CAPACITY });
  const [view, setView] = useState<ProfilerSwimlaneView>(() => buildSwimlaneView(collectorRef.current!.snapshot(), { maxLanes: LANE_LIMIT }));
  // meta 惰性初始化:静态首屏(不跑 effect)也必须读真实注册表,不得渲染假"未接入"。
  const [meta, setMeta] = useState<ProfilerPanelMeta>(() => {
    const quality = readStudioQualityTelemetry();
    const timings = quality?.latestPassTimings;
    const perf = engine?.getPerformanceSnapshot();
    return {
      attached: quality !== undefined,
      timings: quality === undefined
        ? "detached"
        : timings === undefined
          ? "off"
          : timings.availability === "unavailable" ? "unavailable" : "measured",
      fps: perf && perf.sampleCount >= 2 ? perf.fps : undefined,
      sampleCount: collectorRef.current!.size,
    };
  });

  // 采样环:每次 rAF 只读既有只读快照并落环形缓冲,不触发渲染。
  useEffect(() => {
    let raf = 0;
    let stopped = false;
    const tick = (): void => {
      if (stopped) return;
      const deepFrame = engine?.getPerformanceSnapshot()?.deep?.frame as FrameMetrics | undefined;
      const timings = readStudioQualityTelemetry()?.latestPassTimings;
      if (timings && timings.availability === "measured" && timings.passes) {
        const aligned = deepFrame !== undefined && deepFrame.frame === timings.frame;
        collectorRef.current!.push({
          frame: timings.frame,
          passes: timings.passes,
          ...(timings.milliseconds !== undefined ? { gpuSpanMs: timings.milliseconds } : {}),
          ...(aligned && deepFrame ? { cpuSubmitMs: deepFrame.cpuSubmitMs } : {}),
          ...(timings.measuredPassCount !== undefined ? { measuredPassCount: timings.measuredPassCount } : {}),
          ...(timings.requestedPassCount !== undefined ? { requestedPassCount: timings.requestedPassCount } : {}),
          ...(aligned && deepFrame?.rendererRebuilds ? { rebuildTotal: deepFrame.rendererRebuilds.total } : {}),
        });
      }
      raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
    return () => {
      stopped = true;
      window.cancelAnimationFrame(raf);
    };
  }, [engine]);

  // 重绘环:250ms 把环形缓冲折叠成泳道视图;面板关闭时整个 effect 随组件卸载消失。
  useEffect(() => {
    const refresh = (): void => {
      const quality = readStudioQualityTelemetry();
      const timings = quality?.latestPassTimings;
      const perf = engine?.getPerformanceSnapshot();
      setView(buildSwimlaneView(collectorRef.current!.snapshot(), { maxLanes: LANE_LIMIT }));
      setMeta({
        attached: quality !== undefined,
        timings: quality === undefined
          ? "detached"
          : timings === undefined
            ? "off"
            : timings.availability === "unavailable" ? "unavailable" : "measured",
        fps: perf && perf.sampleCount >= 2 ? perf.fps : undefined,
        sampleCount: collectorRef.current!.size,
      });
    };
    refresh();
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [engine]);

  const { attached, timings } = meta;
  const hasLanes = view.lanes.length > 0 && view.frames.length > 0;

  return (
    <div
      ref={drag.panelRef}
      style={drag.style}
      className={`profiler-swimlane-panel${collapsed ? " collapsed" : ""}`}
      aria-label={tr(locale, "性能剖析", "Profiler")}
      data-collapsed={collapsed || undefined}
    >
      <header
        data-drag-handle="true"
        title={tr(locale, "拖动标题栏移动面板", "Drag the title bar to move the panel")}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      >
        <span className="prof-title">
          <Activity size={15} />
          <strong>{tr(locale, "性能剖析", "Profiler")}</strong>
          <small className={attached ? "prof-badge on" : "prof-badge"}>
            {attached ? "Deep WebGPU" : tr(locale, "未接入", "Not attached")}
          </small>
          <small className="prof-fps-mini">{meta.fps !== undefined ? `${meta.fps.toFixed(0)} FPS` : "—"}</small>
        </span>
        <span className="prof-actions">
          <button type="button" aria-label={tr(locale, "清空采样", "Clear samples")} title={tr(locale, "清空采样", "Clear samples")}
            onClick={() => {
              collectorRef.current!.clear();
              setView(buildSwimlaneView([]));
            }}>
            <Trash2 size={13} />
          </button>
          <button type="button" aria-expanded={!collapsed} aria-controls={bodyId}
            title={collapsed ? tr(locale, "展开", "Expand") : tr(locale, "折叠", "Collapse")}
            onClick={() => setCollapsed(value => !value)}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" aria-label={tr(locale, "关闭", "Close")} title={tr(locale, "关闭", "Close")} onClick={props.onClose}>
            <X size={14} />
          </button>
        </span>
      </header>
      {!collapsed && (
        <div id={bodyId} className="prof-body">
          <ProfilerSummary locale={locale} view={view} meta={meta} />
          {!attached ? (
            <p className="prof-empty">
              {tr(locale,
                "当前后端未接入 Deep 帧指标。切换到 Deep WebGPU 后,这里显示逐 pass GPU 泳道。",
                "The current backend does not publish Deep frame metrics. Switch to Deep WebGPU to see the per-pass GPU swimlane.")}
            </p>
          ) : timings === "off" ? (
            <p className="prof-empty">
              {tr(locale,
                "逐 pass GPU 计时未开启:后端未启用 gpuPassTiming 采集开关。",
                "Per-pass GPU timing is off: the backend was not created with the gpuPassTiming switch.")}
            </p>
          ) : timings === "unavailable" ? (
            <p className="prof-empty off">
              <TriangleAlert size={13} /> {tr(locale, "逐 pass 计时暂不可用(时间戳查询槽忙或读回未完成),恢复后自动续采。",
                "Per-pass timing is temporarily unavailable (timestamp slots busy or readback pending); sampling resumes automatically.")}
            </p>
          ) : !hasLanes ? (
            <p className="prof-empty">{tr(locale, "采样中…保持场景可见即可累积泳道。", "Sampling… keep the scene visible to accumulate lanes.")}</p>
          ) : (
            <SwimlaneGrid locale={locale} view={view} />
          )}
          <footer className="prof-footnote">
            {tr(locale,
              "列 = GPU 计时实测帧(读回滞后 1-2 帧,按帧号对齐 CPU 提交与重建账目);采样仅在面板开启时运行,不给帧循环增加负担。",
              "Columns are GPU-timing measured frames (1-2 frame readback lag); CPU submit and rebuild ledger align by frame number. Sampling runs only while the panel is open.")}
          </footer>
        </div>
      )}
    </div>
  );
}

/** 导出供组件测试直测(静态渲染不跑 effect,泳道/摘要以构造视图验证)。 */
export function ProfilerSummary({ locale, view, meta }: {
  locale: AppLocale;
  view: ProfilerSwimlaneView;
  meta: ProfilerPanelMeta;
}) {
  const latest = view.frames.at(-1);
  return (
    <div className="prof-summary">
      <div className={view.mostExpensive ? "prof-kpi" : "prof-kpi dim"}>
        <strong>{view.mostExpensive ? view.mostExpensive.passId : "—"}</strong>
        <span>{view.mostExpensive
          ? tr(locale, `最贵 pass · ${view.mostExpensive.durationMs.toFixed(2)} ms @ #${view.mostExpensive.frame}`,
            `Hottest pass · ${view.mostExpensive.durationMs.toFixed(2)} ms @ #${view.mostExpensive.frame}`)
          : tr(locale, "最贵 pass", "Hottest pass")}</span>
      </div>
      <div className="prof-kpi">
        <strong>{latest && latest.requestedPassCount
          ? `${latest.measuredPassCount ?? latest.passes.length}/${latest.requestedPassCount}`
          : latest ? String(latest.passes.length) : "—"}</strong>
        <span>{tr(locale, "实测/请求 pass(最新帧)", "measured/requested passes (latest)")}</span>
      </div>
      <div className="prof-kpi">
        <strong>{meta.sampleCount}</strong>
        <span>{tr(locale, "窗口帧", "window frames")}</span>
      </div>
      <div className={view.rebuildIncrementCount > 0 ? "prof-kpi warn" : "prof-kpi"}>
        <strong>{String(view.rebuildIncrementCount)}</strong>
        <span>{tr(locale, "重建增量", "renderer rebuilds")}</span>
      </div>
      {view.omittedPassCount > 0 && (
        <div className="prof-kpi dim">
          <strong>+{view.omittedPassCount}</strong>
          <span>{tr(locale, "个低耗 pass 未列入", "low-cost passes not listed")}</span>
        </div>
      )}
    </div>
  );
}

export function SwimlaneGrid({ locale, view }: { locale: AppLocale; view: ProfilerSwimlaneView }) {
  const scale = view.scaleMaxMs > 0 ? view.scaleMaxMs : 1;
  const barWidth = (value: number | undefined): string | undefined => {
    if (value === undefined || value <= 0) return undefined;
    return `${Math.max(8, Math.min(100, (value / scale) * 100))}%`;
  };
  const cells = (values: readonly (number | undefined)[], laneTitle?: string) => values.map((value, index) => {
    const frame = view.frames[index];
    const width = barWidth(value);
    return (
      <div key={index} className={`prof-cell${value === undefined ? " na" : ""}`}
        title={value === undefined || !frame
          ? tr(locale, "该帧未实测", "not measured on this frame")
          : `${laneTitle ?? ""}${frame.frame} · ${value.toFixed(3)} ms`}>
        {width && <i style={{ width }} />}
      </div>
    );
  });

  return (
    <div className="prof-grid" role="img" aria-label={tr(locale, "逐 pass GPU 泳道", "Per-pass GPU swimlane")}>
      <div className="prof-row metric">
        <span className="prof-row-label" title={tr(locale, "GPU 全帧跨度", "GPU frame span")}>
          {tr(locale, "GPU 跨度", "GPU span")}
        </span>
        <div className="prof-cells">{cells(view.gpuSpan.values)}</div>
      </div>
      <div className="prof-row metric">
        <span className="prof-row-label" title={tr(locale, "CPU 提交毫秒(帧号对齐帧)", "CPU submit ms (frame-aligned)")}>
          {tr(locale, "CPU 提交", "CPU submit")}
        </span>
        <div className="prof-cells">{cells(view.cpuSubmit.values)}</div>
      </div>
      {view.lanes.map(lane => (
        <div className="prof-row" key={lane.passId}>
          <span className="prof-row-label" title={`${lane.passId} · Σ${lane.totalMs.toFixed(2)} ms`}>{lane.passId}</span>
          <div className="prof-cells">{cells(lane.values, `${lane.passId} · `)}</div>
        </div>
      ))}
      <div className="prof-row rebuilds">
        <span className="prof-row-label" title={tr(locale, "A2 rendererRebuilds 重建增量", "A2 rendererRebuilds increments")}>
          {tr(locale, "重建", "Rebuilds")}
        </span>
        <div className="prof-cells">
          {view.rebuildMarks.map((mark, index) => (
            <div key={index} className={`prof-cell${mark ? " rebuild" : ""}`}
              title={mark
                ? tr(locale, `重建 #${mark.fromTotal}→#${mark.toTotal} @ 帧 ${mark.frame}`,
                  `rebuild #${mark.fromTotal}→#${mark.toTotal} at frame ${mark.frame}`)
                : tr(locale, "无重建增量", "no rebuild increment")}>
              {mark && <i />}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
