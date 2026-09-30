/// <reference types="@webgpu/types" />
import type { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { decodeFurnaceColor } from "../src/webgpu/whiteFurnace.js";

export async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error("Shared scene GPU operation timed out")), 60000); })]); }
  finally { clearTimeout(timer); }
}

/** Uses the existing formal HDR snapshot and actual swapchain surface. */
export async function readSharedDeepFrame(renderer: PbrRenderer, width: number, height: number) {
  const pending = renderer.frameReadbackResults;
  if (!pending) throw Error("Formal production HDR frame capture was not scheduled");
  const session = renderer.session, device = session.device;
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture: session.context.getCurrentTexture() },
      { buffer, bytesPerRow }, { width, height }); device.queue.submit([encoder.finish()]);
    const [snapshots] = await Promise.all([bounded(pending), bounded(buffer.mapAsync(GPUMapMode.READ))]);
    const hdr = snapshots.find(isPbrFrameReadbackSnapshot);
    if (!hdr || hdr.width !== width || hdr.height !== height) throw Error("Formal production HDR frame readback missing or wrong extent");
    const bytes = new Uint8Array(buffer.getMappedRange()), display = new Uint8Array(width * height * 4);
    if (session.format !== "bgra8unorm" && session.format !== "rgba8unorm") throw Error(`Unsupported actual surface format ${session.format}`);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const from = y * bytesPerRow + x * 4, to = (y * width + x) * 4;
      display[to] = bytes[from + (session.format === "bgra8unorm" ? 2 : 0)]!; display[to + 1] = bytes[from + 1]!;
      display[to + 2] = bytes[from + (session.format === "bgra8unorm" ? 0 : 2)]!; display[to + 3] = bytes[from + 3]!;
    }
    buffer.unmap(); return { hdr: Array.from(decodeFurnaceColor(hdr)), display: Array.from(display) };
  } finally { buffer.destroy(); }
}
