/// <reference types="@webgpu/types" />
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { MAX_SDF_PROFILE_GRID_CELLS } from "../physics/sdfCollisionProfile.js";
import { deriveDimensions, transformPoint, transformedTriangleBounds } from "./sdfSceneBakeGrid.js";
import { DEEP_SDF_BAKE_SCENE_GRID_WGSL, SDF_BAKE_SCENE_GRID_ENTRY,
  SDF_BAKE_SCENE_GRID_MAX_TRIANGLES, SDF_BAKE_SCENE_GRID_PARAMS_BYTES,
  SDF_BAKE_SCENE_GRID_TRIANGLE_VEC4S, SDF_BAKE_SCENE_GRID_WORKGROUP_SIZE } from "./sdfBakeSceneGridWgsl.js";
import type { SdfSceneBakeInstance, SdfSceneBakeReport } from "./sdfSceneBake.js";

/**
 * Brief-GI M3 SDF 场景烘焙 GPU 化:距离场计算从 CPU 增量烘焙(sdfSceneBakeGrid,
 * 实测 570ms/60,192 cells 一次性卡顿)迁移到 compute(sdfBakeSceneGrid.wgsl)。
 *
 * == 与 CPU 合同的关系(逐条)==
 * - 输出 = 场景级 f32 距离场 storage buffer(下游天光追踪 read-only storage 零拷贝
 *   直用,同 encoder 写后读;**不落 3D texture** —— 唯一 GPU 消费方是 buffer 采样链,
 *   纹理中转是纯拷贝开销,如实偏离任务括号内的实现建议);
 * - 格几何(origin/cellSize/dimensions/bounds 并集/外推值)与 bakeSdfSceneGrid 同式
 *   同源(单测对拍同输入逐值一致);CPU 增量路径完整保留为回退与验收参考;
 * - 距离/定号公式同构(triangleDistance/rayX;WGSL f32 vs CPU f64 中间量 → 抽样
 *   容差对拍),交点无排序去重 → 退化射线(共棱/共顶)cell 计数可能不同,验收时
 *   如实报告差异 cell 数(测度零带);
 * - 增量缓存:GPU 路径每次场景 dirty 全量展平 + 重烘(GPU 全量毫秒级);CPU 路径
 *   的逐资产哈希缓存语义不迁移(资产数 × 局部场上传比全量核更贵,如实声明)。
 * - 时钟纪律:宿主注入 now()(37c98eab 先例,runtime 模块不触全局 performance)。
 */

// WebGPU usage 数值常量(sdfGiProductionRuntime 同款先例)。
const USAGE_STORAGE = 0x80, USAGE_COPY_DST = 0x8, USAGE_COPY_SRC = 0x4, USAGE_UNIFORM = 0x40;
const FIELD_USAGE = USAGE_STORAGE | USAGE_COPY_DST | USAGE_COPY_SRC;

/** GPU 烘焙产出的格(与 SdfGrid 形状对齐;distances 空 = 值在 GPU field buffer)。 */
export interface SdfGiBakedGrid {
  readonly origin: readonly [number, number, number];
  readonly cellSize: number;
  readonly dimensions: readonly [number, number, number];
  /** GPU 路径恒空(距离场在 GPU field buffer;读回走 runtime.readField)。 */
  readonly distances: Float32Array<ArrayBuffer>;
  readonly cells: number;
}

export interface SdfSceneBakeGpuInput {
  readonly instances: readonly SdfSceneBakeInstance[];
  readonly cellSize: number;
  readonly instanceDomain: "aabb" | "scene";
}

export interface SdfSceneBakeGpuResult {
  readonly grid: SdfGiBakedGrid;
  readonly field: GPUBuffer;
  readonly report: SdfSceneBakeReport;
  readonly triangleCount: number;
  /** 三角形展平 + 打包的 CPU 墙钟(烘焙帧一次性成本,宿主时钟注入)。 */
  readonly flattenMs: number;
}

/** 管线缓存(每 device 一次;烘焙核与格几何无关,场景 dirty 重入零重建)。 */
const pipelineCache = new WeakMap<GPUDevice, GPUComputePipeline>();

/** GPU SDF 场景烘焙(encoder 挂 bake dispatch;不支持/超预算返回 undefined 回退 CPU)。
 * 同步返回:三角形展平/上传/参数写入为 CPU 侧,distance 场在 encoder 上算出。 */
