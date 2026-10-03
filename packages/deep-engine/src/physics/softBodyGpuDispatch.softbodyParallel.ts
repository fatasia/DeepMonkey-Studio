/**
 * F6/T18 软体 GPU 并行核·第二刀:并行 dispatch 编排(TS)。
 *
 * per tick 单 compute pass:integrate → 障碍投影(可选)→ 边色批 project
 * → 体积色批 project → 障碍投影(可选)→ finalize;一次 submit 一次 readback。
 * 同色批内无共享粒子(storage 并发写安全);数值口径与串行核同公式(f32,FMA 差异由镜像
 * 容差承担,不承诺与串行核逐位——与布料 A3 同族)。
 * 障碍 ABI 与布料核同构(64×80B,判别式 halfExtents.w=radius;pack 在
 * softBodyGpuWgsl.packSoftBodyGpuObstacles,跨核字节恒等由测试锁死);绑定
 * 6=obstacles/7=obstacleRange,静态使用集={0,3,6,7}(布料教训:只绑静态使用槽)。
 * 接触在积分后与约束后各投影一次，与 CPU solver 保持相同非穿透边界；
 * 边/体积约束投影顺序仍为色批序，不承诺与构建序黄金逐位相同。
 * 风场刀(F6/T18):风开启时每子步一个 params uniform 副本(windTickSeconds 递进,
 * 与布料 dispatch 同式),integrate bind group 逐子步换绑;风关单副本逐位退化。
 */
import { colorClothConstraints } from "./clothConstraintColoring.js";
import { colorSoftBodyVolumes } from "./softBodyVolumeColoring.js";
import {
  SOFT_BODY_PARALLEL_ENTRY_FINALIZE, SOFT_BODY_PARALLEL_ENTRY_INTEGRATE,
  SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES, SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES,
  SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES,
  SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE, SOFT_BODY_PARALLEL_SOLVER_WGSL,
} from "./softBodyParallelSolverWgsl.js";
import {
  packSoftBodyGpuEdges, packSoftBodyGpuObstacles, packSoftBodyGpuParams, packSoftBodyGpuParticles, packSoftBodyGpuTets,
  type SoftBodyGpuStepInput,
} from "./softBodyGpuWgsl.js";

// 色批序 f32 镜像(并行核语义真值)在 softBodyParallelMirror.ts(sourceSizeGate 职责拆分);
// 此处 re-export 保持既有消费方(`from "./softBodyGpuDispatch.softbodyParallel.js"`)零改动。
export { mirrorSoftBodyParallelStep, projectObstacle } from "./softBodyParallelMirror.js";

export interface SoftBodyParallelDispatchResult {
  /** 步进后粒子状态,布局同 packSoftBodyGpuParticles(12 floats/粒子)。 */
  readonly state: Float32Array;
  /** 本 tick dispatch 数 = substeps×(2+edgeColors+volumeColors+[有障碍+2])。 */
  readonly dispatchCount: number;
  readonly edgeColors: number;
  readonly volumeColors: number;
  readonly obstacleCount: number;
}

export function softBodyParallelDispatchCount(substeps: number, edgeColors: number, volumeColors: number,
  obstacleCount = 0): number {
  return substeps * (2 + edgeColors + volumeColors + (obstacleCount > 0 ? 2 : 0));
}

const parallelUsages = () => ({
  uniform: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  state: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  readback: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

interface SoftBodyParallelPipelines {
  integrate: GPUComputePipeline;
  projectEdges: GPUComputePipeline;
  projectVolumes: GPUComputePipeline;
  projectObstacles: GPUComputePipeline;
  finalize: GPUComputePipeline;
}

const pipelineCache = new WeakMap<GPUDevice, Promise<SoftBodyParallelPipelines>>();

function softBodyParallelPipelines(device: GPUDevice): Promise<SoftBodyParallelPipelines> {
  let cached = pipelineCache.get(device);
  if (!cached) {
    cached = (async (): Promise<SoftBodyParallelPipelines> => {
      const module = device.createShaderModule({ code: SOFT_BODY_PARALLEL_SOLVER_WGSL });
      const entry = async (entryPoint: string): Promise<GPUComputePipeline> => device.createComputePipelineAsync({
        layout: "auto", compute: { module, entryPoint },
      });
      return {
        integrate: await entry(SOFT_BODY_PARALLEL_ENTRY_INTEGRATE),
        projectEdges: await entry(SOFT_BODY_PARALLEL_ENTRY_PROJECT_EDGES),
        projectVolumes: await entry(SOFT_BODY_PARALLEL_ENTRY_PROJECT_VOLUMES),
        projectObstacles: await entry(SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES),
        finalize: await entry(SOFT_BODY_PARALLEL_ENTRY_FINALIZE),
      };
    })();
    pipelineCache.set(device, cached);
    cached.catch(() => pipelineCache.delete(device));
  }
  return cached;
}

function createBuffer(device: GPUDevice, size: number, usage: GPUBufferUsageFlags,
  source?: ArrayBuffer | ArrayBufferView<ArrayBuffer>): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(4, size), usage });
  if (source) device.queue.writeBuffer(buffer, 0, source as GPUAllowSharedBufferSource);
  return buffer;
}

