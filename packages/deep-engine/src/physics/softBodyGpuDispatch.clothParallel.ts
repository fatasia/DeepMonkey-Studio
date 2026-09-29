/**
 * F6 接线清单①:布料 GPU 并行核(A3,3206952f)的生产换核入口。
 *
 * 职责拆分(sourceSizeGate 纪律):既有串行 dispatch(`softBodyGpuDispatch.ts`,
 * 单工作组构造序核)原样保留为回退路径,该文件零改动;本文件只做三件事:
 * 1. `dispatchClothParallelGpuStep` — 把 A3 并行核(确定性着色色序 Gauss-Seidel,
 *    色间 dispatch 定序)接入与串行完全相同的输入合同 `ClothGpuStepInput`:
 *    宿主着色 → 色桶序约束缓冲 → 每 tick 单 compute pass(substeps×(2+色数)
 *    dispatch)→ readback。
 * 2. `dispatchClothStepAuto` — 换核开关:parallel-first 默认;着色不可用/WGSL
 *    编译失败/设备侧错误三类原因 fail-closed 回退既有串行核,原因入遥测。
 * 3. 遥测计数(纯计数器,不影响任何行为与数值)。
 *
 * 确定性合同:并行核语义真值 = CPU f32 镜像 `ClothParallelMirror`(A3 已锁 240
 * tick 指纹 fixture);真机 FMA 使 GPU vs 镜像非逐位(9.0e-3 m 容差内,A3 实测),
 * 本接线不改变该口径。串行与并行都正确但投影序不同、互相不逐位:确定性重放要求
 * 会话内固定一种内核(结果 kernel 字段供调用方锁定);开关无粘性状态。管线按
 * device 用 WeakMap 缓存(失败不缓存,回退后可重试);缓冲逐调用新建,复用化
 * 会话留接线清单下一片。
 */
import { colorClothConstraints } from "./clothConstraintColoring.js";
import { packClothGpuConstraints, packClothGpuParticles, type ClothGpuStepInput } from "./clothGpuWgsl.js";
import {
  CLOTH_PARALLEL_ENTRY_FINALIZE, CLOTH_PARALLEL_ENTRY_INTEGRATE, CLOTH_PARALLEL_ENTRY_PROJECT,
  CLOTH_PARALLEL_PARAMS_BYTES, CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE, CLOTH_PARALLEL_STEP_RANGE_BYTES,
  DEEP_CLOTH_PARALLEL_SOLVER_WGSL,
} from "./clothSolverWgsl.js";
import { dispatchClothGpuStep, type ClothGpuDispatchResult } from "./softBodyGpuDispatch.js";

/** 并行核单 tick 结果:布局同串行(12 floats/粒子),附带编排计数供遥测与量化。 */
export interface ClothParallelDispatchResult {
  readonly state: Float32Array;
  /** 本 tick compute dispatch 数 = substeps×(2+colorCount);串行路径恒为 1。 */
  readonly dispatchCount: number;
  readonly colorCount: number;
}

export type ClothKernelChoice = "parallel-first" | "serial";
export type ClothKernelUsed = "cloth-parallel" | "cloth-serial";

/** 回退原因(三态,均有独立遥测计数;显式选串行不是回退,不计入)。 */
export type ClothKernelFallbackReason =
  /** 着色 fail-closed:≥32 色(超 u32 掩码/核合同)或退化约束(a===b)。串行核无着色,可安全接管。 */
  | "coloring-unavailable"
  /** 并行核 shader module 创建/编译失败(设备不支持该 WGSL 形态)。 */
  | "wgsl-compile-error"
  /** 管线创建、提交、readback 映射等设备侧失败(含 device lost 中途暴露)。 */
  | "gpu-error";

export interface ClothKernelSwitchResult extends ClothGpuDispatchResult {
  readonly kernel: ClothKernelUsed;
  readonly dispatchCount: number;
  /** 并行核着色数;串行路径为 0。 */
  readonly colorCount: number;
  /** 非空 = 本次由并行核回退到串行核,值为原因。 */
  readonly fallbackReason: ClothKernelFallbackReason | null;
}

/** 带 reason 的并行侧失败:换核开关据此精确计数,未知异常归入 gpu-error。 */
export class ClothParallelDispatchError extends Error {
  readonly reason: ClothKernelFallbackReason;
  constructor(reason: ClothKernelFallbackReason, message: string) {
    super(message);
    this.name = "ClothParallelDispatchError";
    this.reason = reason;
  }
}

export interface ClothKernelSwitchTelemetry {
  readonly parallelSteps: number;
  /** 走串行核的步数 = 显式选择 + 回退(二者之和)。 */
  readonly serialSteps: number;
  readonly fallbacksByReason: Readonly<Record<ClothKernelFallbackReason, number>>;
  readonly lastFallbackReason: ClothKernelFallbackReason | null;
}

