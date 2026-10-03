/**
 * F6-A3 切片:布料 GPU 步进会话——缓冲会话化 + 显式核钉死。
 *
 * 解决两个生产缺口(换核接线 3206952f/b06d8086 的清单②):
 * 1. 缓冲会话化:约束/物理参数/GPU 缓冲/绑定组在会话构建期一次创建,每 tick 只写
 *   粒子状态并复用全部缓冲(逐调用路径每 tick 新建并销毁 ~6+colorCount 个缓冲);
 * 2. 核选择会话口径:options.kernel 显式钉死("cloth-parallel"|"cloth-serial"),
 *   确定性重放调用方不再依赖"auto 无粘性+按结果字段锁定"的约定。
 *
 * 合同与如实边界:
 * - 会话物理参数(constraints/dt/substeps/compliance/damping/gravity)构建期冻结;
 *   每 tick 仅粒子状态可变(与 ClothSolver 会话用法一致)。
 * - parallel 会话 step 输出与逐调用 `dispatchClothParallelGpuStep` 同输入逐位一致
 *   (同 pack/同编排;真机复验承担该证明,CPU 侧只验合同与遥测口径)。
 * - step 遇设备错误抛 ClothParallelDispatchError("gpu-error")后,缓冲状态未定义,
 *   会话标记 dead,后续 step 抛错——调用方 dispose 重建。
 * - serial 会话不复用缓冲(串行文件域不动),仅提供核钉死语义;buffersCreated=0。
 */
import {
  CLOTH_PARALLEL_ENTRY_FINALIZE, CLOTH_PARALLEL_ENTRY_INTEGRATE, CLOTH_PARALLEL_ENTRY_PROJECT,
  CLOTH_PARALLEL_PARAMS_BYTES, CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE, CLOTH_PARALLEL_STEP_RANGE_BYTES,
  DEEP_CLOTH_PARALLEL_SOLVER_WGSL,
} from "./clothSolverWgsl.js";
import {
  colorClothConstraints,
} from "./clothConstraintColoring.js";
import { packClothGpuConstraints, packClothGpuParticles, type ClothGpuConstraintInput, type ClothGpuParticleInput, type ClothGpuStepInput } from "./clothGpuWgsl.js";
import {
  clothParallelDispatchCount, ClothParallelDispatchError, noteClothParallelSessionStep,
  type ClothKernelUsed, type ClothParallelDispatchResult,
} from "./softBodyGpuDispatch.clothParallel.js";
import { dispatchClothGpuStep } from "./softBodyGpuDispatch.js";

export interface ClothGpuStepSessionOptions {
  /** 显式核钉死;auto 换核仍走 dispatchClothStepAuto,会话不做自动回退。 */
  readonly kernel: Extract<ClothKernelUsed, "cloth-parallel" | "cloth-serial">;
}

export interface ClothGpuStepSession {
  readonly kernel: ClothKernelUsed;
  readonly colorCount: number;
  /** 会话生命周期内 GPU 缓冲创建总数(parallel=构建期一次 5+色数;serial=0)。 */
  readonly buffersCreated: number;
  /** 步进一个固定 tick:粒子状态写入持久 state 缓冲,单 pass 全 substeps,一次 submit。 */
  step(particles: readonly ClothGpuParticleInput[]): Promise<ClothParallelDispatchResult>;
  /** 销毁全部会话缓冲;之后 step 抛错(dispose 幂等)。 */
  dispose(): void;
}

// GPU 全局在 Node 不存在:用途标志惰性求值(与 clothParallel 文件同款纪律)。
const sessionUsages = () => ({
  uniform: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  state: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  readback: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
});

function createBuffer(device: GPUDevice, size: number, usage: GPUBufferUsageFlags,
  source?: ArrayBuffer | ArrayBufferView<ArrayBuffer>): GPUBuffer {
  const buffer = device.createBuffer({ size: Math.max(4, size), usage });
  if (source) device.queue.writeBuffer(buffer, 0, source as GPUAllowSharedBufferSource);
  return buffer;
}

interface SessionInternals {
  device: GPUDevice;
  pipelines: { integrate: GPUComputePipeline; project: GPUComputePipeline; finalize: GPUComputePipeline };
  stateBuffer: GPUBuffer;
  paramsBuffer: GPUBuffer;
  kineticBuffer: GPUBuffer;
  readbackBuffer: GPUBuffer;
  projectBindGroups: GPUBindGroup[];
  integrateBindGroup: GPUBindGroup;
  finalizeBindGroup: GPUBindGroup;
  workgroups: number;
  projectWorkgroups: number[];
  colorCount: number;
  substeps: number;
  particlesByteLength: number;
  buffers: GPUBuffer[];
}

