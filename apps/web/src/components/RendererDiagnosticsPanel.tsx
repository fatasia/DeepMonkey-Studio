import { Check, Cpu, Download, LoaderCircle, RefreshCw, ShieldCheck, TriangleAlert, X } from "lucide-react";
import "./RendererDiagnosticsPanel.css";
import type { RendererBackend } from "../viewer/ViewerEngine";
import type { FramePerformanceSnapshot, PerformancePressureCode } from "../viewer/framePerformanceMonitor";
import type { RendererCapabilityProbe, RendererReadiness } from "../rendererCapabilities";
import { translate as tr, type AppLocale } from "../i18n";
import { downloadRendererDiagnosticEvidence } from "../viewer/rendererDiagnosticExport";
import type { StudioFrameCaptureSnapshot, StudioFrameReadbackEntry } from "../viewer/studioFrameCaptureDiagnostics";
import { FrameCaptureSourceMapPanel } from "./FrameCaptureSourceMapPanel";

interface Props {
  locale: AppLocale;
  current: RendererBackend;
  desired: RendererBackend;
  switchPhase: "idle" | "preparing" | "recovering" | "failed";
  switchMessage: string | undefined;
  switching: boolean;
  checking: boolean;
  probe: RendererCapabilityProbe | undefined;
  readiness: RendererReadiness[];
  performance: FramePerformanceSnapshot | undefined;
  frameCapture?: StudioFrameCaptureSnapshot;
  frameReadbacks?: readonly StudioFrameReadbackEntry[] | undefined;
  onClose: () => void;
  onRefresh: () => void;
  onSwitch: (backend: RendererBackend) => void;
}

export function RendererDiagnosticsPanel(props: Props) {
  return (
    <section className="renderer-diagnostics-panel" aria-label={tr(props.locale, "渲染引擎设置", "Rendering engine settings")}>
      <header>
        <span>
          <strong>{tr(props.locale, "渲染引擎设置", "Rendering engine settings")}</strong>
          <small>{tr(props.locale, "切换前预检，失败自动恢复场景", "Preflight before switching; restore the scene on failure")}</small>
        </span>
        <div>
          <button
            aria-label={tr(props.locale, "导出诊断", "Export diagnostics")}
            title={tr(props.locale, "导出设备、后端和性能证据", "Export device, backend, and performance evidence")}
            onClick={() =>
              downloadRendererDiagnosticEvidence({
                current: props.current,
                probe: props.probe,
                readiness: props.readiness,
                performance: props.performance,
              })
            }
          >
            <Download size={14} />
          </button>
          <button aria-label={tr(props.locale, "关闭", "Close")} onClick={props.onClose}>
            <X size={14} />
          </button>
        </div>
      </header>
      {props.checking ? (
        <div className="renderer-diagnostics-loading">
          <LoaderCircle className="spin" size={17} />
          <span>{tr(props.locale, "正在检测浏览器、显卡和项目能力…", "Checking browser, GPU and project capabilities…")}</span>
        </div>
      ) : (
        <>
          <div className="renderer-device-card">
            <Cpu size={17} />
            <span>
              <strong>{props.probe?.adapterName || tr(props.locale, "图形设备", "Graphics device")}</strong>
              <small>
                {props.probe?.maxTextureDimension2D
                  ? `Max texture ${props.probe.maxTextureDimension2D}px`
                  : tr(props.locale, "浏览器未公开设备名称", "Device name is not exposed by the browser")}
              </small>
            </span>
            <button title={tr(props.locale, "重新检测", "Check again")} onClick={props.onRefresh}>
              <RefreshCw size={13} />
            </button>
            {props.probe?.webgpuAdapter && (
              <div className="renderer-device-capabilities">
                <span className={props.probe.timestampQuery ? "available" : "limited"}>
                  Timestamp query · {props.probe.timestampQuery ? tr(props.locale, "支持", "Available") : tr(props.locale, "未开放", "Unavailable")}
                </span>
                <span className={props.probe.shaderF16 ? "available" : "limited"}>
                  Shader F16 · {props.probe.shaderF16 ? tr(props.locale, "支持", "Available") : tr(props.locale, "未开放", "Unavailable")}
                </span>
                {props.probe.maxBindGroups && <span>Bind groups · {props.probe.maxBindGroups}</span>}
                {props.probe.maxComputeInvocationsPerWorkgroup && <span>Compute/workgroup · {props.probe.maxComputeInvocationsPerWorkgroup}</span>}
                {props.probe.maxStorageBufferBindingSize && <span>Storage buffer · {formatBytes(props.probe.maxStorageBufferBindingSize)}</span>}
              </div>
            )}
          </div>
          <SwitchStatus locale={props.locale} current={props.current} desired={props.desired} phase={props.switchPhase} message={props.switchMessage} />
          <PerformanceSummary locale={props.locale} snapshot={props.performance} />
          {props.frameCapture && <FrameCaptureSourceMapPanel locale={props.locale} readbacks={props.frameReadbacks}
            {...props.frameCapture} />}
          <div className="renderer-option-list">
            {props.readiness.map((item) => (
              <article key={item.backend} className={`${item.level} ${props.current === item.backend ? "current" : ""}`}>
                <div className="renderer-option-title">
                  <span>
                    {item.level === "ready" ? <Check size={14} /> : item.level === "limited" ? <TriangleAlert size={14} /> : <X size={14} />}
                    <strong>{item.backend === "webgl" ? "WebGL 2" : "Deep WebGPU Beta"}</strong>
                  </span>
                  {props.current === item.backend && <small>{tr(props.locale, "当前", "Current")}</small>}
                  {props.current !== item.backend && props.desired === item.backend && <small>{tr(props.locale, "目标", "Target")}</small>}
                </div>
                <p>{trReadiness(props.locale, item)}</p>
                <ul>
                  {item.details.map((detail) => (
                    <li key={detail}>{trDetail(props.locale, detail)}</li>
                  ))}
                </ul>
                <button disabled={!item.ready || props.switching || props.current === item.backend} onClick={() => props.onSwitch(item.backend)}>
                  {props.current === item.backend
                    ? tr(props.locale, "正在使用", "In use")
                    : !item.ready
                      ? tr(props.locale, "不可用", "Unavailable")
                      : item.backend === "webgpu"
                        ? tr(props.locale, "启用 Deep WebGPU Beta", "Enable Deep WebGPU Beta")
                        : tr(props.locale, "切换到兼容模式", "Switch to compatibility")}
                </button>
              </article>
            ))}
          </div>
          <footer>
            <ShieldCheck size={14} />
            <span>
              {tr(
                props.locale,
                "Deep WebGPU Beta 保留同一作者状态，成功激活后才保存偏好；画质与功能仍需逐场景验收。",
                "Deep WebGPU Beta retains the same author state and saves preferences only after activation. Visual quality and features still require per-scene validation.",
              )}
            </span>
          </footer>
        </>
      )}
    </section>
  );
}

