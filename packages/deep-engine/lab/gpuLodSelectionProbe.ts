/// <reference types="@webgpu/types" />
import {
  GpuLodSelector,
  GPU_LOD_OUTPUT_STRIDE,
  decodeGpuLodRecords,
  packGpuLodScene,
  selectGpuLodReference,
  type DeviceSession,
  type GpuLodReferenceRecord,
} from "@bim-studio/deep-engine/webgpu";

export interface GpuLodSelectionProbeResult {
  readonly objectCount: number;
  readonly recordCount: number;
  readonly peakResourceCount: number;
  readonly initialDesiredLevelOne: number;
  readonly hysteresisHeldLevelOne: number;
  readonly cameraJumpDesiredLevelZero: number;
  readonly residencyFallbacks: number;
  readonly cpuGpuMatched: boolean;
  readonly passed: boolean;
}

/** Real-device CPU/GPU LOD parity probe; intentionally not registered in lab/main.ts. */
export async function runGpuLodSelectionProbe(session: DeviceSession, objectCount = 128): Promise<GpuLodSelectionProbeResult> {
  if (session.state !== "ready") throw new Error("GPU LOD selection probe requires a ready device session.");
  if (!Number.isSafeInteger(objectCount) || objectCount < 1 || objectCount > 524_288) {
    throw new RangeError("GPU LOD selection probe object count is invalid.");
  }
  const device = session.device;
  const packed = packGpuLodScene(Array.from({ length: objectCount }, (_, index) => ({
    bounds: { min: [-1, -1, 9] as const, max: [1, 1, 11] as const }, instanceIndex: 1_000 + index, hysteresisRatio: 0.1,
    levels: [
      { minProjectedDiameterPixels: 45, geometricError: 1, triangles: 1_000, meshletOffset: index * 30, meshletCount: 20, resident: index % 2 === 0 },
      { minProjectedDiameterPixels: 15, geometricError: 2, triangles: 400, meshletOffset: index * 30 + 20, meshletCount: 8, resident: index % 4 !== 1 },
      { minProjectedDiameterPixels: 0, geometricError: 8, triangles: 100, meshletOffset: index * 30 + 28, meshletCount: 2 },
    ],
  })));
  const owned: GPUBuffer[] = [];
  const own = (resource: GPUBuffer): GPUBuffer => { owned.push(session.own(resource)); return resource; };
  const objects = own(device.createBuffer({ label: "Deep GPU LOD probe objects", size: packed.objectData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const levels = own(device.createBuffer({ label: "Deep GPU LOD probe levels", size: packed.levelData.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
  const readback = own(device.createBuffer({ label: "Deep GPU LOD probe readback", size: objectCount * GPU_LOD_OUTPUT_STRIDE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  device.queue.writeBuffer(objects, 0, packed.objectData); device.queue.writeBuffer(levels, 0, packed.levelData);
  const selector = new GpuLodSelector(session, { cameraJumpThreshold: 1 });
  const viewport = { width: 256, height: 256 }, camera = { projection: "perspective" as const,
    position: [0, 0, 0] as const, forward: [0, 0, 1] as const, verticalFovRadians: Math.PI / 2, near: 0.1, far: 100 };
  const input = { objects, levels, count: objectCount, revision: 0 };
  try {
    const firstReference = selectGpuLodReference(packed, camera, viewport);
    const first = await encodeReadback(device, selector, input, { camera, viewport }, readback, objectCount);
    const movedCamera = { ...camera, position: [0, 0, 0.5] as const };
    const heldReference = selectGpuLodReference(packed, movedCamera, viewport, firstReference.nextPreviousLevels, false);
    const held = await encodeReadback(device, selector, input, { camera: movedCamera, viewport }, readback, objectCount);
    const resetReference = selectGpuLodReference(packed, movedCamera, viewport, heldReference.nextPreviousLevels, true);
    const reset = await encodeReadback(device, selector, input, { camera: movedCamera, viewport, cameraJump: true }, readback, objectCount);
    const cpuGpuMatched = recordsMatch(first, firstReference.records) && recordsMatch(held, heldReference.records)
      && recordsMatch(reset, resetReference.records);
    const initialDesiredLevelOne = first.filter(record => record.desiredLevel === 1).length;
    const hysteresisHeldLevelOne = held.filter(record => record.desiredLevel === 1).length;
    const cameraJumpDesiredLevelZero = reset.filter(record => record.desiredLevel === 0).length;
    const residencyFallbacks = reset.filter(record => record.selectedLevel !== null && record.selectedLevel > record.desiredLevel).length;
    const passed = cpuGpuMatched && initialDesiredLevelOne === objectCount && hysteresisHeldLevelOne === objectCount
      && cameraJumpDesiredLevelZero === objectCount && residencyFallbacks === Math.floor(objectCount / 2);
    return Object.freeze({ objectCount, recordCount: reset.length, peakResourceCount: session.resourceCount,
      initialDesiredLevelOne, hysteresisHeldLevelOne,
      cameraJumpDesiredLevelZero, residencyFallbacks, cpuGpuMatched, passed });
  } finally {
    selector.dispose(); for (const resource of owned.reverse()) session.release(resource);
  }
}

async function encodeReadback(device: GPUDevice, selector: GpuLodSelector,
  input: Parameters<GpuLodSelector["encode"]>[1], view: Parameters<GpuLodSelector["encode"]>[2],
  readback: GPUBuffer, count: number): Promise<readonly GpuLodReferenceRecord[]> {
  const encoder = device.createCommandEncoder({ label: "Deep GPU LOD probe frame" });
  const result = selector.encode(encoder, input, view);
  let command: GPUCommandBuffer;
  try {
    encoder.copyBufferToBuffer(result.records, 0, readback, 0, count * GPU_LOD_OUTPUT_STRIDE);
    command = encoder.finish();
  } catch (error) {
    selector.cancel(result); throw error;
  }
  try { device.queue.submit([command]); }
  catch (error) { selector.fail(result); throw error; }
  selector.commit(result); await device.queue.onSubmittedWorkDone();
  await readback.mapAsync(GPUMapMode.READ);
  const copied = readback.getMappedRange().slice(0); readback.unmap();
  return decodeGpuLodRecords(copied, count);
}

function recordsMatch(gpu: readonly GpuLodReferenceRecord[], cpu: readonly GpuLodReferenceRecord[]): boolean {
  if (gpu.length !== cpu.length) return false;
  return gpu.every((actual, index) => {
    const expected = cpu[index]!;
    return actual.baseLevel === expected.baseLevel && actual.desiredLevel === expected.desiredLevel
      && actual.selectedLevel === expected.selectedLevel && actual.instanceIndex === expected.instanceIndex
      && actual.flags === expected.flags && actual.triangles === expected.triangles
      && actual.meshletOffset === expected.meshletOffset && actual.meshletCount === expected.meshletCount
      && close(actual.projectedDiameterPixels, expected.projectedDiameterPixels)
      && close(actual.projectedErrorPixels, expected.projectedErrorPixels)
      && close(actual.pixelsPerWorldUnit, expected.pixelsPerWorldUnit) && close(actual.depth, expected.depth);
  });
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-4 * Math.max(1, Math.abs(right));
}
