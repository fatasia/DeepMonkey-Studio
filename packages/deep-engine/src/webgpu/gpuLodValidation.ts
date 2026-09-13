/// <reference types="@webgpu/types" />
import type { LodCamera, LodViewport } from "../spatial/lodTypes.js";
import {
  GPU_LOD_LEVEL_STRIDE,
  GPU_LOD_MAX_LEVELS,
  GPU_LOD_MAX_OBJECTS,
  GPU_LOD_OBJECT_STRIDE,
  GPU_LOD_OUTPUT_STRIDE,
  GPU_LOD_UNIFORM_SIZE,
  GPU_LOD_WORKGROUP_SIZE,
  type GpuLodInput,
  type GpuLodSelectorOptions,
  type GpuLodView,
} from "./gpuLodTypes.js";

export interface ValidatedGpuLodCamera {
  readonly position: readonly [number, number, number];
  readonly forward: readonly [number, number, number];
  readonly projectionScale: number;
  readonly near: number;
  readonly far: number;
  readonly projectionMode: 0 | 1;
  readonly signature: readonly number[];
}

export interface ValidatedGpuLodRequest {
  readonly camera: ValidatedGpuLodCamera;
  readonly capacity: number;
  readonly workgroups: number;
  readonly cameraJump: boolean;
  readonly cameraJumpThreshold: number;
}

export function validateGpuLodRequest(device: GPUDevice, input: GpuLodInput, view: GpuLodView,
  options: GpuLodSelectorOptions): ValidatedGpuLodRequest {
  if (!input || typeof input !== "object") throw new TypeError("GPU LOD input is required.");
  integer(input.count, 0, GPU_LOD_MAX_OBJECTS, "GPU LOD input count");
  integer(input.revision, 0, Number.MAX_SAFE_INTEGER, "GPU LOD input revision");
  if (!input.objects || !input.levels) throw new TypeError("GPU LOD input buffers are required.");
  const requiredObjects = Math.max(GPU_LOD_OBJECT_STRIDE, input.count * GPU_LOD_OBJECT_STRIDE);
  const requiredLevels = Math.max(GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE,
    input.count * GPU_LOD_MAX_LEVELS * GPU_LOD_LEVEL_STRIDE);
  if (input.objects.size < requiredObjects || !(input.objects.usage & GPUBufferUsage.STORAGE)) throw new RangeError("GPU LOD object buffer is too small or lacks STORAGE usage.");
  if (input.levels.size < requiredLevels || !(input.levels.usage & GPUBufferUsage.STORAGE)) throw new RangeError("GPU LOD level buffer is too small or lacks STORAGE usage.");
  const capacity = nextGpuLodCapacity(input.count);
  const storageLimit = Math.min(device.limits.maxBufferSize, device.limits.maxStorageBufferBindingSize);
  for (const [size, label] of [[capacity * GPU_LOD_OUTPUT_STRIDE, "output"], [capacity * 4, "history"]] as const) {
    if (size > storageLimit) throw new RangeError(`GPU LOD ${label} buffer exceeds device storage limits.`);
  }
  if (requiredObjects > storageLimit || requiredLevels > storageLimit) throw new RangeError("GPU LOD input exceeds device storage binding limits.");
  if (GPU_LOD_UNIFORM_SIZE > device.limits.maxUniformBufferBindingSize) throw new RangeError("GPU LOD uniform exceeds device limits.");
  const workgroups = Math.ceil(input.count / GPU_LOD_WORKGROUP_SIZE);
  if (workgroups > device.limits.maxComputeWorkgroupsPerDimension) throw new RangeError("GPU LOD dispatch exceeds device limits.");
  const camera = validateGpuLodCamera(view.camera, view.viewport);
  const cameraJumpThreshold = options.cameraJumpThreshold ?? 0.35;
  if (!(cameraJumpThreshold === Infinity || Number.isFinite(cameraJumpThreshold) && cameraJumpThreshold >= 0)) throw new RangeError("GPU LOD camera jump threshold is invalid.");
  if (view.cameraJump !== undefined && typeof view.cameraJump !== "boolean") throw new TypeError("GPU LOD cameraJump must be boolean.");
  return Object.freeze({ camera, capacity, workgroups, cameraJump: view.cameraJump === true, cameraJumpThreshold });
}

export function validateGpuLodCamera(camera: LodCamera, viewport: LodViewport): ValidatedGpuLodCamera {
  if (!camera || typeof camera !== "object" || !viewport || typeof viewport !== "object") throw new TypeError("GPU LOD camera and viewport are required.");
  integer(viewport.width, 1, 65_536, "GPU LOD viewport width"); integer(viewport.height, 1, 65_536, "GPU LOD viewport height");
  const position = vec3(camera.position, "GPU LOD camera position");
  const sourceForward = vec3(camera.forward, "GPU LOD camera forward");
  const length = Math.hypot(...sourceForward);
  if (length <= 1e-12) throw new RangeError("GPU LOD camera forward vector is zero.");
  const forward = sourceForward.map(value => Math.fround(value / length)) as unknown as [number, number, number];
  finite(camera.near, "GPU LOD camera near", true); finite(camera.far, "GPU LOD camera far", true);
  if (camera.far <= camera.near) throw new RangeError("GPU LOD camera far must exceed near.");
  let projectionScale: number, projectionMode: 0 | 1;
  if (camera.projection === "perspective") {
    finite(camera.verticalFovRadians, "GPU LOD vertical field of view", true);
    if (camera.verticalFovRadians >= Math.PI) throw new RangeError("GPU LOD field of view must be less than pi.");
    projectionScale = viewport.height / (2 * Math.tan(camera.verticalFovRadians / 2)); projectionMode = 0;
  } else if (camera.projection === "orthographic") {
    finite(camera.verticalSize, "GPU LOD orthographic vertical size", true);
    projectionScale = viewport.height / camera.verticalSize; projectionMode = 1;
  } else throw new TypeError("GPU LOD camera projection is invalid.");
  projectionScale = Math.fround(projectionScale);
  const validated = { position: position.map(Math.fround) as unknown as [number, number, number], forward,
    projectionScale, near: Math.fround(camera.near), far: Math.fround(camera.far), projectionMode };
  return Object.freeze({ ...validated, signature: Object.freeze([...validated.position, ...forward,
    projectionScale, validated.near, validated.far, projectionMode]) });
}

export function nextGpuLodCapacity(count: number): number {
  if (count === 0) return 1;
  return 2 ** Math.ceil(Math.log2(count));
}

export function cameraSignatureJumped(previous: readonly number[] | undefined, next: readonly number[], threshold: number): boolean {
  if (!previous || previous.length !== next.length) return true;
  if (previous.at(-1) !== next.at(-1)) return true;
  if (threshold === Infinity) return false;
  return next.some((value, index) => Math.abs(value - previous[index]!) > threshold);
}

function vec3(value: readonly number[], label: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new TypeError(`${label} is invalid.`);
  value.forEach(component => finite(component, label));
  return [value[0]!, value[1]!, value[2]!];
}

function finite(value: number, label: string, positive = false): void {
  if (!Number.isFinite(value) || positive && value <= 0 || !Number.isFinite(Math.fround(value))) throw new RangeError(`${label} is invalid.`);
}

function integer(value: number, minimum: number, maximum: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new RangeError(`${label} is invalid.`);
}
