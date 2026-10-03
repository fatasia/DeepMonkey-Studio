// A2 WGSL SDF 碰撞 profile:真机 WebGPU 数值探针(浏览器内执行,由 sdfCollisionGpuTest.mjs 打包驱动)。
// 骨架沿 T18 A3 clothParallelGpuProbe(esbuild 打包 → 本地 http → headless Chrome --enable-unsafe-webgpu)。
//
// 证据口径(数值,非 timing):
// - 场:F6 共享凹 L 棱柱夹具(deep-engine-native/src/physics_sdf_l_fixture.json,由 runner 经
//   本地 http 提供 —— 与 native truth 测试 include_str! 同一字节源,探针不内联副本);
// - 点集:createSdfQueryPointStream 同 seed LCG 4096 点 = native 凸包真值对照的同一点集;
// - 对拍:真机 GPU(querySdfCollisionsGpu,A2 查询核 wgsl/sdfCollisionQuery.wgsl)vs CPU f32
//   模拟镜像(sampleSdfCollision)按容差;真机若做 FMA 融合允许位级差异(只记信息列,不作门),
//   数值容差门为合同(与布料真机先例同口径);
// - 确定性:一轮两 fresh dispatch(各自独立缓冲+管线)GPU-GPU 位级重放;
// - fail-closed:域外单点 lane 返回 status=1 + quiet NaN 位型(0x7fc00000)+ 零梯度。
import {
  createSdfCollisionProfile, createSdfQueryPointStream, estimateSdfCollisionMemory,
  fingerprintSdfQuerySamples, isSdfQueryNanBitPattern, querySdfCollisionsGpu,
  SDF_QUERY_LCG_SEED,
} from "../src/physics/sdfCollisionProfile.js";
import { DEEP_SDF_COLLISION_QUERY_WGSL } from "../src/physics/sdfCollisionQueryWgsl.js";
import { sdfColliderPayloadToGrid } from "../src/physics/sdfCollisionBridge.js";
import type { SdfCollisionProfile } from "../src/physics/sdfCollisionProfile.js";
import type { SdfGrid } from "../src/physics/sdfGrid.js";
import type { SdfCollisionGpuBatch } from "../src/physics/sdfCollisionGpuDispatch.js";

/** 与 native 真值对照(sdf_collision_profile_truth.rs)同点集。 */
const SAMPLE_COUNT = 4096;
/**
 * 数值容差门:GPU-vs-CPU 镜像只允许 FMA/次序级末位差异(实测预期 ~1e-7 量级),
 * 预算给到 1e-4(距离:米;梯度:1/米)—— 远严于体素分辨率(0.2165 m),宽容于 ulp 噪声。
 */
const DISTANCE_TOLERANCE = 1e-4;
const GRADIENT_TOLERANCE = 1e-4;

export async function probeAdapterInfo(): Promise<unknown> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  return adapter.info ?? {};
}

/** 夹具场(单源):runner 服务 fixture.json,元数据自带 grid 几何,不内联副本。 */
async function loadFixtureGrid(): Promise<SdfGrid> {
  const fixture = await fetch("./fixture.json", { cache: "no-store" })
    .then(response => response.json()) as {
      meta: { grid: { origin: [number, number, number]; cellSize: number; dimensions: [number, number, number] } };
      distances: number[];
    };
  const meta = fixture.meta.grid;
  return {
    ...sdfColliderPayloadToGrid({
      origin: meta.origin, cellSize: meta.cellSize, dimensions: meta.dimensions,
      distances: fixture.distances,
    }),
    maxSamplingError: Math.sqrt(3) * meta.cellSize * 0.5,
  };
}

interface ReplayEvidence {
  statusNonzeroCount: number;
  maxDistanceErrorVsCpu: number;
  maxGradientErrorVsCpu: number;
  maxErrorLane: number;
  gpuFingerprint: string;
  cpuFingerprint: string;
  gpuVsCpuBitwise: boolean;
  penetratingCount: number;
  distances: Float32Array;
  gradients: Float32Array;
}

/** 单次 fresh dispatch(独立缓冲 + 独立管线创建),逐 lane 与 CPU 镜像对拍。 */
async function runFreshReplay(device: GPUDevice, profile: SdfCollisionProfile,
  points: readonly (readonly [number, number, number])[], cpu: ReturnType<SdfCollisionProfile["sample"]>[]):
  Promise<ReplayEvidence> {
  const batch: SdfCollisionGpuBatch = await querySdfCollisionsGpu(device, profile, points);
  let statusNonzeroCount = 0;
  for (const status of batch.statuses) if (status !== 0) statusNonzeroCount += 1;
  let maxDistanceError = 0, maxGradientError = 0, maxErrorLane = 0;
  for (let index = 0; index < points.length; index += 1) {
    const reference = cpu[index]!;
    const distanceError = Math.abs(batch.distances[index]! - reference.distance);
    const gradientError = Math.max(
      Math.abs(batch.gradients[index * 3]! - reference.gradient[0]!),
      Math.abs(batch.gradients[index * 3 + 1]! - reference.gradient[1]!),
      Math.abs(batch.gradients[index * 3 + 2]! - reference.gradient[2]!),
    );
    if (distanceError > maxDistanceError || gradientError > maxGradientError) {
      maxErrorLane = index;
      maxDistanceError = Math.max(maxDistanceError, distanceError);
      maxGradientError = Math.max(maxGradientError, gradientError);
    }
  }
  const gpuFingerprint = fingerprintSdfQuerySamples(
    points.map((_, index) => ({
      inDomain: true, distance: batch.distances[index]!,
      gradient: [batch.gradients[index * 3]!, batch.gradients[index * 3 + 1]!, batch.gradients[index * 3 + 2]!] as const,
    })));
  const cpuFingerprint = fingerprintSdfQuerySamples(cpu);
  return {
    statusNonzeroCount,
    maxDistanceErrorVsCpu: maxDistanceError,
    maxGradientErrorVsCpu: maxGradientError,
    maxErrorLane,
    gpuFingerprint,
    cpuFingerprint,
    gpuVsCpuBitwise: gpuFingerprint === cpuFingerprint,
    penetratingCount: cpu.filter(sample => sample.distance < -profile.contactSkin).length,
    distances: batch.distances,
    gradients: batch.gradients,
  };
}