export function encodeSdfSceneBakeGpu(session: DeviceSession, encoder: GPUCommandEncoder,
  input: SdfSceneBakeGpuInput, now: () => number = (): number => 0):
  SdfSceneBakeGpuResult | undefined {
  const begin = now();
  // 实例过滤(与 sdfSceneBake 同合同:动态排除/非法与超预算跳过)。
  const flat = flattenWorldTriangles(input.instances, input.cellSize, input.instanceDomain);
  if (flat === undefined || flat.triangleCount === 0
    || flat.triangleCount > SDF_BAKE_SCENE_GRID_MAX_TRIANGLES
    || flat.cells > MAX_SDF_PROFILE_GRID_CELLS) {
    return undefined;
  }
  const device = session.device;
  const created: GPUBuffer[] = [];
  try {
    const triangleBuffer = session.own(device.createBuffer({ label: "Deep SDF bake triangles",
      size: flat.triangles.byteLength, usage: USAGE_STORAGE | USAGE_COPY_DST }));
    const field = session.own(device.createBuffer({ label: "Deep SDF bake field",
      size: Math.max(16, flat.cells * 4), usage: FIELD_USAGE }));
    const params = session.own(device.createBuffer({ label: "Deep SDF bake params",
      size: SDF_BAKE_SCENE_GRID_PARAMS_BYTES, usage: USAGE_UNIFORM | USAGE_COPY_DST }));
    created.push(triangleBuffer, field, params);
    device.queue.writeBuffer(triangleBuffer, 0, flat.triangles);
    device.queue.writeBuffer(params, 0, packBakeParams(flat, input.cellSize));
    let pipeline = pipelineCache.get(device);
    if (!pipeline) {
      pipeline = device.createComputePipeline({ label: "Deep SDF bake scene grid pipeline",
        layout: "auto",
        compute: { module: device.createShaderModule({ label: "Deep SDF bake scene grid WGSL",
          code: DEEP_SDF_BAKE_SCENE_GRID_WGSL }), entryPoint: SDF_BAKE_SCENE_GRID_ENTRY } });
      pipelineCache.set(device, pipeline);
    }
    const pass = encoder.beginComputePass({ label: "Deep SDF bake scene grid" });
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, device.createBindGroup({ label: "Deep SDF bake scene grid bindings",
      layout: pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: params } },
        { binding: 1, resource: { buffer: triangleBuffer } },
        { binding: 2, resource: { buffer: field } },
      ] }));
    pass.dispatchWorkgroups(Math.ceil(flat.cells / SDF_BAKE_SCENE_GRID_WORKGROUP_SIZE));
    pass.end();
    return {
      grid: { origin: flat.bounds.min, cellSize: input.cellSize, dimensions: flat.dimensions,
        distances: new Float32Array(0), cells: flat.cells },
      field,
      report: gpuReport(flat, input),
      triangleCount: flat.triangleCount,
      flattenMs: now() - begin,
    };
  } catch (error) {
    for (const buffer of created.reverse()) session.release(buffer);
    throw error;
  }
}

export interface FlattenedBake {
  readonly triangles: Float32Array<ArrayBuffer>;
  readonly triangleCount: number;
  readonly bounds: { readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number] };
  readonly dimensions: readonly [number, number, number];
  readonly cells: number;
  readonly exteriorDistance: number;
  readonly excludedDynamicCount: number;
  readonly skippedCount: number;
  readonly perInstance: readonly { id: string; triangles: number }[];
}

/**
 * 世界系三角形展平 + 实例烘焙域编码(与 bakeInstanceGrid 域公式同式;aabb 域 =
 * transformedTriangleBounds ± cellSize 外推圈,scene 域 = 场景全域)。
 * 域外/非法实例与 sdfSceneBake 同判据(动态排除/invalid-geometry 跳过)。
 * 全部实例被跳过时返回 undefined(调用方回退 CPU 的同款错误语义)。
 */
