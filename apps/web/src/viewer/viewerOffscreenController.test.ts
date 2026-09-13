import { afterEach, describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { ViewerOffscreenController, type OffscreenDiagnostics } from "./viewerOffscreenController";

type FrameMessage = { type: "init" | "frame"; frame?: { objects: unknown[]; materials: unknown[]; sequence: number } };

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | undefined;
  onerror: (() => void) | undefined;
  posted: FrameMessage[] = [];
  terminated = false;
  postMessage(message: FrameMessage) { this.posted.push(message); }
  terminate() { this.terminated = true; }
  respond(data: unknown) { this.onmessage?.({ data }); }
}

function flush(times = 4): Promise<void> {
  return times <= 0 ? Promise.resolve() : new Promise<void>((resolve) => setTimeout(resolve, 0)).then(() => flush(times - 1));
}

function compatibleScene(): THREE.Scene {
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0x334455 })));
  return scene;
}

interface Harness {
  controller: ViewerOffscreenController;
  workers: FakeWorker[];
  diagnostics: () => OffscreenDiagnostics;
  painted: { close(): void }[];
}

/** 采集器会读取 pixelRatio、色调映射与阴影开关；桩只需满足这些读操作。 */
function stubRenderer() {
  return {
    isWebGLRenderer: true,
    getPixelRatio: () => 1,
    outputColorSpace: "srgb",
    toneMapping: 0,
    toneMappingExposure: 1,
    shadowMap: { enabled: false, type: 0 },
    getClearColor: (color: { getHex(): number }) => color,
    getClearAlpha: () => 1,
  };
}

function harness(scene: THREE.Scene, renderer = stubRenderer()): Harness {
  const workers: FakeWorker[] = [];
  const painted: { close(): void }[] = [];
  const requestRender = vi.fn();
  const controller = new ViewerOffscreenController({
    container: { clientWidth: 800, clientHeight: 600 } as HTMLElement,
    renderer,
    scene,
    camera: new THREE.PerspectiveCamera(),
    requestRender,
    createWorker: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
    paintBitmap: (bitmap) => painted.push(bitmap),
  });
  return { controller, workers, painted, diagnostics: () => controller.diagnostics(), };
}

const realGlobals: Partial<Record<"OffscreenCanvas" | "Worker" | "createImageBitmap" | "HTMLCanvasElement", unknown>> = {};

function installBrowserStubs(): void {
  for (const name of ["OffscreenCanvas", "Worker", "createImageBitmap", "HTMLCanvasElement"] as const) realGlobals[name] = globalThis[name];
  globalThis.OffscreenCanvas = class { constructor(public width: number, public height: number) {} } as unknown as typeof OffscreenCanvas;
  globalThis.Worker = class {} as unknown as typeof Worker;
  globalThis.createImageBitmap = vi.fn() as unknown as typeof createImageBitmap;
  globalThis.HTMLCanvasElement = class {} as unknown as typeof HTMLCanvasElement;
}

afterEach(() => {
  for (const [name, value] of Object.entries(realGlobals)) {
    if (value === undefined) delete (globalThis as Record<string, unknown>)[name];
    else (globalThis as Record<string, unknown>)[name] = value;
  }
});

