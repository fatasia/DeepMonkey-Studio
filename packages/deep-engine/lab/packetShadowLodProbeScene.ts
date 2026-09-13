import { geometryCenter, prepareRenderPacket, type GeometryResource, type RenderPacket } from "../src/renderPacket.js";
import type { CascadedShadowPlan } from "../src/shadows/types.js";
import { lookAt, multiply, orthographic } from "../src/webgpu/cameraMath.js";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { MeshBuffers, uploadBuffer } from "../src/webgpu/meshBuffers.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "../src/webgpu/packetBufferTypes.js";
import { packPreviousTransforms } from "../src/webgpu/packetInstanceHistory.js";

export function shadowProbeScene(session: DeviceSession) {
  const prepared = prepareRenderPacket(shadowProbePacket()), meshes: MeshBuffers[] = [], owned: GPUBuffer[] = [];
  const geometries = new Map<string, CachedPacketGeometry>([...prepared.geometries].map(([id, source]) => {
    const mesh = new MeshBuffers(session, source); meshes.push(mesh); const center = geometryCenter(source);
    const radius = Math.max(...Array.from(source.indices, index => Math.hypot(source.vertices[index * 6]! - center[0],
      source.vertices[index * 6 + 1]! - center[1], source.vertices[index * 6 + 2]! - center[2])));
    return [id, { source, mesh, center, radius }];
  }));
  const batches = new Map<string, CachedPacketBatch>(prepared.batches.map(source => {
    const previousTransforms = packPreviousTransforms(source);
    const buffer = uploadBuffer(session, "Deep shadow LOD probe instances", source.data, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
    const previousBuffer = uploadBuffer(session, "Deep shadow LOD probe history", previousTransforms, GPUBufferUsage.VERTEX | GPUBufferUsage.STORAGE);
    owned.push(buffer, previousBuffer);
    return [source.key, { source, buffer, capacity: source.data.byteLength, previousBuffer,
      previousCapacity: previousTransforms.byteLength, previousTransforms }];
  }));
  return { geometries, batches, dispose() { for (const buffer of owned) session.release(buffer); for (const mesh of meshes) mesh.dispose(); } };
}

export function shadowProbePlan(): CascadedShadowPlan {
  return { lightDirection: [0, 0, -1], shadowMapSize: 64, splitDepths: new Float32Array([1, 4, 8]),
    cascades: [1, 4, 1].map((radius, index) => {
      const x = index === 2 ? 10 : 0;
      return { index, near: index, far: index + 1, blendStart: index + 0.9, center: [x, 0, 0] as const,
        radius, texelWorldSize: 2 * radius / 64, corners: [],
        viewProjection: multiply(orthographic(radius, 0, 4), lookAt([x, 0, 2], [x, 0, 0])) };
    }) };
}

export function shadowProbePacket(): RenderPacket {
  // 实际球半径 sqrt(0.3² + 0.3²)：两级光源视图直径约 27.15 / 6.79 texel。
  // 阈值令近级选 LOD0，远级先选未驻留的 LOD1，再回退 LOD2。
  const lod = { levels: [
    { geometry: "high", minProjectedDiameterPixels: 20, geometricError: 0 },
    { geometry: "medium", minProjectedDiameterPixels: 4, geometricError: 0.1, resident: false },
    { geometry: "low", minProjectedDiameterPixels: 0, geometricError: 0.2 },
  ] } as const;
  const material = { baseColor: [1, 1, 1] as const, metallic: 0, roughness: 1 };
  const transform = (x: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1];
  return { geometries: [geometry("high", 8), geometry("medium", 4), geometry("low", 1)],
    materials: [{ id: "solid", ...material }, { id: "mask", ...material, alphaMode: "MASK", baseColorAlpha: 0 },
      { id: "blend", ...material, alphaMode: "BLEND", baseColorAlpha: 0.5 }],
    instances: [{ id: "caster", geometry: "high", material: "solid", transform: transform(-0.5), lod },
      { id: "mask", geometry: "high", material: "mask", transform: transform(0.5), lod },
      { id: "blend", geometry: "high", material: "blend", transform: transform(0.5), lod },
      ...Array.from({ length: 64 }, (_, index) => ({ id: `direct-${index}`, geometry: "low", material: "solid", transform: transform(2) }))] };
}

function geometry(id: string, triangles: number): GeometryResource {
  const radius = id === "low" ? 0.15 : 0.3;
  const points = id === "low" ? [[-radius, -radius], [radius, -radius], [0, radius]]
    : [[-radius, -radius], [radius, -radius], [radius, radius], [-radius, radius]];
  const indices = id === "low" ? [0, 1, 2] : Array.from({ length: triangles / 2 }, () => [0, 1, 2, 0, 2, 3]).flat();
  return { id, revision: 0, vertices: new Float32Array(points.flatMap(([x, y]) => [x!, y!, 0, 0, 0, 1])),
    indices: new Uint32Array(indices) };
}
