/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { createAdmittedBuffer } from "../webgpu/resourceAdmission.js";
import { uploadBuffer } from "../webgpu/meshBuffers.js";
import { SDF_SKY_VISIBILITY_PARAMS_BYTES } from "./sdfSkyVisibilityTraceWgsl.js";
import { SDF_GI_PROBE_UPDATE_PARAMS_BYTES, SDF_GI_PROBE_RECORD_VEC4_STRIDE } from "./sdfGiProbeUpdateWgsl.js";
import { packInitialSdfGiRecords, packSdfGiDirectionTable, packSdfGiProbePositions,
  packSdfGiSkyTraceParams } from "./sdfGiPacking.js";
import type { SdfGiBakedGrid } from "./sdfSceneBakeGpu.js";
import type { SdfGiGpuSlots } from "./sdfGiRuntimeTypes.js";

/**
 * Brief-GI M3:烘焙帧 GPU 槽位装配(自 sdfGiProductionRuntime.uploadSlots 提取,守
 * 300 行体量门)。职责单一:上传/直连静态层输入 + 建 trace/update 绑定组。
 * 失败回滚自持(created 数组);旧槽位释放归调用方(失败路径保留旧槽语义不变)。
 * `gpuField` 给定时零拷贝直用(GPU 烘焙输出;CPU 路径上传 grid.distances)。
 */

// WebGPU usage 数值常量(sdfGiProductionRuntime 同款先例)。
const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_COPY_SRC = 0x4, USAGE_UNIFORM = 0x40;
const STORAGE_READ = USAGE_STORAGE | USAGE_COPY_DST;
const STORAGE_RW = USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC;

export interface SdfGiSlotsBuildInput {
  readonly session: DeviceSession;
  readonly grid: SdfGiBakedGrid;
  readonly positions: readonly (readonly number[])[];
  readonly config: { steps: number; coneTan: number; maxDistance: number };
  readonly gpuField?: GPUBuffer;
  readonly traceLayout: GPUBindGroupLayout;
  readonly updateLayout: GPUBindGroupLayout;
  readonly directionCount: number;
}

/** 重建 GPU 槽位并上传静态层输入(烘焙帧;失败时新建资源回滚,抛错交调用方)。 */
export function buildSdfGiSlots(input: SdfGiSlotsBuildInput): SdfGiGpuSlots {
  const { session, grid, positions, config, gpuField } = input;
  const directionCount = input.directionCount;
  const probeCount = positions.length;
  const field = gpuField ?? uploadBuffer(session, "Deep SDF GI scene field",
    grid.distances, STORAGE_READ);
  const probePositions = uploadBuffer(session, "Deep SDF GI probe positions",
    packSdfGiProbePositions(positions), STORAGE_READ);
  const directions = uploadBuffer(session, "Deep SDF GI directions",
    packSdfGiDirectionTable(directionCount), STORAGE_READ);
  const visibilities = createAdmittedBuffer(session, { label: "Deep SDF GI sky visibility",
    size: Math.max(16, probeCount * directionCount * 4), usage: STORAGE_RW });
  // 记录行 = 24 float = 96B/探针(SDF_GI_PROBE_RECORD_VEC4_STRIDE=6 vec4 × 16B)。
  const records = createAdmittedBuffer(session, { label: "Deep SDF GI probe records",
    size: Math.max(16, probeCount * SDF_GI_PROBE_RECORD_VEC4_STRIDE * 16), usage: STORAGE_RW });
  const skyRadiance = createAdmittedBuffer(session, { label: "Deep SDF GI sky radiance",
    size: Math.max(16, directionCount * 16), usage: STORAGE_READ });
  const traceParams = uploadBuffer(session, "Deep SDF GI trace params",
    new Float32Array(SDF_SKY_VISIBILITY_PARAMS_BYTES / 4), USAGE_UNIFORM);
  const updateParams = uploadBuffer(session, "Deep SDF GI update params",
    new Float32Array(SDF_GI_PROBE_UPDATE_PARAMS_BYTES / 4), USAGE_UNIFORM);
  const created = [field, probePositions, directions, visibilities, records, skyRadiance,
    traceParams, updateParams];
  try {
    session.device.queue.writeBuffer(traceParams, 0, packSdfGiSkyTraceParams({
      origin: grid.origin, cellSize: grid.cellSize, dimensions: grid.dimensions,
      steps: config.steps, coneTan: config.coneTan, maxDistance: config.maxDistance,
      directionCount, probeCount }));
    session.device.queue.writeBuffer(records, 0,
      packInitialSdfGiRecords(probeCount, config.maxDistance));
    const traceBindGroup = session.device.createBindGroup({
      label: "Deep SDF GI sky trace bindings", layout: input.traceLayout, entries: [
        { binding: 0, resource: { buffer: traceParams } },
        { binding: 1, resource: { buffer: field } },
        { binding: 2, resource: { buffer: probePositions } },
        { binding: 3, resource: { buffer: directions } },
        { binding: 4, resource: { buffer: visibilities } },
      ] });
    const updateBindGroup = session.device.createBindGroup({
      label: "Deep SDF GI probe update bindings", layout: input.updateLayout, entries: [
        { binding: 0, resource: { buffer: updateParams } },
        { binding: 1, resource: { buffer: visibilities } },
        { binding: 2, resource: { buffer: skyRadiance } },
        { binding: 3, resource: { buffer: records } },
      ] });
    return { field, probePositions, directions, visibilities, records, skyRadiance,
      traceParams, updateParams, traceBindGroup, updateBindGroup, probeCount,
      cells: grid.cells };
  } catch (error) {
    for (const buffer of created.reverse()) session.release(buffer);
    throw error;
  }
}

/** 槽位资源清单(释放面;runtime dispose/rebuild 共用单一来源)。 */
export function sdfGiSlotBuffers(slots: SdfGiGpuSlots): readonly GPUBuffer[] {
  return [slots.field, slots.probePositions, slots.directions, slots.visibilities,
    slots.records, slots.skyRadiance, slots.traceParams, slots.updateParams];
}