/** 一 tick 并行步进:单 pass 全 substeps(与布料并行核同编排纪律)。 */
export async function dispatchSoftBodyParallelGpuStep(
  device: GPUDevice, input: SoftBodyGpuStepInput,
): Promise<SoftBodyParallelDispatchResult> {
  const edgeColoring = colorClothConstraints(
    input.edges.map(edge => edge.a), input.edges.map(edge => edge.b), input.particles.length,
  );
  const volumeColoring = colorSoftBodyVolumes(
    input.tets.map(tet => [tet.i0, tet.i1, tet.i2, tet.i3] as const), input.particles.length,
  );
  // 色桶重排后 pack:colorRange 索引的是桶序数组,与布料并行核同一索引空间合同。
  const orderedEdges = Array.from(edgeColoring.order, (index) => input.edges[index]!);
  const orderedTets = Array.from(volumeColoring.order, (index) => input.tets[index]!);
  const packedParticles = packSoftBodyGpuParticles(input.particles);
  const packedEdges = packSoftBodyGpuEdges(orderedEdges, input.particles.length);
  const packedTets = packSoftBodyGpuTets(orderedTets, input.particles.length);
  // 风场刀(F6/T18):风开启时每子步一个 params 副本(windTickSeconds = tick 基 +
  // sub·h 递进,与布料 dispatchClothParallelGpuStep 同式同表达式);风关单副本,
  // 内容与旧 48B 合同头逐位一致(尾 48B 零)——零风路径缓冲/trace 逐位退化。
  const wind = input.wind;
  const substepParams: ArrayBuffer[] = [];
  for (let sub = 0; sub < (wind ? input.substeps : 1); sub += 1) {
    substepParams.push(packSoftBodyGpuParams(wind
      ? { ...input, wind: { ...wind, tickSeconds: wind.tickSeconds + sub * (input.dtSeconds / input.substeps) } }
      : input));
  }
  const packedParams = substepParams[0]!;
  // 静态障碍(可选):pack 层单一校验源(预算/有限性);数据 buffer 固定 64×80B 预算,
  // obstacleRange=[count,0,0,0]。与布料核同 ABI(跨核字节恒等测试锁)。
  const obstacles = input.obstacles;
  const obstacleCount = obstacles?.length ?? 0;
  const packedObstacles = obstacles && obstacles.length > 0 ? packSoftBodyGpuObstacles(obstacles) : null;
  const workgroups = Math.ceil(input.particles.length / SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE);
  const pipelines = await softBodyParallelPipelines(device);

  const usage = parallelUsages();
  const stateBuffer = createBuffer(device, packedParticles.byteLength, usage.state, packedParticles);
  const edgeBuffer = createBuffer(device, packedEdges.byteLength, usage.state, packedEdges);
  const tetBuffer = createBuffer(device, packedTets.byteLength, usage.state, packedTets);
  // 风开启:每子步一个 params uniform 副本(缓冲构建期一次创建,step 路径零创建);
  // 风关:单副本(内容头 48B 与旧 ABI 逐位一致,尾 48B 零)。缓冲创建序保持
  // state/edge/tet/params/... 与既有编排 trace 合同同位。
  const paramsBuffers = substepParams.map((packed) => createBuffer(device, packed.byteLength, usage.uniform, packed));
  const paramsBuffer = paramsBuffers[0]!;
  // 边色批与体积色批各自一组 range uniform;bind group 按入口拆两套。
  const edgeRangeBuffers = edgeColoring.colorRanges.map(([start, end]) =>
    createBuffer(device, 16, usage.uniform, new Uint32Array([start, end, 0, 0])));
  const volumeRangeBuffers = volumeColoring.colorRanges.map(([start, end]) =>
    createBuffer(device, 16, usage.uniform, new Uint32Array([start, end, 0, 0])));
  const readbackBuffer = createBuffer(device, packedParticles.byteLength, usage.readback);
  // 风开启:每子步 integrate bind group 绑各自的 params 副本(project/finalize 共享
  // 首副本——风槽只有 integrate 静态读,头 48B 各副本同值);风关:单副本单 bind group。
  const integrateBindGroups = paramsBuffers.map((buffer) => device.createBindGroup({
    layout: pipelines.integrate.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 3, resource: { buffer } },
    ],
  }));
  const integrateBindGroup = integrateBindGroups[0]!;
  const edgeBindGroups = edgeRangeBuffers.map((buffer) => device.createBindGroup({
    layout: pipelines.projectEdges.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 1, resource: { buffer: edgeBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: { buffer } },
    ],
  }));
  const volumeBindGroups = volumeRangeBuffers.map((buffer) => device.createBindGroup({
    layout: pipelines.projectVolumes.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: tetBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: { buffer } },
    ],
  }));
  const finalizeBindGroup = device.createBindGroup({
    layout: pipelines.finalize.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 3, resource: { buffer: paramsBuffer } },
    ],
  });
  // 障碍 bind group:projectObstaclesSoftBody 静态使用集={0 particles,3 params,6 obstacles,
  // 7 obstacleRange};auto 布局下绑非静态槽(如 4/5)= Invalid BindGroup 静默丢弃(布料教训)。
  let obstacleBuffer: GPUBuffer | undefined;
  let obstacleRangeBuffer: GPUBuffer | undefined;
  let obstacleBindGroup: GPUBindGroup | undefined;
  if (packedObstacles) {
    obstacleBuffer = createBuffer(device, packedObstacles.byteLength, usage.state, packedObstacles);
    obstacleRangeBuffer = createBuffer(device, 16, usage.uniform, new Uint32Array([obstacleCount, 0, 0, 0]));
    obstacleBindGroup = device.createBindGroup({
      layout: pipelines.projectObstacles.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 3, resource: { buffer: paramsBuffer } },
        { binding: 6, resource: { buffer: obstacleBuffer } },
        { binding: 7, resource: { buffer: obstacleRangeBuffer } },
      ],
    });
  }
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    for (let substep = 0; substep < input.substeps; substep += 1) {
      pass.setPipeline(pipelines.integrate);
      pass.setBindGroup(0, wind ? integrateBindGroups[substep]! : integrateBindGroup);
      pass.dispatchWorkgroups(workgroups);
      // Integrating can move particles inside fixed obstacles.
      if (obstacleBindGroup) {
        pass.setPipeline(pipelines.projectObstacles);
        pass.setBindGroup(0, obstacleBindGroup);
        pass.dispatchWorkgroups(workgroups);
      }
      pass.setPipeline(pipelines.projectEdges);
      for (let color = 0; color < edgeColoring.colorCount; color += 1) {
        pass.setBindGroup(0, edgeBindGroups[color]!);
        pass.dispatchWorkgroups(Math.ceil((edgeColoring.colorRanges[color]![1]! - edgeColoring.colorRanges[color]![0]!) / SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE));
      }
      pass.setPipeline(pipelines.projectVolumes);
      for (let color = 0; color < volumeColoring.colorCount; color += 1) {
        pass.setBindGroup(0, volumeBindGroups[color]!);
        pass.dispatchWorkgroups(Math.ceil((volumeColoring.colorRanges[color]![1]! - volumeColoring.colorRanges[color]![0]!) / SOFT_BODY_PARALLEL_SOLVER_WORKGROUP_SIZE));
      }
      // Distance and volume constraints can move particles back inside an obstacle.
      if (obstacleBindGroup) {
        pass.setPipeline(pipelines.projectObstacles);
        pass.setBindGroup(0, obstacleBindGroup);
        pass.dispatchWorkgroups(workgroups);
      }
      pass.setPipeline(pipelines.finalize);
      pass.setBindGroup(0, finalizeBindGroup);
      pass.dispatchWorkgroups(workgroups);
    }
    pass.end();
    encoder.copyBufferToBuffer(stateBuffer, 0, readbackBuffer, 0, packedParticles.byteLength);
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    return {
      state: new Float32Array(readbackBuffer.getMappedRange().slice(0)),
      dispatchCount: softBodyParallelDispatchCount(input.substeps, edgeColoring.colorCount, volumeColoring.colorCount, obstacleCount),
      edgeColors: edgeColoring.colorCount,
      volumeColors: volumeColoring.colorCount,
      obstacleCount,
    };
  } finally {
    if (readbackBuffer.mapState === "mapped") readbackBuffer.unmap();
    for (const buffer of [stateBuffer, edgeBuffer, tetBuffer, readbackBuffer,
      ...paramsBuffers, ...edgeRangeBuffers, ...volumeRangeBuffers, obstacleBuffer, obstacleRangeBuffer]) {
      if (buffer) buffer.destroy();
    }
  }
}
