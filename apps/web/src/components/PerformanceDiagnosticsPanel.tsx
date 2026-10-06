import { useEffect, useId, useRef, useState } from "react";
import {
  Activity,
  Camera,
  ChevronDown,
  ChevronRight,
  MousePointer2,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import type { CameraState } from "@bim-studio/contracts";
import type { AuthoredQualityProfile, FrameMetrics } from "@bim-studio/deep-engine/webgpu";
import { numberFormat } from "../appDefaults";
import { formatVector } from "../appPresentation";
import type { FramePerformanceSnapshot } from "../viewer/framePerformanceMonitor";
import type { ViewerEngine, PointerInfo } from "../viewer/ViewerEngine";
import { readStudioQualityTelemetry, type StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";
import { translate as tr, type AppLocale } from "../i18n";
import { readBooleanPreference, writeBooleanPreference } from "../hooks/usePersistedBooleanState";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import {
  ProfilerSwimlaneCollector,
  buildSwimlaneView,
  type ProfilerSwimlaneView,
} from "./profilerSwimlaneModel";
import type { SceneStatisticsSummary } from "./SceneViewportStatus";
import "./PerformanceDiagnosticsPanel.css";

/**
 * 统一「性能与诊断」面板(2026-10-06 整合):原 开发者HUD / 场景信息 / 质量遥测 /
 * 性能剖析 四个独立面板堆叠,信息高度重复(三处 FPS、两处逐 pass 列表、两处显存),
 * 收编为单浮动面板 + 四分区:
 *   ① 帧时  —— FPS / 帧时分位 / GPU P95 + 跨帧 pass 时序(合并 DevHud+Profiler);
 *   ② 场景  —— 对象/三角面/draw calls/纹理 + 相机与指针(原场景信息);
 *   ③ 资源  —— JS 堆 / 托管显存;
 *   ④ 管线  —— 品质档 / RT 选路 / 重建账目 / 质量窗口 / 逐 pass 计时与完整泳道。
 *
 * 数据源全部既有、不新增轮询:`engine.getPerformanceSnapshot()`(帧率/帧时/堆/绘制量,
 * 含 FrameMetrics 直通的 RT 阴影选路与重建账目)+ `readStudioQualityTelemetry()`
 * (逐 pass GPU 计时/品质档/托管显存)+ 调用方下发的场景统计。刷新 4Hz 与桥侧
 * 聚合采样同拍;泳道采样走 rAF、仅面板开启时运行,关闭即停。缺测显示「—/未接入」,
 * 绝不伪零;逐 pass 计时未开启时给出 t25-gpu-pass-timing=1 引导。
 */

/** 与桥侧默认 4Hz 采样对齐;面板卸载即停表。 */
const REFRESH_INTERVAL_MS = 250;
/** 泳道窗口帧数与逐 pass 列表截断(与原家族面板一致,显式写出便于调参)。 */
const WINDOW_CAPACITY = 48;
const LANE_LIMIT = 10;
const PASS_TIMINGS_TOP_N = 8;
const COLLAPSED_STORAGE_KEY = "bim-studio.diagnostics.collapsed";

export type DiagnosticsTabId = "frames" | "scene" | "resources" | "pipeline";

const TAB_META: readonly { id: DiagnosticsTabId; zh: string; en: string }[] = [
  { id: "frames", zh: "帧时", en: "Frames" },
  { id: "scene", zh: "场景", en: "Scene" },
  { id: "resources", zh: "资源", en: "Resources" },
  { id: "pipeline", zh: "管线", en: "Pipeline" },
];

interface PanelSnapshot {
  readonly perf: FramePerformanceSnapshot | undefined;
  readonly quality: StudioQualityTelemetryStatus | undefined;
}

interface ProfilerPanelMeta {
  readonly attached: boolean;
  readonly timings: "detached" | "off" | "unavailable" | "measured";
  readonly fps: number | undefined;
  readonly sampleCount: number;
}

export interface PerformanceDiagnosticsPanelProps {
  locale: AppLocale;
  /** 实时帧率/帧时来源(WebGL 与 Deep 均可用);启动中缺省。 */
  engine: ViewerEngine | undefined;
  /** 场景内容统计(模型/构件/三角面/顶点 + 基础体),来自检查器同一数据源。 */
  statistics: SceneStatisticsSummary & { primitiveCount: number };
  camera?: CameraState | undefined;
  pointer?: PointerInfo | undefined;
  onClose: () => void;
}

export function PerformanceDiagnosticsPanel(props: PerformanceDiagnosticsPanelProps) {
  const { locale, engine, statistics } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(() => readBooleanPreference(COLLAPSED_STORAGE_KEY, false));
  const [tab, setTab] = useState<DiagnosticsTabId>("frames");
  const collectorRef = useRef<ProfilerSwimlaneCollector | undefined>(undefined);
  if (!collectorRef.current) collectorRef.current = new ProfilerSwimlaneCollector({ capacity: WINDOW_CAPACITY });
  const [snapshot, setSnapshot] = useState<PanelSnapshot>(() => ({
    perf: engine?.getPerformanceSnapshot(), quality: readStudioQualityTelemetry(),
  }));
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

  // 泳道采样环:每次 rAF 只读既有只读快照并落环形缓冲,不触发渲染;面板关闭即停。
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

  // 4Hz 重绘:快照 + 泳道视图同拍;卸载即清表,无后台常驻。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const quality = readStudioQualityTelemetry();
      const timings = quality?.latestPassTimings;
      const perf = engine?.getPerformanceSnapshot();
      setSnapshot({ perf, quality });
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
    }, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [engine]);

  function toggleCollapsed(next: boolean): void {
    setCollapsed(next);
    writeBooleanPreference(COLLAPSED_STORAGE_KEY, next);
  }

  const { perf, quality } = snapshot;
  const timings = quality?.latestPassTimings;
  const adaptive = perf?.deep?.frame.adaptiveQuality;
  // FrameMetrics 直通披露面:B3 RT 阴影选路 + A2 重建周期账目(只在变化帧携带)。
  const deepFrame = perf?.deep?.frame;
  const rtRoute = deepFrame?.rtShadowRoute;
  const rebuilds = deepFrame?.rendererRebuilds;
  const ready = perf !== undefined && perf.sampleCount >= 2;
  const fpsText = ready ? perf.fps.toFixed(0) : "—";
  const draws = quality?.latestVisibleDraws;
  const backendBadge = quality ? "Deep WebGPU" : perf ? tr(locale, "作者后端", "Author backend") : tr(locale, "未就绪", "Not ready");

  return (
    <div
      ref={drag.panelRef}
      style={drag.style}
      className={`perf-diag${collapsed ? " collapsed" : ""}`}
      aria-label={tr(locale, "性能与诊断", "Performance & diagnostics")}
      data-collapsed={collapsed || undefined}
    >
      <header
        data-drag-handle="true"
        title={tr(locale, "拖动标题栏移动面板 · F9 开关", "Drag the title bar to move · F9 toggles")}
        onPointerDown={drag.onPointerDown}
        onPointerMove={drag.onPointerMove}
        onPointerUp={drag.onPointerUp}
        onPointerCancel={drag.onPointerCancel}
      >
        <span className="pd-title">
          <Activity size={15} />
          <strong>{tr(locale, "性能与诊断", "Performance & diagnostics")}</strong>
          <small className={quality ? "pd-badge on" : "pd-badge"}>{backendBadge}</small>
          <small className="pd-fps-mini">{fpsText} FPS</small>
        </span>
        <span className="pd-actions">
          <button type="button" aria-label={tr(locale, "清空泳道采样", "Clear swimlane samples")} title={tr(locale, "清空采样", "Clear samples")}
            onClick={() => {
              collectorRef.current!.clear();
              setView(buildSwimlaneView([]));
            }}>
            <Trash2 size={13} />
          </button>
          <button type="button" aria-expanded={!collapsed} aria-controls={bodyId}
            title={collapsed ? tr(locale, "展开", "Expand") : tr(locale, "折叠", "Collapse")}
            onClick={() => toggleCollapsed(!collapsed)}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" aria-label={tr(locale, "关闭性能与诊断面板", "Close performance & diagnostics")} title={tr(locale, "关闭", "Close")}
            onClick={props.onClose}>
            <X size={14} />
          </button>
        </span>
      </header>
      {!collapsed && (
        <>
          <nav className="pd-tabs" role="tablist" aria-label={tr(locale, "诊断分区", "Diagnostics sections")}>
            {TAB_META.map((item) => (
              <button key={item.id} type="button" role="tab" aria-selected={tab === item.id}
                className={tab === item.id ? "active" : ""}
                onClick={() => setTab(item.id)}>
                {tr(locale, item.zh, item.en)}
              </button>
            ))}
          </nav>
          <div id={bodyId} className="pd-body" role="tabpanel">
            {tab === "frames" && (
              <FramesTab locale={locale} perf={perf} quality={quality} view={view} meta={meta} />
            )}
            {tab === "scene" && (
              <SceneTab locale={locale} statistics={statistics} perf={perf} quality={quality} camera={props.camera} pointer={props.pointer} />
            )}
            {tab === "resources" && (
              <ResourcesTab locale={locale} perf={perf} quality={quality} />
            )}
            {tab === "pipeline" && (
              <PipelineTab
                locale={locale}
                perf={perf}
                quality={quality}
                timings={timings}
                adaptive={adaptive}
                rtRoute={rtRoute}
                rebuilds={rebuilds}
                deepFrame={deepFrame}
                draws={draws}
                view={view}
                meta={meta}
              />
            )}
          </div>
        </>
      )}
      {collapsed && (
        <span className="pd-mini">
          <small>{ready ? `${perf.frameTimeMs.p50.toFixed(1)} ms` : "—"} · {profileLabel(locale, quality?.activeProfile)}</small>
        </span>
      )}
    </div>
  );
}

