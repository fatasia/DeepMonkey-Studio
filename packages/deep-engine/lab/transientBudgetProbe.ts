import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { PbrTransientTexturePool } from "../src/webgpu/pbrTransientTexturePool.js";

/** 使用生产池编码并读回，预算故障必须先于 GPU 分配且不损坏已编码帧。 */
export async function verifyTransientBudget(session: DeviceSession) {
  const pool = new PbrTransientTexturePool(session, 64), device = session.device;
  const baselineResources = session.resourceCount;
  const readback = device.createBuffer({ size: 256, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const request = (width: number) => ({ resourceId: "budget-probe", format: "rgba8unorm" as const,
    width, height: 1, sampleCount: 1, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
  const observations: { width: number; pixel: number[]; rejected: boolean }[] = [];
  device.pushErrorScope("validation");
  let scopeOpen = true;
  try {
    for (const width of [4, 8, 12, 16]) {
      pool.beginFrame();
      const handle = pool.acquire(request(width)), encoder = device.createCommandEncoder();
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: handle.view,
        clearValue: { r: 0.2, g: 0.4, b: 0.6, a: 1 }, loadOp: "clear", storeOp: "store" }] });
      pass.end(); pool.release(handle);
      let rejected = false;
      try { pool.acquire(request(17)); } catch (error) { rejected = String(error).includes("budget exceeded"); }
      encoder.copyTextureToBuffer({ texture: handle.texture }, { buffer: readback, bytesPerRow: 256 }, [1, 1]);
      device.queue.submit([encoder.finish()]); pool.endFrame(true);
      await readback.mapAsync(GPUMapMode.READ);
      observations.push({ width, pixel: [...new Uint8Array(readback.getMappedRange()).slice(0, 4)], rejected });
      readback.unmap();
    }
    const pressureStats = pool.stats;
    pool.invalidateAll("surface-resize");
    const afterResize = pool.stats.residentBytes;
    pool.beginFrame(); const rebuilt = pool.acquire(request(16)); pool.release(rebuilt);
    device.queue.submit([]); pool.endFrame(true);
    const rebuiltStats = pool.stats;
    pool.dispose();
    const pendingError = device.popErrorScope(); scopeOpen = false;
    const error = await pendingError;
    return { action: "transient-budget", success: observations.every(item => item.rejected
      && item.pixel.join(",") === "51,102,153,255") && pressureStats.peakResidentBytes <= 64
      && pressureStats.budgetEvictedBytes > 0 && afterResize === 0 && !error
      && session.resourceCount === baselineResources,
    observations, pressureStats, afterResize, rebuiltStats, validationError: error?.message ?? null,
    resourceDeltaAfterDispose: session.resourceCount - baselineResources };
  } finally {
    if (readback.mapState === "mapped") readback.unmap();
    readback.destroy(); pool.dispose();
    if (scopeOpen) await device.popErrorScope();
  }
}
