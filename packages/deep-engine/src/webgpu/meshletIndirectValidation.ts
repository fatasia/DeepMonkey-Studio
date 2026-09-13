/// <reference types="@webgpu/types" />
import { MESHLET_PLANNER_RECORD_STRIDE } from "./meshletCullingTypes.js";
import { MESHLET_INDIRECT_WORKGROUP_SIZE } from "./meshletIndirectWgsl.js";
import {
  MESHLET_DRAW_INDEXED_INDIRECT_STRIDE,
  MESHLET_INDIRECT_MAX_DRAWS,
  MESHLET_INDIRECT_PARAMETER_SIZE,
  type MeshletIndirectOptions,
  type ValidatedMeshletIndirect,
} from "./meshletIndirectTypes.js";

const MAPPING_CODES = Object.freeze({ constant: 0, "source-meshlet": 1, "visible-order": 2 });

export function validateMeshletIndirect(
  device: GPUDevice,
  source: ValidatedMeshletIndirect["source"],
  options: MeshletIndirectOptions,
): ValidatedMeshletIndirect {
  if (!source || source.mode !== "gpu" || !Number.isInteger(source.capacity) || source.capacity < 1
    || source.capacity > MESHLET_INDIRECT_MAX_DRAWS || (source.capacity & (source.capacity - 1)) !== 0
    || !Number.isInteger(source.inputCount) || source.inputCount < 1 || source.inputCount > source.capacity
    || source.recordStride !== MESHLET_PLANNER_RECORD_STRIDE) throw new Error("Invalid GPU meshlet culling result.");
  validateBuffer(source.visibleRecords, source.capacity * MESHLET_PLANNER_RECORD_STRIDE, GPUBufferUsage.STORAGE, "planner records");
  validateBuffer(source.visibleCount, 4, GPUBufferUsage.STORAGE, "visible count");
  const expandedIndexCount = uint(options.expandedIndexCount, "expandedIndexCount");
  if (expandedIndexCount < source.inputCount * 3) throw new Error("Expanded meshlet index count cannot cover every source meshlet.");
  const firstIndexBase = uint(options.firstIndexBase ?? 0, "firstIndexBase");
  if (expandedIndexCount > 0x1_0000_0000 - firstIndexBase) throw new Error("Meshlet firstIndex range overflows uint32.");
  const baseVertex = options.baseVertex ?? 0;
  if (!Number.isInteger(baseVertex) || baseVertex < -0x8000_0000 || baseVertex > 0x7fff_ffff) throw new Error("Invalid meshlet baseVertex.");
  const baseInstance = uint(options.baseInstance ?? 0, "baseInstance");
  const instanceMapping = options.instanceMapping ?? "constant";
  const mappingCode = MAPPING_CODES[instanceMapping];
  if (mappingCode === undefined) throw new Error("Invalid meshlet instance mapping.");
  const maximumInstanceOffset = instanceMapping === "constant" ? 0 : source.inputCount - 1;
  if (maximumInstanceOffset > 0xffff_ffff - baseInstance) throw new Error("Meshlet firstInstance mapping overflows uint32.");
  const workgroups = Math.ceil(source.capacity / MESHLET_INDIRECT_WORKGROUP_SIZE);
  if (workgroups > device.limits.maxComputeWorkgroupsPerDimension
    || device.limits.maxComputeInvocationsPerWorkgroup < MESHLET_INDIRECT_WORKGROUP_SIZE
    || device.limits.maxComputeWorkgroupSizeX < MESHLET_INDIRECT_WORKGROUP_SIZE) throw new Error("Meshlet indirect dispatch exceeds device limits.");
  const commandBytes = source.capacity * MESHLET_DRAW_INDEXED_INDIRECT_STRIDE;
  if (commandBytes > device.limits.maxBufferSize || commandBytes > device.limits.maxStorageBufferBindingSize
    || MESHLET_INDIRECT_PARAMETER_SIZE > device.limits.maxUniformBufferBindingSize) {
    throw new Error("Meshlet indirect buffers exceed device limits.");
  }
  return Object.freeze({ source, expandedIndexCount, firstIndexBase, baseVertex, baseInstance,
    instanceMapping, mappingCode, workgroups });
}

export function validateBuffer(buffer: GPUBuffer, minimumSize: number, usage: GPUBufferUsageFlags, label: string): void {
  if (!buffer || buffer.size < minimumSize || (buffer.usage & usage) === 0 || buffer.mapState !== "unmapped") {
    throw new Error(`Meshlet ${label} buffer is incompatible.`);
  }
}

function uint(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) throw new Error(`Invalid meshlet ${label}.`);
  return value;
}