/** ① 帧时:FPS/分位数(原 DevHud)+ 跨帧 pass 时序摘要(原 Profiler)。 */
export function FramesTab({ locale, perf, quality, view, meta }: {
  locale: AppLocale;
  perf: FramePerformanceSnapshot | undefined;
  quality: StudioQualityTelemetryStatus | undefined;
  view: ProfilerSwimlaneView;
  meta: ProfilerPanelMeta;
}) {
  const ready = perf !== undefined && perf.sampleCount >= 2;
  const p95 = perf?.frameTimeMs.p95;
  const gpuP95 = perf?.gpuFrameTime?.supported === true ? formatHudMs(perf.gpuFrameTime.p95Ms) : undefined;
  const deepSpan = quality?.latestPassTimings?.availability === "measured"
    && quality.latestPassTimings.milliseconds !== undefined
    ? formatHudMs(quality.latestPassTimings.milliseconds) : undefined;
  const latest = view.frames.at(-1);
  return (
    <>
      <div className="pd-grid">
        <Metric label="FPS" big value={fpsValue(perf)} />
        <Metric label={tr(locale, "帧时 P50", "Frame P50")} value={ready ? `${perf.frameTimeMs.p50.toFixed(1)} ms` : "—"} />
        <Metric label={tr(locale, "帧时 P95", "Frame P95")} warn={p95 !== undefined && p95 > 33.34}
          value={ready ? `${p95!.toFixed(1)} ms` : "—"} />
        <Metric label="GPU P95" value={gpuP95 ?? "—"} title={gpuP95 === undefined
          ? tr(locale, "GPU 帧时未开启或后端不支持 timestamp-query。", "GPU frame timing is off or timestamp-query is unsupported.")
          : undefined} />
        <Metric label={tr(locale, "GPU 全帧", "GPU frame span")} value={deepSpan ?? "—"} title={deepSpan === undefined
          ? tr(locale, "逐 pass 计时未接入时的全帧跨度缺测;GPU P95 是作者后端读数。", "Frame span needs per-pass timing; GPU P95 is the author-backend reading.")
          : undefined} />
        <Metric label={tr(locale, "超 33ms 帧占比", ">33 ms frames")} value={ready ? `${(perf.over33msRate * 100).toFixed(1)}%` : "—"} />
      </div>
      <section className="pd-section">
        <h3>
          {tr(locale, "跨帧时序", "Across frames")}
          <small>{tr(locale, `窗口 ${meta.sampleCount} 帧`, `${meta.sampleCount} frame window`)}</small>
        </h3>
        <div className="pd-grid">
          <div className={view.mostExpensive ? "pd-kpi" : "pd-kpi dim"}>
            <strong>{view.mostExpensive ? view.mostExpensive.passId : "—"}</strong>
            <span>{view.mostExpensive
              ? tr(locale, `最贵 pass · ${view.mostExpensive.durationMs.toFixed(2)} ms @ #${view.mostExpensive.frame}`,
                `Hottest pass · ${view.mostExpensive.durationMs.toFixed(2)} ms @ #${view.mostExpensive.frame}`)
              : tr(locale, "最贵 pass", "Hottest pass")}</span>
          </div>
          <Metric label={tr(locale, "实测/请求 pass(最新帧)", "measured/requested passes (latest)")}
            value={latest && latest.requestedPassCount
              ? `${latest.measuredPassCount ?? latest.passes.length}/${latest.requestedPassCount}`
              : latest ? String(latest.passes.length) : "—"} />
          <Metric label={tr(locale, "重建增量", "renderer rebuilds")} warn={view.rebuildIncrementCount > 0}
            value={String(view.rebuildIncrementCount)} />
        </div>
        {view.frames.length > 0 && (
          <div className="pd-mini-lanes" role="img" aria-label={tr(locale, "GPU 跨度与 CPU 提交跨帧时序", "GPU span and CPU submit across frames")}>
            <MiniLaneRow label={tr(locale, "GPU 跨度", "GPU span")} values={view.gpuSpan.values} frames={view.frames} locale={locale} />
            <MiniLaneRow label={tr(locale, "CPU 提交", "CPU submit")} values={view.cpuSubmit.values} frames={view.frames} locale={locale} />
          </div>
        )}
        {!meta.attached && (
          <p className="pd-note">
            {tr(locale, "当前后端未接入 Deep 帧指标,跨帧时序不可用;切换到 Deep WebGPU 后显示。",
              "The current backend does not publish Deep frame metrics. Switch to Deep WebGPU for cross-frame timings.")}
          </p>
        )}
      </section>
      <footer className="pd-footnote">
        {tr(locale, "帧样本来自可见帧(后台暂停已剔除);窗口内单帧最贵 pass 在「跨帧时序」点名。",
          "Frame samples cover visible frames (background pauses excluded). The hottest pass per window is named above.")}
      </footer>
    </>
  );
}

