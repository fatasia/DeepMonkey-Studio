import type * as THREE from "three";
import { PostProcessingRuntime } from "./postProcessingRuntime";

/** Three 的 SMAA 内置 LUT 用真正的可上传 CanvasImageSource，Worker 不伪造 HTMLImageElement。 */
export async function createOffscreenPostProcessing(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera): Promise<PostProcessingRuntime> {
  const pending: Promise<void>[] = [];
  class WorkerLutImage extends OffscreenCanvas {
    onload: (() => void) | undefined;
    constructor() { super(1, 1); }
    set src(value: string) {
      pending.push((async () => {
        if (!value.startsWith("data:image/")) throw new Error("Unexpected SMAA image source");
        const bitmap = await createImageBitmap(await (await fetch(value)).blob(), { colorSpaceConversion: "none" });
        try {
          this.width = bitmap.width; this.height = bitmap.height;
          const context = this.getContext("2d"); if (!context) throw new Error("SMAA lookup canvas unavailable");
          context.drawImage(bitmap, 0, 0); this.onload?.();
        } finally { bitmap.close(); }
      })());
    }
  }
  const globals = globalThis as unknown as Record<string, unknown>;
  const previousImage = globals.Image; const previousWindow = globals.window;
  let runtime: PostProcessingRuntime | undefined;
  try {
    // 仅构造期适配第三方的 Image 与 Afterimage 初始视口；不改变主线程或任何 prototype。
    globals.Image = WorkerLutImage; globals.window = { innerWidth: 1, innerHeight: 1 };
    runtime = new PostProcessingRuntime(renderer, scene, camera);
  } finally {
    if (previousImage === undefined) delete globals.Image; else globals.Image = previousImage;
    if (previousWindow === undefined) delete globals.window; else globals.window = previousWindow;
  }
  try { await Promise.all(pending); return runtime; } catch (error) { runtime.dispose(); throw error; }
}