/** 管线创建与会话构建共用 clothParallel 文件的 WeakMap 缓存(失败不缓存语义一致)。 */
async function sessionPipelines(device: GPUDevice): Promise<SessionInternals["pipelines"]> {
  let module: GPUShaderModule;
  try {
    module = device.createShaderModule({ code: DEEP_CLOTH_PARALLEL_SOLVER_WGSL });
    const info = await module.getCompilationInfo?.();
    const fatal = info?.messages.filter((message) => message.type === "error") ?? [];
    if (fatal.length) throw new Error(fatal.map((message) => message.message).join("; "));
  } catch (error) {
    throw new ClothParallelDispatchError("wgsl-compile-error",
      `cloth session kernel compile failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  const entry = async (entryPoint: string): Promise<GPUComputePipeline> => device.createComputePipelineAsync({
    layout: "auto", compute: { module, entryPoint },
  });
  return {
    integrate: await entry(CLOTH_PARALLEL_ENTRY_INTEGRATE),
    project: await entry(CLOTH_PARALLEL_ENTRY_PROJECT),
    finalize: await entry(CLOTH_PARALLEL_ENTRY_FINALIZE),
  };
}

/** 创建固定参数会话:构建期一次校验/着色/打包/建缓冲;失败时已建缓冲全部销毁。 */
export async function createClothGpuStepSession(
  device: GPUDevice, input: ClothGpuStepInput, options: ClothGpuStepSessionOptions,
): Promise<ClothGpuStepSession> {
  if (options.kernel !== "cloth-parallel" && options.kernel !== "cloth-serial") {
    throw new Error(`ClothGpuStepSession: kernel must be "cloth-parallel" or "cloth-serial", got ${String(options.kernel)}.`);
  }
  if (options.kernel === "cloth-serial") {
    return {
      kernel: "cloth-serial", colorCount: 0, buffersCreated: 0,
      async step(particles): Promise<ClothParallelDispatchResult> {
        noteClothParallelSessionStep();
        const serial = await dispatchClothGpuStep(device, { ...input, particles });
        return { state: serial.state, dispatchCount: 1, colorCount: 0 };
      },
      dispose(): void { /* serial 无会话缓冲 */ },
    };
  }

  // 构建期一次:校验+着色+打包(约束/参数冻结)。
  packClothGpuConstraints(input.constraints, input.particles.length);
  let coloring;
  try {
    coloring = colorClothConstraints(
      input.constraints.map((constraint: ClothGpuConstraintInput) => constraint.a),
      input.constraints.map((constraint: ClothGpuConstraintInput) => constraint.b),
      input.particles.length,
    );
  } catch (error) {
    throw new ClothParallelDispatchError("coloring-unavailable",
      `cloth session needs a deterministic coloring: ${error instanceof Error ? error.message : String(error)}`);
  }
  const packedParticles = packClothGpuParticles(input.particles);
  const orderedConstraints = Array.from(coloring.order, (index) => input.constraints[index]!);
  const packedConstraints = packClothGpuConstraints(orderedConstraints, input.particles.length);
  const paramsView = new DataView(new ArrayBuffer(CLOTH_PARALLEL_PARAMS_BYTES));
  {
    // 与 packClothParallelParams 同布局:槽 0-3 整数,4-6/8-10 浮点(构建期冻结)。
    const integers = new Uint32Array(paramsView.buffer);
    const floats = new Float32Array(paramsView.buffer);
    integers[0] = input.particles.length;
    integers[1] = input.constraints.length;
    integers[2] = input.substeps;
    integers[3] = coloring.colorCount;
    floats[4] = Math.fround(input.dtSeconds);
    floats[5] = Math.fround(input.compliance);
    floats[6] = Math.fround(input.damping);
    floats[8] = Math.fround(input.gravity[0]);
    floats[9] = Math.fround(input.gravity[1]);
    floats[10] = Math.fround(input.gravity[2]);
  }
  const workgroups = Math.ceil(input.particles.length / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE);
  const projectWorkgroups = coloring.colorRanges.map(([start, end]) => Math.ceil((end - start) / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE));

  const usage = sessionUsages();
  const buffers: GPUBuffer[] = [];
  let pipelines: SessionInternals["pipelines"] | undefined;
  try {
    pipelines = await sessionPipelines(device).catch((error: unknown) => {
      if (error instanceof ClothParallelDispatchError) throw error;
      throw new ClothParallelDispatchError("gpu-error", `cloth session pipeline creation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    const stateBuffer = createBuffer(device, packedParticles.byteLength, usage.state, packedParticles);
    const constraintBuffer = createBuffer(device, packedConstraints.byteLength, usage.state, packedConstraints);
    const paramsBuffer = createBuffer(device, CLOTH_PARALLEL_PARAMS_BYTES, usage.uniform, paramsView.buffer);
    const kineticBuffer = createBuffer(device, workgroups * 4, usage.state, new Float32Array(workgroups));
    const rangeBuffers = coloring.colorRanges.map(([start, end]) =>
      createBuffer(device, CLOTH_PARALLEL_STEP_RANGE_BYTES, usage.uniform, new Uint32Array([start, end, 0, 0])));
    const readbackBuffer = createBuffer(device, packedParticles.byteLength, usage.readback);
    buffers.push(stateBuffer, constraintBuffer, paramsBuffer, kineticBuffer, readbackBuffer, ...rangeBuffers);
    const projectBindGroups = rangeBuffers.map((buffer) => device.createBindGroup({
      layout: pipelines!.project.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 1, resource: { buffer: constraintBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 3, resource: { buffer } },
      ],
    }));
    const integrateBindGroup = device.createBindGroup({
      layout: pipelines!.integrate.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
      ],
    });
    const finalizeBindGroup = device.createBindGroup({
      layout: pipelines!.finalize.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 4, resource: { buffer: kineticBuffer } },
      ],
    });
    let dead = false;
    const internals: SessionInternals = {
      device, pipelines, stateBuffer, paramsBuffer, kineticBuffer, readbackBuffer,
      projectBindGroups, integrateBindGroup, finalizeBindGroup,
      workgroups, projectWorkgroups, colorCount: coloring.colorCount, substeps: input.substeps,
      particlesByteLength: packedParticles.byteLength, buffers,
    };
    const session: ClothGpuStepSession = {
      kernel: "cloth-parallel",
      colorCount: coloring.colorCount,
      buffersCreated: buffers.length,
      async step(particles): Promise<ClothParallelDispatchResult> {
        if (dead) throw new ClothParallelDispatchError("gpu-error", "cloth session is dead after a device error; dispose and recreate.");
        noteClothParallelSessionStep();
        const packed = packClothGpuParticles(particles);
        try {
          internals.device.queue.writeBuffer(internals.stateBuffer, 0, packed);
          const encoder = internals.device.createCommandEncoder();
          const pass = encoder.beginComputePass();
          for (let substep = 0; substep < internals.substeps; substep += 1) {
            pass.setPipeline(internals.pipelines.integrate);
            pass.setBindGroup(0, internals.integrateBindGroup);
            pass.dispatchWorkgroups(internals.workgroups);
            pass.setPipeline(internals.pipelines.project);
            for (let color = 0; color < internals.colorCount; color += 1) {
              pass.setBindGroup(0, internals.projectBindGroups[color]!);
              pass.dispatchWorkgroups(internals.projectWorkgroups[color]!);
            }
            pass.setPipeline(internals.pipelines.finalize);
            pass.setBindGroup(0, internals.finalizeBindGroup);
            pass.dispatchWorkgroups(internals.workgroups);
          }
          pass.end();
          encoder.copyBufferToBuffer(internals.stateBuffer, 0, internals.readbackBuffer, 0, internals.particlesByteLength);
          internals.device.queue.submit([encoder.finish()]);
          await internals.readbackBuffer.mapAsync(GPUMapMode.READ);
          return {
            state: new Float32Array(internals.readbackBuffer.getMappedRange().slice(0)),
            dispatchCount: clothParallelDispatchCount(internals.substeps, internals.colorCount),
            colorCount: internals.colorCount,
          };
        } catch (error) {
          if (error instanceof ClothParallelDispatchError) { dead = true; throw error; }
          dead = true;
          throw new ClothParallelDispatchError("gpu-error", `cloth session step failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (internals.readbackBuffer.mapState === "mapped") internals.readbackBuffer.unmap();
        }
      },
      dispose(): void {
        dead = true;
        for (const buffer of buffers) buffer.destroy();
      },
    };
    return session;
  } catch (error) {
    for (const buffer of buffers) buffer.destroy();
    void pipelines;
    throw error;
  }
}