/** ② 场景:对象统计(原场景信息)+ 本帧绘制量 + 相机与指针。 */
export function SceneTab({ locale, statistics, perf, quality, camera, pointer }: {
  locale: AppLocale;
  statistics: SceneStatisticsSummary & { primitiveCount: number };
  perf: FramePerformanceSnapshot | undefined;
  quality: StudioQualityTelemetryStatus | undefined;
  camera: CameraState | undefined;
  pointer: PointerInfo | undefined;
}) {
  const draws = quality?.latestVisibleDraws;
  const rendererDraws = perf && perf.renderer.drawCalls > 0
    ? `${formatHudCount(perf.renderer.drawCalls)} / ${formatHudCount(perf.renderer.triangles)}`
    : undefined;
  const drawValue = draws
    ? `${formatHudCount(draws.drawCalls)} / ${formatHudCount(draws.triangles)}`
    : rendererDraws ?? "—";
  return (
    <>
      <div className="pd-grid">
        <Metric label={tr(locale, "对象合计", "Objects")}
          value={numberFormat.format(statistics.modelCount + statistics.primitiveCount + statistics.componentCount)} />
        <Metric label={tr(locale, "模型", "Models")} value={numberFormat.format(statistics.modelCount)} />
        <Metric label={tr(locale, "构件", "Components")} value={numberFormat.format(statistics.componentCount)} />
        <Metric label={tr(locale, "基础体", "Primitives")} value={numberFormat.format(statistics.primitiveCount)} />
        <Metric label={tr(locale, "三角面", "Triangles")} value={numberFormat.format(statistics.triangleCount)} />
        <Metric label={tr(locale, "顶点", "Vertices")} value={numberFormat.format(statistics.vertexCount)} />
      </div>
      <section className="pd-section">
        <h3>{tr(locale, "本帧绘制", "Rendered this frame")}</h3>
        <div className="pd-grid">
          <Metric label="Draw / Tris" value={drawValue}
            title={tr(locale, "Deep 下为 F1 主 pass 包体编码量(量,非逐实例);其余为作者后端计数。",
              "On Deep these are F1 main-pass encoded counts; otherwise author-backend counters.")} />
          <Metric label={tr(locale, "纹理 / 几何体", "Textures / geometries")}
            value={perf && (perf.renderer.textures !== undefined || perf.renderer.geometries !== undefined)
              ? `${perf.renderer.textures !== undefined ? formatHudCount(perf.renderer.textures) : "—"} / ${perf.renderer.geometries !== undefined ? formatHudCount(perf.renderer.geometries) : "—"}`
              : "—"} />
        </div>
      </section>
      <section className="pd-section">
        <h3>{tr(locale, "相机与指针", "Camera & pointer")}</h3>
        <div className="pd-rows">
          <Row icon={<Camera size={13} />} label={tr(locale, "相机", "Camera")} value={camera ? formatVector(camera.position) : "—"} />
          <Row label="◎" labelTitle={tr(locale, "目标", "Target")} hideIcon value={camera ? formatVector(camera.target) : "—"} />
          <Row icon={<MousePointer2 size={13} />} label={tr(locale, "鼠标", "Pointer")}
            value={pointer?.world ? formatVector(pointer.world) : pointer ? `${pointer.screenX}, ${pointer.screenY}` : "—"} />
          {pointer?.objectName && <div className="pd-object-name" title={pointer.objectName}>{pointer.objectName}</div>}
        </div>
      </section>
    </>
  );
}

