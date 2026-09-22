import type { PbrMaterial, RenderPacket } from "../renderPacketTypes.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";
import { buildTlas, invertAffine3x4, type TlasBuildResult, type TlasInstanceDescriptor } from "./tlas.js";

export const RENDER_PACKET_GI_RAY_MASK = 1;

export interface RenderPacketRayMaterialBinding {
  readonly instanceId: string;
  readonly material: PbrMaterial;
}

export interface RenderPacketRayScene {
  readonly tlas: TlasBuildResult;
  /** Indexed by the original TLAS instance index returned by RayBackend hits. */
  readonly materials: readonly RenderPacketRayMaterialBinding[];
  readonly excludedTransparentInstances: number;
  readonly conservativeAlphaMaskInstances: number;
}

/**
 * Adapts the authoritative RenderPacket into the existing RayBackend TLAS.
 * Geometry is shared per resource; this adapter does not introduce another BVH.
 * BLEND instances are omitted because the current closest-hit ABI has no any-hit
 * alpha continuation. MASK remains conservative until texture alpha sampling is
 * added to the GI radiance kernel.
 */
export function buildRenderPacketRayScene(packet: RenderPacket): RenderPacketRayScene {
  if (packet.deformation !== undefined) {
    throw new Error("RenderPacket ray scene requires a baked or undeformed geometry snapshot.");
  }
  const geometryById = new Map(packet.geometries.map(geometry => [geometry.id, geometry]));
  const materialById = new Map(packet.materials.map(material => [material.id, material]));
  const blasByGeometry = new Map<string, RayBlasDescriptor>();
  const instances: TlasInstanceDescriptor[] = [];
  const materials: RenderPacketRayMaterialBinding[] = [];
  let excludedTransparentInstances = 0, conservativeAlphaMaskInstances = 0;

  for (const instance of packet.instances) {
    const material = materialById.get(instance.material);
    if (!material) throw new Error(`RenderPacket ray scene instance ${instance.id} references unknown material ${instance.material}.`);
    if (material.alphaMode === "BLEND") { excludedTransparentInstances++; continue; }
    if (material.alphaMode === "MASK") conservativeAlphaMaskInstances++;
    const geometry = geometryById.get(instance.geometry);
    if (!geometry) throw new Error(`RenderPacket ray scene instance ${instance.id} references unknown geometry ${instance.geometry}.`);
    let blas = blasByGeometry.get(geometry.id);
    if (!blas) {
      if (geometry.vertices.length % 6 !== 0) {
        throw new Error(`RenderPacket ray scene geometry ${geometry.id} must use position-normal vertices.`);
      }
      const positions = new Float32Array(geometry.vertices.length / 2);
      for (let source = 0, target = 0; source < geometry.vertices.length; source += 6, target += 3) {
        positions[target] = geometry.vertices[source]!;
        positions[target + 1] = geometry.vertices[source + 1]!;
        positions[target + 2] = geometry.vertices[source + 2]!;
      }
      blas = { id: geometry.id, vertices: positions, indices: geometry.indices };
      blasByGeometry.set(geometry.id, blas);
    }
    instances.push({ id: instance.id, blas, worldToLocal: worldToLocal(instance.transform, instance.id),
      mask: RENDER_PACKET_GI_RAY_MASK });
    materials.push(Object.freeze({ instanceId: instance.id, material }));
  }
  return Object.freeze({ tlas: buildTlas(instances), materials: Object.freeze(materials),
    excludedTransparentInstances, conservativeAlphaMaskInstances });
}

function worldToLocal(transform: ArrayLike<number>, instanceId: string): TlasInstanceDescriptor["worldToLocal"] {
  if (transform.length !== 16 || Array.from(transform).some(value => !Number.isFinite(value))) {
    throw new Error(`RenderPacket ray scene instance ${instanceId} requires a finite 4x4 transform.`);
  }
  // RenderPacket preserves Three/glTF column-major matrices. RayBackend consumes
  // row-major affine 3x4 matrices, so transpose the addressing before inversion.
  const localToWorld = [transform[0]!, transform[4]!, transform[8]!, transform[12]!,
    transform[1]!, transform[5]!, transform[9]!, transform[13]!,
    transform[2]!, transform[6]!, transform[10]!, transform[14]!];
  return invertAffine3x4(localToWorld) as unknown as TlasInstanceDescriptor["worldToLocal"];
}
