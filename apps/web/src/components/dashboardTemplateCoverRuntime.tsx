import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { DashboardDataWidgetConfig, DashboardPageDocument } from "@bim-studio/contracts";
import type { AppLocale } from "../i18n";
import { buildDashboardTemplateNodes } from "./dashboardTemplateLayoutBuilder";
import type { DashboardTemplateDefinition } from "./dashboardTemplateTypes";
import { templateSupportsRealCover } from "../studio/templateSampleData";
import { buildDashboardSampleMetric, dashboardSampleFilterWidgets } from "./dashboardSampleMetrics";
import { dashboardAuthoredTypography } from "./dashboardTemplateTypography";
import "../styles/dashboard-workspace.css";
import "./DashboardTemplateTypography.css";

/**
 * 真实渲染封面管线:隐藏容器挂载真实 widget 运行时(与插入后同一渲染路径 + 示例数据),
 * 等图表首帧(ECharts finished)后用 html-to-image 截帧,缓存为 dataURL 供卡片淡入替换 SVG 封面。
 *
 * 纪律:
 * - 串行队列逐个渲染,任务间让出双 rAF,主线程不因 277 个模板批量渲染而卡顿。
 * - 只在卡片进入视口(IntersectionObserver)时排队;结果按 `locale:主题:模板` 做 LRU 缓存。
 * - 单模板 8s 超时/任何失败 → 返回 undefined,卡片保持既有 SVG 封面,永不白块。
 * - 主题切换清空缓存并通知订阅者重渲染,保证"同运行时同主题"。
 */

const COVER_WIDTH = 1920;
const COVER_HEIGHT = 1080;
/**
 * 截帧输出 640×360(COVER_WIDTH×ratio):u131 全量取证(317 模板)显示 960×540 下
 * toPng 同步块 p50 517ms、遍历期 long task 2135 次、dataURL 常驻 +453MB;
 * 降到 1/3 后 capture 与内存常驻同步减半以上,卡片显示宽 ~250px 下仍有 ~2.5 倍冗余。
 */
const COVER_CAPTURE_RATIO = 1 / 3;
const COVER_CACHE_LIMIT = 200;
const COVER_TIMEOUT_MS = 8000;
/** 图表 finished 后的字体/合成沉降窗。 */
const COVER_SETTLE_MS = 360;

const COVER_PAGE: DashboardPageDocument = { id: "cover", name: "cover", width: COVER_WIDTH, height: COVER_HEIGHT, viewportFit: "contain", nodes: [] };

const CHART_WIDGET_TYPES: ReadonlySet<string> = new Set([
  "line", "area", "bar", "combo", "pie", "scatter", "radar", "funnel", "gauge",
  "sankey", "sunburst", "treemap", "graph", "map", "wordcloud", "boxplot", "waterfall", "polarBar",
]);

interface CoverEntry { url: string; renderedAt: number }

// Map 的插入序即 LRU 序:命中时重插,超限时淘汰最旧。
const coverCache = new Map<string, CoverEntry>();
const inFlightCovers = new Map<string, Promise<CoverEntry | undefined>>();
const coverQueue: Array<{ key: string; job: () => Promise<CoverEntry | undefined>; resolve: (entry: CoverEntry | undefined) => void }> = [];
let pumping = false;

const coverInvalidationListeners = new Set<() => void>();
let themeObserver: MutationObserver | undefined;

type CoverRuntime = typeof import("./DashboardWidgetRuntime");
type HtmlToImage = typeof import("html-to-image");
type ReactDomClient = typeof import("react-dom/client");

/** 主题键归一:仅 "light" 计为 light,其余(undefined/其他值)一律 dark——与缓存键同一口径。 */
export function normalizeCoverTheme(value: string | undefined): "light" | "dark" {
  return value === "light" ? "light" : "dark";
}

function cacheKeyOf(templateId: string, locale: AppLocale): string {
  return `${locale}:${normalizeCoverTheme(document.documentElement.dataset.theme)}:${templateId}`;
}

