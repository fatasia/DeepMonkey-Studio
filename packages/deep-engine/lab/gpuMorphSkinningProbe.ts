/// <reference types="@webgpu/types" />
import type { MorphPrimitiveSource } from "@bim-studio/deep-engine";
import { GpuMorphSkinner, type DeviceSession, type GpuMorphSource, type GpuMorphWeights,
  type MorphSkinningDynamics, type MorphSkinningSources, type SkinningPalette,
  type SkinningSource } from "@bim-studio/deep-engine/webgpu";

export interface GpuMorphSkinningProbeResult {
  readonly action: "gpu-fused-morph-skinning"; readonly success: boolean;
  readonly initialPosition: readonly number[]; readonly updatedPosition: readonly number[];
  readonly normal: readonly number[]; readonly tangent: readonly number[];
  readonly dynamicBuffersReused: boolean; readonly deviceError?: string;
}

/** Runs a real fused morph-then-skin dispatch, atomic dynamic swap, and GPU readback. */
export async function runGpuMorphSkinningProbe(session: DeviceSession): Promise<GpuMorphSkinningProbeResult> {
  if (session.state !== "ready") throw new Error("Fused morph skinning probe requires a ready device session.");
  const device = session.device, deformer = new GpuMorphSkinner(session);
  const readback = session.own(device.createBuffer({ label: "Deep fused deformation probe readback", size: 48,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  device.pushErrorScope("validation");
  try {
    const source = probeSources(); deformer.setSource(source, probeDynamics(0, [0.5, 0.25], scaledPalette(0)));
    const initial = await execute(device, deformer, readback), resourceCount = session.resourceCount;
    deformer.updateDynamics(probeDynamics(1, [0, 1], identityPalette(1)));
    const dynamicBuffersReused = session.resourceCount === resourceCount, updated = await execute(device, deformer, readback);
    const error = await device.popErrorScope(); if (error) return failed(dynamicBuffersReused, error.message);
    const success = close(initial.slice(0, 3), [14, 2, 0]) && close(updated.slice(0, 3), [1, 4, 0])
      && close(updated.slice(4, 7), [0, 0, 1]) && close(updated.slice(8, 12), [1, 0, 0, -1]) && dynamicBuffersReused;
    return Object.freeze({ action: "gpu-fused-morph-skinning", success, initialPosition: initial.slice(0, 3),
      updatedPosition: updated.slice(0, 3), normal: updated.slice(4, 7), tangent: updated.slice(8, 12), dynamicBuffersReused });
  } catch (error) {
    const scoped = await device.popErrorScope().catch(() => null);
    return failed(false, scoped?.message ?? (error instanceof Error ? error.message : String(error)));
  } finally { deformer.dispose(); session.release(readback); }
}

async function execute(device: GPUDevice, deformer: GpuMorphSkinner, readback: GPUBuffer): Promise<number[]> {
  const encoder = device.createCommandEncoder({ label: "Deep fused deformation probe" }), result = deformer.encode(encoder);
  encoder.copyBufferToBuffer(result.output, 0, readback, 0, 48); device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone(); await readback.mapAsync(GPUMapMode.READ);
  const values = [...new Float32Array(readback.getMappedRange().slice(0))]; readback.unmap(); return values;
}
function probeSources(): MorphSkinningSources {
  const primitive: MorphPrimitiveSource = { id: "fused-probe", sourceMeshIndex: 0, sourcePrimitiveIndex: 0, vertexCount: 1, targets: [
    { index: 0, name: "raise", positionDeltas: new Float32Array([2, 0, 0]), normalDeltas: new Float32Array([0, 1, 0]),
      tangentDeltas: new Float32Array([0, 1, 0]) }, { index: 1, name: "slide", positionDeltas: new Float32Array([0, 4, 0]) },
  ] };
  const morph: GpuMorphSource = { revision: 0, primitive, positions: new Float32Array([1, 0, 0]),
    normals: new Float32Array([0, 0, 1]), tangents: new Float32Array([1, 0, 0, -1]) };
  const skinning: SkinningSource = { revision: 0, positions: new Float32Array([1, 0, 0]), normals: new Float32Array([0, 0, 1]),
    joints: new Uint16Array([0, 0, 0, 0]), weights: new Float32Array([1, 0, 0, 0]) };
  return { morph, skinning };
}
function probeDynamics(revision: number, values: readonly number[], palette: SkinningPalette): MorphSkinningDynamics {
  const morphWeights: GpuMorphWeights = { revision, values: new Float32Array(values) }; return { morphWeights, palette };
}
function scaledPalette(revision: number): SkinningPalette { return { revision, matrices: new Float32Array([
  2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 10, 0, 0, 1,
]) }; }
function identityPalette(revision: number): SkinningPalette { return { revision, matrices: new Float32Array([
  1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
]) }; }
function failed(dynamicBuffersReused: boolean, deviceError: string): GpuMorphSkinningProbeResult {
  return Object.freeze({ action: "gpu-fused-morph-skinning", success: false, initialPosition: [], updatedPosition: [], normal: [], tangent: [],
    dynamicBuffersReused, deviceError });
}
function close(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]!) < 1e-5);
}
