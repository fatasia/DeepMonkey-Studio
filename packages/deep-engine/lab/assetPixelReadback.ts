/// <reference types="@webgpu/types" />
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";

export interface SurfacePixels {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
  readonly checksum: string;
}

/** Copies the actual presentation texture, removes row padding and normalizes BGRA to RGBA. */
export async function readPresentationPixels(
  session: DeviceSession,
  canvas: HTMLCanvasElement,
): Promise<SurfacePixels> {
  const width = canvas.width, height = canvas.height;
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("Asset pixel probe surface is empty.");
  }
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = session.device.createBuffer({
    label: "Deep real-asset presentation readback",
    size: bytesPerRow * height,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });
  try {
    const encoder = session.device.createCommandEncoder({ label: "Deep real-asset presentation copy" });
    encoder.copyTextureToBuffer(
      { texture: session.context.getCurrentTexture() },
      { buffer, bytesPerRow, rowsPerImage: height },
      [width, height],
    );
    session.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const mapped = new Uint8Array(buffer.getMappedRange()), rgba = new Uint8Array(width * height * 4);
    const bgra = session.format.startsWith("bgra");
    let hash = 0x811c9dc5;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const source = y * bytesPerRow + x * 4, target = (y * width + x) * 4;
      rgba[target] = mapped[source + (bgra ? 2 : 0)]!;
      rgba[target + 1] = mapped[source + 1]!;
      rgba[target + 2] = mapped[source + (bgra ? 0 : 2)]!;
      rgba[target + 3] = mapped[source + 3]!;
      for (let channel = 0; channel < 4; channel++) hash = Math.imul(hash ^ rgba[target + channel]!, 0x01000193);
    }
    buffer.unmap();
    return Object.freeze({ width, height, rgba,
      checksum: (hash >>> 0).toString(16).padStart(8, "0") });
  } finally {
    if (buffer.mapState === "mapped") buffer.unmap();
    buffer.destroy();
  }
}
