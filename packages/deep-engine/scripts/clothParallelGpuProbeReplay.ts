// T18 A3 并行布料 probe 主证据重放(sourceSizeGate 拆分:自 clothParallelGpuProbe.ts
// 按职责分文件,代码逐行同源,仅改可见性;语义零变化)。
// 职责:240 ticks 真机重放 vs CPU 模拟镜像逐步对拍 + 真机双跑逐位 + f64 黄金容差。
import {
  ClothParallelMirror, buildClothParallelState, hostMergeTreeSum,
} from "../src/physics/clothParallelSolver.js";
import { ClothSolver } from "../src/physics/clothSolver.js";
import {
  CLOTH_PARALLEL_SOLVER_WORKGROUP_SIZE,
  CLOTH_PARALLEL_ENTRY_INTEGRATE, CLOTH_PARALLEL_ENTRY_PROJECT, CLOTH_PARALLEL_ENTRY_FINALIZE, CLOTH_PARALLEL_PARAMS_BYTES } from "../src/physics/clothSolverWgsl.js";
import { GRID, PINNED, TICKS, stateFingerprint, stretchMaxRatio, gpuContext } from "./clothParallelGpuProbeShared.js";

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
  const paramBytes = new ArrayBuffer(CLOTH_PARALLEL_PARAMS_BYTES);
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
  const paramsBuffer = device.createBuffer({ size: CLOTH_PARALLEL_PARAMS_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
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

  const per24: Array<{ tick: number; cpuFingerprint: string; gpuFingerprint: string; bitwiseMatch: boolean; gpuMaxPosErrVsCpu: number; diffIndexes: number[]; worstParticleIndex?: number; worstPinned?: boolean }> = [];
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
      let worstByte = -1;
      const diffIndexes: number[] = [];
      for (let i = 0; i < gpuState.length; i += 1) {
        const diff = Math.abs(gpuState[i]! - cpuState[i]!);
        if (diff > maxErr) { maxErr = diff; diffIndexes.length = 0; diffIndexes.push(i); worstByte = i; }
        else if (diff === maxErr && diff > 0 && diffIndexes.length < 8) diffIndexes.push(i);
      }
      const worstParticleIndex = worstByte >= 0 ? Math.floor(worstByte / 12) : -1;
      const gpuFingerprint = stateFingerprint(gpuState, particleCount);
      const cpuFingerprint = mirror.stateFingerprint32();
      per24.push({
        tick, cpuFingerprint, gpuFingerprint,
        bitwiseMatch: gpuFingerprint === cpuFingerprint,
        gpuMaxPosErrVsCpu: maxErr,
        diffIndexes,
        worstParticleIndex,
        worstPinned: worstParticleIndex >= 0 ? cpuState[worstParticleIndex * 12 + 3] === 0 : false,
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