// 遥测是本模块唯一的全局可变状态:纯整数计数,无时钟/随机源,不参与任何数值路径。
const telemetry = {
  parallelSteps: 0,
  serialSteps: 0,
  fallbacks: { "coloring-unavailable": 0, "wgsl-compile-error": 0, "gpu-error": 0 } as Record<ClothKernelFallbackReason, number>,
  lastFallbackReason: null as ClothKernelFallbackReason | null,
};

export function snapshotClothKernelSwitchTelemetry(): ClothKernelSwitchTelemetry {
  const { parallelSteps, serialSteps, lastFallbackReason } = telemetry;
  return { parallelSteps, serialSteps, fallbacksByReason: { ...telemetry.fallbacks }, lastFallbackReason };
}

export function resetClothKernelSwitchTelemetry(): void {
  telemetry.parallelSteps = 0;
  telemetry.serialSteps = 0;
  for (const reason of Object.keys(telemetry.fallbacks) as ClothKernelFallbackReason[]) telemetry.fallbacks[reason] = 0;
  telemetry.lastFallbackReason = null;
}

/** 并行 tick 的理论 dispatch 数(量化口径:substeps×(2+色数);串行恒 1)。 */
export function clothParallelDispatchCount(substeps: number, colorCount: number): number {
  return substeps * (2 + colorCount);
}

// GPU 全局在 Node(无适配器)不存在:用途标志惰性求值,纯 CPU 环境导入安全(串行文件同款纪律)。
const parallelUsages = () => ({
  uniform: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  state: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  readback: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

/** 并行核 params uniform(48 B):与串行唯一差异 = 槽 3 从 padding 改为 colorCount。 */
function packClothParallelParams(input: ClothGpuStepInput, colorCount: number): ArrayBuffer {
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
  return out;
}

interface ClothParallelPipelines {
  integrate: GPUComputePipeline;
  project: GPUComputePipeline;
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
  const params = packClothParallelParams(input, coloring.colorCount);
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
  const paramsBuffer = createBuffer(device, params.byteLength, usage.uniform, params);
  const kineticBuffer = createBuffer(device, workgroups * 4, usage.state, new Float32Array(workgroups));
  const rangeBuffers = coloring.colorRanges.map(([start, end]) =>
    createBuffer(device, CLOTH_PARALLEL_STEP_RANGE_BYTES, usage.uniform, new Uint32Array([start, end, 0, 0])));
  const readbackBuffer = createBuffer(device, particles.byteLength, usage.readback);
  const projectBindGroups = rangeBuffers.map((buffer, color) => device.createBindGroup({
    layout: pipelines.project.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 1, resource: { buffer: constraintBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 3, resource: { buffer } },
    ],
  }));
  const integrateBindGroup = device.createBindGroup({
    layout: pipelines.integrate.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
    ],
  });
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
      pass.setBindGroup(0, integrateBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.setPipeline(pipelines.project);
      for (let color = 0; color < coloring.colorCount; color += 1) {
        pass.setBindGroup(0, projectBindGroups[color]!);
        pass.dispatchWorkgroups(projectWorkgroups[color]!);
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
    for (const buffer of [stateBuffer, constraintBuffer, paramsBuffer, kineticBuffer, readbackBuffer, ...rangeBuffers]) buffer.destroy();
  }
}

/**
 * 换核开关(生产入口):默认 parallel-first,任一并行侧失败按原因回退既有串行核。
 * 每次调用独立决策(无粘性);确定性重放由调用方按结果 kernel 字段固定会话内核。
 */
export async function dispatchClothStepAuto(
  device: GPUDevice, input: ClothGpuStepInput,
  options: { kernel?: ClothKernelChoice } = {},
): Promise<ClothKernelSwitchResult> {
  if ((options.kernel ?? "parallel-first") === "serial") {
    telemetry.serialSteps += 1;
    const serial = await dispatchClothGpuStep(device, input);
    return { ...serial, kernel: "cloth-serial", dispatchCount: 1, colorCount: 0, fallbackReason: null };
  }
  try {
    const parallel = await dispatchClothParallelGpuStep(device, input);
    telemetry.parallelSteps += 1;
    return { ...parallel, kernel: "cloth-parallel", fallbackReason: null };
  } catch (error) {
    // 调用方错误(参数/拓扑非法)直接上抛:回退只救设备/着色类失败,不污染遥测。
    if (!(error instanceof ClothParallelDispatchError)) throw error;
    const reason = error.reason;
    telemetry.serialSteps += 1;
    telemetry.fallbacks[reason] += 1;
    telemetry.lastFallbackReason = reason;
    const serial = await dispatchClothGpuStep(device, input);
    return { ...serial, kernel: "cloth-serial", dispatchCount: 1, colorCount: 0, fallbackReason: reason };
  }
}
