/// <reference types="@webgpu/types" />
import { validateBuffer } from "./meshletIndirectValidation.js";
import { MESHLET_DRAW_INDEXED_INDIRECT_STRIDE, type MeshletIndirectPlan,
  type MeshletRenderBundleRequest } from "./meshletIndirectTypes.js";

export interface MeshletBundleSnapshot {
  readonly commands: GPUBuffer;
  readonly request: MeshletRenderBundleRequest;
}

export function buildMeshletRenderBundle(device: GPUDevice, plan: MeshletIndirectPlan,
  request: MeshletRenderBundleRequest): GPURenderBundle {
  validateMeshletRenderBundleRequest(device, plan, request);
  const encoder = device.createRenderBundleEncoder({ label: request.label ?? "Deep meshlet indirect bundle",
    colorFormats: request.colorFormats, ...(request.depthStencilFormat ? { depthStencilFormat: request.depthStencilFormat } : {}),
    ...(request.sampleCount !== undefined ? { sampleCount: request.sampleCount } : {}),
    ...(request.depthReadOnly !== undefined ? { depthReadOnly: request.depthReadOnly } : {}),
    ...(request.stencilReadOnly !== undefined ? { stencilReadOnly: request.stencilReadOnly } : {}) });
  encoder.setPipeline(request.pipeline);
  for (const entry of request.bindGroups ?? []) {
    if (entry.dynamicOffsets) encoder.setBindGroup(entry.index, entry.bindGroup, entry.dynamicOffsets);
    else encoder.setBindGroup(entry.index, entry.bindGroup);
  }
  for (const entry of request.vertexBuffers ?? []) {
    if (entry.size !== undefined) encoder.setVertexBuffer(entry.slot, entry.buffer, entry.offset ?? 0, entry.size);
    else if (entry.offset !== undefined) encoder.setVertexBuffer(entry.slot, entry.buffer, entry.offset);
    else encoder.setVertexBuffer(entry.slot, entry.buffer);
  }
  if (request.indexSize !== undefined) encoder.setIndexBuffer(request.indexBuffer, "uint32", request.indexOffset ?? 0, request.indexSize);
  else if (request.indexOffset !== undefined) encoder.setIndexBuffer(request.indexBuffer, "uint32", request.indexOffset);
  else encoder.setIndexBuffer(request.indexBuffer, "uint32");
  for (let draw = 0; draw < plan.capacity; draw += 1) {
    encoder.drawIndexedIndirect(plan.commands, draw * MESHLET_DRAW_INDEXED_INDIRECT_STRIDE);
  }
  return encoder.finish({ label: request.label ?? "Deep meshlet indirect bundle" });
}

export function sameBundleSnapshot(snapshot: MeshletBundleSnapshot, commands: GPUBuffer,
  request: MeshletRenderBundleRequest): boolean {
  const previous = snapshot.request;
  return snapshot.commands === commands && previous.pipeline === request.pipeline && previous.indexBuffer === request.indexBuffer
    && previous.indexOffset === request.indexOffset && previous.indexSize === request.indexSize
    && previous.label === request.label && previous.depthStencilFormat === request.depthStencilFormat
    && previous.sampleCount === request.sampleCount && previous.depthReadOnly === request.depthReadOnly
    && previous.stencilReadOnly === request.stencilReadOnly && sameValues(previous.colorFormats, request.colorFormats)
    && sameEntries(previous.vertexBuffers, request.vertexBuffers, ["slot", "buffer", "offset", "size"])
    && sameEntries(previous.bindGroups, request.bindGroups, ["index", "bindGroup", "dynamicOffsets"]);
}

export function validateMeshletRenderBundleRequest(device: GPUDevice, plan: MeshletIndirectPlan, request: MeshletRenderBundleRequest): void {
  if (!request || !request.pipeline || !Array.isArray(request.colorFormats)
    || request.colorFormats.length > device.limits.maxColorAttachments
    || request.colorFormats.some(format => format !== null && typeof format !== "string")) throw new Error("Invalid meshlet render bundle formats.");
  const sampleCount = request.sampleCount ?? 1;
  if (sampleCount !== 1 && sampleCount !== 4) throw new Error("Meshlet render bundle sampleCount must be 1 or 4.");
  if ((request.depthReadOnly !== undefined || request.stencilReadOnly !== undefined) && !request.depthStencilFormat) {
    throw new Error("Meshlet bundle read-only depth/stencil flags require a depth format.");
  }
  validateBuffer(request.indexBuffer, 4, GPUBufferUsage.INDEX, "index");
  const indexOffset = request.indexOffset ?? 0, indexSize = request.indexSize ?? request.indexBuffer.size - indexOffset;
  bufferRange(request.indexBuffer, indexOffset, indexSize, "index");
  if ((plan.firstIndexBase + plan.expandedIndexCount) * 4 > indexSize) throw new Error("Meshlet index binding cannot cover indirect firstIndex ranges.");
  ordered(request.vertexBuffers ?? [], "slot", device.limits.maxVertexBuffers, "vertex buffer");
  for (const entry of request.vertexBuffers ?? []) {
    validateBuffer(entry.buffer, 4, GPUBufferUsage.VERTEX, "vertex");
    bufferRange(entry.buffer, entry.offset ?? 0, entry.size ?? entry.buffer.size - (entry.offset ?? 0), "vertex");
  }
  ordered(request.bindGroups ?? [], "index", device.limits.maxBindGroups, "bind group");
  for (const entry of request.bindGroups ?? []) {
    if (!entry.bindGroup || entry.dynamicOffsets?.some(value => !Number.isInteger(value) || value < 0 || value > 0xffff_ffff)) {
      throw new Error("Invalid meshlet bundle bind group.");
    }
  }
}

function bufferRange(buffer: GPUBuffer, offset: number, size: number, label: string): void {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(size) || offset < 0 || size < 4
    || offset % 4 !== 0 || size % 4 !== 0 || offset + size > buffer.size) throw new Error(`Invalid meshlet ${label} buffer range.`);
}

function ordered<T extends object>(values: readonly T[], key: keyof T, maximum: number, label: string): void {
  let previous = -1;
  for (const value of values) {
    const index = value[key];
    if (!Number.isInteger(index) || (index as number) <= previous || (index as number) >= maximum) {
      throw new Error(`Meshlet ${label} slots must be unique, ascending, and device-valid.`);
    }
    previous = index as number;
  }
}

function sameValues(left: readonly unknown[] | undefined, right: readonly unknown[] | undefined): boolean {
  const a = left ?? [], b = right ?? [];
  return a.length === b.length && a.every((value, index) => Array.isArray(value)
    ? sameValues(value, b[index] as readonly unknown[]) : value === b[index]);
}

function sameEntries(left: readonly object[] | undefined, right: readonly object[] | undefined, keys: readonly string[]): boolean {
  const a = left ?? [], b = right ?? [];
  return a.length === b.length && a.every((value, index) => keys.every(key => {
    const l = (value as Record<string, unknown>)[key], r = (b[index] as Record<string, unknown>)[key];
    return Array.isArray(l) && Array.isArray(r) ? sameValues(l, r) : l === r;
  }));
}