/** ③ 资源:JS 堆 + 托管显存(Deep 口径;其他后端如实「未接入」)。 */
export function ResourcesTab({ locale, perf, quality }: {
  locale: AppLocale;
  perf: FramePerformanceSnapshot | undefined;
  quality: StudioQualityTelemetryStatus | undefined;
}) {
  const memory = quality?.latestMemory;
  return (
    <>
      <section className="pd-section">
        <h3>{tr(locale, "JS 堆", "JS heap")}</h3>
        {perf?.heap ? (
          <div className="pd-grid">
            <Metric label={tr(locale, "已用", "Used")} warn={perf.heap.limitBytes > 0 && perf.heap.usedBytes / perf.heap.limitBytes > 0.75}
              value={formatHudHeap(perf.heap.usedBytes, perf.heap.limitBytes)} />
            <Metric label={tr(locale, "上限", "Limit")} value={formatHudBytes(perf.heap.limitBytes)} />
          </div>
        ) : (
          <p className="pd-note">{tr(locale, "该环境未暴露堆计量(performance.memory)。",
            "Heap metrics are not exposed in this environment (performance.memory).")}</p>
        )}
      </section>
      <section className="pd-section">
        <h3>{tr(locale, "托管显存", "Managed VRAM")}</h3>
        {memory ? (
          <div className="pd-grid">
            <Metric label={tr(locale, "估算", "Estimated")}
              warn={Boolean(memory.admission && memory.admission.budgetBytes > 0
                && memory.estimatedBytes / memory.admission.budgetBytes > 0.9)}
              value={formatHudBytes(memory.estimatedBytes)} />
            <Metric label={tr(locale, "峰值", "Peak")} value={formatHudBytes(memory.peakEstimatedBytes)} />
            <Metric label={tr(locale, "缓冲 / 纹理", "Buffers / textures")}
              value={`${formatHudBytes(memory.bufferBytes)} / ${formatHudBytes(memory.textureBytes)}`} />
            <Metric label={tr(locale, "资源数", "Resources")} value={String(memory.resourceCount)} />
            {memory.admission && memory.admission.budgetBytes > 0 && (
              <Metric label={tr(locale, "预算", "Budget")} value={formatHudBytes(memory.admission.budgetBytes)} />
            )}
          </div>
        ) : (
          <p className="pd-note">
            {tr(locale, "该后端未接入托管显存口径;切换到 Deep WebGPU 后显示估算/峰值/缓冲与纹理分解。",
              "Managed VRAM is not attached on this backend. Switch to Deep WebGPU for the estimated/peak/buffer/texture breakdown.")}
          </p>
        )}
      </section>
    </>
  );
}