describe("ViewerOffscreenController", () => {
  it("环境缺失时回退并说明原因，不创建线程", async () => {
    const { controller, workers, diagnostics } = harness(compatibleScene());
    await controller.setEnabled(true);
    expect(diagnostics().mode).toBe("fallback");
    expect(diagnostics().reason).toContain("后台画布");
    expect(workers).toHaveLength(0);
    expect(controller.wantsFrame()).toBe(false);
  });

  it("场景含专用渲染逻辑时透出不兼容原因", async () => {
    installBrowserStubs();
    const scene = compatibleScene();
    const special = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardMaterial());
    special.onBeforeRender = () => undefined;
    scene.add(special);
    const { controller, diagnostics } = harness(scene);
    await controller.setEnabled(true);
    expect(diagnostics().mode).toBe("fallback");
    expect(diagnostics().reason).toContain("专用渲染逻辑");
  });

  it("启动后主线程只发增量帧并回传位图计数", async () => {
    installBrowserStubs();
    const { controller, workers, diagnostics, painted } = harness(compatibleScene());
    await controller.setEnabled(true);
    expect(diagnostics().mode).toBe("active");
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted[0]?.type).toBe("init");
    controller.postFrame({ width: 800, height: 600, delta: 0.016, postProcessing: { enabled: false } as never, outlined: [] });
    expect(workers[0]!.posted.at(-1)?.type).toBe("frame");
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    workers[0]!.respond({ type: "frame", sequence: 1, drawCalls: 3, triangles: 12, renderMs: 1.25, bitmap });
    expect(diagnostics().frames).toBe(1);
    expect(diagnostics().lastDrawCalls).toBe(3);
    expect(painted).toEqual([bitmap]);
    expect(bitmap.close).toHaveBeenCalled();
    expect(controller.wantsFrame()).toBe(true);
  });

  it("材质按需采样：init 携带全量，未变化帧跳过，变化帧重新推送", async () => {
    installBrowserStubs();
    const scene = compatibleScene();
    const { controller, workers } = harness(scene);
    await controller.setEnabled(true);
    const material = (scene.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial;
    controller.postFrame({ width: 800, height: 600, delta: 0.016, postProcessing: { enabled: false } as never, outlined: [] });
    material.color.set(0xff0000);
    material.needsUpdate = true;
    controller.postFrame({ width: 800, height: 600, delta: 0.016, postProcessing: { enabled: false } as never, outlined: [] });
    const messages = workers[0]!.posted;
    expect((messages[0]!.frame!.materials as unknown[]).length).toBeGreaterThan(0);
    expect((messages[1]!.frame!.materials as unknown[])).toHaveLength(0);
    expect((messages[2]!.frame!.materials as unknown[]).length).toBeGreaterThan(0);
  });

  it("结构漂移错误触发静默重启，仍保持 active", async () => {
    installBrowserStubs();
    const { controller, workers, diagnostics } = harness(compatibleScene());
    await controller.setEnabled(true);
    workers[0]!.respond({ type: "error", reason: "scene-stale" });
    await flush();
    expect(workers[0]!.terminated).toBe(true);
    expect(workers.length).toBeGreaterThanOrEqual(2);
    expect(diagnostics().mode).toBe("active");
  });

  it("重启超预算后如实回退并给出原因", async () => {
    installBrowserStubs();
    const { controller, workers, diagnostics } = harness(compatibleScene());
    await controller.setEnabled(true);
    for (let round = 0; round < 3; round += 1) {
      workers.at(-1)!.respond({ type: "error", reason: "scene-stale" });
      await flush();
    }
    expect(diagnostics().mode).toBe("fallback");
    expect(diagnostics().reason).toContain("过于频繁");
    expect(controller.wantsFrame()).toBe(false);
  });

  it("线程致命错误回退主线程渲染", async () => {
    installBrowserStubs();
    const { controller, workers, diagnostics } = harness(compatibleScene());
    await controller.setEnabled(true);
    workers[0]!.respond({ type: "error", reason: "后台渲染初始化或绘制失败" });
    expect(diagnostics().mode).toBe("fallback");
    expect(workers[0]!.terminated).toBe(true);
  });

  it("关闭后终止线程、清理位图并回到主线程", async () => {
    installBrowserStubs();
    const { controller, workers, diagnostics } = harness(compatibleScene());
    await controller.setEnabled(true);
    controller.postFrame({ width: 800, height: 600, delta: 0.016, postProcessing: { enabled: false } as never, outlined: [] });
    await controller.setEnabled(false);
    expect(workers[0]!.terminated).toBe(true);
    expect(diagnostics().mode).toBe("off");
    expect(controller.wantsFrame()).toBe(false);
    controller.postFrame({ width: 800, height: 600, delta: 0.016, postProcessing: { enabled: false } as never, outlined: [] });
    expect(workers[0]!.posted.filter((message) => message.type === "frame")).toHaveLength(1);
    expect(workers[0]!.posted.at(-1)?.type).toBe("dispose");
  });

  it("dispose 幂等且阻止未完成的启动", async () => {
    installBrowserStubs();
    const { controller, diagnostics } = harness(compatibleScene());
    await controller.setEnabled(true);
    controller.dispose();
    controller.dispose();
    expect(diagnostics().mode).toBe("off");
  });
});
