import type { GeometryResource, RenderPacket } from "../renderPacketTypes.js";
import { invertAffineSceneMatrix } from "../scene/math.js";
import type { SceneMatrix4 } from "../scene/types.js";
import { generateNormals } from "../gltf/generatedNormals.js";
import type { SoftBodyRuntimeSession } from "./softBodyRuntimeHost.js";

/** Explicit particle mapping; repeated indices support duplicated mesh seam vertices. */
export interface SoftBodyRenderBinding {
  readonly bodyId: string;
  readonly instanceId: string;
  readonly vertexParticles: readonly number[];
}

/** Existing packet is the only revision carrier. This function does not step physics. */
export function projectSoftBodyRenderPacket(
  session: SoftBodyRuntimeSession, packet: RenderPacket, bindings: readonly SoftBodyRenderBinding[],
): RenderPacket {
  if (!bindings.length) return packet;
  const replacements = new Map<string, GeometryResource>();
  for (const binding of bindings) {
    const instances = packet.instances.filter(instance => instance.id === binding.instanceId);
    if (instances.length !== 1) throw new Error(`Soft-body render instance ${binding.instanceId} must be unique and present.`);
    const instance = instances[0]!;
    const sources = packet.geometries.filter(geometry => geometry.id === instance.geometry);
    if (sources.length !== 1) throw new Error(`Soft-body render geometry ${instance.geometry} must be unique and present.`);
    const source = sources[0]!;
    if (replacements.has(source.id)) throw new Error(`Soft-body render geometry ${source.id} has multiple bindings.`);
    if (instance.pose || instance.lod || packet.deformation?.sources.some(item => item.geometry === source.id)) {
      throw new Error(`Soft-body render geometry ${source.id} cannot replace deformation or LOD.`);
    }
    if (packet.instances.some(other => other !== instance && (other.geometry === source.id || other.lod?.levels.some(level => level.geometry === source.id)))) {
      throw new Error(`Soft-body render geometry ${source.id} must be exclusive to its target instance.`);
    }
    const material = packet.materials.find(item => item.id === instance.material);
    if (!material || source.tangents || material.normalTexture) throw new Error(`Soft-body render geometry ${source.id} requires an untangent material profile.`);
    if (!Number.isSafeInteger(source.revision) || source.revision < 0 || source.revision === Number.MAX_SAFE_INTEGER) {
      throw new Error(`Soft-body render geometry ${source.id} cannot advance its revision.`);
    }
    const transform = Array.from(instance.transform);
    if (transform.length !== 16 || !transform.every(Number.isFinite)
      || transform[3] !== 0 || transform[7] !== 0 || transform[11] !== 0 || transform[15] !== 1) {
      throw new Error(`Soft-body render instance ${instance.id} requires a finite affine transform.`);
    }
    // First streaming profile: authored translation only; scaled/rotated meshes
    // require a separate mapping/reference admission before this API accepts them.
    const linear = [transform[0],transform[1],transform[2],transform[4],transform[5],transform[6],transform[8],transform[9],transform[10]];
    if (linear.some((value,index) => value !== (index%4 === 0 ? 1 : 0))) {
      throw new Error(`Soft-body render instance ${instance.id} requires a translation-only profile.`);
    }
    const inverse = invertAffineSceneMatrix(transform as unknown as SceneMatrix4);
    if (!inverse) throw new Error(`Soft-body render instance ${instance.id} transform must be invertible.`);
    const positions = session.readout(binding.bodyId);
    if (!positions) throw new Error(`Soft-body render body ${binding.bodyId} is not present in the session.`);
    const count = source.vertices.length / 6;
    if (!Number.isSafeInteger(count) || count < 3 || binding.vertexParticles.length !== count) {
      throw new Error(`Soft-body render geometry ${source.id} needs one particle mapping per vertex.`);
    }
    const local = new Float32Array(count * 3);
    for (let vertex = 0; vertex < count; vertex++) {
      const particle = binding.vertexParticles[vertex]!;
      if (!Number.isSafeInteger(particle) || particle < 0 || particle*3+2 >= positions.length) {
        throw new Error(`Soft-body render vertex ${vertex} maps to an invalid particle.`);
      }
      const x = positions[particle*3]!, y = positions[particle*3+1]!, z = positions[particle*3+2]!;
      for (let axis = 0; axis < 3; axis++) {
        const value = Math.fround(inverse[axis]!*x+inverse[4+axis]!*y+inverse[8+axis]!*z+inverse[12+axis]!);
        if (!Number.isFinite(value)) throw new Error(`Soft-body render vertex ${vertex} is non-finite after projection.`);
        local[vertex*3+axis] = value;
      }
    }
    const normals = generateNormals(local, source.indices, `soft-body.${binding.bodyId}.${source.id}`);
    const vertices = new Float32Array(source.vertices.length);
    let changed = false;
    for (let vertex = 0; vertex < count; vertex++) {
      for (let axis = 0; axis < 3; axis++) {
        const position = local[vertex*3+axis]!, normal = normals[vertex*3+axis]!;
        vertices[vertex*6+axis] = position; vertices[vertex*6+3+axis] = normal;
        changed ||= position !== source.vertices[vertex*6+axis] || normal !== source.vertices[vertex*6+3+axis];
      }
    }
    replacements.set(source.id, changed ? { ...source, revision: source.revision+1, vertices } : source);
  }
  if (![...replacements].some(([id, geometry]) => geometry !== packet.geometries.find(item => item.id === id))) return packet;
  return { ...packet, geometries: packet.geometries.map(geometry => replacements.get(geometry.id) ?? geometry) };
}
