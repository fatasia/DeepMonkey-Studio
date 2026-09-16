import { prepareRenderPacket } from "../src/renderPacket.js";
import { AuthorSelectedLodResources } from "../src/webgpu/authorSelectedLodResources.js";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "../src/webgpu/packetBufferTypes.js";
import type { Frustum } from "../src/webgpu/gpuFrustumCulling.js";
import type { PacketLodDraw } from "../src/webgpu/packetLodTypes.js";
import { packCurrentTransforms } from "../src/webgpu/packetInstanceHistory.js";
import { MeshBuffers } from "../src/webgpu/meshBuffers.js";

const box = (x: number): Frustum => ({ planes: [[1, 0, 0, 2 - x], [-1, 0, 0, 2 + x],
  [0, 1, 0, 2], [0, -1, 0, 2], [0, 0, 1, 2], [0, 0, -1, 2]] });
const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/** Actual production owner/kernel, with GPU indirect and current/previous row readback. */
export async function runAuthorLodFrustumProbe(session: DeviceSession) {
  const device = session.device;
  const geometrySources = [0, 10].map((x, index) => ({ id: `level-${index}`, revision: 1,
    vertices: new Float32Array([x, 0, 0, 0, 0, 1, x + .5, 0, 0, 0, 0, 1, x, .5, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }));
  const prepared = prepareRenderPacket({ geometries: geometrySources,
    materials: [{ id: "m", baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
    instances: [{ id: "author", material: "m", geometry: "level-0", transform, lod: { strategy: "author-selected", revision: 1,
      levels: geometrySources.map((source, index) => ({ geometry: source.id, distance: index * 10, hysteresis: 0 })), selectedLevels: [0, 1] } }] });
  const original = prepared.batches[0]!, data = new Float32Array([...original.data, ...original.data]);
  data[36 + 3] = -10;
  const source = { ...original, count: 2, data, instanceIds: ["first", "second"] };
  const previous = packCurrentTransforms(source); previous[3] = -1; previous[12 + 3] = -11;
  // The owner uploads its stable input; borrowed raster buffers are not used by its compute path.
  const unused = device.createBuffer({ size: 4, usage: GPUBufferUsage.VERTEX });
  const batch: CachedPacketBatch = { source, buffer: unused, previousBuffer: unused, capacity: 4, previousCapacity: 4, previousTransforms: previous };
  const geometries = new Map(geometrySources.map((geometry, index) => [geometry.id, { source: geometry,
    center: [index * 10 + .25, .25, 0], radius: Math.SQRT1_2 / 2,
    mesh: new MeshBuffers(session, geometry) } as CachedPacketGeometry]));
  const camera = new AuthorSelectedLodResources(session), shadow = new AuthorSelectedLodResources(session);
  const modes: unknown[] = [];
  device.pushErrorScope("validation");
  try {
    for (const selectedLevels of [[0, 1], [], [1], [0]]) {
      const lod = source.lod!;
      if (lod.strategy !== "author-selected") throw Error("author profile required");
      const current = { ...batch, source: { ...source, lod: { ...lod, selectedLevels, revision: modes.length + 1 } } };
      const encoder = device.createCommandEncoder();
      const mainStats = camera.encode(encoder, box(0), [current], geometries);
      const shadowStats = shadow.encode(encoder, box(10), [current], geometries);
      const reads = [...camera.draws(source.key)!.map(draw => scheduleRead(device, encoder, draw, "camera")),
        ...shadow.draws(source.key)!.map(draw => scheduleRead(device, encoder, draw, "shadow"))];
      device.queue.submit([encoder.finish()]); camera.commitFrame(); shadow.commitFrame();
      const results = await Promise.all(reads.map(read => read()));
      for (const result of results) {
        const level = result.geometry === "level-0" ? 0 : 1;
        const expected = result.view === "camera" ? [level ? -10 : 0] : level ? [0] : [];
        if (result.count !== expected.length || result.current.some((value, index) => value !== expected[index])
          || result.previous.some((value, index) => value !== expected[index]! - 1)) throw Error(`Incorrect level bounds/identity: ${JSON.stringify(result)}`);
      }
      modes.push({ selectedLevels, mainStats, shadowStats, results });
    }
  } finally { camera.dispose(); shadow.dispose(); for (const geometry of geometries.values()) geometry.mesh.dispose(); unused.destroy(); }
  const error = await device.popErrorScope(); if (error) throw Error(error.message);
  return { success: true, modes, scope: "Production author LOD owner and unchanged frustum kernel; separate camera/shadow bounds and current/previous identities. Formal raster regression is a separate probe." };
}

function scheduleRead(device: GPUDevice, encoder: GPUCommandEncoder, draw: PacketLodDraw, view: string) {
  const read = device.createBuffer({ size: 416, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  encoder.copyBufferToBuffer(draw.indirect, 0, read, 0, 20);
  encoder.copyBufferToBuffer(draw.instances, 0, read, 32, 288);
  encoder.copyBufferToBuffer(draw.previousTransforms, 0, read, 320, 96);
  return async () => {
    try {
      await read.mapAsync(GPUMapMode.READ);
      const bytes = read.getMappedRange(), count = new Uint32Array(bytes)[1]!;
      const data = new Float32Array(bytes), current: number[] = [], previous: number[] = [];
      for (let index = 0; index < count; index++) { current.push(data[8 + index * 36 + 3]!); previous.push(data[80 + index * 12 + 3]!); }
      return { view, geometry: draw.geometry, count, current, previous };
    } finally { read.destroy(); }
  };
}
