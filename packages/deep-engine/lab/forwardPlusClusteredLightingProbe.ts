/// <reference types="@webgpu/types" />
import { ForwardPlusClusterAssigner, type ClusteredLights, type ForwardPlusClusterResources } from "@bim-studio/deep-engine/lighting";
import type { DeviceSession } from "@bim-studio/deep-engine/webgpu";

export interface ForwardPlusClusteredLightingProbeResult {
  readonly action: "forward-plus-clustered-lighting";
  readonly success: boolean;
  readonly cpuGpuExact: boolean;
  readonly stableBufferReuse: boolean;
  readonly leftRightDirectional: boolean;
  readonly verticalOriginCorrect: boolean;
  readonly logarithmicDepthDirectional: boolean;
  readonly boundedOverflow: boolean;
  readonly overflowCount: number;
  readonly expectedOverflowCount: number;
  readonly clusterCount: number;
}

interface GpuAssignment { readonly headers: Uint32Array; readonly indices: Uint32Array; readonly overflow: number }
const GRID = { viewportWidth: 128, viewportHeight: 64, tileSizeX: 32, tileSizeY: 32,
  zSlices: 4, near: 1, far: 16, verticalFovRadians: Math.PI / 2, maxLightsPerCluster: 2 } as const;
const point = (positionView: readonly [number, number, number], range: number) =>
  ({ positionView, range, color: [1, 0.5, 0.25] as const, intensity: 2 });

