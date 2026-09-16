import type { DeviceSession } from "./deviceSession.js";
import { uploadBuffer } from "./meshBuffers.js";
import { packPbrAuthorColorEffects, type PbrAuthorColorEffects } from "./pbrAuthorColorEffects.js";

/** One renderer-owned output uniform, independent of the shared scene frame ABI. */
export class PbrAuthorColorBindings {
  readonly binding: GPUBindGroup;
  private readonly buffer: GPUBuffer;
  private data = packPbrAuthorColorEffects(undefined);
  private disposed = false;
  constructor(private readonly session: DeviceSession, layout: GPUBindGroupLayout) {
    this.buffer = uploadBuffer(session, "Deep author color effects", this.data, GPUBufferUsage.UNIFORM);
    try { this.binding = session.device.createBindGroup({ layout, entries: [{ binding: 0, resource: { buffer: this.buffer } }] }); }
    catch (error) { session.release(this.buffer); throw error; }
  }
  update(effects: PbrAuthorColorEffects | undefined): void {
    if (this.disposed) throw new Error("Author color bindings are disposed.");
    const next = packPbrAuthorColorEffects(effects);
    if (next.every((value, index) => value === this.data[index])) return;
    this.session.device.queue.writeBuffer(this.buffer, 0, next);
    this.data = next;
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.session.release(this.buffer);
  }
}
