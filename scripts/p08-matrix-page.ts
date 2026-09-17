// P0-08 像素矩阵 Web 宿主（浏览器入口，由 scripts/run-p08-pixel-matrix.mts 用 esbuild 打包）。
// 复用 C1 宿主装配（DashboardCandidateController + composition host + chartFrame），按
// /fixtures.json 清单连续 publish 各矩阵格 fixture，publish 后同步 readback（已提交帧只在当前任务内可拷贝）。
// fixture 为磁盘上 rehash 过的完整 JSON（与 Native 读同一字节），页面不做任何改写。
// 验证宿主非产品入口；产品 C1 宿主装配未在此实现。
import { DeviceSession } from "../packages/deep-engine/src/webgpu/deviceSession.js";
import { BackendCanvasDeck, type BackendCanvasHost, type BackendCanvasSurface } from "../packages/deep-engine/src/threeBridge/BackendCanvasDeck.js";
import { createDashboardCompositionGpuHost } from "../packages/deep-engine/src/webgpu/dashboardCompositionHost.js";
import { DashboardCandidateController } from "../packages/deep-engine/src/runtimePackage/dashboardCandidateController.js";
import { chartFrame } from "../apps/web/src/delivery/dashboardChartFrame.js";

const SURFACE_WIDTH = 960, SURFACE_HEIGHT = 540, DEVICE_EPOCH = 1;

interface CellResult {
  id: string;
  ok: boolean;
  stage: string;
  message?: string;
  packageHash?: string;
  pageId?: string;
  pngDataUrl?: string;
  coloredPixels?: number;
  totalPixels?: number;
}
interface P08Success {
  ok: true;
  adapter: Readonly<{ vendor: string; architecture: string; device: string; description: string; isFallbackAdapter: boolean }> | null;
  canvasFormat: string;
  renderTargetFormat: string;
  cells: CellResult[];
}
interface P08Failure { ok: false; stage: string; message: string; stack?: string }
export type P08Result = P08Success | P08Failure;
declare global { interface Window { __P08_RESULT?: P08Result } }

class P08CanvasHost implements BackendCanvasHost {
  readonly token = Symbol("p08-deck-host");
  constructor(private readonly container: HTMLDivElement) {}
  ensureGridLayout(): void { this.container.style.display = "grid"; }
  createCanvas(): BackendCanvasSurface { return new P08Surface(document.createElement("canvas")); }
  append(surface: BackendCanvasSurface): void { this.container.appendChild(surface.native as HTMLCanvasElement); }
}
class P08Surface implements BackendCanvasSurface {
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

/** publish 后同步读回当前活动 canvas：2d drawImage + getImageData，统计彩色像素并转 PNG data URL。 */
function readback(deck: BackendCanvasDeck): { pngDataUrl: string; coloredPixels: number; totalPixels: number } {
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
  return { pngDataUrl: capture.toDataURL("image/png"), coloredPixels: colored, totalPixels: capture.width * capture.height };
}

async function run(): Promise<P08Result> {
  let stage = "webgpu-probe";
  try {
    const gpu = navigator.gpu;
    if (!gpu) throw new Error("WebGPU is unavailable in this browser (navigator.gpu is undefined).");
    stage = "fetch-manifest";
    const manifest = await (await fetch("/fixtures.json")).json() as { id: string }[];
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
      const initial = new P08Surface(document.createElement("canvas"));
      initial.width = SURFACE_WIDTH; initial.height = SURFACE_HEIGHT;
      const deck = new BackendCanvasDeck(new P08CanvasHost(container), "deep-dashboard-initial", initial);
      const { host, loader } = createDashboardCompositionGpuHost({
        deck, session, width: SURFACE_WIDTH, height: SURFACE_HEIGHT,
        deviceEpoch: () => DEVICE_EPOCH, chartFrame,
      });
      const controller = new DashboardCandidateController(loader, host);
      stage = "cells";
      const cells: CellResult[] = [];
      for (const entry of manifest) {
        const cellStage = `publish:${entry.id}`;
        try {
          const fixture = await (await fetch(`/fixture/${entry.id}.json`)).json();
          const published = await controller.publish(fixture, { deviceEpoch: DEVICE_EPOCH });
          if (published.status !== "committed") {
            throw new Error(`publish status=${published.status} failure=${published.failure ?? "-"}`
              + ` releaseFailures=${JSON.stringify(published.releaseFailures)}`);
          }
          const frame = readback(deck);
          cells.push({
            id: entry.id, ok: true, stage: "committed",
            packageHash: published.identity.packageHash, pageId: published.identity.pageId,
            pngDataUrl: frame.pngDataUrl, coloredPixels: frame.coloredPixels, totalPixels: frame.totalPixels,
          });
        } catch (error) {
          cells.push({ id: entry.id, ok: false, stage: cellStage,
            message: error instanceof Error ? error.message : String(error) });
        }
      }
      stage = "dispose";
      controller.dispose();
      return { ok: true, adapter: session.adapterInfo ?? null, canvasFormat: session.format,
        renderTargetFormat: session.format === "rgba8unorm" ? "rgba8unorm-srgb" : "bgra8unorm-srgb", cells };
    } finally { session.dispose(); }
  } catch (error) {
    return { ok: false, stage, message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined };
  }
}

void run().then((result) => { window.__P08_RESULT = result; });
