import { prepareRenderPacket, type RenderPacket } from "../renderPacket.js";
import { uniqueById } from "../renderPacketValidation.js";
import { STOCK_MATERIAL_INSTANCE_OPTIONS } from "../materialInstanceAbi.js";
import { buildRenderPacketRayScene, RENDER_PACKET_GI_RAY_MASK } from "./renderPacketRayScene.js";
import { traceTlasClosest } from "./tlas.js";
import type { PathTraceCpuSurfaceQuery } from "./pathTraceCpuTransport.js";
import { ptDot, type PathTraceRgb } from "./pathTraceCpuTypes.js";
import { adaptPathTraceRenderPacketMaterial } from "./pathTraceRenderPacketMaterial.js";
import { preparePathTraceTriangleNormals, preparePathTraceWorldNormals, pathTraceTriangleWeights,
  interpolatePathTraceWorldNormal } from "./pathTraceTriangleNormals.js";

/** Snapshot-owned prepared BLAS cache; no cache crosses a scene revision or user scene. */
export function buildPathTraceRenderPacketScene(packet: RenderPacket) {
  if (packet.deformation !== undefined) throw new Error("CPU path trace unsupported deformation; bake a geometry snapshot first.");
  if (packet.materialLosses?.length) throw new Error("CPU path trace unsupported unresolved material losses.");
  uniqueById(packet.instances, "instance");
  uniqueById(packet.materials, "material");
  uniqueById(packet.geometries, "geometry");
  for (const instance of packet.instances) {
    if (instance.pose !== undefined || instance.lod !== undefined) throw new Error("CPU path trace unsupported pose/LOD.");
    const matrix = instance.transform;
    if (matrix.length !== 16 || matrix[3] !== 0 || matrix[7] !== 0 || matrix[11] !== 0 || matrix[15] !== 1) {
      throw new Error("CPU path trace instance requires an affine column-major transform.");
    }
  }
  // Authority performs general resource/type/range checks and copies used geometry arrays.
  const prepared = prepareRenderPacket(packet, STOCK_MATERIAL_INSTANCE_OPTIONS);
  const trianglesByGeometry = new Map<string, ReturnType<typeof preparePathTraceTriangleNormals>>();
  for (const geometry of prepared.geometries.values()) {
    if (geometry.colors !== undefined) throw new Error("CPU path trace unsupported vertex colors.");
    trianglesByGeometry.set(geometry.id, preparePathTraceTriangleNormals(geometry));
  }
  const adaptedMaterials = new Map(packet.materials.map(material => [material.id, adaptPathTraceRenderPacketMaterial(material)]));
  const snapshot: RenderPacket = { geometries: [...prepared.geometries.values()],
    materials: packet.materials.map(material => ({ ...material, baseColor: [...material.baseColor],
      ...(material.emissiveFactor ? { emissiveFactor: [...material.emissiveFactor] as PathTraceRgb } : {}) })),
    instances: packet.instances.map(instance => ({ ...instance, transform: new Float32Array(Array.from(instance.transform)) })) };
  const scene = buildRenderPacketRayScene(snapshot);
  const instances = new Map(scene.tlas.instances.map(instance => [instance.id, instance]));
  const materialByInstance = new Map(snapshot.instances.map(instance => [instance.id, adaptedMaterials.get(instance.material)!]));
  const worldNormals = new Map<string, Map<number, ReturnType<typeof preparePathTraceWorldNormals>>>();
  const traceSurface: PathTraceCpuSurfaceQuery = query => {
    const hit = traceTlasClosest(scene.tlas, query, RENDER_PACKET_GI_RAY_MASK, blas => {
      const cached = scene.tlas.preparedBlas?.get(blas);
      if (!cached) throw new Error("CPU path trace prepared BLAS cache is incomplete.");
      return cached;
    });
    if (!hit) return undefined;
    const instance = instances.get(hit.instanceId)!;
    let cache = worldNormals.get(instance.id);
    if (!cache) { cache = new Map(); worldNormals.set(instance.id, cache); }
    const triangle = trianglesByGeometry.get(instance.blas.id)![hit.primitiveIndex]!;
    let normals = cache.get(hit.primitiveIndex);
    if (!normals) {
      normals = preparePathTraceWorldNormals(triangle, instance.worldToLocal);
      cache.set(hit.primitiveIndex, normals);
    }
    let normal: PathTraceRgb = normals.geometric;
    if (!triangle.flat) {
      const x = query.ox + query.dx * hit.t, y = query.oy + query.dy * hit.t, z = query.oz + query.dz * hit.t;
      const m = instance.worldToLocal;
      const local: PathTraceRgb = [m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
      normal = interpolatePathTraceWorldNormal(normals.corners, pathTraceTriangleWeights(triangle, local));
      if (ptDot(normal, normals.geometric) <= 0) throw new Error("CPU path trace interpolation crossed geometric normal hemisphere.");
    }
    return { t: hit.t, normal, geometricNormal: normals.geometric, material: materialByInstance.get(hit.instanceId)! };
  };
  // Keep owners private: callers receive the surface query and immutable scalar diagnostics.
  return Object.freeze({ traceSurface, instanceCount: scene.tlas.instances.length,
    uniqueBlasCount: scene.tlas.preparedBlas?.size ?? 0 });
}
