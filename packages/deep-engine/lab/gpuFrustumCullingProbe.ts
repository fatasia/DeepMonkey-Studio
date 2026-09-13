import { createGpuFrustumCulling, type CullingInstance, type Frustum } from "@bim-studio/deep-engine/webgpu";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const frustum: Frustum = { planes: [
  [1, 0, 0, 1], [-1, 0, 0, 1], [0, 1, 0, 1], [0, -1, 0, 1], [0, 0, 1, 1], [0, 0, -1, 1],
] };

function translated(x: number, id: number): CullingInstance {
  const model = IDENTITY.slice(); model[12] = x;
  return { modelMatrix: model, bounds: [0, 0, 0, 0.25], metadata: [id, 0, 0, 0] };
}

/** Runs the actual compute pipeline and reads its indirect count/compacted rows back from the GPU. */
export async function verifyGpuFrustumCulling(device: GPUDevice): Promise<Record<string, unknown>> {
  const culler = createGpuFrustumCulling(device, 4, 3);
  const indirectReadback = device.createBuffer({ label: "Deep culling probe indirect readback", size: 20, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const compactedReadback = device.createBuffer({ label: "Deep culling probe compacted readback", size: 4 * 144, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    culler.writeInput(device.queue, [translated(0, 0), translated(0.6, 6), translated(2.0, 20), translated(-2.0, 200)], frustum);
    const encoder = device.createCommandEncoder({ label: "Deep culling probe command" });
    culler.encode(encoder);
    encoder.copyBufferToBuffer(culler.indirect, 0, indirectReadback, 0, 20);
    encoder.copyBufferToBuffer(culler.compacted, 0, compactedReadback, 0, 4 * 144);
    device.queue.submit([encoder.finish()]);
    await device.queue.onSubmittedWorkDone();
    await Promise.all([indirectReadback.mapAsync(GPUMapMode.READ), compactedReadback.mapAsync(GPUMapMode.READ)]);
    const indirect = new Uint32Array(indirectReadback.getMappedRange().slice(0));
    const compacted = new Uint32Array(compactedReadback.getMappedRange().slice(0));
    const count = indirect[1] ?? 0;
    const metadata = Array.from({ length: count }, (_, index) => compacted[index * 36 + 32] ?? 0).sort((a, b) => a - b);
    indirectReadback.unmap(); compactedReadback.unmap();
    const verified = count === 2 && JSON.stringify(metadata) === JSON.stringify([0, 6]) && indirect[0] === 3;
    return { action: "gpu-frustum-culling", success: verified, inputCount: 4, visibleCount: count, compactedMetadata: metadata, indirectIndexCount: indirect[0], capacity: culler.capacity, atomicCompaction: true, vertexCompatibleOutput: true };
  } finally {
    culler.dispose(); indirectReadback.destroy(); compactedReadback.destroy();
  }
}
