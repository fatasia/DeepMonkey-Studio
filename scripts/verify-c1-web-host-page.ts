// C1 验证宿主（浏览器入口，由 scripts/verify-c1-web-host.mts 用 esbuild 打包）。
// 在真实 WebGPU 上经 DashboardCandidateController + composition host 渲染 dashboard runtime
// package 一帧并读回像素。验证宿主非产品入口；产品 C1 宿主装配（web 应用路由/事务 deck swap）未在此实现。
import { DeviceSession } from "../packages/deep-engine/src/webgpu/deviceSession.js";
import { BackendCanvasDeck, type BackendCanvasHost, type BackendCanvasSurface } from "../packages/deep-engine/src/threeBridge/BackendCanvasDeck.js";
import { createDashboardCompositionGpuHost } from "../packages/deep-engine/src/webgpu/dashboardCompositionHost.js";
import { DashboardCandidateController } from "../packages/deep-engine/src/runtimePackage/dashboardCandidateController.js";
import { chartFrame } from "../apps/web/src/delivery/dashboardChartFrame.js";

const SURFACE_WIDTH = 960, SURFACE_HEIGHT = 540, DEVICE_EPOCH = 1;
const bypassedChartFrames: string[] = [];
const skippedChartSeries: string[] = [];
/** Web deep2d 扫描线三角化（fillRings）对扇形/圆弧环存在奇数 crossing 缺口，pie/gauge 暂不可渲染。 */
const GPU_SUPPORTED_SERIES = new Set(["line", "bar", "scatter", "heatmap"]);

/**
 * fixture 必须原样进 controller（packageHash 有内容校验），适配只作用于克隆的 ChartIR：
 * 1) 产品静态 chartFrame 拒绝初始 dataZoom/actions（Native 渲染交互初态应用后的几何）；
 * 2) pie/gauge 扇形几何触发 Web 三角化 "Invalid Deep2D polygon crossings"（生产缺口，见汇报）。
 * 两类差异如实上报，归 P0-08 像素矩阵追因，本片不做阈值判定。
 */
const adaptedChartFrame: typeof chartFrame = async (candidate, signal) => {
  try { return await chartFrame(candidate, signal); } catch (error) {
    const text = String(error);
    if (!candidate.chart || !(text.includes("initial dataZoom or actions") || text.includes("polygon crossings"))) throw error;
    bypassedChartFrames.push(candidate.node.id);
    const ir = structuredClone(candidate.chart.ir);
    ir.actions = []; ir.dataZoom = [];
    const series = ir.series.filter(item => {
      if (GPU_SUPPORTED_SERIES.has(item.type)) return true;
      skippedChartSeries.push(`${candidate.node.id}/${item.id}:${item.type}`);
      return false;
    });
    return chartFrame({ ...candidate, chart: { ...candidate.chart, ir: { ...ir, series } } }, signal);
  }
}

interface C1Success {
  ok: true;
  adapter: Readonly<{ vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean }> | null;
  canvasFormat: string;
  renderTargetFormat: string;
  width: number;
  height: number;
  pageColoredPixels: number;
  totalPixels: number;
  identity: unknown;
  releaseFailures: string[];
  bypassedChartFrames: string[];
  skippedChartSeries: string[];
  pngDataUrl: string;
}
interface C1Failure { ok: false; stage: string; message: string; stack?: string }
export type C1Result = C1Success | C1Failure;
declare global { interface Window { __C1_RESULT?: C1Result } }

/** deck 的 reserve/publish 只需要创建、附加与样式快照恢复；表面容器整体移出视口。 */
class C1CanvasHost implements BackendCanvasHost {
  readonly token = Symbol("c1-deck-host");
  constructor(private readonly container: HTMLDivElement) {}
  ensureGridLayout(): void { this.container.style.display = "grid"; }
  createCanvas(): BackendCanvasSurface { return new C1Surface(document.createElement("canvas")); }
  append(surface: BackendCanvasSurface): void { this.container.appendChild(surface.native as HTMLCanvasElement); }
}

