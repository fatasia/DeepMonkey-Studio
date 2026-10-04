import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Activity, ChevronDown, ChevronRight, X } from "lucide-react";
import type { AuthoredQualityProfile } from "@bim-studio/deep-engine/webgpu";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { readStudioQualityTelemetry, type StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";
import { translate as tr, type AppLocale } from "../i18n";
import { readBooleanPreference, writeBooleanPreference } from "../hooks/usePersistedBooleanState";
import "./DevHud.css";

/**
 * 刀 6 开发者 HUD:对标 UE stat unit 的常驻性能观测小条。
 * 数据源全部既有(不新增轮询):`engine.getPerformanceSnapshot()`(实时帧率/帧时/
 * 堆/绘制量)+ `readStudioQualityTelemetry()`(window.__deepQualityTelemetry 镜像:
 * 逐 pass GPU 计时/自适应品质档/托管显存)。刷新 4Hz 与桥侧聚合采样同拍。
 * 缺测显示「—/未接入」,绝不伪零;逐 pass 计时未开启时给出 t25-gpu-pass-timing=1 引导。
 */

/** 与 QualityTelemetryPanel 的刷新节奏及桥侧默认 4Hz 采样对齐;卸载即停表。 */
const REFRESH_INTERVAL_MS = 250;
/** 逐 pass 耗时列表长度:HUD 是小条,取 Top-5(全量分解看质量遥测面板)。 */
const PASS_TIMINGS_TOP_N = 5;
const POSITION_STORAGE_KEY = "bim-studio.devhud.position";
const COLLAPSED_STORAGE_KEY = "bim-studio.devhud.collapsed";

interface HudSnapshot {
  readonly perf: FramePerformanceSnapshot | undefined;
  readonly quality: StudioQualityTelemetryStatus | undefined;
}

interface HudPosition { x: number; y: number }

interface DevHudProps {
  locale: AppLocale;
  /** 实时帧率/帧时来源(WebGL 与 Deep 均可用);启动中缺省。 */
  engine: ViewerEngine | undefined;
  onClose: () => void;
}

/** 位置持久化;localStorage 受限(隐私模式/受限 webview)时静默退回会话态,与仓内偏好惯例一致。 */
function readHudPosition(): HudPosition | undefined {
  try {
    const raw = window.localStorage.getItem(POSITION_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<HudPosition>;
    if (typeof parsed.x !== "number" || typeof parsed.y !== "number"
      || !Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return undefined;
    return { x: parsed.x, y: parsed.y };
  } catch {
    return undefined;
  }
}

function writeHudPosition(position: HudPosition): void {
  try {
    window.localStorage.setItem(POSITION_STORAGE_KEY, JSON.stringify(position));
  } catch {
    // 受限存储只保留当前会话位置。
  }
}

/** 按当前视口收敛位置;窗口缩小后恢复时把 HUD 拉回可见区,8px 边距与面板拖拽惯例一致。 */
function clampHudPosition(position: HudPosition, width: number, height: number): HudPosition {
  const maxX = Math.max(8, window.innerWidth - width - 8);
  const maxY = Math.max(8, window.innerHeight - height - 8);
  return { x: Math.min(maxX, Math.max(8, position.x)), y: Math.min(maxY, Math.max(8, position.y)) };
}

export function DevHud(props: DevHudProps) {
  const { locale, engine } = props;
  const bodyId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; offsetX: number; offsetY: number } | undefined>(undefined);
  const previousUserSelectRef = useRef<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(() => readBooleanPreference(COLLAPSED_STORAGE_KEY, false));
  const [position, setPosition] = useState<HudPosition | undefined>(readHudPosition);
  const [snapshot, setSnapshot] = useState<HudSnapshot>(() => ({
    perf: engine?.getPerformanceSnapshot(), quality: readStudioQualityTelemetry(),
  }));

  // 4Hz 快照刷新;面板卸载即清表,无后台常驻。
  useEffect(() => {
    const timer = window.setInterval(() => setSnapshot({
      perf: engine?.getPerformanceSnapshot(), quality: readStudioQualityTelemetry(),
    }), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [engine]);

  // 恢复持久化位置时按当前视口精收敛(保存后窗口可能变小),只在挂载时做一次。
  useEffect(() => {
    const panel = panelRef.current;
    if (!position || !panel) return;
    const rect = panel.getBoundingClientRect();
    const clamped = clampHudPosition(position, rect.width, rect.height);
    if (clamped.x !== position.x || clamped.y !== position.y) setPosition(clamped);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在挂载恢复时收敛一次
  }, []);

  useEffect(() => () => {
    if (previousUserSelectRef.current !== undefined) {
      document.body.style.userSelect = previousUserSelectRef.current;
      previousUserSelectRef.current = undefined;
    }
  }, []);

  function onPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as HTMLElement).closest("button")) return;
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const parent = panel.offsetParent as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect();
    const originX = parentRect?.left ?? 0;
    const originY = parentRect?.top ?? 0;
    dragRef.current = { pointerId: event.pointerId, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top };
    previousUserSelectRef.current = document.body.style.userSelect;
    document.body.style.userSelect = "none";
    event.currentTarget.setPointerCapture(event.pointerId);
    setPosition(clampHudPosition({ x: rect.left - originX, y: rect.top - originY }, rect.width, rect.height));
  }

  function onPointerMove(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    const panel = panelRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !panel) return;
    const parent = panel.offsetParent as HTMLElement | null;
    const parentRect = parent?.getBoundingClientRect();
    const originX = parentRect?.left ?? 0;
    const originY = parentRect?.top ?? 0;
    const rect = panel.getBoundingClientRect();
    setPosition(clampHudPosition({
      x: event.clientX - originX - drag.offsetX, y: event.clientY - originY - drag.offsetY,
    }, rect.width, rect.height));
  }

  function endDrag(event: ReactPointerEvent<HTMLElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    dragRef.current = undefined;
    if (previousUserSelectRef.current !== undefined) {
      document.body.style.userSelect = previousUserSelectRef.current;
      previousUserSelectRef.current = undefined;
    }
    // 拖动落点即持久化点;写入失败静默(受限存储)。
    setPosition((current) => {
      if (current) writeHudPosition(current);
      return current;
    });
  }

  function toggleCollapsed(next: boolean): void {
    setCollapsed(next);
    writeBooleanPreference(COLLAPSED_STORAGE_KEY, next);
  }

  const { perf, quality } = snapshot;
  const timings = quality?.latestPassTimings;
  const adaptive = perf?.deep?.frame.adaptiveQuality;
  const hudStyle: CSSProperties | undefined = position
    ? { left: `${position.x}px`, top: `${position.y}px`, right: "auto" }
    : undefined;
  const fpsText = perf && perf.sampleCount >= 2 ? perf.fps.toFixed(0) : "—";
  const p50Text = perf && perf.sampleCount >= 2 ? formatHudMs(perf.frameTimeMs.p50) : "—";
  const p95Text = perf && perf.sampleCount >= 2 ? formatHudMs(perf.frameTimeMs.p95) : "—";
  const gpuP95 = perf?.gpuFrameTime?.supported === true ? formatHudMs(perf.gpuFrameTime.p95Ms) : undefined;
  const deepSpan = timings?.availability === "measured" && timings.milliseconds !== undefined
    ? formatHudMs(timings.milliseconds) : undefined;
  const draws = quality?.latestVisibleDraws;
  const backendBadge = quality ? "Deep WebGPU" : perf ? tr(locale, "作者后端", "Author backend") : tr(locale, "未就绪", "Not ready");

  return (
    <div ref={panelRef} style={hudStyle} className={`dev-hud${collapsed ? " collapsed" : ""}`}
      aria-label={tr(locale, "开发者 HUD", "Developer HUD")} data-collapsed={collapsed || undefined}>
      <header data-drag-handle="true" title={tr(locale, "拖动移动 · F9 开关", "Drag to move · F9 toggles")}
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <span className="hud-title">
          <Activity size={13} />
          <strong>{fpsText}</strong>
          <small className="hud-unit">FPS</small>
          {!collapsed && <small className="hud-badge">{backendBadge}</small>}
        </span>
        {collapsed && <span className="hud-mini"><small>{p50Text} · {profileLabel(locale, quality?.activeProfile)}</small></span>}
        <span className="hud-actions">
          <button type="button" aria-expanded={!collapsed} aria-controls={bodyId}
            title={collapsed ? tr(locale, "展开", "Expand") : tr(locale, "折叠", "Collapse")}
            onClick={() => toggleCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
          </button>
          <button type="button" aria-label={tr(locale, "关闭开发者 HUD", "Close developer HUD")} title={tr(locale, "关闭", "Close")}
            onClick={props.onClose}>
            <X size={12} />
          </button>
        </span>
      </header>
      {!collapsed && (
        <div id={bodyId} className="hud-body">
          <HudRow label={tr(locale, "帧时 P50", "Frame P50")} value={p50Text} />
          <HudRow label={tr(locale, "帧时 P95", "Frame P95")} value={p95Text}
            warn={(perf?.frameTimeMs.p95 ?? 0) > 33.34 && perf !== undefined && perf.sampleCount >= 2} />
          <HudRow label="GPU P95" value={gpuP95 ?? "—"} title={gpuP95 === undefined
            ? tr(locale, "GPU 帧时未开启或后端不支持 timestamp-query。", "GPU frame timing is off or timestamp-query is unsupported.")
            : undefined} />
          <HudRow label={tr(locale, "GPU 全帧", "GPU frame span")} value={deepSpan ?? "—"} title={deepSpan === undefined
            ? tr(locale, "逐 pass 计时未接入时的全帧跨度缺测;GPU P95 是作者后端读数。", "Frame span needs per-pass timing; GPU P95 is the author-backend reading.")
            : undefined} />
          <PassTimingsTop locale={locale} timings={timings} attached={quality !== undefined} />
          <HudRow label={tr(locale, "品质档", "Quality profile")} value={quality
            ? `${profileLabel(locale, quality.activeProfile)}${adaptive ? ` · L${adaptive.level}` : ""}`
            : perf?.renderer.adaptiveRenderScale?.enabled
              ? `×${perf.renderer.adaptiveRenderScale.renderScale.toFixed(2)}`
              : "—"}
            title={adaptive?.enabled === false ? tr(locale, "自适应降档未启用", "Adaptive quality is off") : undefined} />
          <HudRow label={tr(locale, "JS 堆", "JS heap")} value={perf?.heap ? formatHudHeap(perf.heap.usedBytes, perf.heap.limitBytes) : "—"} />
          <HudRow label={tr(locale, "托管显存", "Managed VRAM")} value={quality?.latestMemory ? formatHudBytes(quality.latestMemory.estimatedBytes) : "—"} />
          <HudRow label="Draw / Tris" value={draws
            ? `${formatHudCount(draws.drawCalls)} / ${formatHudCount(draws.triangles)}`
            : perf && perf.renderer.drawCalls > 0
              ? `${formatHudCount(perf.renderer.drawCalls)} / ${formatHudCount(perf.renderer.triangles)}`
              : "—"}
            title={tr(locale, "Deep 下为 F1 主 pass 包体编码量(量,非逐实例);其余为作者后端计数。",
              "On Deep these are F1 main-pass encoded counts; otherwise author-backend counters.")} />
          {quality === undefined && (
            <p className="hud-note">
              {tr(locale, "质量遥测未接入:切到 Deep WebGPU 后显示逐 pass 计时与品质档。",
                "Quality telemetry not attached: switch to Deep WebGPU for per-pass timings and profiles.")}
            </p>
          )}
          {quality !== undefined && timings === undefined && (
            <p className="hud-note">
              {tr(locale, "逐 pass 计时未开启:URL 加 t25-gpu-pass-timing=1 后重载。",
                "Per-pass timing is off: reload with t25-gpu-pass-timing=1 in the URL.")}
            </p>
          )}
          {quality?.failure !== undefined && (
            <p className="hud-note warn">{tr(locale, "采样已停止", "Sampling stopped")}: {quality.failure}</p>
          )}
        </div>
      )}
    </div>
  );
}

function HudRow({ label, value, warn = false, title }: {
  label: string; value: string; warn?: boolean; title?: string | undefined;
}) {
  return (
    <div className={`hud-row${warn ? " warn" : ""}`} title={title ?? (warn ? label : undefined)}>
      <span className="hud-label">{label}</span>
      <span className="hud-value">{value}</span>
    </div>
  );
}

/** 逐 pass Top-5:实测按耗时降序;缺测分别声明(未接入 / 未开启 / 读回失败),不伪零。 */
function PassTimingsTop({ locale, timings, attached }: {
  locale: AppLocale;
  timings: StudioQualityTelemetryStatus["latestPassTimings"];
  attached: boolean;
}) {
  if (!attached) return <div className="hud-row off"><span className="hud-label">{tr(locale, "GPU 逐 pass", "GPU passes")}</span><span className="hud-value">—</span></div>;
  if (timings === undefined) {
    return (
      <div className="hud-row off">
        <span className="hud-label">{tr(locale, "GPU 逐 pass", "GPU passes")}</span>
        <span className="hud-value">{tr(locale, "未开启", "Off")}</span>
      </div>
    );
  }
  if (timings.availability === "unavailable") {
    return (
      <div className="hud-row off" title={timings.unavailableReason}>
        <span className="hud-label">{tr(locale, "GPU 逐 pass", "GPU passes")}</span>
        <span className="hud-value">{tr(locale, "不可用", "Unavailable")}</span>
      </div>
    );
  }
  const passes = [...(timings.passes ?? [])].sort((left, right) => right.durationMs - left.durationMs);
  const top = passes.slice(0, PASS_TIMINGS_TOP_N);
  const maximum = top[0]?.durationMs ?? 0;
  return (
    <div className="hud-passes">
      {top.map((pass) => (
        <div key={pass.passId} className="hud-pass-row" title={`${pass.passId}: ${formatHudMs(pass.durationMs)}`}>
          <span className="hud-pass-name">{pass.passId}</span>
          <span className="hud-pass-bar" aria-hidden="true">
            <i style={{ width: `${maximum > 0 ? Math.max(4, (pass.durationMs / maximum) * 100) : 4}%` }} />
          </span>
          <span className="hud-pass-ms">{formatHudMs(pass.durationMs)}</span>
        </div>
      ))}
      <div className="hud-pass-foot">
        {tr(locale, `Top ${top.length}/${passes.length} · 计时帧 #${timings.frame}`,
          `Top ${top.length}/${passes.length} · frame #${timings.frame}`)}
        {timings.measuredPassCount !== undefined && timings.requestedPassCount !== undefined
          && timings.measuredPassCount < timings.requestedPassCount
          ? tr(locale, ` · 丢样 ${timings.requestedPassCount - timings.measuredPassCount}`,
            ` · ${timings.requestedPassCount - timings.measuredPassCount} dropped`)
          : ""}
      </div>
    </div>
  );
}

const PROFILE_LABELS: Record<AuthoredQualityProfile, [string, string]> = {
  performance: ["性能", "Performance"],
  balanced: ["均衡", "Balanced"],
  quality: ["画质", "Quality"],
  ultra: ["极致", "Ultra"],
};

function profileLabel(locale: AppLocale, profile: AuthoredQualityProfile | null | undefined): string {
  if (!profile) return tr(locale, "未设档", "Unset");
  const [zh, en] = PROFILE_LABELS[profile];
  return locale === "zh-CN" ? zh : en;
}

/** 格式化全部可单测导出:毫秒 / 字节 / 大数计数 / 堆占用,非法输入一律 "—",不伪零。 */
export function formatHudMs(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value < 0) return "—";
  return `${value.toFixed(2)} ms`;
}

export function formatHudBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} kB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

export function formatHudCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1_000) return String(Math.round(value));
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

export function formatHudHeap(usedBytes: number, limitBytes: number): string {
  if (!Number.isFinite(usedBytes) || usedBytes < 0) return "—";
  const used = formatHudBytes(usedBytes);
  if (!Number.isFinite(limitBytes) || limitBytes <= 0) return used;
  return `${used} / ${formatHudBytes(limitBytes)}`;
}
