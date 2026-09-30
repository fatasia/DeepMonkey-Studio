/**
 * A2 SDF 碰撞 profile:内存预算(分辨率 × 字节数,全显式)+ GPU dispatch 宿主。
 * (按职责从 sdfCollisionProfile.ts 拆分;总合同语义见彼处头注。)
 *
 * opt-in 语义由类型强制:GPU 查询只接受 createSdfCollisionProfile 的产物,
 * 不存在「默认开启」路径;与 sdfGpuQuery.ts 的证据路径并存,互不替代。
 */
import {
  DEEP_SDF_COLLISION_QUERY_WGSL, SDF_QUERY_ENTRY, SDF_QUERY_MAX_POINTS, SDF_QUERY_NAN_BITS,
  SDF_QUERY_PARAMS_BYTES, SDF_QUERY_WORKGROUP_SIZE,
} from "./sdfCollisionQueryWgsl.js";
import type { SdfGrid } from "./sdfGrid.js";
import type { SdfCollisionProfile } from "./sdfCollisionProfile.js";

export {
  DEEP_SDF_COLLISION_QUERY_WGSL, SDF_QUERY_ENTRY, SDF_QUERY_MAX_POINTS, SDF_QUERY_NAN_BITS,
  SDF_QUERY_PARAMS_BYTES, SDF_QUERY_WORKGROUP_SIZE,
};

/** 与 sdfGrid 的 MAX_CELLS 同源上界(本模块是内存预算的所有者,profile 侧引用)。 */
export const MAX_SDF_PROFILE_GRID_CELLS = 262_144;

// ─── 内存预算(分辨率 × 字节数,全显式) ───────────────────────────────────────

export interface SdfCollisionMemoryEstimate {
  readonly cells: number;
  /** 距离场:f32 × cells。 */
  readonly fieldBytes: number;
  /** 查询点 vec4f × count。 */
  readonly queryBufferBytes: number;
  /** 结果 vec4f × count(梯度 xyz + distance w)。 */
  readonly resultBufferBytes: number;
  /** 状态 u32 × count。 */
  readonly statusBufferBytes: number;
  /** uniform 参数(固定 48 B)。 */
  readonly paramsBytes: number;
  /** 上传小计(field + queries + params)。 */
  readonly uploadBytes: number;
  /** 全部 GPU 缓冲合计。 */
  readonly totalBytes: number;
}

/** 分辨率 × 字节数;超预算(网格 cells、单批查询数)fail-closed 抛错,不静默截断。 */
export function estimateSdfCollisionMemory(
  dimensions: readonly [number, number, number], queryCount: number,
): SdfCollisionMemoryEstimate {
  const [nx, ny, nz] = dimensions;
  const cells = nx * ny * nz;
  if (![nx, ny, nz].every(value => Number.isSafeInteger(value) && value >= 2 && value <= 128)
    || !Number.isSafeInteger(cells) || cells > MAX_SDF_PROFILE_GRID_CELLS) {
    throw new RangeError(
      `SDF 碰撞 profile 网格尺寸超预算(每维 2..128、cells ≤ ${MAX_SDF_PROFILE_GRID_CELLS}),实测 ${nx}×${ny}×${nz}`,
    );
  }
  if (!Number.isSafeInteger(queryCount) || queryCount < 1 || queryCount > SDF_QUERY_MAX_POINTS) {
    throw new RangeError(`SDF 查询点数量必须是 1..${SDF_QUERY_MAX_POINTS},实测 ${queryCount}`);
  }
  const fieldBytes = cells * 4;
  const queryBufferBytes = queryCount * 16;
  const resultBufferBytes = queryCount * 16;
  const statusBufferBytes = queryCount * 4;
  const paramsBytes = SDF_QUERY_PARAMS_BYTES;
  const uploadBytes = fieldBytes + queryBufferBytes + paramsBytes;
  return {
    cells, fieldBytes, queryBufferBytes, resultBufferBytes, statusBufferBytes, paramsBytes,
    uploadBytes, totalBytes: uploadBytes + resultBufferBytes + statusBufferBytes,
  };
}

// ─── GPU dispatch 宿主 ─────────────────────────────────────────────────────────

export interface SdfCollisionGpuBatch {
  /** trilinear 有符号距离(域外 lane 为 quiet NaN 0x7fc00000)。 */
  readonly distances: Float32Array<ArrayBuffer>;
  /** 梯度 xyz 交叠(域外 lane 为 0)。 */
  readonly gradients: Float32Array<ArrayBuffer>;
  /** 0 = 域内;1 = 域外。宿主合同:任何非 0 ⇒ 调用方整批拒绝。 */
  readonly statuses: Uint32Array<ArrayBuffer>;
}

