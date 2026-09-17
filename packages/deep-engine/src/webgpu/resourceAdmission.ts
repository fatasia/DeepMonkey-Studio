import type { DeviceSession } from "./deviceSession.js";

/** 同步分配边界不需要异步 reservation：检查与 create/own 间没有 await。 */
export function createAdmittedBuffer(session: DeviceSession, descriptor: GPUBufferDescriptor): GPUBuffer {
  session.assertResourceAdmission?.({ size: descriptor.size });
  return session.own(session.device.createBuffer(descriptor));
}

export function createAdmittedTexture(session: DeviceSession, descriptor: GPUTextureDescriptor): GPUTexture {
  const size = descriptor.size;
  const dimensions = Symbol.iterator in Object(size) ? [...size as Iterable<number>] : undefined;
  const extent = size as GPUExtent3DDict;
  const normalizedSize = { width: dimensions?.[0] ?? extent.width,
    height: dimensions ? dimensions[1] ?? 1 : extent.height ?? 1,
    depthOrArrayLayers: dimensions ? dimensions[2] ?? 1 : extent.depthOrArrayLayers ?? 1 };
  session.assertResourceAdmission?.({ ...normalizedSize,
    dimension: descriptor.dimension ?? "2d", sampleCount: descriptor.sampleCount ?? 1,
    mipLevelCount: descriptor.mipLevelCount ?? 1, format: descriptor.format });
  return session.own(session.device.createTexture({ ...descriptor, size: normalizedSize }));
}