export function flattenWorldTriangles(instances: readonly SdfSceneBakeInstance[],
  cellSize: number, instanceDomain: "aabb" | "scene"): FlattenedBake | undefined {
  const statics: { instance: SdfSceneBakeInstance;
    bounds: { min: [number, number, number]; max: [number, number, number] } }[] = [];
  let excluded = 0, skipped = 0;
  const perInstance: { id: string; triangles: number }[] = [];
  for (const instance of instances) {
    const triangles = instance.mesh.indices.length / 3;
    if (instance.dynamic === true) { excluded += 1; continue; }
    if (!Number.isSafeInteger(triangles) || triangles < 1
      || instance.mesh.positions.length % 3 !== 0
      || !instance.mesh.positions.every(Number.isFinite)
      || instance.mesh.indices.some(index => index >= instance.mesh.positions.length / 3)) {
      skipped += 1; continue;
    }
    statics.push({ instance, bounds: transformedTriangleBounds(instance.mesh, instance.transform) });
  }
  if (!statics.length) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const entry of statics) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, entry.bounds.min[axis]!);
      max[axis] = Math.max(max[axis]!, entry.bounds.max[axis]!);
    }
  }
  const bounds = { min, max };
  const dimensions = deriveDimensions(bounds, cellSize);
  const cells = dimensions[0]! * dimensions[1]! * dimensions[2]!;
  const exteriorDistance = Math.fround(Math.hypot(
    (bounds.max[0]! - bounds.min[0]!), (bounds.max[1]! - bounds.min[1]!),
    (bounds.max[2]! - bounds.min[2]!)));
  const triangleTotal = statics.reduce((sum, entry) =>
    sum + entry.instance.mesh.indices.length / 3, 0);
  const triangles = new Float32Array(triangleTotal * SDF_BAKE_SCENE_GRID_TRIANGLE_VEC4S * 4);
  let cursor = 0;
  for (const entry of statics) {
    const positions = entry.instance.mesh.positions, indices = entry.instance.mesh.indices;
    // 实例烘焙域(bakeInstanceGrid 同式:aabb 域 = AABB ± cellSize 外推圈)。
    const pad = instanceDomain === "scene" ? 0 : cellSize;
    const domainOrigin: [number, number, number] = instanceDomain === "scene"
      ? [bounds.min[0]!, bounds.min[1]!, bounds.min[2]!]
      : [Math.fround(entry.bounds.min[0]! - pad), Math.fround(entry.bounds.min[1]! - pad),
        Math.fround(entry.bounds.min[2]! - pad)];
    const domainDimensions: [number, number, number] = instanceDomain === "scene"
      ? [...dimensions]
      : [Math.ceil((entry.bounds.max[0]! + pad - domainOrigin[0]!) / cellSize) + 1,
        Math.ceil((entry.bounds.max[1]! + pad - domainOrigin[1]!) / cellSize) + 1,
        Math.ceil((entry.bounds.max[2]! + pad - domainOrigin[2]!) / cellSize) + 1];
    const world = new Float32Array(positions.length);
    for (let vertex = 0; vertex < positions.length / 3; vertex++) {
      const point = transformPoint(entry.instance.transform, positions[vertex * 3]!,
        positions[vertex * 3 + 1]!, positions[vertex * 3 + 2]!);
      world[vertex * 3] = point[0]; world[vertex * 3 + 1] = point[1]; world[vertex * 3 + 2] = point[2];
    }
    for (let triangle = 0; triangle < indices.length / 3; triangle++) {
      for (let corner = 0; corner < 3; corner++) {
        const offset = indices[triangle * 3 + corner]! * 3;
        triangles[cursor++] = world[offset]!;
        triangles[cursor++] = world[offset + 1]!;
        triangles[cursor++] = world[offset + 2]!;
        triangles[cursor++] = 0;
      }
      triangles[cursor++] = domainOrigin[0]; triangles[cursor++] = domainOrigin[1];
      triangles[cursor++] = domainOrigin[2]; triangles[cursor++] = domainDimensions[0]!;
      triangles[cursor++] = domainDimensions[1]!; triangles[cursor++] = domainDimensions[2]!;
      triangles[cursor++] = 0; triangles[cursor++] = 0;
    }
    perInstance.push({ id: entry.instance.id, triangles: indices.length / 3 });
  }
  return { triangles, triangleCount: triangleTotal, bounds, dimensions, cells,
    exteriorDistance, excludedDynamicCount: excluded, skippedCount: skipped, perInstance };
}

/**
 * BakeParams 打包(64B;WGSL struct 布局:vec3u@0 + u32@12 + f32@16 + **vec3f 对齐 16
 * → origin@32** + f32@44 + u32@48 → struct 尺寸 52 舍入到 64。Chrome 按 struct 全长取
 * minBindingSize(真机实测 48 会在 CreateBindGroup 处拒);与 sdfGiPublish 32B 同教训)。
 */
export function packBakeParams(flat: FlattenedBake, cellSize: number): ArrayBuffer {
  const buffer = new ArrayBuffer(SDF_BAKE_SCENE_GRID_PARAMS_BYTES);
  const words = new DataView(buffer);
  words.setUint32(0, flat.dimensions[0]!, true);
  words.setUint32(4, flat.dimensions[1]!, true);
  words.setUint32(8, flat.dimensions[2]!, true);
  words.setUint32(12, flat.triangleCount, true);
  words.setFloat32(16, cellSize, true);
  words.setFloat32(32, flat.bounds.min[0]!, true);
  words.setFloat32(36, flat.bounds.min[1]!, true);
  words.setFloat32(40, flat.bounds.min[2]!, true);
  words.setFloat32(44, flat.exteriorDistance, true);
  words.setUint32(48, flat.cells, true);
  return buffer;
}

/** 烘焙报告(GPU 路径;逐实例 baked,语义与 CPU 报告同构)。 */
function gpuReport(flat: FlattenedBake, input: SdfSceneBakeGpuInput): SdfSceneBakeReport {
  const instances = flat.perInstance.map(entry => ({ id: entry.id, status: "baked" as const,
    triangles: entry.triangles, gridCells: flat.cells })).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return { instances: Object.freeze(instances), bakedCount: instances.length,
    cachedCount: 0, excludedDynamicCount: flat.excludedDynamicCount,
    skippedCount: flat.skippedCount, dimensions: [...flat.dimensions],
    cellSize: input.cellSize, exteriorDistance: flat.exteriorDistance };
}
