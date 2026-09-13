/// <reference types="@webgpu/types" />
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";

export interface PartialLodSurfaceEvidence {
  readonly width: number;
  readonly height: number;
  readonly redPixels: number;
  readonly redCentroidX: number | null;
  readonly redCentroidY: number | null;
  readonly peakRgba: readonly [number, number, number, number];
  readonly checksum: string;
}

/** Reads the real presentable texture and isolates the probe's emissive-red mesh. */
export async function readPartialLodSurface(
  session: DeviceSession,
  canvas: HTMLCanvasElement,
): Promise<PartialLodSurfaceEvidence> {
  const width = canvas.width, height = canvas.height;
  if (width < 1 || height < 1) throw new Error("Partial LOD probe surface is empty.");
  const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
  const buffer = session.device.createBuffer({ label: "Deep partial LOD surface readback",
    size: bytesPerRow * height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = session.device.createCommandEncoder({ label: "Deep partial LOD surface copy" });
    encoder.copyTextureToBuffer({ texture: session.context.getCurrentTexture() },
      { buffer, bytesPerRow, rowsPerImage: height }, [width, height]);
    session.device.queue.submit([encoder.finish()]);
    await buffer.mapAsync(GPUMapMode.READ);
    const bytes = new Uint8Array(buffer.getMappedRange());
    const bgra = session.format.startsWith("bgra");
    let redPixels = 0, weightedX = 0, weightedY = 0, peakScore = -Infinity;
    let peak: [number, number, number, number] = [0, 0, 0, 0], hash = 0x811c9dc5;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const offset = y * bytesPerRow + x * 4;
      const r = bytes[offset + (bgra ? 2 : 0)]!, g = bytes[offset + 1]!;
      const b = bytes[offset + (bgra ? 0 : 2)]!, a = bytes[offset + 3]!;
      for (const value of [r, g, b, a]) hash = Math.imul(hash ^ value, 0x01000193);
      const score = r - Math.max(g, b);
      if (score > peakScore) { peakScore = score; peak = [r, g, b, a]; }
      if (r >= 96 && r - g >= 48 && r - b >= 48) {
        redPixels++; weightedX += x; weightedY += y;
      }
    }
    buffer.unmap();
    return Object.freeze({ width, height, redPixels,
      redCentroidX: redPixels ? weightedX / redPixels / width : null,
      redCentroidY: redPixels ? weightedY / redPixels / height : null,
      peakRgba: Object.freeze(peak), checksum: (hash >>> 0).toString(16).padStart(8, "0") });
  } finally {
    if (buffer.mapState === "mapped") buffer.unmap();
    buffer.destroy();
  }
}