function bitwiseEqual(a: Float32Array, b: Float32Array): boolean {
  if (a.length !== b.length) return false;
  const left = new Uint32Array(a.buffer, a.byteOffset, a.length);
  const right = new Uint32Array(b.buffer, b.byteOffset, b.length);
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/** 主证据:F6 凹 L 场上 4096 点真机查询 vs CPU f32 镜像 + 两 fresh 重放 + 域外 fail-closed。 */
export async function runSdfCollisionGpuProbe(): Promise<unknown> {
  const adapter = await navigator.gpu?.requestAdapter();
  if (!adapter) throw new Error("WebGPU adapter unavailable");
  const device = await adapter.requestDevice();
  // fail-fast:真机编译诊断先行(cloth 探针同款),Dawn 的 pipeline 错误信息会被吞。
  const module = device.createShaderModule({ code: DEEP_SDF_COLLISION_QUERY_WGSL });
  const compilation = await module.getCompilationInfo();
  const fatal = compilation.messages.filter(message => message.type === "error");
  if (fatal.length) {
    throw new Error(`WGSL compile failed: ${fatal.map(message =>
      `${message.lineNum}:${message.linePos} ${message.message}`).join("; ")}`);
  }
  const grid = await loadFixtureGrid();
  const profile = createSdfCollisionProfile({ enabled: true, grid });
  const points = createSdfQueryPointStream(grid, SAMPLE_COUNT, SDF_QUERY_LCG_SEED);
  const cpu = points.map(point => profile.sample(point));
  // 一轮两 fresh:两次 dispatch 各自新建全部 GPU 缓冲与管线(逐位回放合同的同输入重放)。
  const first = await runFreshReplay(device, profile, points, cpu);
  const second = await runFreshReplay(device, profile, points, cpu);
  const replayBitwise = bitwiseEqual(first.distances, second.distances)
    && bitwiseEqual(first.gradients, second.gradients);
  // 域外 fail-closed:单点域外查询,宿主见到 status=1 + NaN 位型 + 零梯度 ⇒ 整批拒绝路径可达。
  const outside = await querySdfCollisionsGpu(device, profile,
    [[grid.origin[0]! - 10, grid.origin[1]! - 10, grid.origin[2]! - 10]]);
  const outsideBits = new Uint32Array(outside.distances.buffer, outside.distances.byteOffset, 1)[0]!;
  const failClosed = {
    statusOne: outside.statuses[0] === 1,
    nanBitPattern: isSdfQueryNanBitPattern(outsideBits),
    zeroGradient: outside.gradients.every(value => value === 0),
  };
  return {
    samples: SAMPLE_COUNT,
    grid: { dimensions: grid.dimensions, cellSize: grid.cellSize, maxSamplingError: grid.maxSamplingError },
    memoryBytes: profile.memoryEstimate(SAMPLE_COUNT).totalBytes,
    fresh: [
      {
        statusNonzeroCount: first.statusNonzeroCount,
        maxDistanceErrorVsCpu: first.maxDistanceErrorVsCpu,
        maxGradientErrorVsCpu: first.maxGradientErrorVsCpu,
        maxErrorLane: first.maxErrorLane,
        gpuFingerprint: first.gpuFingerprint,
        cpuFingerprint: first.cpuFingerprint,
        gpuVsCpuBitwise: first.gpuVsCpuBitwise,
        penetratingCount: first.penetratingCount,
      },
      {
        statusNonzeroCount: second.statusNonzeroCount,
        maxDistanceErrorVsCpu: second.maxDistanceErrorVsCpu,
        maxGradientErrorVsCpu: second.maxGradientErrorVsCpu,
        maxErrorLane: second.maxErrorLane,
        gpuFingerprint: second.gpuFingerprint,
        cpuFingerprint: second.cpuFingerprint,
        gpuVsCpuBitwise: second.gpuVsCpuBitwise,
        penetratingCount: second.penetratingCount,
      },
    ],
    replayBitwise,
    failClosed,
    memoryEstimate: estimateSdfCollisionMemory(grid.dimensions, SAMPLE_COUNT),
    deviceLost: device.lost ? "tracked" : "unknown",
  };
}
