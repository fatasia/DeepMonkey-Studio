import { useEffect, useId, useState } from "react";
import { ChevronDown, ChevronRight, Gauge, TriangleAlert, X } from "lucide-react";
import type { AuthoredQualityProfile } from "@bim-studio/deep-engine/webgpu";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { readStudioQualityTelemetry, type StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";
import { translate as tr, type AppLocale } from "../i18n";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import "./QualityTelemetryPanel.css";

/** 面板刷新节奏与桥侧默认 4Hz 聚合采样对齐;关闭面板即停表,无后台常驻。 */
const REFRESH_INTERVAL_MS = 250;

interface PanelSnapshot {
  readonly perf: FramePerformanceSnapshot | undefined;
  readonly quality: StudioQualityTelemetryStatus | undefined;
}

interface QualityTelemetryPanelProps {
  locale: AppLocale;
  /** 实时帧率/帧时来源(作者后端,WebGL 与 Deep 均可用)。 */
  engine: ViewerEngine | undefined;
  onClose: () => void;
}

/**
 * T25 质量遥测剖析面板:实时帧率/帧时分位数 + Deep QualityFrameRecord 语义窗口
 * (pass 数/上传字节/可见实例/活动质量档/自适应决策)+ 托管显存。数据可测即显示
 * 数值,覆盖口径缺失显示「未接入」,绝不伪零;全部颜色取 base.css 令牌。
 */
export function QualityTelemetryPanel(props: QualityTelemetryPanelProps) {
  const { locale, engine } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [snapshot, setSnapshot] = useState<PanelSnapshot>(() => ({
    perf: engine?.getPerformanceSnapshot(), quality: readStudioQualityTelemetry(),
  }));

  useEffect(() => {
    const timer = window.setInterval(() => setSnapshot({
      perf: engine?.getPerformanceSnapshot(), quality: readStudioQualityTelemetry(),
    }), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [engine]);

  const { perf, quality } = snapshot;
  const latest = quality?.collector.frames.at(-1);
  const coverage = quality?.coverage;
  const waiting = quality !== undefined && quality.collector.retainedFrameCount === 0 && quality.failure === undefined;
  const p95 = perf?.frameTimeMs.p95;
  const fpsText = perf && perf.sampleCount >= 2 ? perf.fps.toFixed(0) : "—";

  return (
    <div
      ref={drag.panelRef}
      style={drag.style}
      className={`quality-telemetry-panel${collapsed ? " collapsed" : ""}`}
      aria-label={tr(locale, "质量遥测", "Quality telemetry")}
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
        <span className="qt-title">
          <Gauge size={15} />
          <strong>{tr(locale, "质量遥测", "Quality telemetry")}</strong>
          <small className={quality ? "qt-badge on" : "qt-badge"}>
            {quality ? "Deep WebGPU" : tr(locale, "未接入", "Not attached")}
          </small>
          <small className="qt-fps-mini">{fpsText} FPS</small>
        </span>
        <span className="qt-actions">
          <button
            type="button"
            aria-expanded={!collapsed}
            aria-controls={bodyId}
            title={collapsed ? tr(locale, "展开", "Expand") : tr(locale, "折叠", "Collapse")}
            onClick={() => setCollapsed(value => !value)}
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" aria-label={tr(locale, "关闭", "Close")} title={tr(locale, "关闭", "Close")}
            onClick={props.onClose}>
            <X size={14} />
          </button>
        </span>
      </header>
      {!collapsed && (
        <div id={bodyId} className="qt-body">
          <QualitySection title={tr(locale, "实时性能", "Live performance")}>
            <Metric label="FPS" value={fpsText} />
            <Metric label={tr(locale, "帧时 P50", "Frame P50")}
              value={perf && perf.sampleCount >= 2 ? `${perf.frameTimeMs.p50.toFixed(1)} ms` : "—"} />
            <Metric label={tr(locale, "帧时 P95", "Frame P95")} warn={p95 !== undefined && p95 > 33.34}
              value={perf && perf.sampleCount >= 2 ? `${p95!.toFixed(1)} ms` : "—"} />
            <Metric label="JS heap"
              warn={Boolean(perf?.heap && perf.heap.limitBytes > 0 && perf.heap.usedBytes / perf.heap.limitBytes > 0.75)}
              value={perf?.heap ? formatBytes(perf.heap.usedBytes) : "—"} />
          </QualitySection>
          <QualitySection
            title={tr(locale, "质量窗口", "Quality window")}
            hint={quality
              ? tr(locale, `聚合 ${quality.sampleHz} Hz · 保留 ${quality.collector.retainedFrameCount}/${quality.collector.capacity} 帧`,
                `${quality.sampleHz} Hz aggregate · ${quality.collector.retainedFrameCount}/${quality.collector.capacity} frames`)
              : undefined}
          >
            {quality === undefined ? (
              <p className="qt-empty">
                {tr(locale, "当前后端未接入质量遥测。切换到 Deep WebGPU 后,这里会显示 pass 数、上传字节与活动质量档。",
                  "Quality telemetry is not attached to the current backend. Switch to Deep WebGPU to see pass count, upload bytes and the active quality profile.")}
              </p>
            ) : quality.failure !== undefined ? (
              <p className="qt-empty failure">
                <TriangleAlert size={13} /> {tr(locale, "采样已停止", "Sampling stopped")}: {quality.failure}
              </p>
            ) : waiting ? (
              <p className="qt-empty">{tr(locale, "等待首个采样窗口…", "Waiting for the first sampling window…")}</p>
            ) : (
              <>
                <Metric label={tr(locale, "活动质量档", "Active profile")}
                  value={quality.activeProfile ? profileLabel(locale, quality.activeProfile) : tr(locale, "未设档", "Unset")} />
                <Metric label={tr(locale, "Pass 数/帧", "Passes / frame")} tone={coverage?.passCount}
                  value={coverage?.passCount === "frame-graph-receipt" && latest ? String(latest.passCount) : tr(locale, "未接入", "Not attached")} />
                <Metric label={tr(locale, "上传字节/窗口", "Uploads / window")} tone={coverage?.uploadedBytes}
                  value={coverage?.uploadedBytes === "chunk-stream-residency-delta" && latest
                    ? formatBytes(latest.uploadedBytes) : tr(locale, "未接入", "Not attached")} />
                <Metric label={tr(locale, "可见实例", "Visible instances")} tone={coverage?.visibleInstances}
                  title={tr(locale, "TS 运行时未挂遮挡读回,该值在 WebGPU 后端暂不可测(Native 可测)。",
                    "The TS runtime has no occlusion readback yet; this value is unmeasured on WebGPU (measured on Native).")}
                  value={tr(locale, "未接入", "Not attached")} />
                <Metric label={tr(locale, "自适应决策", "Adaptive decisions")}
                  value={latest ? String(latest.adaptiveDecisions) : "—"} />
              </>
            )}
          </QualitySection>
          <QualitySection title={tr(locale, "托管显存", "Managed VRAM")}>
            {quality?.latestMemory ? (
              <>
                <Metric label={tr(locale, "估算", "Estimated")} value={formatBytes(quality.latestMemory.estimatedBytes)}
                  warn={Boolean(quality.latestMemory.admission && quality.latestMemory.admission.budgetBytes > 0
                    && quality.latestMemory.estimatedBytes / quality.latestMemory.admission.budgetBytes > 0.9)} />
                <Metric label={tr(locale, "峰值", "Peak")} value={formatBytes(quality.latestMemory.peakEstimatedBytes)} />
                <Metric label={tr(locale, "缓冲 / 纹理", "Buffers / textures")}
                  value={`${formatBytes(quality.latestMemory.bufferBytes)} / ${formatBytes(quality.latestMemory.textureBytes)}`} />
                <Metric label={tr(locale, "资源数", "Resources")} value={String(quality.latestMemory.resourceCount)} />
              </>
            ) : (
              <p className="qt-empty">{tr(locale, "该后端未接入", "Not attached on this backend")}</p>
            )}
          </QualitySection>
          <footer className="qt-footnote">
            {tr(locale,
              "覆盖口径:pass 数 = 帧图回执;上传字节 = chunk 流驻留增量;可见实例未挂读回。缺测显示「未接入」,不伪零。",
              "Coverage: passes from frame-graph receipt; uploads from chunk-stream residency delta; visible instances unmeasured. Missing data reads “not attached”, never a fake zero.")}
          </footer>
        </div>
      )}
    </div>
  );
}

function QualitySection({ title, hint, children }: {
  title: string; hint?: string | undefined; children: React.ReactNode;
}) {
  return (
    <section className="qt-section">
      <h3>
        {title}
        {hint && <small>{hint}</small>}
      </h3>
      <div className="qt-grid">{children}</div>
    </section>
  );
}

function Metric({ label, value, warn = false, tone, title }: {
  label: string; value: string; warn?: boolean; tone?: string | undefined; title?: string;
}) {
  const off = tone === "unavailable";
  return (
    <div className={`qt-metric${warn ? " warn" : ""}${off ? " off" : ""}`} title={title ?? (warn ? label : undefined)}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

const PROFILE_LABELS: Record<AuthoredQualityProfile, [string, string]> = {
  performance: ["性能", "Performance"],
  balanced: ["均衡", "Balanced"],
  quality: ["画质", "Quality"],
  ultra: ["极致", "Ultra"],
};

function profileLabel(locale: AppLocale, profile: AuthoredQualityProfile): string {
  const [zh, en] = PROFILE_LABELS[profile];
  return tr(locale, zh, en);
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} kB`;
  return `${(value / 1024 ** 2).toFixed(1)} MB`;
}
