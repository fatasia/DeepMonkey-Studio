import { useCallback, useEffect, useId, useReducer, useRef, useState, type RefObject } from "react";
import { Camera, ChevronDown, ChevronRight, Columns2, Flame, Trash2, X } from "lucide-react";
import type { ViewerEngine } from "../viewer/ViewerEngine";
import { readStudioQualityTelemetry } from "../viewer/StudioDeepQualityTelemetry";
import { translate as tr, type AppLocale } from "../i18n";
import { useFloatingPanelDrag } from "../hooks/useFloatingPanelDrag";
import { BAKE_CHECK_WINDOW_MS, INITIAL_BAKE_BENCH_STATE, gpuBakeShare, readSdfGiMetrics,
  reduceBakeBench, type BakeBenchState, type SdfGiBakeMetrics } from "./bakeBenchModel";
import { captureViewportCanvasFrame, GI_OFF_BASELINE_STORAGE_KEY, type BakeBenchSnapshot } from "./bakeBenchCapture";
import "./LightingBakeBenchPanel.css";

/** 面板轮询节奏与桥侧 4Hz 遥测发布对齐;关闭面板即停表,无后台常驻。 */
const POLL_INTERVAL_MS = 250;

/** A/B 基准帧(GI 关)跨「开启 sdf-gi → 重建后端」的页面重载持久化(sessionStorage)。 */
function loadStoredBaseline(): BakeBenchSnapshot | undefined {
  try {
    if (typeof sessionStorage === "undefined") return undefined;
    const raw = sessionStorage.getItem(GI_OFF_BASELINE_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as BakeBenchSnapshot;
    return parsed?.dataUrl?.startsWith("data:image/") && parsed.sdfGiOn === false ? parsed : undefined;
  } catch { return undefined; }
}

function storeBaseline(snapshot: BakeBenchSnapshot | undefined): void {
  try {
    if (typeof sessionStorage === "undefined") return;
    if (snapshot) sessionStorage.setItem(GI_OFF_BASELINE_STORAGE_KEY, JSON.stringify(snapshot));
    else sessionStorage.removeItem(GI_OFF_BASELINE_STORAGE_KEY);
  } catch { /* 配额满/隐私模式:基准退化为仅本会话内存态,不阻塞。 */ }
}

export interface LightingBakeBenchPanelProps {
  locale: AppLocale;
  /** 实时帧率/呈现帧订阅来源(作者引擎,WebGL 与 Deep 均可用)。 */
  engine: ViewerEngine | undefined;
  /** 视口容器:用于定位呈现画布抓取 A/B 对比帧。 */
  viewportRef: RefObject<HTMLElement | null>;
  onClose: () => void;
}

/**
 * 光照烘焙工作台(Brief-GI M2/M3 操作台):触发检查/进度观测/烘焙摘要/烘焙前后
 * (GI 关·开)A/B 对比。烘焙的权威触发是引擎的场景 dirty 机制(包 revision 变化
 * 帧自动烘焙),本面板如实观察计数器推进并报告,不做伪进度、不伪造烘焙。
 * 全部颜色取 base.css 令牌;缺测显示「未接入」,绝不伪零。
 */
export function LightingBakeBenchPanel(props: LightingBakeBenchPanelProps) {
  const { locale, engine } = props;
  const drag = useFloatingPanelDrag<HTMLDivElement>();
  const bodyId = useId();
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState(() => readStudioQualityTelemetry());
  const [bench, dispatch] = useReducer(reduceBakeBench, undefined,
    () => initBenchState(readStudioQualityTelemetry()));
  const [perfP95, setPerfP95] = useState<number | undefined>();
  const checkTimerRef = useRef<number | undefined>(undefined);
  const [slotA, setSlotA] = useState<BakeBenchSnapshot | undefined>(loadStoredBaseline);
  const [slotB, setSlotB] = useState<BakeBenchSnapshot | undefined>();
  const [compareMode, setCompareMode] = useState<"split" | "a" | "b">("split");
  const [splitPercent, setSplitPercent] = useState(50);
  const armedSlotRef = useRef<"a" | "b" | undefined>(undefined);
  const [captureAttempt, setCaptureAttempt] = useState(0);
  const [captureNote, setCaptureNote] = useState<string | undefined>();
  const autoCapturedBakeRef = useRef<number | undefined>(undefined);

  const metrics = readSdfGiMetrics(status);
  // 观察窗进行中如实展示帧时 P95 尖峰(大场景 CPU 展平/上传的真实代价,无伪进度条)。
  useEffect(() => {
    if (bench.phase.kind !== "checking") { setPerfP95(undefined); return; }
    setPerfP95(engine?.getPerformanceSnapshot().frameTimeMs.p95);
  }, [bench.phase.kind, engine, status]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const latest = readStudioQualityTelemetry();
      setStatus(latest);
      dispatch({ type: "tick", atMs: Date.now(), metrics: readSdfGiMetrics(latest) });
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => () => window.clearTimeout(checkTimerRef.current), []);

  // 新烘焙出现即自动补拍「GI 开」对比帧(无读回时静默留空,由手动抓帧兜底)。
  useEffect(() => {
    if (bench.phase.kind !== "fresh" || autoCapturedBakeRef.current === bench.phase.record.bakeIndex) return;
    autoCapturedBakeRef.current = bench.phase.record.bakeIndex;
    if (!slotB) armCapture("b");
  }, [bench.phase, slotB]); // eslint-disable-line react-hooks/exhaustive-deps -- slotB 只用于避免覆盖已有人工抓帧

  // 抓帧:订阅呈现帧,下一帧同步 drawImage 呈现画布(内容在本帧内有效)。
  // 静置视口每次订阅只催一帧,失败后需重新订阅催帧;上限 5 次后如实报错。
  useEffect(() => {
    const slot = armedSlotRef.current;
    if (!slot || !engine) return;
    let attempts = 0;
    let cancelled = false;
    let retryTimer: number | undefined;
    let unsubscribe: (() => void) | undefined;
    const attemptOnNextFrame = () => {
      if (cancelled) return;
      attempts += 1;
      unsubscribe = engine.subscribePresentationFrames(() => {
        if (cancelled || armedSlotRef.current !== slot) return;
        const frame = captureViewportCanvasFrame(props.viewportRef.current, engine.getRendererBackend());
        if (!frame) {
          unsubscribe?.();
          unsubscribe = undefined;
          if (attempts >= 5) {
            armedSlotRef.current = undefined;
            setCaptureNote(tr(locale, "连续 5 帧未取到呈现画布(后端切换中或画布不可读)", "No presentable canvas across 5 frames (switching or unreadable)"));
            return;
          }
          retryTimer = window.setTimeout(attemptOnNextFrame, 120);
          return;
        }
        armedSlotRef.current = undefined;
        setCaptureNote(undefined);
        if (slot === "a") { storeBaseline(frame); setSlotA(frame); }
        else setSlotB(frame);
      });
    };
    attemptOnNextFrame();
    return () => { cancelled = true; window.clearTimeout(retryTimer); unsubscribe?.(); };
  }, [captureAttempt, engine, locale, props.viewportRef]);

  const armCapture = useCallback((slot: "a" | "b") => {
    armedSlotRef.current = slot;
    setCaptureNote(undefined);
    setCaptureAttempt(value => value + 1);
  }, []);

  function startBakeCheck() {
    if (!metrics) return;
    setCaptureNote(undefined);
    dispatch({ type: "check-started", atMs: Date.now() });
    window.clearTimeout(checkTimerRef.current);
    checkTimerRef.current = window.setTimeout(
      () => dispatch({ type: "check-timeout", atMs: Date.now() }), BAKE_CHECK_WINDOW_MS);
  }

  const phase = bench.phase.kind === "gi-disabled" && metrics !== undefined ? "idle" : bench.phase.kind;
  const giOn = metrics !== undefined;
  const badge = giOn ? tr(locale, "SDF GI 运行中", "SDF GI active") : tr(locale, "未开启", "Disabled");
  const summary = summaryEntries(locale, bench, metrics, perfP95);
  // 单帧视图:A/B 切换选帧;只抓到一槽时直接展示那一帧(模式选择仅在双帧时有意义)。
  const singleFrame = (compareMode === "a" && slotA ? slotA : undefined) ?? slotB ?? slotA!;

  return (
    <div
      ref={drag.panelRef}
      style={drag.style}
      className={`bake-bench-panel${collapsed ? " collapsed" : ""}`}
      aria-label={tr(locale, "光照烘焙", "Lighting bake")}
      data-testid="bake-bench-panel"
      data-phase={phase}
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
        <span className="bb-title">
          <Flame size={15} />
          <strong>{tr(locale, "光照烘焙", "Lighting bake")}</strong>
          <small className={giOn ? "bb-badge on" : "bb-badge"}>{badge}</small>
        </span>
        <span className="bb-actions">
          <button type="button" aria-expanded={!collapsed} aria-controls={bodyId}
            title={collapsed ? tr(locale, "展开", "Expand") : tr(locale, "折叠", "Collapse")}
            onClick={() => setCollapsed(value => !value)}>
            {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          </button>
          <button type="button" aria-label={tr(locale, "关闭", "Close")} title={tr(locale, "关闭", "Close")}
            onClick={props.onClose}>
            <X size={14} />
          </button>
        </span>
      </header>
      {!collapsed && (
        <div id={bodyId} className="bb-body">
          <section className="bb-section">
            <h3>{tr(locale, "烘焙状态", "Bake state")}</h3>
            <p className={`bb-phase bb-phase-${phase}`} data-testid="bake-bench-phase" role="status">
              {phaseText(locale, phase, bench, giOn)}
            </p>
            <div className="bb-run">
              <button type="button" className="bb-bake-button" disabled={!giOn}
                data-testid="bake-bench-check"
                onClick={startBakeCheck}>
                <Flame size={14} />
                {tr(locale, "烘焙光照", "Bake lighting")}
              </button>
              <span className="bb-hint">
                {giOn
                  ? tr(locale, "修改场景(移动/增删对象)后引擎按 dirty 自动重烘焙;此处校验并报告结果。",
                    "Edit the scene (move/add/remove) and the engine rebakes on dirty; this verifies and reports.")
                  : tr(locale, "SDF GI 未开启:以 URL 参数 sdf-gi=1 打开工作区并重建 Deep 后端后可用。",
                    "SDF GI is off: open the workspace with URL param sdf-gi=1 and rebuild the Deep backend.")}
              </span>
            </div>
          </section>
          <section className="bb-section">
            <h3>{tr(locale, "烘焙摘要", "Bake summary")}</h3>
            <div className="bb-grid">
              {summary.map(item => (
                <div key={item.label} className={`bb-metric${item.off ? " off" : ""}`} title={item.title}>
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                </div>
              ))}
            </div>
          </section>
          <section className="bb-section">
            <h3>
              {tr(locale, "烘焙前后对比(GI 关 ↔ 开)", "Before / after (GI off ↔ on)")}
              {(slotA || slotB) && (
                <span className="bb-compare-tools">
                  {slotA && slotB && (
                    <button type="button" className={compareMode === "split" ? "active" : ""}
                      aria-pressed={compareMode === "split"} title={tr(locale, "滑块对比", "Split compare")}
                      onClick={() => setCompareMode("split")}>
                      <Columns2 size={13} />
                    </button>
                  )}
                  {slotA && (
                    <button type="button" className={compareMode === "a" ? "active" : ""}
                      aria-pressed={compareMode === "a"} title={tr(locale, "看 GI 关帧", "Show GI-off frame")}
                      onClick={() => setCompareMode("a")}>A</button>
                  )}
                  {slotB && (
                    <button type="button" className={compareMode === "b" ? "active" : ""}
                      aria-pressed={compareMode === "b"} title={tr(locale, "看 GI 开帧", "Show GI-on frame")}
                      onClick={() => setCompareMode("b")}>B</button>
                  )}
                  {slotA && (
                    <button type="button" title={tr(locale, "清除 GI 关基准", "Clear GI-off baseline")}
                      onClick={() => { storeBaseline(undefined); setSlotA(undefined); setCompareMode("split"); }}>
                      <Trash2 size={13} />
                    </button>
                  )}
                  {slotB && (
                    <button type="button" title={tr(locale, "清除 GI 开帧", "Clear GI-on frame")}
                      onClick={() => { setSlotB(undefined); setCompareMode("split"); }}>
                      <Trash2 size={13} />
                    </button>
                  )}
                </span>
              )}
            </h3>
            {slotA && slotB && compareMode === "split" ? (
              <figure className="bb-compare" data-testid="bake-bench-compare">
                <div className="bb-compare-stage">
                  <img src={slotB.dataUrl} alt={tr(locale, "GI 开启帧", "GI-on frame")} draggable={false} />
                  <div className="bb-compare-clip" style={{ width: `${splitPercent}%` }}>
                    <img src={slotA.dataUrl} alt={tr(locale, "GI 关闭帧", "GI-off frame")} draggable={false} />
                  </div>
                </div>
                <figcaption>
                  <span>A · {tr(locale, "GI 关", "GI off")}</span>
                  <input type="range" min={0} max={100} value={splitPercent} aria-label={tr(locale, "对比分割位置", "Compare split position")}
                    onChange={event => setSplitPercent(Number(event.currentTarget.value))} />
                  <span>{tr(locale, "GI 开", "GI on")} · B</span>
                </figcaption>
              </figure>
            ) : (slotA || slotB) ? (
              <figure className="bb-compare single" data-testid="bake-bench-compare">
                <img src={singleFrame.dataUrl}
                  alt={singleFrame.sdfGiOn ? tr(locale, "GI 开启帧", "GI-on frame") : tr(locale, "GI 关闭帧", "GI-off frame")}
                  draggable={false} />
                <figcaption>{compareFrameCaption(locale, singleFrame)}</figcaption>
              </figure>
            ) : (
              <p className="bb-empty">
                {tr(locale, "尚无对比帧:GI 关闭时「抓 GI 关基准」,开启 sdf-gi 并烘焙后「抓当前帧」。",
                  "No frames yet: capture the GI-off baseline while GI is off, then capture after enabling sdf-gi and baking.")}
              </p>
            )}
            <div className="bb-run">
              <button type="button" className="bb-capture-button" disabled={!engine}
                data-testid="bake-bench-capture-off"
                onClick={() => armCapture("a")}>
                <Camera size={13} /> {tr(locale, "抓 GI 关基准", "Capture GI-off baseline")}
              </button>
              <button type="button" className="bb-capture-button" disabled={!engine || !giOn}
                data-testid="bake-bench-capture-on"
                onClick={() => armCapture("b")}>
                <Camera size={13} /> {tr(locale, "抓当前帧(GI 开)", "Capture current (GI on)")}
              </button>
            </div>
            {captureNote && <p className="bb-empty failure">{captureNote}</p>}
            {slotA && slotB && slotA.backend !== slotB.backend && (
              <p className="bb-empty">
                {tr(locale, `两帧呈现后端不同(${slotA.backend} ↔ ${slotB.backend}),对比含后端渲染差异,不只 GI。`,
                  `Frames use different presentation backends (${slotA.backend} ↔ ${slotB.backend}); the comparison includes backend differences, not just GI.`)}
              </p>
            )}
          </section>
          <footer className="bb-footnote">
            {tr(locale,
              "覆盖口径:烘焙由引擎场景 dirty(包 revision 变化)自动触发,引擎无手动触发 API;本面板轮询 4Hz 遥测观察计数器推进,不伪进度。GPU 稳态烘焙 4.4ms 级帧内完成,大场景 CPU 展平以帧时 P95 尖峰呈现。对比帧为呈现画布 JPEG 缩略,非无损。",
              "Coverage: bakes trigger automatically on scene dirty (packet revision change); the engine has no manual trigger API. This panel polls 4 Hz telemetry for counter progress — no fake progress. Steady-state GPU bake is ~4.4 ms in-frame; large-scene CPU flattening shows up as frame-time P95 spikes. Compare frames are JPEG canvas thumbnails, not lossless.")}
          </footer>
        </div>
      )}
    </div>
  );
}

function initBenchState(status: ReturnType<typeof readStudioQualityTelemetry>): BakeBenchState {
  const metrics = readSdfGiMetrics(status);
  return metrics ? reduceBakeBench(INITIAL_BAKE_BENCH_STATE, { type: "tick", atMs: Date.now(), metrics }) : INITIAL_BAKE_BENCH_STATE;
}

function phaseText(locale: AppLocale, phase: string, bench: BakeBenchState, giOn: boolean): string {
  if (!giOn) return tr(locale, "SDF GI 未开启——烘焙运行时未构建", "SDF GI off — bake runtime not built");
  if (phase === "checking") return tr(locale, "正在观察场景变更与烘焙计数…", "Watching scene changes and bake counter…");
  if (phase === "fresh" && bench.phase.kind === "fresh") {
    return tr(locale, `第 ${bench.phase.record.bakeIndex} 次烘焙已完成(${bench.phase.record.gpuBaked ? "GPU 距离场" : "CPU 回退"})`,
      `Bake #${bench.phase.record.bakeIndex} complete (${bench.phase.record.gpuBaked ? "GPU distance field" : "CPU fallback"})`);
  }
  if (phase === "up-to-date") return tr(locale, "已是最新:观察窗内无场景变更,未发生新烘焙。", "Up to date: no scene change within the window, no new bake.");
  return bench.lastBake
    ? tr(locale, "就绪:场景自上次烘焙后无变更。", "Ready: no scene change since the last bake.")
    : tr(locale, "就绪:引擎按场景 dirty 自动烘焙,此处如实观测。", "Ready: the engine bakes on scene dirty; observed here as it happens.");
}

interface SummaryEntry { readonly label: string; readonly value: string; readonly off?: boolean | undefined; readonly title?: string | undefined }

function summaryEntries(locale: AppLocale, bench: BakeBenchState, metrics: SdfGiBakeMetrics | undefined,
  perfP95: number | undefined): SummaryEntry[] {
  if (!metrics) {
    return [
      { label: tr(locale, "探针数", "Probes"), value: tr(locale, "未接入", "—"), off: true },
      { label: tr(locale, "SDF cells", "SDF cells"), value: tr(locale, "未接入", "—"), off: true },
      { label: tr(locale, "最近烘焙", "Last bake"), value: tr(locale, "未接入", "—"), off: true },
      { label: tr(locale, "烘焙路径", "Bake path"), value: tr(locale, "未接入", "—"), off: true },
      { label: tr(locale, "预算档", "Budget"), value: tr(locale, "未接入", "—"), off: true },
      { label: tr(locale, "观察窗帧时 P95", "Window frame P95"), value: perfP95 !== undefined ? `${perfP95.toFixed(1)} ms` : "—", off: perfP95 === undefined },
    ];
  }
  const share = gpuBakeShare(metrics);
  const lastBake = bench.lastBake;
  return [
    { label: tr(locale, "探针数", "Probes"), value: metrics.sdfGiProbeCount > 0 ? metrics.sdfGiProbeCount.toLocaleString() : "0" },
    { label: tr(locale, "SDF cells", "SDF cells"), value: metrics.sdfGiBakeCells > 0 ? metrics.sdfGiBakeCells.toLocaleString() : "0" },
    { label: tr(locale, "最近烘焙", "Last bake"), title: lastBake ? new Date(lastBake.observedAtMs).toLocaleString() : undefined,
      value: lastBake ? formatClock(lastBake.observedAtMs) : tr(locale, "会话内未观测", "none in session"), off: !lastBake },
    { label: tr(locale, "烘焙路径", "Bake path"), title: tr(locale, "GPU compute 距离场次数 / CPU 增量回退次数", "GPU compute field bakes / CPU incremental fallbacks"),
      value: tr(locale, `GPU ${share.gpu} · CPU ${share.cpuFallback}`, `GPU ${share.gpu} · CPU ${share.cpuFallback}`) },
    { label: tr(locale, "预算档", "Budget"), title: tr(locale, "自适应质量档 + 每帧探针 SH 更新预算", "Adaptive quality profile + per-frame probe SH update budget"),
      value: metrics.ddgiUpdateBudget !== undefined
        ? tr(locale, `DDGI 预算 ${metrics.ddgiUpdateBudget}`, `DDGI budget ${metrics.ddgiUpdateBudget}`)
        : tr(locale, "预算未接入", "budget n/a"), off: metrics.ddgiUpdateBudget === undefined },
    { label: tr(locale, "观察窗帧时 P95", "Window frame P95"), title: tr(locale, "烘焙检查期间的帧时尖峰(大场景 CPU 展平真实代价)", "Frame-time spikes during the check window (real cost of large-scene CPU flattening)"),
      value: perfP95 !== undefined ? `${perfP95.toFixed(1)} ms` : "—", off: perfP95 === undefined },
  ];
}

function compareFrameCaption(locale: AppLocale, snapshot: BakeBenchSnapshot): string {
  const state = snapshot.sdfGiOn ? tr(locale, "GI 开", "GI on") : tr(locale, "GI 关", "GI off");
  return `A/B ${state} · ${snapshot.backend} · ${formatClock(snapshot.capturedAtMs)}`;
}

function formatClock(ms: number): string {
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
