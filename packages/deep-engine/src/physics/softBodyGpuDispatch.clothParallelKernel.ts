/**
 * F6 接线清单① 布料 GPU 并行核 内核层(sourceSizeGate 拆分:自
 * softBodyGpuDispatch.clothParallel.ts 按职责分文件,代码逐行同源,仅改可见性;
 * 语义零变化。消费方仍从 softBodyGpuDispatch.clothParallel.js 导入,本文件不直接对外)。
 *
 * 职责:params uniform 打包(48B,槽3=colorCount)、按 device 的管线 WeakMap 缓存
 * (失败不缓存,回退后可重试)、一 tick 并行核步进(substeps×(integrate+逐色
 * project+finalize) 单 pass,整 tick 一次 submit,readback)。
 */
import { colorClothConstraints } from "./clothConstraintColoring.js";
import { packClothGpuConstraints, packClothGpuParticles, type ClothGpuStepInput } from "./clothGpuWgsl.js";
import {
  CLOTH_PARALLEL_ENTRY_FINALIZE, CLOTH_PARALLEL_ENTRY_INTEGRATE, CLOTH_PARALLEL_ENTRY_PROJECT,
  CLOTH_PARALLEL_PARAMS_BYTES, CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE, CLOTH_PARALLEL_STEP_RANGE_BYTES,
  DEEP_CLOTH_PARALLEL_SOLVER_WGSL,
} from "./clothSolverWgsl.js";
import {
  CLOTH_GPU_MAX_OBSTACLES, clothParallelDispatchCount, ClothParallelDispatchError,
  packClothGpuObstacles, type ClothParallelDispatchResult,
} from "./softBodyGpuDispatch.clothParallelContract.js";