function cacheSet(key: string, entry: CoverEntry): void {
  coverCache.delete(key);
  coverCache.set(key, entry);
  while (coverCache.size > COVER_CACHE_LIMIT) {
    const oldest = coverCache.keys().next().value;
    if (oldest === undefined) break;
    coverCache.delete(oldest);
  }
}

let lastObservedTheme: "light" | "dark" | undefined;

function watchTheme(): void {
  if (themeObserver || typeof MutationObserver === "undefined") return;
  // MutationObserver 对"同值 setAttribute"同样回调;只在主题键真变时清缓存,
  // 避免同值写入触发全量 317 卡无谓重渲染(u131 取证实测踩中)。
  lastObservedTheme = normalizeCoverTheme(document.documentElement.dataset.theme);
  themeObserver = new MutationObserver(() => {
    const next = normalizeCoverTheme(document.documentElement.dataset.theme);
    if (next === lastObservedTheme) return;
    lastObservedTheme = next;
    if (coverCache.size === 0) return;
    coverCache.clear();
    for (const listener of coverInvalidationListeners) listener();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
}

/** 串行泵:逐个执行渲染任务,任务间让出双 rAF;失败按 undefined 结算(卡片回退 SVG)。 */
async function pumpCoverQueue(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (coverQueue.length > 0) {
      const next = coverQueue.shift()!;
      let entry: CoverEntry | undefined;
      try {
        entry = await next.job();
      } catch (reason) {
        console.warn(`[templateCover] 渲染失败,回退 SVG 封面 (${next.key})`, reason);
      }
      next.resolve(entry);
      inFlightCovers.delete(next.key);
      await nextFrameGap();
    }
  } finally {
    pumping = false;
  }
}

function nextFrameGap(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

function requestTemplateCover(template: DashboardTemplateDefinition, locale: AppLocale): Promise<CoverEntry | undefined> {
  if (!templateSupportsRealCover(template.layout)) return Promise.resolve(undefined);
  const key = cacheKeyOf(template.id, locale);
  const cached = coverCache.get(key);
  if (cached) {
    coverCache.delete(key);
    coverCache.set(key, cached);
    return Promise.resolve(cached);
  }
  const pending = inFlightCovers.get(key);
  if (pending) return pending;
  const promise = new Promise<CoverEntry | undefined>((resolve) => {
    // 主题切换与在途渲染竞态:渲染完成后主题键已变的封面不入缓存(由下一次请求按新主题重渲)。
    coverQueue.push({ key, job: async () => {
      const entry = await renderTemplateCover(template, locale);
      if (entry && cacheKeyOf(template.id, locale) === key) cacheSet(key, entry);
      return entry;
    }, resolve });
  });
  inFlightCovers.set(key, promise);
  void pumpCoverQueue();
  return promise;
}

// ---- 隐藏渲染宿主 ----------------------------------------------------------------

let coverHost: HTMLDivElement | undefined;
let coverHostUsers = 0;

function ensureCoverHost(): HTMLDivElement {
  watchTheme();
  if (!coverHost) {
    coverHost = document.createElement("div");
    coverHost.id = "dashboard-template-cover-host";
    coverHost.setAttribute("aria-hidden", "true");
    // 视口外的固定宿主:html-to-image 按节点自身盒模型克隆渲染,原点偏移不影响截帧。
    coverHost.style.cssText = "position:fixed;left:-100000px;top:0;width:0;height:0;overflow:visible;pointer-events:none;";
  }
  if (!coverHost.isConnected) document.body.append(coverHost);
  coverHostUsers += 1;
  return coverHost;
}

function releaseCoverHost(): void {
  coverHostUsers = Math.max(0, coverHostUsers - 1);
  if (coverHostUsers === 0 && coverHost?.isConnected) coverHost.remove();
}

function hexAlpha(hex: string, alpha: string): string {
  return /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : hex;
}

// ---- 就绪跟踪 --------------------------------------------------------------------
// 采用 compact 渲染(关闭图表动画):就绪判定 = ECharts canvas 全部出现 + 沉降窗,
// 不依赖 finished 事件——动画关闭后 finished 不再触发,且规避动画长尾造成的秒级等待。

interface ReadinessTracker {
  pollReady: () => boolean;
  ready: () => Promise<boolean>;
}

function createReadinessTracker(artboard: HTMLElement, expected: number): ReadinessTracker {
  // 就绪 = 每个图表容器各自出现 canvas(按容器数,防止单图多 canvas 提前满足总数)
  const canvasesReady = () => [...artboard.querySelectorAll(".dashboard-drill-chart")].filter((host) => host.querySelector("canvas")).length >= Math.max(1, expected);
  return {
    pollReady: canvasesReady,
    ready: () => new Promise<boolean>((resolve) => {
      const startedAt = performance.now();
      const probe = () => {
        if (canvasesReady() || performance.now() - startedAt > COVER_TIMEOUT_MS) {
          resolve(canvasesReady());
          return;
        }
        window.setTimeout(probe, 90);
      };
      probe();
    }),
  };
}

function settle(ms: number): Promise<void> {
  return new Promise((resolve) => { window.setTimeout(resolve, ms); });
}

// ---- 单模板渲染任务 ----------------------------------------------------------------

async function renderTemplateCover(template: DashboardTemplateDefinition, locale: AppLocale): Promise<CoverEntry | undefined> {
  const host = ensureCoverHost();
  // 真实运行时按需动态引入:未打开模板库/资源页的会话不承担 widget 运行时成本。
  const stageStart = performance.now();
  const [{ createRoot }, { toPng }, runtime, fontCss] = await Promise.all([
    import("react-dom/client") as Promise<ReactDomClient>,
    import("html-to-image") as Promise<HtmlToImage>,
    import("./DashboardWidgetRuntime") as Promise<CoverRuntime>,
    getCoverFontEmbedCss(),
  ]);
  const nodes = buildDashboardTemplateNodes(locale, COVER_PAGE, template, 0);
  const expected = nodes.filter((node) => node.kind === "data-widget" && CHART_WIDGET_TYPES.has(node.widget.type)).length;

  const artboard = document.createElement("div");
  artboard.className = "dashboard-cover-artboard";
  artboard.style.cssText = [
    `position:relative`,
    `width:${COVER_WIDTH}px`,
    `height:${COVER_HEIGHT}px`,
    `overflow:hidden`,
    // 页面底 = 模板 surface + 域 accent 顶光,与 SVG 封面的"域色空气感"同语言,但内容是真实渲染。
    `background:radial-gradient(130% 100% at 50% -8%, ${hexAlpha(template.accent, "26")}, transparent 55%), ${template.surface}`,
  ].join(";");
  host.append(artboard);
  const tracker = createReadinessTracker(artboard, expected);
  const root = createRoot(artboard);
  root.render(<CoverCanvas nodes={nodes} locale={locale} runtime={runtime} />);
  const mountMs = Math.round(performance.now() - stageStart);
  const readyStart = performance.now();
  try {
    const settled = await tracker.ready();
    // 超时视为失败:半成品截帧比 SVG 插画更糟,诚实回退。
    // 超时分支留 warn 痕迹:全量遍历取证需要区分"就绪超时"与"渲染异常"。
    if (!settled) {
      console.warn(`[templateCover] 就绪超时(${COVER_TIMEOUT_MS}ms),回退 SVG 封面 (${template.id}), expected=${expected}`);
      return undefined;
    }
    await settle(COVER_SETTLE_MS);
    await nextFrameGap();
    const readyMs = Math.round(performance.now() - readyStart);
    const captureStart = performance.now();
    const url = await toPng(artboard, { width: COVER_WIDTH, height: COVER_HEIGHT, pixelRatio: COVER_CAPTURE_RATIO, cacheBust: false, ...(fontCss ? { fontEmbedCSS: fontCss } : {}) });
    recordCoverPerf(template.id, { mountMs, readyMs, captureMs: Math.round(performance.now() - captureStart) });
    return url ? { url, renderedAt: Date.now() } : undefined;
  } finally {
    root.unmount();
    artboard.remove();
    releaseCoverHost();
  }
}

/** 字体嵌入 CSS 全文档只算一次(html-to-image 每次调用重扫 stylesheets 是主要固定开销之一)。 */
let coverFontCss: Promise<string> | undefined;
function getCoverFontEmbedCss(): Promise<string> {
  coverFontCss ??= import("html-to-image")
    .then(({ getFontEmbedCSS }) => getFontEmbedCSS(document.body))
    .catch(() => "");
  return coverFontCss;
}

/** 渲染分阶段耗时(供性能取证;上限 50 条,滚动覆盖)。 */
function recordCoverPerf(templateId: string, stages: { mountMs: number; readyMs: number; captureMs: number }): void {
  const sink = (window as typeof window & { __templateCoverPerf?: unknown[] }).__templateCoverPerf ??= [];
  sink.push({ templateId, ...stages });
  if (sink.length > 50) sink.shift();
}

// ---- 真实渲染画布(与画布节点同一外壳样式类 + DashboardWidgetView) --------------------

type SampleRows = NonNullable<DashboardDataWidgetConfig["sampleData"]>["rows"];

function CoverCanvas({ nodes, locale, runtime }: {
  nodes: ReturnType<typeof buildDashboardTemplateNodes>;
  locale: AppLocale;
  runtime: CoverRuntime;
}) {
  const widgets = useMemo(() => nodes.map((node) => node.widget), [nodes]);
  // 与 useDashboardMetrics 的 visibleMetrics 样例分支同语义:样例行经筛选器过滤后构建指标。
  const metricFor = useCallback((widget: DashboardDataWidgetConfig) =>
    widget.sampleData
      ? buildDashboardSampleMetric(widget, runtime.applyDashboardFilters(widget.sampleData.rows, {}, dashboardSampleFilterWidgets(widget, widgets)) as SampleRows)
      : undefined, [runtime, widgets]);
  const noop = useCallback(() => undefined, []);
  return <>
    {nodes.map((node) => {
      const widget = node.widget;
      return <div key={node.id}
        className="dashboard-node dashboard-native-widget"
        style={{
          left: node.frame.x, top: node.frame.y, width: node.frame.width, height: node.frame.height,
          ...runtime.widgetBackgroundStyle(widget),
          color: widget.textColor ?? "#eef2f4",
        }}>
        <runtime.DashboardWidgetView
          locale={locale}
          widget={widget}
          metric={metricFor(widget)}
          compact
          filters={{}}
          onDataInteraction={noop}
          onAnimationStart={noop}
          onAnimationEnd={noop}
        />
      </div>;
    })}
  </>;
}

// ---- React 接口 ----------------------------------------------------------------

/**
 * 模板封面真渲染 hook:返回截帧 dataURL(未就绪/失败时 undefined,调用方保持 SVG 封面)。
 * `enabled=false`(如实时 previewNodes 分支)时不排队、不渲染。
 */
export function useDashboardTemplateCover(
  template: DashboardTemplateDefinition,
  locale: AppLocale,
  containerRef: RefObject<HTMLElement | null>,
  enabled = true,
): string | undefined {
  const [url, setUrl] = useState<string | undefined>();
  const [themeEpoch, setThemeEpoch] = useState(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  useEffect(() => {
    const invalidate = () => setThemeEpoch((epoch) => epoch + 1);
    coverInvalidationListeners.add(invalidate);
    return () => { coverInvalidationListeners.delete(invalidate); };
  }, []);
  useEffect(() => {
    if (!enabled || !templateSupportsRealCover(template.layout)) return;
    const key = cacheKeyOf(template.id, locale);
    const cached = coverCache.get(key);
    if (cached) {
      setUrl(cached.url);
      return;
    }
    setUrl(undefined);
    const element = containerRef.current;
    // 无 IntersectionObserver 环境(测试/旧内核):直接排队,行为等同"可见"。
    if (!element || typeof IntersectionObserver === "undefined") {
      void requestTemplateCover(template, locale).then((entry) => {
        if (mountedRef.current && entry) setUrl(entry.url);
      });
      return;
    }
    let cancelled = false;
    const observer = new IntersectionObserver((entries) => {
      if (cancelled || !entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void requestTemplateCover(template, locale).then((entry) => {
        if (!cancelled && mountedRef.current && entry) setUrl(entry.url);
      });
    }, { rootMargin: "320px" });
    observer.observe(element);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [template, locale, containerRef, enabled, themeEpoch]);
  return url;
}
