// T18 A3 并行布料:真机 WebGPU 重放探针(浏览器内执行,由 clothParallelGpuTest.mjs 打包驱动)。
//
// 证据口径(如实声明):
// - 本探针把 wgsl/clothSolver.wgsl(单源)编译为真实 GPU pipeline,按合同 dispatch 序
//   (每子步 integrate → 逐色 project → finalize+kinetics)重放 240 ticks,逐 24 tick
//   读回状态与 CPU f32 模拟镜像(clothParallelSolver.ts)对拍;
// - 逐位成立 = 真机浮点实现与模拟口径一致;不一致时输出逐步最大漂移,并对照
//   f64 黄金(ClothSolver)0.05 m 容差与 5% 拉伸带给出容差口径结论;
// - 同 seed 真机双跑逐位(GPU 重放确定性)独立成列。
import {
  ClothParallelMirror, buildClothParallelState, fingerprintFloat32, hostMergeTreeSum,
} from "../src/physics/clothParallelSolver.js";
import { ClothSolver } from "../src/physics/clothSolver.js";
import { DEEP_CLOTH_PARALLEL_SOLVER_WGSL, CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE,
  CLOTH_PARALLEL_ENTRY_INTEGRATE, CLOTH_PARALLEL_ENTRY_PROJECT, CLOTH_PARALLEL_ENTRY_FINALIZE } from "../src/physics/clothSolverWgsl.js";

const GRID = {
  columns: 12, rows: 12, spacing: 0.1, mass: 0.2,
  gravity: [0, -9.81, 0], dtSeconds: 1 / 60, substeps: 8, compliance: 0, damping: 0.01,
  perturbation: 0.005, seed: 20260927, origin: [0, 0, 0],
};
const PINNED = [[0, 11], [11, 11]];
const TICKS = 240;

export async function probeAdapterInfo(): Promise<unknown> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  return adapter.info ?? {};
}

function stateFingerprint(state: Float32Array, particleCount: number): string {
  const all = new Float32Array(particleCount * 6);
  for (let i = 0; i < particleCount; i += 1) {
    all[i] = state[i * 12]!;
    all[particleCount + i] = state[i * 12 + 1]!;
    all[2 * particleCount + i] = state[i * 12 + 2]!;
    all[3 * particleCount + i] = state[i * 12 + 4]!;
    all[4 * particleCount + i] = state[i * 12 + 5]!;
    all[5 * particleCount + i] = state[i * 12 + 6]!;
  }
  return fingerprintFloat32(all);
}

function stretchMaxRatio(state: Float32Array, build: ReturnType<typeof buildClothParallelState>): number {
  const constraints = new Uint32Array(build.constraintBuffer);
  const rests = new Float32Array(build.constraintBuffer);
  let max = 0;
  for (let bucket = 0; bucket < build.constraintCount; bucket += 1) {
    const a = constraints[bucket * 4]!;
    const b = constraints[bucket * 4 + 1]!;
    const rest = rests[bucket * 4 + 2]!;
    const dx = state[a * 12]! - state[b * 12]!;
    const dy = state[a * 12 + 1]! - state[b * 12 + 1]!;
    const dz = state[a * 12 + 2]! - state[b * 12 + 2]!;
    const ratio = Math.abs(Math.hypot(dx, dy, dz) - rest) / rest;
    if (ratio > max) max = ratio;
  }
  return max;
}

