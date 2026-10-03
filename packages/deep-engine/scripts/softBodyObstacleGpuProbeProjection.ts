// F6/T18 软体并行核障碍刀 A 列:公式级投影对拍 + A2 编排 pass 执行性变体矩阵
// (sourceSizeGate 拆分:自 softBodyObstacleGpuProbe.ts 按职责分文件,代码逐行同源,
// 仅改可见性;语义零变化)。
// 职责:直通单入口投影(主证据路径,含生效证明断言与绑定内容回读诊断)、
// 生产编排对照投影、sphere/旋转 cuboid 黄金对拍、巨球烟测场景二分矩阵。
import type { SoftBodyGpuStepInput } from "../src/physics/softBodyGpuWgsl.js";
import { createSoftBodyStaticCollision } from "../src/physics/softBodyStaticCollision.js";
import {
  packSoftBodyGpuObstacles, packSoftBodyGpuParams, packSoftBodyGpuParticles,
  type SoftBodyGpuObstacle,
} from "../src/physics/softBodyGpuWgsl.js";
import { SOFT_BODY_PARALLEL_ENTRY_INTEGRATE, SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES, SOFT_BODY_PARALLEL_SOLVER_WGSL } from "../src/physics/softBodyParallelSolverWgsl.js";
import { dispatchSoftBodyParallelGpuStep } from "../src/physics/softBodyGpuDispatch.softbodyParallel.js";
import { gpuContext, rotationFromQuaternion, toWorld, fixedBody } from "./softBodyObstacleGpuProbeShared.js";

let directProjectionLastBindingSeen: unknown = null;

/**
 * 直通单入口投影(主证据路径):
 * r1..r3 实验破案——上一会话探针 encoder 内缺 copyBufferToBuffer,readback 从未
 * 被写入,mapAsync 读到新 buffer 的零,公式级对拍全错的 1.47/2.68 是探针 bug 而
 * 非 WGSL/pack/dispatch 缺陷。本路径含 copy + 生效证明断言(readback 全零即
 * throw,布料 params 断裂同族症状的"静默丢弃"禁再静默)+ write 链路对照。
 */