/** uniform 打包(48 B,布局与 WGSL QueryParams 互钉;测试逐字段回读)。 */
export function packSdfQueryParams(grid: Pick<SdfGrid, "origin" | "cellSize" | "dimensions">,
  count: number, contactSkin: number): ArrayBuffer {
  if (!Number.isSafeInteger(count) || count < 1 || count > SDF_QUERY_MAX_POINTS) {
    throw new RangeError(`SDF 查询点数量必须是 1..${SDF_QUERY_MAX_POINTS},实测 ${count}`);
  }
  const params = new ArrayBuffer(SDF_QUERY_PARAMS_BYTES);
  const view = new DataView(params);
  grid.origin.forEach((value, axis) => view.setFloat32(axis * 4, value, true));
  view.setFloat32(12, grid.cellSize, true);
  grid.dimensions.forEach((value, axis) => view.setUint32(16 + axis * 4, value, true));
  view.setUint32(28, count, true);
  view.setFloat32(32, contactSkin, true);
  return params;
}

/**
 * 真机 WebGPU 批次查询。opt-in 由参数类型强制(只接受 createSdfCollisionProfile
 * 的产物);返回前不做静默降级:非有限查询点、域外状态一律原样返回,由调用方按
 * 合同拒绝。无 GPU 设备时本函数不可用(不做 CPU 回退冒充 GPU 证据)。
 */
export async function querySdfCollisionsGpu(
  device: GPUDevice, profile: SdfCollisionProfile, points: readonly (readonly [number, number, number])[],
): Promise<SdfCollisionGpuBatch> {
  const count = points.length;
  if (count < 1 || count > SDF_QUERY_MAX_POINTS || points.some(point => !point.every(Number.isFinite))) {
    throw new RangeError("SDF GPU 查询点数量或数值非法");
  }
  const params = packSdfQueryParams(profile.grid, count, profile.contactSkin);
  const queryBuffer = new Float32Array(count * 4);
  points.forEach((point, index) => {
    queryBuffer[index * 4] = point[0]!;
    queryBuffer[index * 4 + 1] = point[1]!;
    queryBuffer[index * 4 + 2] = point[2]!;
  });
  const memory = estimateSdfCollisionMemory(profile.grid.dimensions, count);
  const make = (size: number, usage: GPUBufferUsageFlags, source?: ArrayBufferView<ArrayBuffer> | ArrayBuffer) => {
    const buffer = device.createBuffer({ size: Math.max(4, size), usage });
    if (source) device.queue.writeBuffer(buffer, 0, source);
    return buffer;
  };
  const uniform = make(memory.paramsBytes, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, params);
  const field = make(memory.fieldBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, profile.grid.distances);
  const queries = make(memory.queryBufferBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, queryBuffer);
  const results = make(memory.resultBufferBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const statuses = make(memory.statusBufferBytes, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);
  const resultRead = make(memory.resultBufferBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  const statusRead = make(memory.statusBufferBytes, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
  try {
    const module = device.createShaderModule({ code: DEEP_SDF_COLLISION_QUERY_WGSL });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto", compute: { module, entryPoint: SDF_QUERY_ENTRY },
    });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: uniform } }, { binding: 1, resource: { buffer: field } },
      { binding: 2, resource: { buffer: queries } }, { binding: 3, resource: { buffer: results } },
      { binding: 4, resource: { buffer: statuses } },
    ] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(Math.ceil(count / SDF_QUERY_WORKGROUP_SIZE));
    pass.end();
    encoder.copyBufferToBuffer(results, 0, resultRead, 0, memory.resultBufferBytes);
    encoder.copyBufferToBuffer(statuses, 0, statusRead, 0, memory.statusBufferBytes);
    device.queue.submit([encoder.finish()]);
    await resultRead.mapAsync(GPUMapMode.READ);
    await statusRead.mapAsync(GPUMapMode.READ);
    const resultView = new DataView(resultRead.getMappedRange().slice(0));
    const statusView = new DataView(statusRead.getMappedRange().slice(0));
    const distances = new Float32Array(count);
    const gradients = new Float32Array(count * 3);
    const statusesOut = new Uint32Array(count);
    for (let index = 0; index < count; index += 1) {
      gradients[index * 3] = resultView.getFloat32(index * 16, true);
      gradients[index * 3 + 1] = resultView.getFloat32(index * 16 + 4, true);
      gradients[index * 3 + 2] = resultView.getFloat32(index * 16 + 8, true);
      distances[index] = resultView.getFloat32(index * 16 + 12, true);
      statusesOut[index] = statusView.getUint32(index * 4, true);
    }
    return { distances, gradients, statuses: statusesOut };
  } finally {
    for (const buffer of [resultRead, statusRead]) {
      if (buffer.mapState === "mapped") buffer.unmap();
    }
    for (const buffer of [uniform, field, queries, results, statuses, resultRead, statusRead]) buffer.destroy();
  }
}

/** 域外 lane 的 NaN 位型校验(u32 口径,与 SDF_QUERY_NAN_BITS 互钉)。 */
export function isSdfQueryNanBitPattern(bits: number): boolean {
  return bits === SDF_QUERY_NAN_BITS;
}
