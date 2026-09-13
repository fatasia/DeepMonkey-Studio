/// <reference types="@webgpu/types" />
import { GpuSkinner, type DeviceSession, type SkinningPalette, type SkinningSource } from "@bim-studio/deep-engine/webgpu";

export interface GpuSkinningProbeResult {
  readonly action: "gpu-skinning-compute";
  readonly success: boolean;
  readonly initialPosition: readonly number[];
  readonly updatedPosition: readonly number[];
  readonly normal: readonly number[];
  readonly paletteBufferReused: boolean;
  readonly deviceError?: string;
}

/** Runs source upload, compute deformation, palette swap and exact buffer readback on the active device. */
export async function runGpuSkinningProbe(session: DeviceSession): Promise<GpuSkinningProbeResult> {
  if (session.state !== "ready") throw new Error("GPU skinning probe requires a ready device session.");
  const device = session.device, skinner = new GpuSkinner(session);
  const readback = session.own(device.createBuffer({ label: "Deep GPU skinning probe readback", size: 32,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const source: SkinningSource = { revision: 0, positions: new Float32Array([1, 0, 0]), normals: new Float32Array([1, 0, 0]),
    joints: new Uint16Array([0, 0, 0, 0]), weights: new Float32Array([1, 0, 0, 0]) };
  device.pushErrorScope("validation");
  try {
    skinner.setSource(source, palette(0, 2));
    const initialPosition = await execute(device, skinner, readback);
    const resourceCount = session.resourceCount;
    skinner.updatePalette(palette(1, 4));
    const paletteBufferReused = session.resourceCount === resourceCount;
    const updatedPosition = await execute(device, skinner, readback);
    const error = await device.popErrorScope();
    if (error) return Object.freeze({ action: "gpu-skinning-compute", success: false, initialPosition: [], updatedPosition: [],
      normal: [], paletteBufferReused, deviceError: error.message });
    const normal = updatedPosition.slice(4, 7);
    const success = close(initialPosition.slice(0, 3), [3, 0, 0]) && close(updatedPosition.slice(0, 3), [5, 0, 0])
      && close(normal, [1, 0, 0]) && paletteBufferReused;
    return Object.freeze({ action: "gpu-skinning-compute", success, initialPosition: initialPosition.slice(0, 3),
      updatedPosition: updatedPosition.slice(0, 3), normal, paletteBufferReused });
  } catch (error) {
    const scoped = await device.popErrorScope().catch(() => null);
    return Object.freeze({ action: "gpu-skinning-compute", success: false, initialPosition: [], updatedPosition: [], normal: [],
      paletteBufferReused: false, deviceError: scoped?.message ?? (error instanceof Error ? error.message : String(error)) });
  } finally {
    skinner.dispose(); session.release(readback);
  }
}

async function execute(device: GPUDevice, skinner: GpuSkinner, readback: GPUBuffer): Promise<number[]> {
  const encoder = device.createCommandEncoder({ label: "Deep GPU skinning probe" }), result = skinner.encode(encoder);
  encoder.copyBufferToBuffer(result.output, 0, readback, 0, 32);
  device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
  const values = [...new Float32Array(readback.getMappedRange().slice(0))]; readback.unmap(); return values;
}
function palette(revision: number, translation: number): SkinningPalette {
  return { revision, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, translation, 0, 0, 1]) };
}
function close(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) < 1e-5);
}