/** ④ 管线:品质档/RT 选路/重建账目 + 质量窗口 + 逐 pass 计时 + 完整泳道。 */
export function PipelineTab({ locale, perf, quality, timings, adaptive, rtRoute, rebuilds, deepFrame, draws, view, meta }: {
  locale: AppLocale;
  perf: FramePerformanceSnapshot | undefined;
  quality: StudioQualityTelemetryStatus | undefined;
  timings: StudioQualityTelemetryStatus["latestPassTimings"];
  /** 窄化结构类型:仅消费 level/enabled,真实 AdaptiveQualityState 是只读超集。 */
  adaptive: { readonly level: number; readonly enabled: boolean } | undefined;
  /** 窄化结构类型:真实 RtShadowRouteMetrics 是只读超集。 */
  rtRoute: { readonly channel: "ray-traced" | "cascade"; readonly reason?: string | undefined } | undefined;
  /** 窄化结构类型:真实 rendererRebuilds 是只读超集。 */
  rebuilds: {
    readonly ordinal: number;
    readonly total: number;
    readonly last?: { readonly index: number; readonly releasedEstimateBytes: number; readonly pipelineCompiles: number };
  } | undefined;
  deepFrame: FrameMetrics | undefined;
  draws: StudioQualityTelemetryStatus["latestVisibleDraws"];
  view: ProfilerSwimlaneView;
  meta: ProfilerPanelMeta;
}) {
  const latest = quality?.collector.frames.at(-1);
  const coverage = quality?.coverage;
  const waiting = quality !== undefined && quality.collector.retainedFrameCount === 0 && quality.failure === undefined;
  const hasLanes = view.lanes.length > 0 && view.frames.length > 0;
  return (
    <>
      <div className="pd-grid">
        <Metric label={tr(locale, "品质档", "Quality profile")} value={quality
          ? `${profileLabel(locale, quality.activeProfile)}${adaptive ? ` · L${adaptive.level}` : ""}`
          : perf?.renderer.adaptiveRenderScale?.enabled
            ? `×${perf.renderer.adaptiveRenderScale.renderScale.toFixed(2)}`
            : "—"}
          title={adaptive?.enabled === false ? tr(locale, "自适应降档未启用", "Adaptive quality is off") : undefined} />
        <Metric label={tr(locale, "RT 阴影", "RT shadows")} value={rtRoute ? rtShadowRouteLabel(locale, rtRoute.channel) : "—"}
          title={rtRoute?.reason ?? (deepFrame
            ? tr(locale, "本帧无选路披露(RT 阴影未启用或场景未供给)", "No route disclosure this frame (RT shadows off or scene not supplied)")
            : undefined)} />
        <Metric label={tr(locale, "渲染器重建", "Renderer rebuilds")} value={formatHudRebuilds(rebuilds)}
          title={rebuilds?.last
            ? tr(locale, `最近重建 #${rebuilds.last.index}:释放 ${formatHudBytes(rebuilds.last.releasedEstimateBytes)} · 管线编译 ${rebuilds.last.pipelineCompiles} 条`,
              `Last rebuild #${rebuilds.last.index}: released ${formatHudBytes(rebuilds.last.releasedEstimateBytes)} · ${rebuilds.last.pipelineCompiles} pipeline compile(s)`)
            : deepFrame
              ? tr(locale, "本帧未携带(该披露只在重建后的首帧出现)", "Not carried this frame (disclosed only on the first frame after a rebuild)")
              : undefined} />
      </div>
      <section className="pd-section">
        <h3>
          {tr(locale, "质量窗口", "Quality window")}
          <small>{quality
            ? tr(locale, `聚合 ${quality.sampleHz} Hz · 保留 ${quality.collector.retainedFrameCount}/${quality.collector.capacity} 帧`,
              `${quality.sampleHz} Hz aggregate · ${quality.collector.retainedFrameCount}/${quality.collector.capacity} frames`)
            : undefined}</small>
        </h3>
        {quality === undefined ? (
          <p className="pd-note">
            {tr(locale, "当前后端未接入质量遥测。切换到 Deep WebGPU 后,这里会显示 pass 数、上传字节与自适应决策。",
              "Quality telemetry is not attached to the current backend. Switch to Deep WebGPU to see pass count, upload bytes and adaptive decisions.")}
          </p>
        ) : quality.failure !== undefined ? (
          <p className="pd-note warn"><TriangleAlert size={13} /> {tr(locale, "采样已停止", "Sampling stopped")}: {quality.failure}</p>
        ) : waiting ? (
          <p className="pd-note">{tr(locale, "等待首个采样窗口…", "Waiting for the first sampling window…")}</p>
        ) : (
          <div className="pd-grid">
            <Metric label={tr(locale, "Pass 数/帧", "Passes / frame")} tone={coverage?.passCount}
              value={coverage?.passCount === "frame-graph-receipt" && latest ? String(latest.passCount) : tr(locale, "未接入", "Not attached")} />
            <Metric label={tr(locale, "上传字节/窗口", "Uploads / window")} tone={coverage?.uploadedBytes}
              value={coverage?.uploadedBytes === "chunk-stream-residency-delta" && latest
                ? formatHudBytes(latest.uploadedBytes) : tr(locale, "未接入", "Not attached")} />
            <Metric label={tr(locale, "可见绘制(draw)", "Visible draws")} tone={coverage?.visibleInstances}
              title={tr(locale, "F1 口径:主 pass 包体 CPU 编码 draw 调用数(量,非时)。逐实例幸存数仍需遮挡读回,WebGPU 未挂,不伪称逐实例。",
                "F1: main-pass encoded draw-call count (count, not timing). Per-instance survivor counts still need an occlusion readback, not attached on WebGPU.")}
              value={coverage?.visibleInstances === "main-pass-draw-calls" && draws
                ? String(draws.drawCalls) : tr(locale, "未接入", "Not attached")} />
            <Metric label={tr(locale, "自适应决策", "Adaptive decisions")}
              value={latest ? String(latest.adaptiveDecisions) : "—"} />
          </div>
        )}
      </section>
      <section className="pd-section">
        <h3>
          {tr(locale, "逐 Pass GPU 耗时", "Per-pass GPU timings")}
          <small>{timings?.availability === "measured"
            ? tr(locale, `计时帧 #${timings.frame}`, `measured frame #${timings.frame}`)
            : undefined}</small>
        </h3>
        <PassTimings locale={locale} timings={timings} attached={quality !== undefined} />
      </section>
      {meta.attached && meta.timings === "measured" && (
        <section className="pd-section">
          <h3>{tr(locale, "跨帧泳道", "Cross-frame swimlane")}</h3>
          {hasLanes ? (
            <SwimlaneGrid locale={locale} view={view} />
          ) : (
            <p className="pd-note">{tr(locale, "采样中…保持场景可见即可累积泳道。", "Sampling… keep the scene visible to accumulate lanes.")}</p>
          )}
        </section>
      )}
      <footer className="pd-footnote">
        {tr(locale,
          "覆盖口径:pass 数 = 帧图回执;上传字节 = chunk 流驻留增量;可见实例未挂读回。泳道列 = GPU 计时实测帧(读回滞后 1-2 帧,按帧号对齐 CPU 提交与重建账目)。缺测显示「未接入」,不伪零。",
          "Coverage: passes from frame-graph receipt; uploads from chunk-stream residency delta; visible instances unmeasured. Swimlane columns are GPU-timing measured frames (1-2 frame readback lag). Missing data reads “not attached”, never a fake zero.")}
      </footer>
    </>
  );
}