async function runReplay(device: GPUDevice, module: GPUShaderModule): Promise<{
  per24: Array<{ tick: number; cpuFingerprint: string; gpuFingerprint: string; bitwiseMatch: boolean; gpuMaxPosErrVsCpu: number }>;
  finalState: Float32Array;
  kinetic: { cpu: number; gpu: number; bitwiseMatch: boolean };
  replayDigest: string;
}> {
  const build = buildClothParallelState({ ...GRID, pinned: PINNED });
  const mirror = new ClothParallelMirror(buildClothParallelState({ ...GRID, pinned: PINNED }));
  const particleCount = build.particleCount;
  const workgroups = Math.ceil(particleCount / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE);

  const stateBuffer = device.createBuffer({ size: build.state.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const constraintBuffer = device.createBuffer({ size: build.constraintBuffer.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const paramBytes = new ArrayBuffer(48);
  {
    const ints = new Uint32Array(paramBytes);
    const floats = new Float32Array(paramBytes);
    ints[0] = particleCount;
    ints[1] = build.constraintCount;
    ints[2] = GRID.substeps;
    ints[3] = build.coloring.colorCount;
    floats[4] = Math.fround(GRID.dtSeconds);
    floats[5] = Math.fround(GRID.compliance);
    floats[6] = Math.fround(GRID.damping);
    floats[8] = Math.fround(GRID.gravity[0]);
    floats[9] = Math.fround(GRID.gravity[1]);
    floats[10] = Math.fround(GRID.gravity[2]);
  }
  const paramsBuffer = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(paramsBuffer, 0, paramBytes);
  device.queue.writeBuffer(constraintBuffer, 0, build.constraintBuffer);
  device.queue.writeBuffer(stateBuffer, 0, build.state);

  // 每色独立 uniform + bind group(色序 = bind group 序,构建期一次写定)。
  const rangeBuffers: GPUBuffer[] = [];
  const projectBindGroups: GPUBindGroup[] = [];
  const integratePipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: CLOTH_PARALLEL_ENTRY_INTEGRATE } });
  const projectPipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: CLOTH_PARALLEL_ENTRY_PROJECT } });
  const finalizePipeline = device.createComputePipeline({ layout: "auto", compute: { module, entryPoint: CLOTH_PARALLEL_ENTRY_FINALIZE } });
  for (const [start, end] of build.coloring.colorRanges) {
    const rangeBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(rangeBuffer, 0, new Uint32Array([start, end, 0, 0]));
    rangeBuffers.push(rangeBuffer);
  }
  const baseBindGroup = device.createBindGroup({
    layout: integratePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
    ],
  });
  // finalize 的 kineticPartials 槽(每 workgroup 一个 f32,单写者;tick 间由写零重置)。
  const kineticBuffer = device.createBuffer({
    size: Math.max(4, workgroups * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC,
  });
  device.queue.writeBuffer(kineticBuffer, 0, new Float32Array(workgroups));
  const finalizeBindGroup = device.createBindGroup({
    layout: finalizePipeline.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: stateBuffer } },
      { binding: 2, resource: { buffer: paramsBuffer } },
      { binding: 4, resource: { buffer: kineticBuffer } },
    ],
  });
  for (let color = 0; color < build.coloring.colorCount; color += 1) {
    projectBindGroups.push(device.createBindGroup({
      layout: projectPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: stateBuffer } },
        { binding: 1, resource: { buffer: constraintBuffer } },
        { binding: 2, resource: { buffer: paramsBuffer } },
        { binding: 3, resource: { buffer: rangeBuffers[color]! } },
      ],
    }));
  }

  const readback = device.createBuffer({ size: build.state.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const kineticReadback = device.createBuffer({
    size: Math.max(4, workgroups * 4), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const readState = async (): Promise<Float32Array> => {
    device.queue.submit([]);
    const encoder = device.createCommandEncoder();
    encoder.copyBufferToBuffer(stateBuffer, 0, readback, 0, build.state.byteLength);
    device.queue.submit([encoder.finish()]);
    await readback.mapAsync(GPUMapMode.READ);
    const state = new Float32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    return state;
  };

  const per24: Array<{ tick: number; cpuFingerprint: string; gpuFingerprint: string; bitwiseMatch: boolean; gpuMaxPosErrVsCpu: number }> = [];
  for (let tick = 1; tick <= TICKS; tick += 1) {
    mirror.step();
    for (let sub = 0; sub < GRID.substeps; sub += 1) {
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(integratePipeline);
      pass.setBindGroup(0, baseBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.setPipeline(projectPipeline);
      for (let color = 0; color < build.coloring.colorCount; color += 1) {
        pass.setBindGroup(0, projectBindGroups[color]!);
        const [start, end] = build.coloring.colorRanges[color]!;
        pass.dispatchWorkgroups(Math.ceil((end - start) / CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE));
      }
      pass.setPipeline(finalizePipeline);
      pass.setBindGroup(0, finalizeBindGroup);
      pass.dispatchWorkgroups(workgroups);
      pass.end();
      device.queue.submit([encoder.finish()]);
    }
    if (tick % 24 === 0 || tick === TICKS) {
      const gpuState = await readState();
      const cpuState = mirror.captureState();
      let maxErr = 0;
      const diffIndexes: number[] = [];
      for (let i = 0; i < gpuState.length; i += 1) {
        const diff = Math.abs(gpuState[i]! - cpuState[i]!);
        if (diff > maxErr) { maxErr = diff; diffIndexes.length = 0; diffIndexes.push(i); }
        else if (diff === maxErr && diff > 0 && diffIndexes.length < 8) diffIndexes.push(i);
      }
      const gpuFingerprint = stateFingerprint(gpuState, particleCount);
      const cpuFingerprint = mirror.stateFingerprint32();
      per24.push({
        tick, cpuFingerprint, gpuFingerprint,
        bitwiseMatch: gpuFingerprint === cpuFingerprint,
        gpuMaxPosErrVsCpu: maxErr,
        diffIndexes,
      });
    }
  }
  const finalState = await readState();
  device.queue.submit([]);
  const kEncoder = device.createCommandEncoder();
  kEncoder.copyBufferToBuffer(kineticBuffer, 0, kineticReadback, 0, workgroups * 4);
  device.queue.submit([kEncoder.finish()]);
  await kineticReadback.mapAsync(GPUMapMode.READ);
  const partials = new Float32Array(kineticReadback.getMappedRange().slice(0));
  kineticReadback.unmap();
  const gpuKinetic = hostMergeTreeSum(Array.from(partials));
  const cpuKinetic = mirror.kineticPerSubstep[mirror.kineticPerSubstep.length - 1]!;

  for (const buffer of [stateBuffer, constraintBuffer, paramsBuffer, readback, kineticReadback, kineticBuffer, ...rangeBuffers]) buffer.destroy();
  return {
    per24,
    finalState,
    kinetic: { cpu: cpuKinetic, gpu: gpuKinetic, bitwiseMatch: gpuKinetic === cpuKinetic },
    replayDigest: stateFingerprint(finalState, particleCount),
  };
}

let cachedModule: { device: GPUDevice; module: GPUShaderModule } | null = null;

async function gpuContext(): Promise<{ device: GPUDevice; module: GPUShaderModule }> {
  if (cachedModule) return cachedModule;
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  const module = device.createShaderModule({ code: DEEP_CLOTH_PARALLEL_SOLVER_WGSL });
  const info = await module.getCompilationInfo();
  const fatal = info.messages.filter((message) => message.type === "error");
  if (fatal.length) throw new Error(`WGSL compile failed: ${fatal.map((m) => m.message).join("; ")}`);
  cachedModule = { device, module };
  return cachedModule;
}

/** 主证据:240 ticks 真机重放 vs CPU 模拟镜像逐步对拍 + 真机双跑逐位 + 黄金容差。 */
export async function runClothParallelGpuReplay(): Promise<unknown> {
  const { device, module } = await gpuContext();
  const first = await runReplay(device, module);
  const second = await runReplay(device, module);
  const golden = new ClothSolver({ ...GRID });
  for (const [col, row] of PINNED) golden.setPinned(col, row, true);
  for (let t = 0; t < TICKS; t += 1) golden.step();
  const snap = golden.capture();
  let goldenMaxErr = 0;
  for (let i = 0; i < first.finalState.length / 12; i += 1) {
    const dx = first.finalState[i * 12]! - snap.px[i]!;
    const dy = first.finalState[i * 12 + 1]! - snap.py[i]!;
    const dz = first.finalState[i * 12 + 2]! - snap.pz[i]!;
    goldenMaxErr = Math.max(goldenMaxErr, Math.hypot(dx, dy, dz));
  }
  const bitwiseAll = first.per24.every((row) => row.bitwiseMatch);
  return {
    ticks: TICKS,
    per24: first.per24,
    simulationParityBitwise: bitwiseAll,
    maxStateFloatDriftVsCpu: Math.max(...first.per24.map((row) => row.gpuMaxPosErrVsCpu)),
    replayBitwise: first.replayDigest === second.replayDigest,
    kinetic: first.kinetic,
    golden: {
      maxPositionError: goldenMaxErr,
      tolerance: 0.05,
      withinTolerance: goldenMaxErr <= 0.05,
    },
    stretch: {
      gpuMaxRatio: stretchMaxRatio(first.finalState, buildClothParallelState({ ...GRID, pinned: PINNED })),
      band: 0.05,
    },
    deviceLost: device.lost ? "tracked" : "unknown",
  };
}