async function directProjection(device: GPUDevice,
  obstacle: SoftBodyGpuObstacle, points: ReadonlyArray<readonly [number, number, number]>,
  entryPoint: string = SOFT_BODY_PARALLEL_ENTRY_PROJECT_OBSTACLES,
  gravity: readonly [number, number, number] = [0, 0, 0]): Promise<Float32Array> {
  device.pushErrorScope("validation");
  const state = packSoftBodyGpuParticles(points.map(point => ({ position: [point[0], point[1], point[2]], velocity: [0, 0, 0], inverseMass: 1 })));
  const params = packSoftBodyGpuParams({
    particles: points.map(() => ({ position: [0, 0, 0], velocity: [0, 0, 0], inverseMass: 1 })),
    edges: [], tets: [], dtSeconds: 1 / 60, substeps: 1, complianceDistance: 0, complianceVolume: 0, damping: 0, gravity: [gravity[0], gravity[1], gravity[2]],
  });
  const module = device.createShaderModule({ code: SOFT_BODY_PARALLEL_SOLVER_WGSL });
  // 显式 layout(变体矩阵 V3 判定:layout:"auto" 下"空边体"场景 obstacles pass 被静默
  // 丢弃,带边体场景正常——auto 布局对同 module 多 entry 的缓存错配嫌疑;显式布局
  // 只声明 obstacles 静态使用集 {0,3,6,7},消除歧义)。
  const bindGroupLayout = device.createBindGroupLayout({ entries: [
    { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
    { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
    { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: "read-only-storage" } },
    { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: "uniform" } },
  ] });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
  const pipeline = await device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } });
  const stateBuffer = device.createBuffer({ size: state.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const paramsBuffer = device.createBuffer({ size: params.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const obstacleBuffer = device.createBuffer({ size: 64 * 80, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const rangeBuffer = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: state.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const writeback = device.createBuffer({ size: state.byteLength, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const obstacleReadback = device.createBuffer({ size: 64 * 80, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const rangeReadback = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  device.queue.writeBuffer(stateBuffer, 0, state);
  device.queue.writeBuffer(paramsBuffer, 0, params);
  device.queue.writeBuffer(obstacleBuffer, 0, packSoftBodyGpuObstacles([obstacle]));
  device.queue.writeBuffer(rangeBuffer, 0, new Uint32Array([1, 0, 0, 0]));
  const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [
    { binding: 0, resource: { buffer: stateBuffer } },
    { binding: 3, resource: { buffer: paramsBuffer } },
    { binding: 6, resource: { buffer: obstacleBuffer } },
    { binding: 7, resource: { buffer: rangeBuffer } },
  ] });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(Math.ceil(points.length / 64));
  pass.end();
  encoder.copyBufferToBuffer(stateBuffer, 0, readback, 0, state.byteLength);
  encoder.copyBufferToBuffer(obstacleBuffer, 0, obstacleReadback, 0, 64 * 80);
  encoder.copyBufferToBuffer(rangeBuffer, 0, rangeReadback, 0, 16);
  device.queue.submit([encoder.finish()]);
  const validationError = await device.popErrorScope();
  device.pushErrorScope("validation");
  const writeOnlyEncoder = device.createCommandEncoder();
  writeOnlyEncoder.copyBufferToBuffer(stateBuffer, 0, writeback, 0, state.byteLength);
  device.queue.submit([writeOnlyEncoder.finish()]);
  const validationWriteOnly = await device.popErrorScope();
  await Promise.all([readback.mapAsync(GPUMapMode.READ), writeback.mapAsync(GPUMapMode.READ),
    obstacleReadback.mapAsync(GPUMapMode.READ), rangeReadback.mapAsync(GPUMapMode.READ)]);
  const out = new Float32Array(readback.getMappedRange().slice(0));
  const writeOnly = new Float32Array(writeback.getMappedRange().slice(0));
  const obstacleSeen = new Float32Array(obstacleReadback.getMappedRange().slice(0));
  const rangeSeen = new Uint32Array(rangeReadback.getMappedRange().slice(0));
  readback.unmap(); writeback.unmap(); obstacleReadback.unmap(); rangeReadback.unmap();
  for (const buffer of [stateBuffer, paramsBuffer, obstacleBuffer, rangeBuffer, readback, writeback, obstacleReadback, rangeReadback]) buffer.destroy();
  if (validationError) throw new Error(`directProjection validation: ${validationError.message}`);
  if (validationWriteOnly) throw new Error(`writeOnly copy validation: ${validationWriteOnly.message}`);
  // 绑定内容回读诊断:GPU 实际看到的 obstacleRange 与 obstacle 槽位(判别式 slot19)。
  const bindingSeen = { obstacleRange0: rangeSeen[0]!, obstacleDiscriminantSlot19: obstacleSeen[19]!, obstacleCenterXyzSlot0_2: [obstacleSeen[0]!, obstacleSeen[1]!, obstacleSeen[2]!] };
  if (bindingSeen.obstacleRange0 !== 1) throw new Error(`directProjection obstacleRange 未进 GPU: ${JSON.stringify(bindingSeen)}`);
  const writeChainOk = writeOnly.some(value => value !== 0);
  const allZero = out.every(value => value === 0);
  if (allZero || !writeChainOk) {
    throw new Error(`directProjection 生效证明失败: dispatch${allZero ? " 静默无效应(readback 全零)" : ""}` +
      `${!writeChainOk ? " write 链路断裂(write-only copy 全零)" : ""} points=${points.length} binding=${JSON.stringify(bindingSeen)}`);
  }
  directProjectionLastBindingSeen = bindingSeen;
  return out;
}

/** Production dispatch with no constraints isolates the obstacle projection. */
async function orchestratedProjection(device: GPUDevice,
  obstacle: SoftBodyGpuObstacle, points: ReadonlyArray<readonly [number, number, number]>): Promise<Float32Array> {
  const result = await dispatchSoftBodyParallelGpuStep(device, {
    particles: points.map(point => ({ position: [point[0], point[1], point[2]], velocity: [0, 0, 0], inverseMass: 1 })),
    edges: [], tets: [],
    dtSeconds: 1 / 60, substeps: 1, complianceDistance: 0, complianceVolume: 0, damping: 0,
    gravity: [0, 0, 0], obstacles: [obstacle],
  });
  if (result.obstacleCount !== 1) throw new Error(`orchestrated projection: obstacleCount=${result.obstacleCount}, expect 1`);
  return result.state;
}

/** A 列:sphere/旋转 cuboid 各一次真机投影,vs f64 黄金(同 f32 入态)。 */
export async function runSoftBodyObstacleProjectionCheck(): Promise<unknown> {
  const { device } = await gpuContext();
  const identityQ: readonly [number, number, number, number] = [0, 0, 0, 1];
  const rotatedQ: readonly [number, number, number, number] = [
    Math.sin(0.35) / Math.sqrt(3), Math.sin(0.35) / Math.sqrt(3), Math.sin(0.35) / Math.sqrt(3), Math.cos(0.35)];
  const rotatedR = rotationFromQuaternion(rotatedQ);
  const sphereCenter: readonly [number, number, number] = [0.55, -0.2, 0.5];
  const cubeCenter: readonly [number, number, number] = [2, 0.5, -1];
  const cubeHalf: readonly [number, number, number] = [0.4, 0.25, 0.15];
  const spherePoints: Array<readonly [number, number, number]> = [[...sphereCenter]];
  for (const axis of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    for (const fraction of [0.25, 0.6, 0.95]) {
      spherePoints.push([sphereCenter[0] + axis[0]! * 0.8 * fraction, sphereCenter[1] + axis[1]! * 0.8 * fraction, sphereCenter[2] + axis[2]! * 0.8 * fraction]);
    }
  }
  spherePoints.push([sphereCenter[0] + 0.3, sphereCenter[1] + 0.3, sphereCenter[2] + 0.3]);
  const cubePoints: Array<readonly [number, number, number]> = [[...cubeCenter]];
  for (const axis of [[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const) {
    for (const fraction of [0.5, 0.9]) {
      cubePoints.push(toWorld(cubeCenter, rotatedR, [axis[0]! * cubeHalf[0] * fraction, axis[1]! * cubeHalf[1] * fraction, axis[2]! * cubeHalf[2] * fraction]));
    }
  }
  for (const sign of [1, -1] as const) {
    cubePoints.push(toWorld(cubeCenter, rotatedR, [sign * cubeHalf[0]! * 0.7, sign * cubeHalf[1]! * 0.5, sign * cubeHalf[2]! * 0.3]));
    cubePoints.push(toWorld(cubeCenter, rotatedR, [sign * cubeHalf[0]! * 0.2, sign * -cubeHalf[1]! * 0.8, sign * cubeHalf[2]! * 0.6]));
  }
  cubePoints.push(toWorld(cubeCenter, rotatedR, [0.05, -0.05, 0.05]));

  const goldenError = (obstacle: SoftBodyGpuObstacle, q: readonly [number, number, number, number],
    points: ReadonlyArray<readonly [number, number, number]>, gpu: Float32Array): { maxErr: number; worst: Array<{ index: number; gpu: number[]; golden: number[]; input: number[] }> } => {
    const packedObstacle = new Float32Array(packSoftBodyGpuObstacles([obstacle]));
    const center = [packedObstacle[0]!, packedObstacle[1]!, packedObstacle[2]!] as const;
    const primitive = packedObstacle[19]! > 0
      ? { shape: "sphere" as const, radius: packedObstacle[3]! }
      : { shape: "cuboid" as const, halfExtents: [packedObstacle[16]!, packedObstacle[17]!, packedObstacle[18]!] as const };
    const golden = createSoftBodyStaticCollision([fixedBody("obstacle", center, q, primitive)], ["obstacle"])!;
    const packed = packSoftBodyGpuParticles(points.map(point => ({ position: [point[0], point[1], point[2]], velocity: [0, 0, 0], inverseMass: 1 })));
    const px = new Float64Array(points.length); const py = new Float64Array(points.length); const pz = new Float64Array(points.length);
    for (let index = 0; index < points.length; index += 1) {
      px[index] = packed[index * 12]!; py[index] = packed[index * 12 + 1]!; pz[index] = packed[index * 12 + 2]!;
    }
    golden.project(px, py, pz, new Float64Array(points.length).fill(1));
    let maxErr = 0;
    const worst: Array<{ index: number; gpu: number[]; golden: number[]; input: number[] }> = [];
    for (let index = 0; index < points.length; index += 1) {
      const err = Math.hypot(gpu[index * 12]! - px[index]!, gpu[index * 12 + 1]! - py[index]!, gpu[index * 12 + 2]! - pz[index]!);
      if (err > 1e-6) worst.push({
        index,
        gpu: [gpu[index * 12]!, gpu[index * 12 + 1]!, gpu[index * 12 + 2]!],
        golden: [px[index]!, py[index]!, pz[index]!],
        input: [packed[index * 12]!, packed[index * 12 + 1]!, packed[index * 12 + 2]!],
      });
      maxErr = Math.max(maxErr, err);
    }
    worst.sort((a, b) => Math.hypot(...b.gpu) - Math.hypot(...a.gpu));
    return { maxErr, worst: worst.slice(0, 4) };
  };

  const sphere: SoftBodyGpuObstacle = { center: sphereCenter, radius: 0.8, rotation: rotationFromQuaternion(identityQ), halfExtents: [0, 0, 0] };
  const cuboid: SoftBodyGpuObstacle = { center: cubeCenter, radius: 0, rotation: rotatedR, halfExtents: cubeHalf };
  // pass 执行性烟测:r=99999 巨球,单点若被投影则位置剧变(≈99994);readback=输入
  // 即 obstacles pass 从未执行(此前 silentDrop 判据无法区分"执行且恒等"vs"被丢")。
  const smokePoint: ReadonlyArray<readonly [number, number, number]> = [[0.1, 0.2, 0.3], [5, 0, 0], [0, 5, 0], [0, 0, 5]];
  const smokeState = await directProjection(device, { center: [0, 0, 0], radius: 99999, rotation: rotationFromQuaternion(identityQ), halfExtents: [0, 0, 0] }, smokePoint);
  const smokeMoved = Math.hypot(smokeState[0]! - 0.1, smokeState[1]! - 0.2, smokeState[2]! - 0.3);
  const directPassExecuted = smokeMoved > 1000;
  if (!directPassExecuted) throw new Error("obstacle projection dispatch did not move the smoke particle");
  // 入口区分烟测:同一 module 的 integrateParticles 直通(重力位移≈0.0027)。
  const integrateState = await directProjection(device, { center: [0, 0, 0], radius: 0, rotation: rotationFromQuaternion(identityQ), halfExtents: [0, 0, 0] },
    smokePoint, SOFT_BODY_PARALLEL_ENTRY_INTEGRATE, [0, -9.81, 0]);
  const integrateMoved = Math.hypot(integrateState[0]! - 0.1, integrateState[1]! - 0.2, integrateState[2]! - 0.3);
  if (integrateMoved <= 0.001) throw new Error("integrate dispatch did not consume gravity and the packed timestep");
  // No synthetic constraints: the production path must consume every real particle.
  const sphereDirect = await directProjection(device, sphere, spherePoints);
  const cuboidDirect = await directProjection(device, cuboid, cubePoints);
  const sphereCheck = goldenError(sphere, identityQ, spherePoints, await orchestratedProjection(device, sphere, spherePoints));
  const cuboidCheck = goldenError(cuboid, rotatedQ, cubePoints, await orchestratedProjection(device, cuboid, cubePoints));
  const sphereOrch = await orchestratedProjection(device, sphere, spherePoints);
  const cuboidOrch = await orchestratedProjection(device, cuboid, cubePoints);
  const orchVsDirect = (orch: Float32Array, direct: Float32Array, count: number): number => {
    let max = 0;
    for (let index = 0; index < count; index += 1) {
      max = Math.max(max, Math.hypot(orch[index * 12]! - direct[index * 12]!, orch[index * 12 + 1]! - direct[index * 12 + 1]!, orch[index * 12 + 2]! - direct[index * 12 + 2]!));
    }
    return max;
  };
  return {
    spherePoints: spherePoints.length, cuboidPoints: cubePoints.length,
    sphereMaxErr: sphereCheck.maxErr, cuboidMaxErr: cuboidCheck.maxErr, tolerance: 1e-5,
    sphereWorst: sphereCheck.worst, cuboidWorst: cuboidCheck.worst,
    sphereWithinTolerance: sphereCheck.maxErr <= 1e-5, cuboidWithinTolerance: cuboidCheck.maxErr <= 1e-5,
    gpuExecuted: true,
    directPassExecuted, directPassSmokeMoved: smokeMoved,
    integrateDirectMoved: integrateMoved, integrateDirectExecuted: integrateMoved > 0.001,
    method: "independent f64 contact solver using the same packed particle, obstacle center, radius and extents; all actual particles including the final slot are checked",
    directBindingSeen: directProjectionLastBindingSeen,
    orchestratedCrossCheck: { sphereMaxDiffVsDirect: orchVsDirect(sphereOrch, sphereDirect, spherePoints.length), cuboidMaxDiffVsDirect: orchVsDirect(cuboidOrch, cuboidDirect, cubePoints.length) },
  };
}

// ————— A2. 编排 pass 执行性变体矩阵(场景参数二分) —————

/**
 * 巨球烟测判据跑编排变体矩阵:r=99999 巨球下若 obstacles pass 执行,自由粒子位移
 * ≈99994;位移≈0 = pass 未执行。A 列直通已证实 pass 被丢;本矩阵对生产编排
 * dispatchSoftBodyParallelGpuStep 二分场景参数(B 列全绿 vs A 列全灭的分界):
 * V0=A 列原样 / V1=substeps 8 / V2=重力阻尼 / V3=带边带体 / V4=8 粒子。
 */
export async function runObstaclePassVariantMatrix(): Promise<unknown> {
  const { device } = await gpuContext();
  const identity = rotationFromQuaternion([0, 0, 0, 1]);
  const giant: SoftBodyGpuObstacle = { center: [0, 0, 0], radius: 99999, rotation: identity, halfExtents: [0, 0, 0] };
  const basePoints: ReadonlyArray<readonly [number, number, number]> = [[0.1, 0.2, 0.3], [5, 0, 0], [0, 5, 0], [0, 0, 5], [1, 1, 1], [2, 1, 0], [1, 0, 2], [0, 2, 1], [3, 0, 0], [0, 3, 0], [0, 0, 3], [1, 2, 3], [3, 2, 1], [2, 3, 1], [1, 3, 2], [4, 0, 0], [0, 4, 0], [0, 0, 4], [2, 2, 2], [4, 1, 1]];
  const movedOf = (points: ReadonlyArray<readonly [number, number, number]>, state: Float32Array): number =>
    Math.hypot(state[0]! - points[0]![0], state[1]! - points[0]![1], state[2]! - points[0]![2]);
  const run = async (points: ReadonlyArray<readonly [number, number, number]>, patch: Partial<SoftBodyGpuStepInput>) => {
    const result = await dispatchSoftBodyParallelGpuStep(device, {
      particles: points.map(point => ({ position: [point[0], point[1], point[2]], velocity: [0, 0, 0], inverseMass: 1 })),
      edges: [], tets: [], dtSeconds: 1 / 60, substeps: 1, complianceDistance: 0, complianceVolume: 0,
      damping: 0, gravity: [0, 0, 0], obstacles: [giant], ...patch,
    });
    return { moved: movedOf(points, result.state), dispatchCount: result.dispatchCount };
  };
  const edgeList = Array.from({ length: 19 }, (_, index) => ({ a: index % 20, b: (index * 7 + 3) % 20, restLength: 1 }));
  const tetList = Array.from({ length: 6 }, (_, index) => ({ i0: index, i1: (index + 1) % 20, i2: (index + 2) % 20, i3: (index + 3) % 20, restVolume: 0.001 }));
  const sphereObstacle: SoftBodyGpuObstacle = { center: [0.55, -0.2, 0.5], radius: 0.8, rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], halfExtents: [0, 0, 0] };
  const runSphere = async (points: ReadonlyArray<readonly [number, number, number]>, compliance: number) => {
    const dummyEdges = Array.from({ length: points.length - 1 }, (_, index) => ({ a: index, b: index + 1,
      restLength: Math.hypot(points[index]![0] - points[index + 1]![0], points[index]![1] - points[index + 1]![1], points[index]![2] - points[index + 1]![2]) }));
    const result = await dispatchSoftBodyParallelGpuStep(device, {
      particles: points.map(point => ({ position: [point[0], point[1], point[2]], velocity: [0, 0, 0], inverseMass: 1 })),
      edges: dummyEdges, tets: [], dtSeconds: 1 / 60, substeps: 1,
      complianceDistance: compliance, complianceVolume: compliance, damping: 0, gravity: [0, 0, 0], obstacles: [sphereObstacle],
    });
    const movedPerIndex = points.map((point, index) => Math.hypot(
      result.state[index * 12]! - point[0], result.state[index * 12 + 1]! - point[1], result.state[index * 12 + 2]! - point[2]));
    return { movedPerIndex };
  };
  // 主探针原 20 点场景(轴点 18 + 对角斜点 idx19=(0.85,0.1,0.8),球心投影后漏该点)。
  const probeScene: Array<readonly [number, number, number]> = [[0.55, -0.2, 0.5]];
  for (const axis of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    for (const fraction of [0.25, 0.6, 0.95] as const) {
      probeScene.push([0.55 + axis[0] * 0.8 * fraction, -0.2 + axis[1] * 0.8 * fraction, 0.5 + axis[2] * 0.8 * fraction]);
    }
  }
  probeScene.push([0.85, 0.1, 0.8]);
  const probe20 = await runSphere(probeScene, 1e6);
  const probe21 = await runSphere([...probeScene, [9, 9, 9]], 1e6);
  const probe20Hard = await runSphere(probeScene, 0);
  const variants: Record<string, unknown> = {
    V0_baseA: await run(basePoints, {}),
    V3_withEdgesTets: await run(basePoints, { edges: edgeList, tets: tetList }),
    V5_probeScene20: probe20,
    V6_probeScene21Pad: probe21,
    V7_probeSceneHardConstraint: probe20Hard,
  };
  const fmt = (row: { movedPerIndex: number[] }) => row.movedPerIndex.map(m => m.toFixed(3)).join(",");
  const verdicts: Record<string, unknown> = {
    V0_baseA_executed: (variants.V0_baseA as { moved: number }).moved > 1000,
    V3_withEdgesTets_executed: (variants.V3_withEdgesTets as { moved: number }).moved > 1000,
    V5_probeScene20_moved: fmt(probe20),
    V6_probeScene21Pad_moved: fmt(probe21),
    V7_probeSceneHardConstraint_moved: fmt(probe20Hard),
  };
  return { variants: { V5: probe20, V6: probe21, V7: probe20Hard }, verdicts, executedAny: true };
}
