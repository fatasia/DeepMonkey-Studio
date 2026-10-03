import { buildTracedScene, traceClosest } from "./rayTrace.js";
import type { PathTraceReferenceKernel } from "./pathTraceReferenceKernel.js";
import { createPathTraceCpuTransport } from "./pathTraceCpuTransport.js";
import { ptAdd, ptCross, ptNormalize, ptScale, validatePathTraceRgb,
  type PathTraceCpuKernelOptions, type PathTraceVec3 } from "./pathTraceCpuTypes.js";

/** Static single-BLAS CPU reference; no raster readback or renderer dependency. */
export function createPathTraceCpuKernel(options: PathTraceCpuKernelOptions): PathTraceReferenceKernel {
  const blas = { id: options.blas.id, vertices: options.blas.vertices.slice(), indices: options.blas.indices.slice() };
  if (blas.vertices.length % 3 !== 0 || blas.indices.length % 3 !== 0
    || blas.vertices.some(v => !Number.isFinite(v))
    || blas.indices.some(i => i >= blas.vertices.length / 3)) throw new RangeError("Invalid path trace BLAS.");
  if (options.materials.length !== blas.indices.length / 3) throw new RangeError("Path trace needs one material per triangle.");
  const materials = options.materials.map(material => {
    if (material.model !== "lambert" && material.model !== "ggx-conductor" && material.model !== "production-opaque-pbr") throw new TypeError("Unsupported path trace material.");
    validatePathTraceRgb(material.reflectance, "reflectance", 1);
    validatePathTraceRgb(material.emission ?? [0, 0, 0], "emission");
    if (material.model === "ggx-conductor" && (!Number.isFinite(material.roughness)
      || material.roughness! < 0.045 || material.roughness! > 1)) throw new RangeError("GGX roughness must be in [0.045, 1].");
    if (material.model === "production-opaque-pbr" && (!Number.isFinite(material.roughness)
      || material.roughness! < 0 || material.roughness! > 1 || !Number.isFinite(material.metallic ?? 0)
      || (material.metallic ?? 0) < 0 || (material.metallic ?? 0) > 1
      || !Number.isFinite(material.ior ?? 1.5) || (material.ior ?? 1.5) < 1)) throw new RangeError("Invalid production opaque PBR parameters.");
    return { ...material, reflectance: [...material.reflectance] as PathTraceVec3,
      emission: [...(material.emission ?? [0, 0, 0])] as PathTraceVec3 };
  });
  const scene = buildTracedScene(blas);
  const normals = materials.map((_, triangle) => {
    const vertex = (corner: number): PathTraceVec3 => {
      const offset = blas.indices[triangle * 3 + corner]! * 3;
      return [blas.vertices[offset]!, blas.vertices[offset + 1]!, blas.vertices[offset + 2]!];
    };
    const a = vertex(0), b = vertex(1), c = vertex(2);
    return ptNormalize(ptCross(ptAdd(b, ptScale(a, -1)), ptAdd(c, ptScale(a, -1))));
  });
  return createPathTraceCpuTransport(options, query => {
    const hit = traceClosest(scene, query);
    return hit === undefined ? undefined : { t: hit.t, normal: normals[hit.primitiveIndex]!, material: materials[hit.primitiveIndex]! };
  });
}
