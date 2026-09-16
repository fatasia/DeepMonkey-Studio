import type { PacketResidencyTicket } from "./packetResidencyDomain.js";
import type { PacketResidencySetProjection } from "./packetResidencySet.js";
import type { ResidentPacketProjection } from "./residentPacketProjection.js";
import { mergeSceneChunkProjections } from "./sceneChunkFrameProjection.js";

export interface ResidentSceneChunk {
  readonly key: string;
  readonly projection: ResidentPacketProjection;
}

export interface ResidentSceneChunkFrame {
  readonly frame: number;
  readonly chunks: readonly ResidentSceneChunk[];
  readonly released: boolean;
  chunk(key: string): ResidentPacketProjection | undefined;
  /** One-shot ownership transfer. Frame.release becomes inert until the renderer retires the transferred projection. */
  takeProjection(): ResidentPacketProjection;
  release(): void;
}

/** Creates a frame transactionally; malformed internal bindings cannot leak acquired leases. */
export function createResidentSceneChunkFrame(frame: number,
  values: readonly PacketResidencySetProjection[],
  keys: ReadonlyMap<PacketResidencyTicket, string>): ResidentSceneChunkFrame {
  try { return new SceneFrame(frame, values, keys); }
  catch (error) {
    const failures = releaseSceneChunkProjections(values.map(value => value.projection));
    if (failures.length) throw new AggregateError([error, ...failures],
      "Resident scene chunk frame construction rollback failed.");
    throw error;
  }
}

export function releaseSceneChunkProjections(values: readonly ResidentPacketProjection[]): unknown[] {
  const failures: unknown[] = [];
  for (let index = values.length - 1; index >= 0; index--) {
    try { values[index]!.release(); } catch (error) { failures.push(error); }
  }
  return failures;
}

class SceneFrame implements ResidentSceneChunkFrame {
  private releasedValue = false;
  private transferred = false;
  private readonly lookup = new Map<string, ResidentPacketProjection>();
  readonly chunks: readonly ResidentSceneChunk[];
  constructor(readonly frame: number, values: readonly PacketResidencySetProjection[],
    keys: ReadonlyMap<PacketResidencyTicket, string>) {
    this.chunks = Object.freeze(values.map(value => {
      const key = keys.get(value.ticket);
      if (!key) throw new Error("Scene residency projection has no chunk binding.");
      if (this.lookup.has(key)) throw new Error("Duplicate scene residency chunk binding.");
      this.lookup.set(key, value.projection);
      return Object.freeze({ key, projection: value.projection });
    }));
  }
  get released(): boolean { return this.releasedValue; }
  chunk(key: string): ResidentPacketProjection | undefined { return this.lookup.get(key); }
  takeProjection(): ResidentPacketProjection {
    if (this.releasedValue || this.transferred) throw new Error("Scene frame ownership is already released or transferred.");
    this.transferred = true;
    return mergeSceneChunkProjections(this.chunks.map(value => value.projection), () => { this.releasedValue = true; });
  }
  release(): void {
    if (this.releasedValue || this.transferred) return;
    this.releasedValue = true;
    const failures = releaseSceneChunkProjections(this.chunks.map(value => value.projection));
    if (failures.length) throw new AggregateError(failures, "Resident scene chunk frame release failed.");
  }
}