function SwitchStatus({ locale, current, desired, phase, message }: {
  locale: AppLocale;
  current: RendererBackend;
  desired: RendererBackend;
  phase: Props["switchPhase"];
  message: string | undefined;
}) {
  const currentName = current === "webgpu" ? "Deep WebGPU Beta" : "WebGL 2";
  const desiredName = desired === "webgpu" ? "Deep WebGPU Beta" : "WebGL 2";
  if (phase === "idle" && current === desired) {
    return <div className="renderer-switch-status idle"><Check size={14} /><span><strong>{tr(locale, "当前渲染后端", "Active renderer")}</strong><small>{currentName}</small></span></div>;
  }
  const icon = phase === "failed" ? <TriangleAlert size={14} /> : <LoaderCircle className="spin" size={14} />;
  const title = phase === "recovering"
    ? tr(locale, "正在恢复", "Recovering")
    : phase === "failed"
      ? tr(locale, "切换未完成", "Switch incomplete")
      : tr(locale, "正在准备", "Preparing");
  return <div className={`renderer-switch-status ${phase}`}>{icon}<span><strong>{title} · {currentName} → {desiredName}</strong><small>{message ?? tr(locale, "作者数据保持在同一工作区中。", "Author data remains in the same workspace.")}</small></span></div>;
}