/** 逐 pass 耗时列表:实测按耗时降序 Top-8;缺测分别声明(未接入 / 未开启 / 读回失败),不伪零。 */
export function PassTimings({ locale, timings, attached }: {
  locale: AppLocale;
  timings: StudioQualityTelemetryStatus["latestPassTimings"];
  attached: boolean;
}) {
  if (!attached) {
    return <p className="pd-note">{tr(locale, "当前后端未接入质量遥测。", "Quality telemetry is not attached to the current backend.")}</p>;
  }
  if (timings === undefined) {
    return (
      <p className="pd-note">
        {tr(locale, "逐 pass 计时未开启:URL 加 t25-gpu-pass-timing=1 后重载。",
          "Per-pass timing is off: reload with t25-gpu-pass-timing=1 in the URL.")}
      </p>
    );
  }
  if (timings.availability === "unavailable") {
    return (
      <p className="pd-note off">
        <TriangleAlert size={13} /> {timings.unavailableReason ?? tr(locale, "逐 pass 计时不可用。", "Per-pass timings unavailable.")}
      </p>
    );
  }
  const passes = [...(timings.passes ?? [])].sort((left, right) => right.durationMs - left.durationMs);
  const top = passes.slice(0, PASS_TIMINGS_TOP_N);
  const maximum = top[0]?.durationMs ?? 0;
  return (
    <div className="pd-pass-list">
      {top.map(pass => (
        <div key={pass.passId} className="pd-pass-row" title={`${pass.passId}: ${pass.durationMs.toFixed(3)} ms`}>
          <span className="pd-pass-name">{pass.passId}</span>
          <span className="pd-pass-bar" aria-hidden="true">
            <i style={{ width: `${maximum > 0 ? Math.max(3, (pass.durationMs / maximum) * 100) : 3}%` }} />
          </span>
          <span className="pd-pass-ms">{pass.durationMs.toFixed(2)} ms</span>
        </div>
      ))}
      <footer className="pd-pass-foot">
        {tr(locale,
          `全帧 ${formatHudMs(timings.milliseconds)} · 实测 ${timings.measuredPassCount ?? passes.length}/${timings.requestedPassCount ?? passes.length} pass`,
          `frame span ${formatHudMs(timings.milliseconds)} · ${timings.measuredPassCount ?? passes.length}/${timings.requestedPassCount ?? passes.length} passes measured`)}
        {passes.length > top.length
          ? tr(locale, ` · 另有 ${passes.length - top.length} 个 pass 未列入`, ` · ${passes.length - top.length} more not listed`)
          : ""}
      </footer>
    </div>
  );
}

