/// <reference types="@webgpu/types" />
import { GPU_CULL_INDIRECT_STRIDE, GPU_CULL_INSTANCE_STRIDE } from "./gpuFrustumCulling.js";
import {
  HI_Z_OCCLUSION_MAX_INSTANCES,
  HI_Z_OCCLUSION_WORKGROUP_SIZE,
  type HiZOcclusionInput,
  type HiZOcclusionOptions,
  type HiZOcclusionView,
} from "./hiZOcclusionTypes.js";

export interface ValidatedHiZOcclusionRequest {
  readonly temporal: boolean;
  readonly cameraCut: boolean;
  readonly cameraJumpThreshold: number;
  readonly depthBias: number;
  readonly nearClipEpsilon: number;
  readonly indexArgs: readonly [number, number, number, number];
}

export function validateHiZOcclusionRequest(device: GPUDevice, input: HiZOcclusionInput, view: HiZOcclusionView,
  options: HiZOcclusionOptions): ValidatedHiZOcclusionRequest {
  if (!Number.isInteger(input.count) || input.count < 0 || input.count > HI_Z_OCCLUSION_MAX_INSTANCES) throw new Error("Invalid Hi-Z occlusion input count.");
  if (!Number.isSafeInteger(input.revision) || input.revision < 0) throw new Error("Invalid Hi-Z occlusion input revision.");
  validateBuffer(input.instances, input.count * GPU_CULL_INSTANCE_STRIDE, GPUBufferUsage.STORAGE, "instance");
  validateBuffer(input.bounds, input.count * 16, GPUBufferUsage.STORAGE, "bounds");
  if (view.viewProjection.length !== 16 || !view.viewProjection.every(Number.isFinite)) throw new Error("Hi-Z viewProjection must contain 16 finite values.");
  if (view.cameraPosition.length !== 3 || !view.cameraPosition.every(Number.isFinite)) throw new Error("Hi-Z cameraPosition must contain three finite values.");
  if (view.viewport.length !== 2 || !view.viewport.every(value => Number.isInteger(value) && value > 0
    && value <= device.limits.maxTextureDimension2D)) throw new Error("Hi-Z viewport must contain device-valid positive integer dimensions.");
  validatePyramid(view);
  const workgroups = Math.ceil(input.count / HI_Z_OCCLUSION_WORKGROUP_SIZE);
  if (workgroups > device.limits.maxComputeWorkgroupsPerDimension) throw new Error("Hi-Z occlusion dispatch exceeds device limits.");
  const capacity = nextHiZOcclusionCapacity(Math.max(input.count, 1));
  const storageLimit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
  if (capacity * 4 > storageLimit) throw new Error("Hi-Z occlusion output exceeds storage buffer limits.");
  const temporal = options.temporal ?? true, cameraCut = options.cameraCut ?? false;
  if (typeof temporal !== "boolean" || typeof cameraCut !== "boolean") throw new Error("Invalid Hi-Z temporal options.");
  const cameraJumpThreshold = options.cameraJumpThreshold ?? 0.35, depthBias = options.depthBias ?? 0.0005,
    nearClipEpsilon = options.nearClipEpsilon ?? 1e-5;
  if (!Number.isFinite(cameraJumpThreshold) || cameraJumpThreshold < 0
    || !Number.isFinite(depthBias) || depthBias < 0 || depthBias > 1
    || !Number.isFinite(nearClipEpsilon) || nearClipEpsilon <= 0 || nearClipEpsilon > 1) throw new Error("Invalid Hi-Z occlusion tuning.");
  const indexArgs = [input.indexCount, input.firstIndex ?? 0, input.baseVertex ?? 0, input.firstInstance ?? 0] as const;
  packHiZOcclusionIndirect(indexArgs);
  if (indexArgs[3] !== 0) throw new Error("Hi-Z visible-index indirection currently requires firstInstance 0.");
  return { temporal, cameraCut, cameraJumpThreshold, depthBias, nearClipEpsilon, indexArgs };
}

function validatePyramid(view: HiZOcclusionView): void {
  const hiz = view.hiz;
  if (hiz.format !== "r32float" || hiz.texture.format !== "r32float"
    || (hiz.texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0) throw new Error("Hi-Z occlusion requires a sampled r32float pyramid.");
  if (!Number.isSafeInteger(hiz.sourceRevision) || hiz.sourceRevision < 0
    || hiz.texture.dimension !== "2d" || hiz.texture.depthOrArrayLayers !== 1 || hiz.texture.sampleCount !== 1
    || hiz.width !== hiz.texture.width || hiz.height !== hiz.texture.height || hiz.width < 1 || hiz.height < 1
    || hiz.mipLevelCount < 1 || hiz.mipLevelCount !== hiz.levels.length || hiz.mipLevelCount > hiz.texture.mipLevelCount
    || hiz.levels.some((level, index) => level.level !== index || level.width !== Math.max(1, Math.floor(hiz.width / 2 ** index))
      || level.height !== Math.max(1, Math.floor(hiz.height / 2 ** index)))) throw new Error("Invalid Hi-Z pyramid dimensions or mip levels.");
  const requiredReduction = view.reversedZ ? "min" : "max";
  if (hiz.reversedZ !== view.reversedZ || hiz.reduction !== requiredReduction) throw new Error("Hi-Z depth convention or reduction is incompatible with occlusion.");
}

function validateBuffer(buffer: GPUBuffer, requiredSize: number, usage: GPUBufferUsageFlags, name: string): void {
  if (buffer.size < requiredSize || (buffer.usage & usage) === 0 || buffer.mapState !== "unmapped") {
    throw new Error(`Hi-Z ${name} buffer is incompatible with the Deep culling ABI.`);
  }
}

export function packHiZOcclusionIndirect(args: readonly [number, number, number, number]): ArrayBuffer {
  const [indexCount, firstIndex, baseVertex, firstInstance] = args;
  if (!Number.isInteger(indexCount) || indexCount < 0 || indexCount > 0xffffffff
    || !Number.isInteger(firstIndex) || firstIndex < 0 || firstIndex > 0xffffffff
    || !Number.isInteger(baseVertex) || baseVertex < -0x80000000 || baseVertex > 0x7fffffff
    || !Number.isInteger(firstInstance) || firstInstance < 0 || firstInstance > 0xffffffff) throw new Error("Invalid Hi-Z indirect draw arguments.");
  const packed = new ArrayBuffer(GPU_CULL_INDIRECT_STRIDE), view = new DataView(packed);
  view.setUint32(0, indexCount, true); view.setUint32(4, 0, true); view.setUint32(8, firstIndex, true);
  view.setInt32(12, baseVertex, true); view.setUint32(16, firstInstance, true); return packed;
}

export function nextHiZOcclusionCapacity(count: number): number {
  return 2 ** Math.ceil(Math.log2(Math.max(1, count)));
}
