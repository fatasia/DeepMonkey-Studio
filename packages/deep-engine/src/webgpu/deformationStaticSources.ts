import type { DeformationSource } from "../deformation/types.js";
import type { DeviceSession } from "./deviceSession.js";
import { assertRevision } from "./packetDeformationRevision.js";
import { runResourceCleanup } from "./resourceCleanup.js";

export interface DeformationStaticUpload {
  readonly session: DeviceSession;
  /** Caller validates packed size/capacity first. Static leases never contain pose dynamics. */
  upload(label: string, bytes: ArrayBuffer | ArrayBufferView<ArrayBuffer>): GPUBuffer;
}
interface Entry {
  readonly key: string; readonly source: DeformationSource;
  readonly buffers: Map<string, GPUBuffer>; references: number;
}
/** Namespace is this PacketBuffers owner, epoch is its exact DeviceSession; no global IDs/cache. */
export class DeformationStaticSources {
  private readonly ready = new Map<string, Entry>();
  constructor(private readonly session: DeviceSession) {}
  stage(): DeformationStaticSourceStage { return new DeformationStaticSourceStage(this, this.session); }
  acquire(source: DeformationSource, geometryRevision: number): Entry {
    if (this.session.state !== "ready") throw Error("Deformation static source device is not ready.");
    const key = JSON.stringify([source.geometry, geometryRevision, source.id, source.revision, source.kind, source.semantics,
      source.skinning?.revision, source.morph?.revision]);
    const existing = this.ready.get(key);
    if (existing) { assertRevision(source, existing.source); existing.references++; return existing; }
    return { key, source, buffers: new Map(), references: 1 };
  }
  publish(entry: Entry): void {
    if (this.session.state !== "ready") throw Error("Deformation static source device is not ready.");
    const previous = this.ready.get(entry.key);
    if (previous && previous !== entry) {
      // Independently prepared candidates are never retroactively merged while borrowed.
      assertRevision(entry.source, previous.source); return;
    }
    this.ready.set(entry.key, entry);
  }
  release(entry: Entry): void {
    if (--entry.references !== 0) return;
    if (this.ready.get(entry.key) === entry) this.ready.delete(entry.key);
    const buffers = [...entry.buffers.values()]; entry.buffers.clear();
    runResourceCleanup("Static deformation release failed.", buffers.map(buffer => () => this.session.release(buffer)));
  }
}

/** New entries remain private until the containing GPU validation AND publication succeed. */
export class DeformationStaticSourceStage {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;
  constructor(private readonly pool: DeformationStaticSources, private readonly session: DeviceSession) {}
  source(source: DeformationSource, geometryRevision: number): DeformationStaticUpload {
    if (this.disposed || this.session.state !== "ready") throw Error("Static deformation stage is not ready.");
    let entry = this.entries.get(source.id);
    if (entry) assertRevision(source, entry.source);
    else { entry = this.pool.acquire(source, geometryRevision); this.entries.set(source.id, entry); }
    const target = entry;
    return { session: this.session, upload: (label, bytes) => {
      if (this.disposed || this.session.state !== "ready") throw Error("Static deformation lease is not ready.");
      const existing = target.buffers.get(label);
      if (existing) return existing;
      const buffer = this.session.own(this.session.device.createBuffer({ label, size: bytes.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }));
      try { this.session.device.queue.writeBuffer(buffer, 0, bytes); }
      catch (error) { this.session.release(buffer); throw error; }
      target.buffers.set(label, buffer); return buffer;
    } };
  }
  publishValidated(): void {
    if (this.disposed) throw Error("Static deformation stage is disposed.");
    for (const entry of this.entries.values()) this.pool.publish(entry);
  }
  dispose(): void {
    if (this.disposed) return; this.disposed = true;
    const entries = [...this.entries.values()]; this.entries.clear();
    runResourceCleanup("Static deformation stage cleanup failed.", entries.map(entry => () => this.pool.release(entry)));
  }
}
