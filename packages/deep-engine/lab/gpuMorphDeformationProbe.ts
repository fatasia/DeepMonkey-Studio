/// <reference types="@webgpu/types" />
import type { MorphPrimitiveSource } from "@bim-studio/deep-engine";
import { GpuMorphDeformer, type DeviceSession, type GpuMorphSource,
  type GpuMorphWeights } from "@bim-studio/deep-engine/webgpu";

export interface GpuMorphDeformationProbeResult {
  readonly action: "gpu-morph-deformation-compute";
  readonly success: boolean;
  readonly initialPosition: readonly number[];
  readonly updatedPosition: readonly number[];
  readonly updatedNormal: readonly number[];
  readonly updatedTangent: readonly number[];
  readonly weightBuffersReused: boolean;
  readonly deviceError?: string;
}

/** Runs real source upload, morph compute, weight swap and exact GPU readback on the active device. */
export async function runGpuMorphDeformationProbe(session: DeviceSession): Promise<GpuMorphDeformationProbeResult> {
  if (session.state !== "ready") throw new Error("GPU morph probe requires a ready device session.");
  const device = session.device, deformer = new GpuMorphDeformer(session);
  const readback = session.own(device.createBuffer({ label: "Deep GPU morph probe readback", size: 48,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  device.pushErrorScope("validation");
  try {
    deformer.setSource(probeSource(), probeWeights(0, [0.5, 0.25]));
    const initial = await execute(device, deformer, readback), resourceCount = session.resourceCount;
    deformer.updateWeights(probeWeights(1, [0, 1]));
    const weightBuffersReused = session.resourceCount === resourceCount, updated = await execute(device, deformer, readback);
    const error = await device.popErrorScope();
    if (error) return failed(weightBuffersReused, error.message);
    const success = close(initial.slice(0, 3), [2, 1, 0]) && close(updated.slice(0, 3), [1, 4, 0])
      && close(updated.slice(4, 7), [0, 0, 1]) && close(updated.slice(8, 12), [1, 0, 0, -1]) && weightBuffersReused;
    return Object.freeze({ action: "gpu-morph-deformation-compute", success, initialPosition: initial.slice(0, 3),
      updatedPosition: updated.slice(0, 3), updatedNormal: updated.slice(4, 7), updatedTangent: updated.slice(8, 12), weightBuffersReused });
  } catch (error) {
    const scoped = await device.popErrorScope().catch(() => null);
    return failed(false, scoped?.message ?? (error instanceof Error ? error.message : String(error)));
  } finally {
    deformer.dispose(); session.release(readback);
  }
}

async function execute(device: GPUDevice, deformer: GpuMorphDeformer, readback: GPUBuffer): Promise<number[]> {
  const encoder = device.createCommandEncoder({ label: "Deep GPU morph probe" }), result = deformer.encode(encoder);
  encoder.copyBufferToBuffer(result.output, 0, readback, 0, 48); device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
  const values = [...new Float32Array(readback.getMappedRange().slice(0))]; readback.unmap(); return values;
}
function probeSource(): GpuMorphSource {
  const primitive: MorphPrimitiveSource = { id: "probe", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1, targets: [
    { index: 0, name: "raise", positionDeltas: new Float32Array([2, 0, 0]), normalDeltas: new Float32Array([0, 1, 0]),
      tangentDeltas: new Float32Array([0, 1, 0]) },
    { index: 1, name: "slide", positionDeltas: new Float32Array([0, 4, 0]) },
  ] };
  return { revision: 0, primitive, positions: new Float32Array([1, 0, 0]), normals: new Float32Array([0, 0, 1]),
    tangents: new Float32Array([1, 0, 0, -1]) };
}
function probeWeights(revision: number, values: readonly number[]): GpuMorphWeights {
  return { revision, values: new Float32Array(values) };
}
function failed(weightBuffersReused: boolean, deviceError: string): GpuMorphDeformationProbeResult {
  return Object.freeze({ action: "gpu-morph-deformation-compute", success: false, initialPosition: [], updatedPosition: [],
    updatedNormal: [], updatedTangent: [], weightBuffersReused, deviceError });
}
function close(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) < 1e-5);
}