// GPU 全局在 Node(无适配器)不存在:用途标志惰性求值,纯 CPU 环境导入安全(串行文件同款纪律)。
const parallelUsages = () => ({
  uniform: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  state: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  readback: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

/** 并行核 params uniform(48 B):与串行唯一差异 = 槽 3 从 padding 改为 colorCount。 */
function packClothParallelParams(input: ClothGpuStepInput, colorCount: number,
  windTickSeconds = Number.NaN): ArrayBuffer {
  if (!Number.isSafeInteger(input.substeps) || input.substeps < 1) throw new Error(`Cloth parallel GPU substeps must be an integer >= 1, got ${input.substeps}.`);
  if (!(input.dtSeconds > 0) || !Number.isFinite(input.dtSeconds)) throw new Error("Cloth parallel GPU dtSeconds must be positive and finite.");
  if (!(input.compliance >= 0) || !Number.isFinite(input.compliance)) throw new Error("Cloth parallel GPU compliance must be finite and >= 0.");
  if (!(input.damping >= 0) || input.damping >= 1 || !Number.isFinite(input.damping)) throw new Error("Cloth parallel GPU damping must be finite in [0,1).");
  if (input.gravity.length !== 3 || !input.gravity.every(Number.isFinite)) throw new Error("Cloth parallel GPU gravity must contain three finite values.");
  const out = new ArrayBuffer(CLOTH_PARALLEL_PARAMS_BYTES);
  const integers = new Uint32Array(out);
  const floats = new Float32Array(out);
  integers[0] = input.particles.length;
  integers[1] = input.constraints.length;
  integers[2] = input.substeps;
  integers[3] = colorCount;
  floats[4] = Math.fround(input.dtSeconds);
  floats[5] = Math.fround(input.compliance);
  floats[6] = Math.fround(input.damping);
  floats[8] = Math.fround(input.gravity[0]);
  floats[9] = Math.fround(input.gravity[1]);
  floats[10] = Math.fround(input.gravity[2]);
  const wind = input.wind;
  if (wind) {
    integers[7] = 1;
    floats[12] = Math.fround(wind.direction[0]);
    floats[13] = Math.fround(wind.direction[1]);
    floats[14] = Math.fround(wind.direction[2]);
    integers[15] = 0;
    integers[16] = (wind.seed ^ 0x51ed2701) >>> 0; // WIND_NOISE_SALT:与 f64 黄金/镜像同源
    floats[17] = Math.fround(wind.baseSpeed);
    floats[18] = Math.fround(wind.gustFrequency);
    floats[19] = Math.fround(wind.spatialScale);
    floats[20] = Math.fround(windTickSeconds);
  }
  return out;
}

interface ClothParallelPipelines {
  integrate: GPUComputePipeline;
  project: GPUComputePipeline;
  projectObstacles: GPUComputePipeline;
  finalize: GPUComputePipeline;
}

const pipelineCache = new WeakMap<GPUDevice, Promise<ClothParallelPipelines>>();

function clothParallelPipelines(device: GPUDevice): Promise<ClothParallelPipelines> {
  let cached = pipelineCache.get(device);
  if (!cached) {
    cached = (async (): Promise<ClothParallelPipelines> => {
      let module: GPUShaderModule;
      try {
        module = device.createShaderModule({ code: DEEP_CLOTH_PARALLEL_SOLVER_WGSL });
        const info = await module.getCompilationInfo?.();
        const fatal = info?.messages.filter((message) => message.type === "error") ?? [];
        if (fatal.length) throw new Error(fatal.map((message) => message.message).join("; "));
      } catch (error) {
        throw new ClothParallelDispatchError("wgsl-compile-error",
          `cloth parallel kernel compile failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      const entry = async (entryPoint: string): Promise<GPUComputePipeline> => device.createComputePipelineAsync({
        layout: "auto", compute: { module, entryPoint },
      });
      return {
        integrate: await entry(CLOTH_PARALLEL_ENTRY_INTEGRATE),
        project: await entry(CLOTH_PARALLEL_ENTRY_PROJECT),
        projectObstacles: await entry("projectObstacles"),
        finalize: await entry(CLOTH_PARALLEL_ENTRY_FINALIZE),
      };
    })();
    pipelineCache.set(device, cached);
    cached.catch(() => pipelineCache.delete(device)); // 失败不缓存:回退后设备恢复时可重试换核。
  }
  return cached;
}

function createBuffer(device: GPUDevice, size: number, usage: GPUBufferUsageFlags,
  source?: ArrayBuffer | ArrayBufferView<ArrayBuffer>): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(4, size), usage });
  if (source) device.queue.writeBuffer(buffer, 0, source as GPUAllowSharedBufferSource);
  return buffer;
}

/**
 * 一 tick 并行核步进:与 `dispatchClothGpuStep` 同输入合同。
 * 每 tick 单 compute pass,内含 substeps×(integrate + 逐色 project + finalize);
 * 同 pass 内 dispatch 按记录序执行且写可见(A3 真机探针同机制),整 tick 一次 submit。
 */
export async function dispatchClothParallelGpuStep(
  device: GPUDevice, input: ClothGpuStepInput,
): Promise<ClothParallelDispatchResult> {
  // 着色前按构建序全量校验(pack 层单一校验源):着色只见合法索引;
  // 越界/非法是调用方错误,走普通异常直接上抛(见 dispatchClothStepAuto),不伪装成回退。
  packClothGpuConstraints(input.constraints, input.particles.length);
  const endpointsA = input.constraints.map((constraint) => constraint.a);
  const endpointsB = input.constraints.map((constraint) => constraint.b);
  let coloring;
  try {
    coloring = colorClothConstraints(endpointsA, endpointsB, input.particles.length);
  } catch (error) {
    throw new ClothParallelDispatchError("coloring-unavailable",
      `cloth parallel kernel needs a deterministic coloring: ${error instanceof Error ? error.message : String(error)}`);
  }
  const particles = packClothGpuParticles(input.particles);
  // TypedArray.map 会按数值语义 coerce,必须走 Array.from 保对象引用(桶序 = 色序执行序)。
  const orderedConstraints = Array.from(coloring.order, (index) => input.constraints[index]!);
  const constraints = packClothGpuConstraints(orderedConstraints, input.particles.length);
  // 风时间 per-substep:风开启时每个子步一个 params 副本(tick+sub·h 递进),构建期一次创建。
  const wind = input.wind;
  const substepParams: ArrayBuffer[] = [];
  for (let sub = 0; sub < (wind ? input.substeps : 1); sub += 1) {
    substepParams.push(packClothParallelParams(input, coloring.colorCount,
      wind ? wind.tickSeconds + sub * (input.dtSeconds / input.substeps) : Number.NaN));
  }
  const params = substepParams[0]!;
  const workgroups = Math.ceil(input.particles.length / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE);
  const projectWorkgroups = coloring.colorRanges.map(([start, end]) => Math.ceil((end - start) / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE));
  // 管线创建失败同样属于设备能力缺失:包装为 gpu-error 走回退,不裸抛。
  const pipelines = await clothParallelPipelines(device).catch((error: unknown) => {
    if (error instanceof ClothParallelDispatchError) throw error;
    throw new ClothParallelDispatchError("gpu-error", `cloth parallel pipeline creation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  const usage = parallelUsages();
  const stateBuffer = createBuffer(device, particles.byteLength, usage.state, particles);
  const constraintBuffer = createBuffer(device, constraints.byteLength, usage.state, constraints);
  const paramsBuffers = substepParams.map((packed) => createBuffer(device, packed.byteLength, usage.uniform, packed));
  const paramsBuffer = paramsBuffers[0]!;
  const kineticBuffer = createBuffer(device, workgroups * 4, usage.state, new Float32Array(workgroups));
  const rangeBuffers = coloring.colorRanges.map(([start, end]) =>
    createBuffer(device, CLOTH_PARALLEL_STEP_RANGE_BYTES, usage.uniform, new Uint32Array([start, end, 0, 0])));
  const readbackBuffer = createBuffer(device, particles.byteLength, usage.readback);
  // 静态障碍(可选):数据 buffer 固定 64×80B 预算;obstacleRange=[count,0,0,0]。
  const obstacles = input.obstacles;
  const obstacleCount = obstacles?.length ?? 0;
  let obstacleBuffer: GPUBuffer | undefined;
  let obstacleRangeBuffer: GPUBuffer | undefined;
  let obstacleBindGroup: GPUBindGroup | undefined;
  if (obstacles && obstacleCount > 0) {
    obstacleBuffer = createBuffer(device, CLOTH_GPU_MAX_OBSTACLES * 80, usage.state, packClothGpuObstacles(obstacles));
    obstacleRangeBuffer = createBuffer(device, 16, usage.uniform, new Uint32Array([obstacleCount, 0, 0, 0]));
    obstacleBindGroup = device.createBindGroup({
      layout: pipelines.projectObstacles.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        // WGSL projectObstacles 静态使用 params@binding(2)(stepRange@3 是 project 入口的
        // 槽位,不在本管线 auto 布局的静态使用集;绑 3 会得到 Invalid BindGroup,Submit 丢弃)。
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 5, resource: { buffer: obstacleBuffer } },
        { binding: 6, resource: { buffer: obstacleRangeBuffer } },
      ],
    });
  }
  const projectBindGroups = rangeBuffers.map((buffer, color) => device.createBindGroup({
    layout: pipelines.project.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 1, resource: { buffer: constraintBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 3, resource: { buffer } },
    ],
  }));
  const integrateBindGroups = paramsBuffers.map((buffer) => device.createBindGroup({
    layout: pipelines.integrate.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer } },
    ],
  }));
  const integrateBindGroup = integrateBindGroups[0]!;
  const finalizeBindGroup = device.createBindGroup({
    layout: pipelines.finalize.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: { buffer: kineticBuffer } },
    ],
  });
  try {
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    for (let substep = 0; substep < input.substeps; substep += 1) {
      pass.setPipeline(pipelines.integrate);
      pass.setBindGroup(0, wind ? integrateBindGroups[substep]! : integrateBindGroup);
      pass.dispatchWorkgroups(workgroups);
      if (obstacleBindGroup) {
        pass.setPipeline(pipelines.projectObstacles);
        pass.setBindGroup(0, obstacleBindGroup);
        pass.dispatchWorkgroups(workgroups);
      }
      pass.setPipeline(pipelines.project);
      for (let color = 0; color < coloring.colorCount; color += 1) {
        pass.setBindGroup(0, projectBindGroups[color]!);
        pass.dispatchWorkgroups(projectWorkgroups[color]!);
      }
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
    encoder.copyBufferToBuffer(stateBuffer, 0, readbackBuffer, 0, particles.byteLength);
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    return {
      state: new Float32Array(readbackBuffer.getMappedRange().slice(0)),
      dispatchCount: clothParallelDispatchCount(input.substeps, coloring.colorCount),
      colorCount: coloring.colorCount,
    };
  } catch (error) {
    if (error instanceof ClothParallelDispatchError) throw error;
    throw new ClothParallelDispatchError("gpu-error", `cloth parallel device step failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    if (readbackBuffer.mapState === "mapped") readbackBuffer.unmap();
    for (const buffer of [stateBuffer, constraintBuffer, ...paramsBuffers, kineticBuffer, readbackBuffer, ...rangeBuffers]) buffer.destroy();
  }
}
