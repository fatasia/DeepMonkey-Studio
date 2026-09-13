/// <reference types="@webgpu/types" />
import { MESHLET_BOUNDS_STRIDE, MESHLET_DESCRIPTOR_STRIDE } from "../geometry/types.js";
import type { HiZResult } from "./hiZPyramid.js";
import { MESHLET_CULL_WORKGROUP_SIZE } from "./meshletCullingWgsl.js";
import { prepareMeshletConeFrame } from "./meshletConeFrame.js";
import {
  MESHLET_CULL_MAX_COUNT,
  MESHLET_CULL_UNIFORM_SIZE,
  MESHLET_PLANNER_RECORD_STRIDE,
  type MeshletCullingInput,
  type MeshletCullingOptions,
  type MeshletCullingView,
} from "./meshletCullingTypes.js";

const IDENTITY = Object.freeze([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);

export interface ValidatedMeshletCull {
  readonly viewProjection: readonly number[];
  readonly worldFromObject: readonly number[];
  readonly coneCamera: readonly number[];
  readonly coneRadiusError: number;
  readonly frustum: readonly number[];
  readonly cameraPosition: readonly number[];
  readonly viewport: readonly number[];
  readonly reversedZ: boolean;
  readonly hiz: HiZResult | undefined;
  readonly normalCone: boolean;
  readonly depthBias: number;
  readonly nearClipEpsilon: number;
  readonly coneEpsilon: number;
  readonly capacity: number;
  readonly workgroups: number;
  readonly blocks: number;
}

export function validateMeshletCull(
  device: GPUDevice,
  input: MeshletCullingInput,
  view: MeshletCullingView,
  options: MeshletCullingOptions,
): ValidatedMeshletCull {
  kernelLimits(device);
  integer(input.count, 0, MESHLET_CULL_MAX_COUNT, "meshlet count");
  integer(input.revision, 0, Number.MAX_SAFE_INTEGER, "meshlet revision");
  validateBuffer(input.descriptors, input.count * MESHLET_DESCRIPTOR_STRIDE * 4, "descriptor");
  validateBuffer(input.bounds, input.count * MESHLET_BOUNDS_STRIDE * 4, "bounds");
  const storageLimit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
  if (input.count * MESHLET_DESCRIPTOR_STRIDE * 4 > storageLimit || input.count * MESHLET_BOUNDS_STRIDE * 4 > storageLimit) {
    throw new Error("Meshlet input exceeds a storage binding limit.");
  }
  const viewProjection = matrix(view.viewProjection, "viewProjection", false);
  const worldFromObject = matrix(view.worldFromObject ?? IDENTITY, "worldFromObject", true);
  const cameraPosition = vector(view.cameraPosition, 3, "cameraPosition");
  const coneFrame = prepareMeshletConeFrame(worldFromObject, cameraPosition);
  const viewport = vector(view.viewport, 2, "viewport");
  if (!viewport.every(value => Number.isInteger(value) && value > 0 && value <= device.limits.maxTextureDimension2D)) {
    throw new Error("Meshlet viewport must contain device-valid positive integer dimensions.");
  }
  if (typeof view.reversedZ !== "boolean") throw new Error("Meshlet reversedZ must be boolean.");
  const frustum = normalizeFrustum(view.frustum);
  if (view.hiz) validateHiZ(view.hiz, view.reversedZ);
  const normalCone = options.normalCone ?? true;
  if (typeof normalCone !== "boolean") throw new Error("Meshlet normalCone must be boolean.");
  const depthBias = finiteRange(options.depthBias ?? 0.0005, 0, 1, "depthBias");
  const nearClipEpsilon = finiteRange(options.nearClipEpsilon ?? 1e-5, Number.MIN_VALUE, 1, "nearClipEpsilon");
  const coneEpsilon = finiteRange(options.coneEpsilon ?? 1e-5, 0, 0.1, "coneEpsilon");
  const capacity = nextMeshletCapacity(Math.max(input.count, 1));
  const workgroups = Math.ceil(input.count / MESHLET_CULL_WORKGROUP_SIZE), blocks = Math.ceil(capacity / MESHLET_CULL_WORKGROUP_SIZE);
  if (workgroups > device.limits.maxComputeWorkgroupsPerDimension) throw new Error("Meshlet culling dispatch exceeds device limits.");
  for (const size of [capacity * 4, capacity * MESHLET_PLANNER_RECORD_STRIDE, blocks * 4, MESHLET_CULL_UNIFORM_SIZE]) {
    if (size > device.limits.maxBufferSize || size > (size === MESHLET_CULL_UNIFORM_SIZE
      ? device.limits.maxUniformBufferBindingSize : device.limits.maxStorageBufferBindingSize)) {
      throw new Error("Meshlet culling output exceeds device buffer limits.");
    }
  }
  return Object.freeze({ viewProjection, worldFromObject, coneCamera: coneFrame.camera, coneRadiusError: coneFrame.radiusError, frustum, cameraPosition, viewport,
    reversedZ: view.reversedZ, hiz: view.hiz, normalCone: normalCone && coneFrame.valid,
    depthBias, nearClipEpsilon, coneEpsilon, capacity, workgroups, blocks });
}

export function nextMeshletCapacity(count: number): number {
  if (!Number.isInteger(count) || count < 1 || count > MESHLET_CULL_MAX_COUNT) throw new Error("Invalid meshlet capacity request.");
  return 2 ** Math.ceil(Math.log2(count));
}

function kernelLimits(device: GPUDevice): void {
  const limits = device.limits;
  if (limits.maxComputeInvocationsPerWorkgroup < MESHLET_CULL_WORKGROUP_SIZE
    || limits.maxComputeWorkgroupSizeX < MESHLET_CULL_WORKGROUP_SIZE
    || limits.maxBindingsPerBindGroup < 10 || limits.maxStorageBuffersPerShaderStage < 8
    || limits.maxUniformBuffersPerShaderStage < 1 || limits.maxSampledTexturesPerShaderStage < 1) {
    throw new Error("Device limits cannot represent the meshlet culling kernel.");
  }
}

function validateBuffer(buffer: GPUBuffer, requiredSize: number, label: string): void {
  if (!buffer || buffer.size < Math.max(4, requiredSize) || (buffer.usage & GPUBufferUsage.STORAGE) === 0 || buffer.mapState !== "unmapped") {
    throw new Error(`Meshlet ${label} buffer is incompatible with the GPU ABI.`);
  }
}

function validateHiZ(hiz: HiZResult, reversedZ: boolean): void {
  const texture = hiz.texture;
  if (hiz.format !== "r32float" || texture.format !== "r32float" || (texture.usage & GPUTextureUsage.TEXTURE_BINDING) === 0
    || texture.dimension !== "2d" || texture.depthOrArrayLayers !== 1 || texture.sampleCount !== 1
    || hiz.width !== texture.width || hiz.height !== texture.height || hiz.width < 1 || hiz.height < 1
    || !Number.isSafeInteger(hiz.sourceRevision) || hiz.sourceRevision < 0
    || hiz.mipLevelCount < 1 || hiz.mipLevelCount !== hiz.levels.length || hiz.mipLevelCount > texture.mipLevelCount
    || hiz.levels.some((level, index) => level.level !== index || level.width !== Math.max(1, Math.floor(hiz.width / 2 ** index))
      || level.height !== Math.max(1, Math.floor(hiz.height / 2 ** index)))) throw new Error("Invalid meshlet Hi-Z pyramid.");
  if (hiz.reversedZ !== reversedZ || hiz.reduction !== (reversedZ ? "min" : "max")) {
    throw new Error("Meshlet Hi-Z depth convention or reduction is incompatible.");
  }
}

function matrix(value: ArrayLike<number>, label: string, affine: boolean): readonly number[] {
  const result = vector(value, 16, label);
  if (affine && (result[3] !== 0 || result[7] !== 0 || result[11] !== 0 || result[15] !== 1)) {
    throw new Error("Meshlet worldFromObject must be an affine column-major matrix.");
  }
  return result;
}

function normalizeFrustum(value: MeshletCullingView["frustum"]): readonly number[] {
  if (!value || !Array.isArray(value.planes) || value.planes.length !== 6) throw new Error("Meshlet frustum must contain six planes.");
  return value.planes.flatMap((plane) => {
    if (!plane || plane.length !== 4 || !plane.every(Number.isFinite)) throw new Error("Meshlet frustum planes must contain four finite values.");
    const length = Math.hypot(plane[0], plane[1], plane[2]);
    const normalized = [plane[0] / length, plane[1] / length, plane[2] / length, plane[3] / length];
    if (length <= 1e-8 || !normalized.every(value => Number.isFinite(Math.fround(value)))) throw new Error("Meshlet frustum plane is degenerate or overflows float32.");
    return normalized;
  });
}

function vector(value: ArrayLike<number>, length: number, label: string): readonly number[] {
  if (!value || value.length !== length) throw new Error(`Meshlet ${label} must contain ${length} values.`);
  const copy = Array.from(value);
  if (!copy.every(component => Number.isFinite(component) && Number.isFinite(Math.fround(component)))) {
    throw new Error(`Meshlet ${label} must contain finite float32 values.`);
  }
  return copy;
}

function integer(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${label}.`);
}

function finiteRange(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`Invalid meshlet ${label}.`);
  return value;
}
