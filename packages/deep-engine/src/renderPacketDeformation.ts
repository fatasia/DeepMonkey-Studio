import { snapshotDeformation } from "./deformation/validation.js";
import type { DeformationPose, DeformationSnapshot } from "./deformation/types.js";
import type { GeometryResource, RenderInstance } from "./renderPacketTypes.js";
import { snapshotDeformationPoseUpdate } from "./renderPacketPoseUpdate.js";

/** Explicit renderer capability boundary; author preparation is not a support claim. */
export function assertPacketDeformationSupported(packet: { readonly deformation?: unknown; readonly poses?: unknown;
  readonly instances?: readonly { readonly pose?: string }[]; readonly batches?: readonly { readonly pose?: string }[] }, supported = false): void {
  if (!supported && (packet.deformation !== undefined || packet.poses !== undefined
    || packet.instances?.some(instance => instance.pose !== undefined) || packet.batches?.some(batch => batch.pose !== undefined))) {
    throw new Error("RenderPacket deformation is not enabled for this renderer.");
  }
}

export function preparePacketDeformation(deformation: DeformationSnapshot | undefined,
  geometries: ReadonlyMap<string, GeometryResource>, instances: readonly RenderInstance[]): DeformationSnapshot | undefined {
  if (deformation === undefined) { validateInstancePoses(instances, undefined); return undefined; }
  if (deformation?.sources?.length > 4096 || deformation?.poses?.length > 16_384) throw new Error("Deformation exceeds packet resource limits.");
  const owned = snapshotDeformation(deformation);
  for (const source of owned.sources) {
    const geometry = geometries.get(source.geometry);
    if (!geometry) throw new Error(`Missing deformation geometry ${source.geometry}.`);
    for (const base of [source.morph, source.skinning]) {
      if (!base) continue;
      const count = geometry.vertices.length / 6;
      if (base.positions.length !== count * 3 || !base.normals || base.normals.length !== count * 3) {
        throw new Error(`Deformation base vertex count/normals must match geometry ${source.geometry}.`);
      }
      for (let vertex = 0; vertex < count; vertex++) for (let lane = 0; lane < 3; lane++) {
        if (base.positions[vertex * 3 + lane] !== geometry.vertices[vertex * 6 + lane]
          || base.normals[vertex * 3 + lane] !== geometry.vertices[vertex * 6 + 3 + lane]) {
          throw new Error(`Deformation base must match remapped geometry ${source.geometry} vertex order.`);
        }
      }
    }
    for (const tangents of [source.morph?.tangents, source.skinning?.tangents]) {
      if (tangents && (!geometry.tangents || tangents.length !== geometry.tangents.length
        || tangents.some((value, index) => value !== geometry.tangents![index]))) {
        throw new Error(`Deformation tangents must match geometry ${source.geometry}.`);
      }
    }
  }
  validateInstancePoses(instances, owned);
  return owned;
}

/** Retained source arrays stay owned by the prepared packet; only changing pose arrays are copied. */
export function prepareDeformationPoseUpdate(retained: DeformationSnapshot | undefined,
  poses: readonly DeformationPose[] | undefined, instances: readonly RenderInstance[]): DeformationSnapshot | undefined {
  if (poses === undefined) {
    if (instances.some(instance => instance.pose !== undefined)) throw new Error("Posed instance updates require explicit poses.");
    return undefined;
  }
  if (!retained) throw new Error("Pose updates require prepared deformation sources.");
  const candidate = snapshotDeformationPoseUpdate(retained, poses);
  validateInstancePoses(instances, candidate);
  return candidate;
}

export function validateInstancePoses(instances: readonly RenderInstance[], deformation: DeformationSnapshot | undefined): void {
  const poses = new Map(deformation?.poses.map(pose => [pose.id, pose]));
  const sources = new Map(deformation?.sources.map(source => [source.id, source]));
  for (const instance of instances) {
    if (instance.pose === undefined) continue;
    const pose = poses.get(instance.pose), source = pose ? sources.get(pose.source) : undefined;
    if (!source) throw new Error(`Missing deformation pose ${instance.pose}.`);
    if (source.geometry !== instance.geometry) throw new Error(`Pose ${instance.pose} references another geometry.`);
    if (instance.lod) throw new Error("Deformed instances require a dedicated source per LOD; LOD pose mapping is not supported.");
  }
}