function same(left: Uint32Array, right: Uint32Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clustersForLight(result: GpuAssignment, lightIndex: number, maxPerCluster: number): number[] {
  const clusters: number[] = [];
  for (let cluster = 0; cluster < result.headers.length / 2; cluster++) {
    const offset = result.headers[cluster * 2]!, count = result.headers[cluster * 2 + 1]!;
    if (result.indices.slice(offset, offset + Math.min(count, maxPerCluster)).includes(lightIndex)) clusters.push(cluster);
  }
  return clusters;
}

function allClustersMatchAxis(clusters: readonly number[], tilesX: number, tilesY: number, axis: "x" | "y" | "z", expected: number): boolean {
  return clusters.length > 0 && clusters.every(cluster => axis === "x"
    ? cluster % (tilesX * tilesY) % tilesX === expected
    : axis === "y" ? Math.floor(cluster % (tilesX * tilesY) / tilesX) === expected
      : Math.floor(cluster / (tilesX * tilesY)) === expected);
}

async function execute(device: GPUDevice, assigner: ForwardPlusClusterAssigner, resources: ForwardPlusClusterResources,
  headerReadback: GPUBuffer, indexReadback: GPUBuffer, overflowReadback: GPUBuffer): Promise<GpuAssignment> {
  const encoder = device.createCommandEncoder({ label: "Deep Forward+ clustered lighting probe" });
  assigner.encode(encoder);
  encoder.copyBufferToBuffer(resources.clusterHeaderBuffer, 0, headerReadback, 0, resources.clusterHeaderByteLength);
  encoder.copyBufferToBuffer(resources.clusterLightIndexBuffer, 0, indexReadback, 0, resources.clusterLightIndexByteLength);
  encoder.copyBufferToBuffer(resources.overflowBuffer, 0, overflowReadback, 0, 4);
  device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
  await Promise.all([headerReadback.mapAsync(GPUMapMode.READ), indexReadback.mapAsync(GPUMapMode.READ), overflowReadback.mapAsync(GPUMapMode.READ)]);
  const headers = new Uint32Array(headerReadback.getMappedRange().slice(0));
  const indices = new Uint32Array(indexReadback.getMappedRange().slice(0));
  const overflow = new Uint32Array(overflowReadback.getMappedRange().slice(0))[0] ?? 0;
  headerReadback.unmap(); indexReadback.unmap(); overflowReadback.unmap(); return { headers, indices, overflow };
}

/** Standalone real-GPU readback probe. Deliberately not wired into the Lab main loop yet. */
export async function verifyForwardPlusClusteredLighting(session: DeviceSession): Promise<ForwardPlusClusteredLightingProbeResult> {
  if (session.state !== "ready") throw new Error("Forward+ clustered lighting probe requires a ready device session.");
  const device = session.device, assigner = new ForwardPlusClusterAssigner(session), owned: GPUBuffer[] = [];
  const own = (buffer: GPUBuffer): GPUBuffer => { owned.push(session.own(buffer)); return buffer; };
  const lights: ClusteredLights = { points: [point([-3, -1, -6], 0.4), point([3, 1, -6], 0.4),
    point([0, -1, -1.5], 0.1), point([0, 1, -12], 0.4)] };
  let resources = assigner.prepare(GRID, lights, { cpuReference: true });
  const stable = assigner.prepare(GRID, lights, { cpuReference: true });
  const stableBufferReuse = stable.clusterHeaderBuffer === resources.clusterHeaderBuffer && stable.clusterLightIndexBuffer === resources.clusterLightIndexBuffer
    && stable.localBoundsBuffer === resources.localBoundsBuffer && stable.pointLightBuffer === resources.pointLightBuffer;
  resources = stable;
  const headerReadback = own(device.createBuffer({ label: "Deep Forward+ header readback", size: resources.clusterHeaderByteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const indexReadback = own(device.createBuffer({ label: "Deep Forward+ index readback", size: resources.clusterLightIndexByteLength,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  const overflowReadback = own(device.createBuffer({ label: "Deep Forward+ overflow readback", size: 4,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
  try {
    const directional = await execute(device, assigner, resources, headerReadback, indexReadback, overflowReadback);
    const reference = resources.cpuReference!;
    const cpuGpuExact = same(directional.headers, reference.headers) && same(directional.indices, reference.lightIndices)
      && directional.overflow === reference.overflowCount;
    const [left, right, near, far] = [0, 1, 2, 3].map(index => clustersForLight(directional, index, GRID.maxLightsPerCluster));
    const leftRightDirectional = allClustersMatchAxis(left!, resources.grid.tilesX, resources.grid.tilesY, "x", 1)
      && allClustersMatchAxis(right!, resources.grid.tilesX, resources.grid.tilesY, "x", 2);
    const verticalOriginCorrect = allClustersMatchAxis(left!, resources.grid.tilesX, resources.grid.tilesY, "y", 1)
      && allClustersMatchAxis(right!, resources.grid.tilesX, resources.grid.tilesY, "y", 0);
    const logarithmicDepthDirectional = allClustersMatchAxis(near!, resources.grid.tilesX, resources.grid.tilesY, "z", 0)
      && allClustersMatchAxis(far!, resources.grid.tilesX, resources.grid.tilesY, "z", 3);

    const overflowLights: ClusteredLights = { points: Array.from({ length: 4 }, () => point([0, 0, -2], 100)) };
    const overflowResources = assigner.prepare(GRID, overflowLights, { cpuReference: true }), overflowReference = overflowResources.cpuReference!;
    const overflow = await execute(device, assigner, overflowResources, headerReadback, indexReadback, overflowReadback);
    const overflowExact = same(overflow.headers, overflowReference.headers) && same(overflow.indices, overflowReference.lightIndices);
    const boundedOverflow = overflowExact && overflow.overflow === overflowReference.overflowCount
      && overflow.headers.every((value, index) => index % 2 === 0 || value <= GRID.maxLightsPerCluster);
    const success = cpuGpuExact && stableBufferReuse && leftRightDirectional && verticalOriginCorrect && logarithmicDepthDirectional && boundedOverflow;
    return { action: "forward-plus-clustered-lighting", success, cpuGpuExact, stableBufferReuse, leftRightDirectional,
      verticalOriginCorrect, logarithmicDepthDirectional, boundedOverflow, overflowCount: overflow.overflow,
      expectedOverflowCount: overflowReference.overflowCount, clusterCount: resources.grid.clusterCount };
  } finally {
    assigner.dispose(); for (const buffer of owned) session.release(buffer);
  }
}