/** 跨帧泳道网格(原 Profiler):行 = pass,列 = 实测帧;导出供测试直测。 */
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
      <div key={index} className={`pd-cell${value === undefined ? " na" : ""}`}
        title={value === undefined || !frame
          ? tr(locale, "该帧未实测", "not measured on this frame")
          : `${laneTitle ?? ""}${frame.frame} · ${value.toFixed(3)} ms`}>
        {width && <i style={{ width }} />}
      </div>
    );
  });

  return (
    <div className="pd-swimlane" role="img" aria-label={tr(locale, "逐 pass GPU 泳道", "Per-pass GPU swimlane")}>
      <div className="pd-lane metric">
        <span className="pd-lane-label" title={tr(locale, "GPU 全帧跨度", "GPU frame span")}>
          {tr(locale, "GPU 跨度", "GPU span")}
        </span>
        <div className="pd-lane-cells">{cells(view.gpuSpan.values)}</div>
      </div>
      <div className="pd-lane metric">
        <span className="pd-lane-label" title={tr(locale, "CPU 提交毫秒(帧号对齐帧)", "CPU submit ms (frame-aligned)")}>
          {tr(locale, "CPU 提交", "CPU submit")}
        </span>
        <div className="pd-lane-cells">{cells(view.cpuSubmit.values)}</div>
      </div>
      {view.lanes.map(lane => (
        <div className="pd-lane" key={lane.passId}>
          <span className="pd-lane-label" title={`${lane.passId} · Σ${lane.totalMs.toFixed(2)} ms`}>{lane.passId}</span>
          <div className="pd-lane-cells">{cells(lane.values, `${lane.passId} · `)}</div>
        </div>
      ))}
      <div className="pd-lane rebuilds">
        <span className="pd-lane-label" title={tr(locale, "A2 rendererRebuilds 重建增量", "A2 rendererRebuilds increments")}>
          {tr(locale, "重建", "Rebuilds")}
        </span>
        <div className="pd-lane-cells">
          {view.rebuildMarks.map((mark, index) => (
            <div key={index} className={`pd-cell${mark ? " rebuild" : ""}`}
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

/** 帧时 tab 的迷你跨帧行:只 GPU 跨度 / CPU 提交两行,完整泳道在管线 tab。 */
function MiniLaneRow({ label, values, frames, locale }: {
  label: string;
  values: readonly (number | undefined)[];
  frames: ProfilerSwimlaneView["frames"];
  locale: AppLocale;
}) {
  const finite = values.filter((value): value is number => value !== undefined && Number.isFinite(value) && value > 0);
  const max = finite.length > 0 ? Math.max(...finite) : 0;
  return (
    <div className="pd-mini-lane">
      <span className="pd-mini-lane-label">{label}</span>
      <span className="pd-mini-lane-cells">
        {values.map((value, index) => (
          <i key={index} className={value === undefined ? "na" : ""}
            title={value === undefined || !frames[index]
              ? tr(locale, "该帧未实测", "not measured on this frame")
              : `${frames[index].frame} · ${value.toFixed(2)} ms`}
            style={value !== undefined && max > 0
              ? { height: `${Math.max(8, Math.min(100, (value / max) * 100))}%` }
              : undefined} />
        ))}
      </span>
    </div>
  );
}

function fpsValue(perf: FramePerformanceSnapshot | undefined): string {
  return perf && perf.sampleCount >= 2 ? perf.fps.toFixed(0) : "—";
}

function Row({ label, value, icon, labelTitle, hideIcon }: {
  label: string; value: string; icon?: React.ReactNode; labelTitle?: string | undefined; hideIcon?: boolean;
}) {
  return (
    <div className="pd-row">
      {!hideIcon && (icon ?? <span className="pd-row-spacer" />)}
      <span className="pd-row-label" title={labelTitle}>{label}</span>
      <code>{value}</code>
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

function Metric({ label, value, warn = false, big = false, tone, title }: {
  label: string; value: string; warn?: boolean; big?: boolean; tone?: string | undefined; title?: string | undefined;
}) {
  const off = tone === "unavailable";
  return (
    <div className={`pd-metric${warn ? " warn" : ""}${off ? " off" : ""}${big ? " big" : ""}`} title={title ?? (warn ? label : undefined)}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
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

/** B3 RT 阴影选路标签:ray-traced/cascade 双语;缺测由调用方给 —。 */
export function rtShadowRouteLabel(locale: AppLocale, channel: "ray-traced" | "cascade"): string {
  return channel === "ray-traced" ? tr(locale, "光线追踪", "Ray-traced") : tr(locale, "级联", "Cascade");
}

/**
 * A2 重建周期摘要:本实例序号 + 进程累计重建数。
 * 形如 "#0 · Σ3";字段只在 total 变化后的首帧携带,缺测 — 不是"从未重建"。
 */
export function formatHudRebuilds(value: { readonly ordinal: number; readonly total: number } | undefined): string {
  if (!value || !Number.isFinite(value.ordinal) || !Number.isFinite(value.total)
    || value.ordinal < 0 || value.total < 0) return "—";
  return `#${value.ordinal} · Σ${Math.round(value.total)}`;
}