class C1Surface implements BackendCanvasSurface {
  constructor(readonly native: HTMLCanvasElement) {}
  get width(): number { return this.native.width; }
  set width(value: number) { this.native.width = value; }
  get height(): number { return this.native.height; }
  set height(value: number) { this.native.height = value; }
  get parentToken(): unknown { return null; }
  getStyle(name: string): string { return this.native.style.getPropertyValue(name); }
  setStyle(name: string, value: string): void { this.native.style.setProperty(name, value); }
  getAttribute(name: string): string | null { return this.native.getAttribute(name); }
  setAttribute(name: string, value: string): void { this.native.setAttribute(name, value); }
  removeAttribute(name: string): void { this.native.removeAttribute(name); }
  remove(): void { this.native.remove(); }
}

async function run(): Promise<C1Result> {
  let stage = "webgpu-probe";
  try {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error("WebGPU is unavailable in this browser (navigator.gpu is undefined).");
    stage = "fetch-fixture";
    const response = await fetch("/fixture.json");
    if (!response.ok) throw new Error(`fixture fetch failed: HTTP ${response.status}`);
    const fixture = await response.json();
    stage = "device-session";
    const sessionCanvas = document.createElement("canvas");
    sessionCanvas.width = 4; sessionCanvas.height = 4;
    sessionCanvas.style.cssText = "position:fixed;left:-10000px;top:0;";
    document.body.appendChild(sessionCanvas);
    const session = await DeviceSession.open(sessionCanvas, gpu, new AbortController().signal);
    try {
      stage = "canvas-deck";
      const container = document.createElement("div");
      container.style.cssText = `position:fixed;left:-10000px;top:0;width:${SURFACE_WIDTH}px;height:${SURFACE_HEIGHT}px;overflow:hidden;`;
      document.body.appendChild(container);
      const initial = new C1Surface(document.createElement("canvas"));
      initial.width = SURFACE_WIDTH; initial.height = SURFACE_HEIGHT;
      const deck = new BackendCanvasDeck(new C1CanvasHost(container), "deep-dashboard-initial", initial);
      stage = "composition-host";
      const { host, loader } = createDashboardCompositionGpuHost({
        deck, session, width: SURFACE_WIDTH, height: SURFACE_HEIGHT,
        deviceEpoch: () => DEVICE_EPOCH, chartFrame: adaptedChartFrame,
      });
      const controller = new DashboardCandidateController(loader, host);
      stage = "publish";
      const published = await controller.publish(fixture, { deviceEpoch: DEVICE_EPOCH });
      if (published.status !== "committed") {
        throw new Error(`publish status=${published.status} failure=${published.failure ?? "-"}`
          + ` releaseFailures=${JSON.stringify(published.releaseFailures)}`);
      }
      stage = "readback";
      // WebGPU canvas 的已提交帧内容只在当前任务内可拷贝，必须在 publish 后同步读出。
      const source = deck.active!.canvas.native as HTMLCanvasElement;
      const capture = document.createElement("canvas");
      capture.width = source.width; capture.height = source.height;
      const context2d = capture.getContext("2d", { willReadFrequently: true });
      if (!context2d) throw new Error("2d readback context is unavailable.");
      context2d.drawImage(source, 0, 0);
      const image = context2d.getImageData(0, 0, capture.width, capture.height);
      let colored = 0;
      for (let offset = 0; offset < image.data.length; offset += 4) {
        if (image.data[offset] || image.data[offset + 1] || image.data[offset + 2]) colored += 1;
      }
      const pngDataUrl = capture.toDataURL("image/png");
      stage = "dispose";
      controller.dispose();
      return { ok: true, adapter: session.adapterInfo ?? null, canvasFormat: session.format,
        renderTargetFormat: session.format === "rgba8unorm" ? "rgba8unorm-srgb" : "bgra8unorm-srgb",
        width: capture.width, height: capture.height, pageColoredPixels: colored,
        totalPixels: capture.width * capture.height, identity: published.identity,
        releaseFailures: [...published.releaseFailures], bypassedChartFrames: [...bypassedChartFrames],
        skippedChartSeries: [...skippedChartSeries], pngDataUrl };
    } finally { session.dispose(); }
  } catch (error) {
    return { ok: false, stage, message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined };
  }
}

void run().then((result) => { window.__C1_RESULT = result; });