function PerformanceSummary({ locale, snapshot }: { locale: AppLocale; snapshot: FramePerformanceSnapshot | undefined }) {
  if (!snapshot || snapshot.sampleCount < 2) {
    return (
      <section className="renderer-performance-summary pending">
        <strong>{tr(locale, "正在建立性能样本…", "Building a performance sample…")}</strong>
        <small>{tr(locale, "保持场景可见，约十秒后可获得稳定分位数。", "Keep the scene visible for a stable ten-second window.")}</small>
      </section>
    );
  }
  const { renderer, frameTimeMs } = snapshot;
  return (
    <section className="renderer-performance-summary" aria-label={tr(locale, "实时性能", "Live performance")}>
      <header>
        <strong>{tr(locale, "实时性能", "Live performance")}</strong>
        <small>
          {snapshot.sampleCount} {tr(locale, "个可见帧样本", "visible frame samples")}
        </small>
      </header>
      <div className="renderer-performance-metrics">
        <Metric label="FPS" value={snapshot.fps.toFixed(0)} />
        <Metric label="P95" value={`${frameTimeMs.p95.toFixed(1)} ms`} warning={frameTimeMs.p95 > 33.34} />
        {snapshot.gpuFrameTime?.sampleCount ? (
          <Metric label={tr(locale, "GPU P95", "GPU P95")} value={`${snapshot.gpuFrameTime.p95Ms.toFixed(1)} ms`} warning={snapshot.gpuFrameTime.p95Ms > 33.34} />
        ) : snapshot.gpuFrameTime?.supported ? (
          <Metric label={tr(locale, "GPU 计时", "GPU timing")} value={tr(locale, "采样中", "Sampling")} />
        ) : null}
        <Metric label={tr(locale, ">33ms 帧", ">33ms frames")} value={`${(snapshot.over33msRate * 100).toFixed(1)}%`} warning={snapshot.over33msRate > 0.05} />
        <Metric label="Draw calls" value={renderer.drawCalls.toLocaleString(locale)} warning={renderer.drawCalls > 1_000} />
        <Metric label={tr(locale, "三角面", "Triangles")} value={compactNumber(renderer.triangles)} warning={renderer.triangles > 5_000_000} />
        <Metric label={tr(locale, "纹理", "Textures")} value={renderer.textures?.toLocaleString(locale) ?? "—"} warning={(renderer.textures ?? 0) > 800} />
        {snapshot.heap && (
          <Metric
            label="JS heap"
            value={formatBytes(snapshot.heap.usedBytes)}
            warning={snapshot.heap.limitBytes > 0 && snapshot.heap.usedBytes / snapshot.heap.limitBytes > 0.75}
          />
        )}
        {snapshot.mainThread?.supported && (
          <Metric
            label={tr(locale, "长任务 / 阻塞", "Long tasks / blocking")}
            value={`${snapshot.mainThread.count} / ${snapshot.mainThread.blockingTimeMs.toFixed(0)}ms`}
            warning={snapshot.mainThread.blockingTimeMs > 100}
          />
        )}
      </div>
      <div className="renderer-load-evidence">
        <span>
          {renderer.backend.toUpperCase()} · {renderer.pixelRatio.toFixed(2)}× · {compactNumber(renderer.viewportPixels)} px
        </span>
        {renderer.activeFeatures.length > 0 && <span>{renderer.activeFeatures.join(" · ")}</span>}
      </div>
      {renderer.adaptiveRenderScale && <AdaptiveQualityStatus locale={locale} state={renderer.adaptiveRenderScale} />}
      {snapshot.pressureSignals.length > 0 ? (
        <ul className="renderer-pressure-signals">
          {snapshot.pressureSignals.map((signal) => (
            <li className={signal.level} key={signal.code}>
              <strong>{pressureName(locale, signal.code)}</strong>
              <span>{signal.evidence}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="renderer-pressure-clear">
          <Check size={13} />
          {tr(locale, "当前窗口未发现明显负载压力", "No obvious pressure in the current window")}
        </p>
      )}
      <small className="renderer-attribution-note">
        {tr(locale, "负载线索用于缩小排查范围，不替代浏览器 Performance / GPU Profile。", "Load signals narrow the search; they do not replace a Performance/GPU profile.")}
      </small>
    </section>
  );
}

function AdaptiveQualityStatus({ locale, state }: { locale: AppLocale; state: NonNullable<FramePerformanceSnapshot["renderer"]["adaptiveRenderScale"]> }) {
  const percent = Math.round(state.renderScale * 100);
  const adaptive = state.mode === "adaptive-fill-rate";
  const title = !state.enabled
    ? tr(locale, "标准画质 · 100%", "Standard quality · 100%")
    : adaptive
      ? tr(locale, `自动优化 · ${percent}% 填充率`, `Adaptive · ${percent}% fill rate`)
      : tr(locale, "自动优化 · 全画质 100%", "Adaptive · full quality 100%");
  const detail = adaptive
    ? tr(
        locale,
        "完整模型、灯光、效果与仿真保持不变；压力解除后自动恢复。",
        "Full assets, lights, effects and simulation remain intact; quality restores automatically after pressure clears.",
      )
    : state.enabled
      ? tr(locale, "当前性能健康，完整画质保持开启。", "Performance is healthy and full quality remains active.")
      : tr(locale, "未启用动态调整，严格使用作者发布画质。", "Dynamic adjustment is off; authored publication quality is used exactly.");
  return (
    <div className={`renderer-quality-guard ${adaptive ? "active" : "full"}`}>
      <ShieldCheck size={14} />
      <span>
        <strong>{title}</strong>
        <small>
          {detail}
          {state.reason ? ` ${state.reason}` : ""}
        </small>
      </span>
    </div>
  );
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className={warning ? "warning" : ""}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function compactNumber(value: number): string {
  return Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatBytes(value: number): string {
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(0)} KB`;
  return `${(value / 1024 ** 2).toFixed(value < 100 * 1024 ** 2 ? 1 : 0)} MB`;
}

function pressureName(locale: AppLocale, code: PerformancePressureCode): string {
  const names: Record<PerformancePressureCode, [string, string]> = {
    "frame-budget": ["帧预算", "Frame budget"],
    "draw-calls": ["绘制批次", "Draw calls"],
    "geometry-load": ["几何负载", "Geometry load"],
    "texture-load": ["纹理负载", "Texture load"],
    "fill-rate": ["像素填充", "Fill rate"],
    "heap-pressure": ["内存压力", "Heap pressure"],
    "main-thread": ["主线程阻塞", "Main-thread blocking"],
  };
  return locale === "zh-CN" ? names[code][0] : names[code][1];
}

function trReadiness(locale: AppLocale, item: RendererReadiness): string {
  const translations: Record<string, string> = {
    "生产兼容，功能完整": "Production-compatible and feature-complete",
    "当前环境无法创建 WebGL 2 上下文": "This environment cannot create a WebGL 2 context",
    当前设备不可用: "Unavailable on this device",
    "可试用，存在场景限制": "Available for trial with scene limitations",
    "可试用，需逐场景验收": "Available for trial; validate per scene",
  };
  return locale === "zh-CN" ? item.summary : (translations[item.summary] ?? item.summary);
}

function trDetail(locale: AppLocale, detail: string): string {
  const translations: Record<string, string> = {
    当前后处理与真实对象轮廓完整可用: "Current post-processing and true object outlines are fully available",
    "模型、材质、拾取与动画完整可用": "Models, materials, picking and animation are fully available",
    作为生产兼容后端保留: "Retained as the production compatibility backend",
    "需要 HTTPS 或 localhost 安全上下文": "Requires HTTPS or a localhost secure context",
    安全上下文可用: "Secure context available",
    "浏览器未暴露 WebGPU API": "The browser does not expose WebGPU",
    "未找到可用的高性能 GPU 适配器": "No high-performance GPU adapter is available",
    "GPU 适配器可用": "GPU adapter available",
    "Studio 使用 Deep WebGPU 投影画布；材质、环境与作者辅助层仍需逐场景验收":
      "Studio uses the Deep WebGPU projection canvas; materials, environment and author overlays still require per-scene validation",
    "作者后处理或对象轮廓需要逐场景验证；自动发布保留 WebGL":
      "Authored post-processing or object outlines require per-scene validation; automatic publication remains on WebGL",
    "仅在显式选择时使用；自动默认仍保留 WebGL":
      "Used only when explicitly selected; automatic default remains on WebGL",
    "产品 WebGPU 路径尚未完成 WebXR 实机验收，XR 会话继续使用 WebGL": "The product WebGPU path has not passed WebXR device validation; XR sessions continue to use WebGL",
    "XR 会话挂载在本后端：WebXR 进入、控制器选择与双目渲染均走 WebGL": "XR sessions mount on this backend: WebXR entry, controller selection and stereo rendering all run on WebGL",
    "Deep WebGPU 激活期间 XR 入口不可用；浏览器端 WebGPU-XR 会话特性尚未落地，属诚实降级而非缺陷": "The XR entry is unavailable while Deep WebGPU is active; browser-side WebGPU-XR session support has not landed yet — an honest fallback, not a defect",
  };
  return locale === "zh-CN" ? detail : (translations[detail] ?? detail);
}
