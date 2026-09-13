import type { PreparedBatch } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { packGpuLodScene } from "./gpuLodPacking.js";
import { GPU_LOD_MAX_LEVELS } from "./gpuLodTypes.js";
import { conservativeAffineScale } from "./affineSphereBounds.js";
import { failWithResourceCleanup, runResourceCleanup } from "./resourceCleanup.js";

type LodProfile = NonNullable<PreparedBatch["lod"]>;
export interface PacketLodBatchMapping {
  readonly batch: CachedPacketBatch;
  readonly offset: number;
  readonly profile: LodProfile;
  readonly residentLevelIndices: readonly number[];
}
export interface PacketLodSceneInputs {
  readonly objects: GPUBuffer; readonly levels: GPUBuffer; readonly capacity: number;
  readonly count: number; readonly revision: number; readonly topology: string;
  readonly mappings: readonly PacketLodBatchMapping[];
}

/** Color and all light views share one revision upload; only selection and outputs are view-specific. */
export class PacketLodSceneCache {
  private scene: PacketLodSceneInputs | undefined;
  constructor(private readonly session: DeviceSession) {}

  prepare(batches: readonly CachedPacketBatch[],
    residentGeometries: ReadonlyMap<string, CachedPacketGeometry>,
    bounds: PacketGeometryBoundsMap, revision: number): PacketLodSceneInputs {
    if (this.scene?.revision === revision) return this.scene;
    const objects = [], mappings: PacketLodBatchMapping[] = []; let offset = 0;
    for (const batch of batches) {
      const profile = batch.source.lod!;
      const sphere = localProfileSphere(profile, bounds);
      const residentLevelIndices = Object.freeze(profile.levels.flatMap((level, index) =>
        level.resident && residentGeometries.has(level.geometry) ? [index] : []));
      mappings.push({ batch, offset, profile, residentLevelIndices });
      for (let index = 0; index < batch.source.count; index++) objects.push({ sphere: worldSphere(batch.source.data, index, sphere),
        instanceIndex: index, hysteresisRatio: profile.hysteresisRatio, levels: profile.levels.map((level, levelIndex) => ({
          minProjectedDiameterPixels: level.minProjectedDiameterPixels, geometricError: level.geometricError,
          triangles: level.triangles, meshletOffset: levelIndex, meshletCount: 1,
          resident: level.resident && residentGeometries.has(level.geometry),
        })) });
      offset += batch.source.count;
    }
    const packed = packGpuLodScene(objects), capacity = Math.max(1, 2 ** Math.ceil(Math.log2(Math.max(1, packed.count))));
    const old = this.scene, reusable = old && old.capacity >= capacity && capacity * 4 >= old.capacity;
    const created: GPUBuffer[] = [];
    const make = (label: string, size: number) => {
      const value = this.session.own(this.session.device.createBuffer({ label, size,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })); created.push(value); return value;
    };
    let next: PacketLodSceneInputs;
    try {
      const inputs = reusable ? old : { objects: make("Deep packet LOD objects", capacity * 32),
        levels: make("Deep packet LOD levels", capacity * GPU_LOD_MAX_LEVELS * 20), capacity };
      this.session.device.queue.writeBuffer(inputs.objects, 0, packed.objectData);
      this.session.device.queue.writeBuffer(inputs.levels, 0, packed.levelData);
      next = { ...inputs, count: packed.count, revision, topology: topologySignature(mappings), mappings: Object.freeze(mappings) };
    } catch (error) {
      // A partial in-place upload must never be reused as the previous revision.
      if (reusable && this.scene === old) this.scene = undefined;
      failWithResourceCleanup(error, "Packet LOD scene preparation failed.", [
        ...created.map(buffer => () => this.session.release(buffer)),
        ...(reusable && old ? [() => this.session.release(old.objects),
          () => this.session.release(old.levels)] : []),
      ]);
    }
    this.scene = next;
    if (!reusable && old) runResourceCleanup("Superseded packet LOD scene retirement failed.",
      [() => this.session.release(old.objects), () => this.session.release(old.levels)]);
    return next;
  }

  clear(): void {
    const scene = this.scene; this.scene = undefined;
    if (scene) runResourceCleanup("Packet LOD scene disposal failed.",
      [() => this.session.release(scene.objects), () => this.session.release(scene.levels)]);
  }
}

export type PacketGeometryBoundsMap = ReadonlyMap<string,
  Pick<CachedPacketGeometry, "center" | "radius">>;

function localProfileSphere(profile: LodProfile, geometries: PacketGeometryBoundsMap): readonly [number, number, number, number] {
  const values = profile.levels.map(level => geometries.get(level.geometry) ?? missingGeometry(level.geometry));
  const min = [0, 1, 2].map(axis => Math.min(...values.map(value => value.center[axis]! - value.radius)));
  const max = [0, 1, 2].map(axis => Math.max(...values.map(value => value.center[axis]! + value.radius)));
  const center = [0, 1, 2].map(axis => (min[axis]! + max[axis]!) * 0.5);
  return [center[0]!, center[1]!, center[2]!, Math.max(...values.map(value => Math.hypot(
    value.center[0] - center[0]!, value.center[1] - center[1]!, value.center[2] - center[2]!) + value.radius))];
}
function worldSphere(data: Float32Array, index: number, sphere: readonly [number, number, number, number]): [number, number, number, number] {
  const o = index * 36, [x, y, z, radius] = sphere;
  const center = [data[o]! * x + data[o + 1]! * y + data[o + 2]! * z + data[o + 3]!,
    data[o + 4]! * x + data[o + 5]! * y + data[o + 6]! * z + data[o + 7]!,
    data[o + 8]! * x + data[o + 9]! * y + data[o + 10]! * z + data[o + 11]!] as const;
  return [center[0], center[1], center[2], radius * conservativeAffineScale(data, o)];
}
function topologySignature(mappings: readonly PacketLodBatchMapping[]): string {
  return JSON.stringify(mappings.map(value => [value.batch.source.key,
    value.batch.source.instanceIds, value.residentLevelIndices]));
}
function missingGeometry(id: string): never { throw new Error(`LOD geometry is not resident: ${id}.`); }
