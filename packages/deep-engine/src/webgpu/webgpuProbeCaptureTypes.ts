/// <reference types="@webgpu/types" />
import type { ProbeCaptureBeginContext } from "../lighting/probeClipmapCaptureExecutor.js";
import type { ProbeClipmapPlan, ProbeUpdate, ProbeVector3 } from "../lighting/probeClipmapPlan.js";
import { WEBGPU_PROBE_CAPTURE_WORKGROUP } from "./webgpuProbeCaptureWgsl.js";

export const WEBGPU_PROBE_VOLUME_FORMAT = "rgba16float" as const satisfies GPUTextureFormat;
export const WEBGPU_PROBE_UNIFORM_BYTES = 48;

export interface WebGpuProbeRadianceContext {
  readonly encoder: GPUCommandEncoder;
  readonly update: ProbeUpdate;
  readonly updateIndex: number;
  readonly destination: GPUTexture;
  readonly destinationView: GPUTextureView;
  readonly destinationOrigin: Readonly<{ x: number; y: number; z: number }>;
  readonly context: ProbeCaptureBeginContext;
}
export type WebGpuProbeRadianceEncoder = (context: WebGpuProbeRadianceContext) => void;
export interface WebGpuProbeCaptureOptions {
  readonly fallbackRadiance?: ProbeVector3;
  readonly maxTransientBytes?: number;
  readonly encodeSourceRadiance?: WebGpuProbeRadianceEncoder;
  /** Previous-frame weight for scheduler-classified dynamic probes. */
  readonly dynamicIrradianceHysteresis?: number;
  /** F1 slice-3: max per-channel frame-to-frame change relative to history; 0 (default) disables. */
  readonly energyClamp?: number;
  /** F1 slice-3: bounded feedback weight for non-dynamic probes; 0 (default) keeps them fresh-only. */
  readonly staticIrradianceHysteresis?: number;
}
export interface WebGpuProbeCaptureSubmission {
  readonly commandBuffer: GPUCommandBuffer;
  readonly checked: Promise<void>;
}
export interface WebGpuProbeSamplingBinding {
  readonly deviceEpoch: string;
  readonly generation: number;
  readonly profileKey: string;
  readonly texture: GPUTexture;
  readonly view: GPUTextureView;
  readonly sampler: GPUSampler;
  readonly levelMetadataBuffer: GPUBuffer;
  readonly format: typeof WEBGPU_PROBE_VOLUME_FORMAT;
  readonly width: number;
  readonly height: number;
  readonly depthOrArrayLayers: number;
  readonly mipLevelCount: number;
  readonly allocatedBytes: number;
}
export interface ProbeVolumeSize {
  readonly key: string;
  readonly width: number;
  readonly height: number;
  readonly layers: number;
  readonly mipCount: number;
  readonly bytes: number;
}

export function validateProbeVolume(device: GPUDevice, plan: ProbeClipmapPlan,
  maxBytes: number): ProbeVolumeSize {
  const width = plan.profile.gridSize[0], height = plan.profile.gridSize[1];
  const layers = plan.profile.gridSize[2] * plan.profile.levelCount;
  const mipCount = Math.floor(Math.log2(Math.max(width, height))) + 1;
  const bytes = Array.from({ length: mipCount }, (_, mip) => probeMipSize(width, mip)
    * probeMipSize(height, mip) * layers * 8).reduce((sum, value) => sum + value, 0);
  const transient = bytes * 2 + WEBGPU_PROBE_UNIFORM_BYTES
    + plan.profile.levelMetadataBytes + plan.profile.updateListBytes;
  const dispatch = device.limits.maxComputeWorkgroupsPerDimension;
  if (width > device.limits.maxTextureDimension2D || height > device.limits.maxTextureDimension2D
    || layers > device.limits.maxTextureArrayLayers || transient > maxBytes
    || layers > dispatch || Math.ceil(width / 8) > dispatch || Math.ceil(height / 8) > dispatch
    || Math.ceil(plan.updates.length / WEBGPU_PROBE_CAPTURE_WORKGROUP) > dispatch) {
    throw new RangeError("Probe capture volume exceeds WebGPU limits or transient budget.");
  }
  return Object.freeze({ key: `${width}x${height}x${layers}x${mipCount}`,
    width, height, layers, mipCount, bytes });
}
export function validateProbeRadiance(value: ProbeVector3): ProbeVector3 {
  if (!Array.isArray(value) || value.length !== 3 || value.some(channel =>
    typeof channel !== "number" || !Number.isFinite(channel) || channel < 0 || channel > 65_504)) {
    throw new RangeError("fallbackRadiance must contain three finite positive half-float channels.");
  }
  return Object.freeze([...value]) as unknown as ProbeVector3;
}
export function validateProbeHysteresis(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("dynamicIrradianceHysteresis must be in [0, 1).");
  }
  return value;
}
export function validateProbeEnergyClamp(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new RangeError("energyClamp must be a non-negative finite number.");
  }
  return value;
}
export function packProbeCaptureUniform(plan: ProbeClipmapPlan, fallback: ProbeVector3,
  dynamicHysteresis: number, hasHistory: boolean, energyClamp = 0, staticHysteresis = 0): ArrayBuffer {
  const data = new ArrayBuffer(WEBGPU_PROBE_UNIFORM_BYTES);
  new Uint32Array(data).set([plan.updates.length, plan.profile.gridSize[2], plan.profile.levelCount]);
  const floats = new Float32Array(data); floats[3] = hasHistory ? dynamicHysteresis : 0;
  floats.set([...fallback, 1], 4);
  // F1 slice-3: bounded history feedback. energyClamp 0 disables the frame-to-frame energy
  // clamp; staticHysteresis 0 keeps static probes purely freshly filtered (both bit-exact
  // with the previous contract when left at their defaults).
  floats[8] = energyClamp;
  floats[9] = hasHistory ? staticHysteresis : 0;
  return data;
}
export function positiveProbeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer.`);
  return value;
}
export function assertProbeUpdate(plan: ProbeClipmapPlan, update: ProbeUpdate, index: number): void {
  if (plan.updates[index] !== update) throw new Error("Probe capture update order changed.");
}
export function probeMipSize(value: number, mip: number): number {
  return Math.max(1, Math.floor(value / 2 ** mip));
}
export function probeStorageLayout(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } };
}
export function probeUniformLayout(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } };
}
export function probeSampledTextureLayout(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE,
    texture: { sampleType: "float", viewDimension: "2d-array", multisampled: false } };
}
export function probeStorageTextureLayout(binding: number): GPUBindGroupLayoutEntry {
  return { binding, visibility: GPUShaderStage.COMPUTE,
    storageTexture: { access: "write-only", format: WEBGPU_PROBE_VOLUME_FORMAT, viewDimension: "2d-array" } };
}
export function probeAbortError(message: string): Error {
  const error = new Error(message); error.name = "AbortError"; return error;
}
