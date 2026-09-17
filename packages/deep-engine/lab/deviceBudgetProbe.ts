import { DeviceSession } from "../src/webgpu/deviceSession.js";
import { createAdmittedBuffer, createAdmittedTexture } from "../src/webgpu/resourceAdmission.js";

/** 独立小预算 device：拒绝新候选后，已编码的旧目标仍须可提交并读回。 */
export async function verifyDeviceBudget() {
  const canvas = document.createElement("canvas");
  const session = await DeviceSession.open(canvas, navigator.gpu, new AbortController().signal, 20);
  const device = session.device;
  let scopeOpen = true;
  device.pushErrorScope("validation");
  try {
    const active = createAdmittedTexture(session, { size: [4, 1], format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    const readback = createAdmittedBuffer(session, { size: 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: active.createView(),
      clearValue: { r: 0.2, g: 0.4, b: 0.6, a: 1 }, loadOp: "clear", storeOp: "store" }] });
    pass.end();
    let rejected = false, unknownRejected = false;
    try { createAdmittedBuffer(session, { size: 4, usage: GPUBufferUsage.COPY_DST }); }
    catch (error) { rejected = String(error).includes("ownership budget exceeded"); }
    try { createAdmittedTexture(session, { size: [1], format: "depth24plus", usage: GPUTextureUsage.RENDER_ATTACHMENT }); }
    catch (error) { unknownRejected = String(error).includes("known resource sizes"); }
    encoder.copyTextureToBuffer({ texture: active }, { buffer: readback }, [1, 1]);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const pixel = [...new Uint8Array(readback.getMappedRange()).slice(0, 4)]; readback.unmap();
    const peak = session.resourceMemory;
    session.release(active); session.release(readback);
    const retry = createAdmittedBuffer(session, { size: 20, usage: GPUBufferUsage.COPY_DST });
    const recovered = session.resourceMemory; session.release(retry);
    const pendingError = device.popErrorScope(); scopeOpen = false;
    const validationError = await pendingError;
    return { action: "device-budget", success: rejected && unknownRejected && pixel.join(",") === "51,102,153,255"
      && peak.estimatedBytes === 20 && peak.peakEstimatedBytes === 20 && recovered.estimatedBytes === 20
      && session.resourceMemory.estimatedBytes === 0 && !validationError,
    pixel, rejected, unknownRejected, peak, recovered, afterRelease: session.resourceMemory,
    validationError: validationError?.message ?? null };
  } finally {
    if (scopeOpen) await device.popErrorScope();
    session.dispose();
  }
}
