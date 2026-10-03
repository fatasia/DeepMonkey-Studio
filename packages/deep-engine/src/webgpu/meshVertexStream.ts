import type { GeometryResource } from "../renderPacket.js";
import { validateGeometries } from "../renderPacketGeometry.js";
import { createPacketGeometryBounds, type PacketGeometryBounds } from "./packetGeometryBounds.js";
import type { DeviceSession } from "./deviceSession.js";

export interface MeshVertexUpdate {
  readonly geometry: GeometryResource;
  readonly bounds: PacketGeometryBounds;
  commit(): boolean;
  discard(): void;
}

/** Called only by constructor opt-in, before any GPU upload; default meshes do not copy. */
export function captureVertexStreamBaseline(mesh: GeometryResource): GeometryResource {
  validateGeometries(new Map([[mesh.id,mesh]]));
  if(mesh.tangents) throw Error("Mesh vertex streaming does not support tangents.");
  return {...mesh,vertices:mesh.vertices.slice(),indices:mesh.indices.slice(),
    ...(mesh.uv0?{uv0:mesh.uv0.slice()}:{}),...(mesh.uv1?{uv1:mesh.uv1.slice()}:{}),
    ...(mesh.colors?{colors:mesh.colors.slice()}:{}),};
}

/** Buffer transaction only. The packet owner must publish source/bounds/revision with this lease. */
export class MeshVertexStream {
  private extra: GPUBuffer | undefined;
  private activeExtra = false;
  private disposed = false;
  private pending: object | undefined;
  constructor(private readonly session: DeviceSession, private source: GeometryResource,
    private readonly original: GPUBuffer, private readonly pack: (source: GeometryResource) => Float32Array<ArrayBuffer>,
    private readonly allocate: (data: Float32Array<ArrayBuffer>) => GPUBuffer) {}

  get vertices(): GPUBuffer { return this.activeExtra ? this.extra! : this.original; }
  get revision(): number { return this.source.revision; }

  stage(next: GeometryResource): MeshVertexUpdate {
    if (this.disposed || this.session.state !== "ready") throw Error("Mesh vertex stream is not ready.");
    if (this.pending) throw Error("Mesh vertex stream already has a pending transaction.");
    validateGeometries(new Map([[next.id,next]]));
    if (next.id !== this.source.id || next.vertices.length !== this.source.vertices.length
      || next.tangents || this.source.tangents
      || !equal(next.indices,this.source.indices) || !optional(next.uv0,this.source.uv0)
      || !optional(next.uv1,this.source.uv1) || !optional(next.colors,this.source.colors)) {
      throw Error("Mesh vertex streaming requires fixed identity, topology, UV, colors and no tangents.");
    }
    const changed = !equal(next.vertices,this.source.vertices);
    if (next.revision < this.source.revision || (next.revision === this.source.revision && changed)) {
      throw Error("Mesh vertex streaming requires a monotonic geometry revision.");
    }
    const owned={...this.source,revision:next.revision,vertices:next.vertices.slice()};
    // The returned readonly geometry is not the stream's authoritative baseline.
    const snapshot={...next,vertices:owned.vertices.slice()};
    const bounds = createPacketGeometryBounds(new Map([[next.id,owned]])).get(next.id)!;
    const updated = next.revision !== this.source.revision;
    let targetExtra = this.activeExtra;
    if (changed) {
      const packed = this.pack(owned);
      if (packed.byteLength > this.session.device.limits.maxBufferSize) throw Error("Stream vertices exceed device buffer limit.");
      targetExtra = !this.activeExtra;
      if (targetExtra && !this.extra) this.extra = this.allocate(packed);
      else this.session.device.queue.writeBuffer(targetExtra ? this.extra! : this.original,0,packed);
    }
    const ticket = {}; this.pending = ticket; let settled = false;
    return {geometry:snapshot,bounds,
      commit:()=>{
        if (settled || this.disposed || this.pending !== ticket || this.session.state !== "ready") {
          throw Error("Mesh vertex update cannot commit a cancelled or stale transaction.");
        }
        settled = true; this.pending = undefined; this.activeExtra = targetExtra; this.source = owned;
        return updated;
      },
      discard:()=>{if (settled) return; settled=true; if (this.pending===ticket) this.pending=undefined;},
    };
  }

  /** The original vertex buffer remains owned by MeshBuffers; release only the one extra slot. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed=true;this.pending=undefined;
    if(this.extra){this.session.release(this.extra);this.extra=undefined;}
  }
}
const equal=(a:Float32Array|Uint32Array,b:Float32Array|Uint32Array)=>a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
const optional=(a:Float32Array|undefined,b:Float32Array|undefined)=>a===undefined?b===undefined:b!==undefined&&equal(a,b);
