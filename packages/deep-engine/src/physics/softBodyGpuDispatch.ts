/**
 * F6 切片 3:布料/软体 GPU dispatch 生产入口(仿 sdfGpuQuery 先例)。
 *
 * 定位与诚实边界:T18 A3 核是单工作组确定性核(一次调用拥有全部状态),
 * dispatch 让它从「库内核」变成「生产可调用」——pack(既有 ABI)→ 显式布局
 * 缓冲 → 一次 step → readback。CPU f64 求解器仍是真值;本路径是 f32 证据/
 * 加速路径,不参与逐位合同(每 lane 恰被一个 invocation 拥有,无归约歧义,
 * 但 f32 与 f64 逐位不同)。
 *
 * 缓冲布局完全复用 pack* 函数(单一 ABI 来源);参数/存储缓冲尺寸即
 * CLOTH_GPU_*_BYTES / SOFT_BODY_GPU_*_BYTES 常量,不做第二次定义。
 */
import {
  CLOTH_GPU_COMPUTE_WGSL, CLOTH_GPU_CONSTRAINT_STRIDE_BYTES, CLOTH_GPU_PARAMS_BYTES,
  packClothGpuConstraints, packClothGpuParams, packClothGpuParticles,
  type ClothGpuStepInput,
} from "./clothGpuWgsl.js";
import {
  SOFT_BODY_GPU_COMPUTE_WGSL, SOFT_BODY_GPU_EDGE_STRIDE_BYTES, SOFT_BODY_GPU_PARAMS_BYTES,
  SOFT_BODY_GPU_TET_STRIDE_BYTES, packSoftBodyGpuEdges, packSoftBodyGpuParams,
  packSoftBodyGpuParticles, packSoftBodyGpuTets, type SoftBodyGpuStepInput,
} from "./softBodyGpuWgsl.js";

export interface ClothGpuDispatchResult {
  /** 步进后的粒子状态,布局同 packClothGpuParticles(12 floats/粒子)。 */
  readonly state: Float32Array;
}

export interface SoftBodyGpuDispatchResult {
  /** 步进后的粒子状态,布局同 packSoftBodyGpuParticles(12 floats/粒子)。 */
  readonly state: Float32Array;
}

const makeBuffer = (
  device: GPUDevice, size: number, usage: GPUBufferUsageFlags,
  source?: ArrayBuffer | ArrayBufferView<ArrayBuffer>,
): GPUBuffer => {
  const buffer = device.createBuffer({ size: Math.max(4, size), usage });
  if (source) device.queue.writeBuffer(buffer, 0, source as GPUAllowSharedBufferSource);
  return buffer;
};

// GPU 全局在 Node(无适配器)不存在:用途标志必须惰性求值,保证本模块
// 在纯 CPU 环境(测试/原生宿主)可安全导入——与 sdfGpuQuery 先例一致。
const storageRead = (): GPUBufferUsageFlags => GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
const readback = (): GPUBufferUsageFlags => GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ;

/** 一步布料 GPU 步进(等价 mirrorClothGpuStep 的 f32 执行)。 */
export async function dispatchClothGpuStep(
  device: GPUDevice, input: ClothGpuStepInput,
): Promise<ClothGpuDispatchResult> {
  const particles = packClothGpuParticles(input.particles);
  const constraints = packClothGpuConstraints(input.constraints, input.particles.length);
  const params = packClothGpuParams(input);
  const stateBytes = particles.byteLength;
  const uniform = makeBuffer(device, CLOTH_GPU_PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, params);
  const particleBuffer = makeBuffer(device, stateBytes, storageRead() | GPUBufferUsage.COPY_SRC, particles);
  const constraintBuffer = makeBuffer(device, constraints.byteLength, storageRead(), constraints);
  const readbackBuffer = makeBuffer(device, stateBytes, readback());
  try {
    const module = device.createShaderModule({ code: CLOTH_GPU_COMPUTE_WGSL });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto", compute: { module, entryPoint: "stepCloth" },
    });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: constraintBuffer } },
      { binding: 2, resource: { buffer: uniform } },
    ] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(particleBuffer, 0, readbackBuffer, 0, stateBytes);
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    return { state: new Float32Array(readbackBuffer.getMappedRange().slice(0)) };
  } finally {
    if (readbackBuffer.mapState === "mapped") readbackBuffer.unmap();
    for (const buffer of [uniform, particleBuffer, constraintBuffer, readbackBuffer]) buffer.destroy();
  }
}

/** 一步软体 GPU 步进(等价 mirrorSoftBodyGpuStep 的 f32 执行)。 */
export async function dispatchSoftBodyGpuStep(
  device: GPUDevice, input: SoftBodyGpuStepInput,
): Promise<SoftBodyGpuDispatchResult> {
  const particles = packSoftBodyGpuParticles(input.particles);
  const edges = packSoftBodyGpuEdges(input.edges, input.particles.length);
  const tets = packSoftBodyGpuTets(input.tets, input.particles.length);
  const params = packSoftBodyGpuParams(input);
  const stateBytes = particles.byteLength;
  const uniform = makeBuffer(device, SOFT_BODY_GPU_PARAMS_BYTES, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, params);
  const particleBuffer = makeBuffer(device, stateBytes, storageRead() | GPUBufferUsage.COPY_SRC, particles);
  const edgeBuffer = makeBuffer(device, edges.byteLength, storageRead(), edges);
  const tetBuffer = makeBuffer(device, tets.byteLength, storageRead(), tets);
  const readbackBuffer = makeBuffer(device, stateBytes, readback());
  try {
    const module = device.createShaderModule({ code: SOFT_BODY_GPU_COMPUTE_WGSL });
    const pipeline = await device.createComputePipelineAsync({
      layout: "auto", compute: { module, entryPoint: "stepSoftBody" },
    });
    const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: particleBuffer } },
      { binding: 1, resource: { buffer: edgeBuffer } },
      { binding: 2, resource: { buffer: tetBuffer } },
      { binding: 3, resource: { buffer: uniform } },
    ] });
    const encoder = device.createCommandEncoder();
    const pass = encoder.beginComputePass();
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.dispatchWorkgroups(1);
    pass.end();
    encoder.copyBufferToBuffer(particleBuffer, 0, readbackBuffer, 0, stateBytes);
    device.queue.submit([encoder.finish()]);
    await readbackBuffer.mapAsync(GPUMapMode.READ);
    return { state: new Float32Array(readbackBuffer.getMappedRange().slice(0)) };
  } finally {
    if (readbackBuffer.mapState === "mapped") readbackBuffer.unmap();
    for (const buffer of [uniform, particleBuffer, edgeBuffer, tetBuffer, readbackBuffer]) buffer.destroy();
  }
}

// 供树摇与文档核对:步长常量在本模块的消费面显式引用。
void CLOTH_GPU_CONSTRAINT_STRIDE_BYTES;
void SOFT_BODY_GPU_EDGE_STRIDE_BYTES;
void SOFT_BODY_GPU_TET_STRIDE_BYTES;
