/// <reference types="@webgpu/types" />
import type { ExpandedMeshletIndices } from "../geometry/meshletIndices.js";
import type { DeviceSession } from "./deviceSession.js";

/** Owns one preserve- or flip-winding expanded uint32 meshlet index buffer. */
export class MeshletIndexBuffer {
  readonly buffer: GPUBuffer;
  readonly indexCount: number;
  readonly meshletCount: number;
  readonly winding: ExpandedMeshletIndices["winding"];
  private disposed = false;

  constructor(private readonly session: DeviceSession, source: ExpandedMeshletIndices) {
    if (session.state !== "ready") throw new Error("GPU session is not ready for meshlet index upload.");
    validateExpanded(source);
    this.indexCount = source.indices.length;
    this.meshletCount = source.meshletCount;
    this.winding = source.winding;
    const buffer = session.own(session.device.createBuffer({ label: `Deep meshlet ${source.winding} indices`,
      size: Math.max(4, source.indices.byteLength), usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC }));
    try { session.device.queue.writeBuffer(buffer, 0, source.indices); }
    catch (error) { session.release(buffer); throw error; }
    this.buffer = buffer;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; this.session.release(this.buffer);
  }
}

function validateExpanded(source: ExpandedMeshletIndices): void {
  if (!source || !(source.indices instanceof Uint32Array) || !(source.ranges instanceof Uint32Array)
    || !Number.isSafeInteger(source.meshletCount) || source.meshletCount < 0
    || !Number.isSafeInteger(source.triangleCount) || source.triangleCount < 0
    || source.indices.length !== source.triangleCount * 3 || source.ranges.length !== source.meshletCount * 2
    || (source.winding !== "preserve" && source.winding !== "flip")) throw new Error("Invalid expanded meshlet index data.");
  let expectedFirst = 0;
  for (let meshlet = 0; meshlet < source.meshletCount; meshlet += 1) {
    const first = source.ranges[meshlet * 2]!, count = source.ranges[meshlet * 2 + 1]!;
    if (first !== expectedFirst || count < 3 || count % 3 !== 0 || first + count > source.indices.length) {
      throw new Error("Expanded meshlet index ranges must be contiguous complete triangles.");
    }
    expectedFirst += count;
  }
  if (expectedFirst !== source.indices.length || (source.meshletCount === 0) !== (source.indices.length === 0)) {
    throw new Error("Expanded meshlet index ranges do not cover the index data.");
  }
}
