import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL } from "../src/lighting/reflectionProbeBoxProjectionWgsl.ts";
import { measureReflectionParallaxCase, reflectionProbeBoxProjectCpu,
  reflectionProbeInfluenceWeightCpu, roomParallaxCases } from "../src/lighting/reflectionProbeParallax.ts";
import { c15ReflectionProbePageKernel } from "./c15ReflectionProbePageKernel.mjs";

// C15 反射探针盒投影——真机 headless GPU 采集(复用 T03 证据链模式:
// headless Chrome + 真机 NVIDIA GPU)。判定:
// - 生产 WGSL 单源核在真实 Dawn/Tint 编译零 error;
// - GPU f32 vs CPU f64 镜像逐用例对拍:方向分量 max abs diff ≤ 1e-5、hitDistance ≤ 1e-4、
//   权重 ≤ 1e-5(哨兵用例要求逐位一致——哨兵是语义不是数值);
// - 逐调用成本:合并两核的单 pass 耗时 − 基线核单 pass 耗时,给出每用例增量口径;
// - 量化对照(平面 vs 盒投影)随 JSON 落盘 test-output/deep-core/C15/。

const WARMUP = 5, SAMPLES = 30;
// 成本负载体量:16384 线程 × 4096 迭代 ≈ 67M 次核心调用/dispatch。Chrome
// performance.now 以 0.1ms 量化,256 迭代时 delta(≈0.05ms)翻硬币落在量化噪声里
// (首轮实测),4096 迭代把 delta 抬到 ≈1ms,远超量化下限。
const COST_THREADS = 16384, ITERATIONS = 4096;
const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/C15/", import.meta.url));

const ROOM = { center: [0, 0, 0], halfExtents: [4, 1.5, 4], blendDistance: 1, influenceRadius: 2 };
const DIRECTIONS = [
  [0.2, 0.6, 0.8], [0.9, 0.1, 0.2], [-0.5, 0.7, -0.3],
];

interface GpuCase { name: string; position: readonly number[]; direction: readonly number[] }

const buildCases = (): GpuCase[] => {
  const cases: GpuCase[] = [];
  const sweepOffsets = [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5];
  for (const offset of sweepOffsets) {
    for (const [directionIndex, direction] of DIRECTIONS.entries()) {
      cases.push({ name: `room-x${offset.toFixed(2)}-d${directionIndex}`,
        position: [offset, 0, 0], direction });
    }
  }
  // 语义哨兵与退化族:盒外(-1)、零方向(-2)、面上接收点(t=0 边界)、对角命中、平行轴(轴不约束)。
  // 非法盒(-2 经 extents)路径由 CPU 门禁覆盖(全局 ROOM 为合法盒,单盒扫描不换探针)。
  cases.push({ name: "outside-box", position: [4.5, 0, 0], direction: [1, 0, 0] });
  cases.push({ name: "zero-direction", position: [0, 0, 0], direction: [0, 0, 0] });
  cases.push({ name: "face-exact", position: [4, 0, 0], direction: [0, 1, 0] });
  cases.push({ name: "diagonal-corner", position: [3.9, 1.4, 3.9], direction: [1, 1, 1] });
  cases.push({ name: "parallel-axis", position: [1, 1, 1], direction: [0, 1, 0] });
  return cases;
};

const CASES = buildCases();
// CaseInput 布局(与页内核 struct 严格镜像,storage 对齐后 stride=64B=16 floats):
// [position(3),0] [direction(3),0] [center(3),blendDistance] [halfExtents(3),influenceRadius]。
const packedCases = new Float32Array(CASES.length * 16);
CASES.forEach((item, index) => {
  const row = index * 16;
  packedCases.set([...item.position, 0,
    ...item.direction, 0,
    ...ROOM.center, ROOM.blendDistance,
    ...ROOM.halfExtents, ROOM.influenceRadius], row);
});

const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end("<html><body style=\"background:#101820\"><canvas id=\"view\" width=\"64\" height=\"64\"></canvas></body></html>"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"],
});
await mkdir(outputDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  await page.goto(`http://127.0.0.1:${port}`);
  const gpu = await page.evaluate(c15ReflectionProbePageKernel, {
    caseCount: CASES.length,
    cases: Array.from(packedCases),
    wgslLibrary: DEEP_REFLECTION_PROBE_BOX_PROJECTION_WGSL,
    warmup: WARMUP, samples: SAMPLES,
    costThreads: COST_THREADS, iterations: ITERATIONS,
  });
  if (gpu.error) throw new Error(`GPU probe failed: ${gpu.error} ${JSON.stringify(gpu.messages ?? [])}`);
  // 位重解释而非逐元素转换:new Float32Array(Buffer) 会把字节值 0..255 当 float(本次真 bug)。
  const reinterpretF32 = (base64: string): Float32Array => {
    const bytes = new Uint8Array(Buffer.from(base64, "base64"));
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  };
  const projected = reinterpretF32(gpu.projectedB64);
  const weights = reinterpretF32(gpu.weightsB64);

  const compare = <T>(a: T, b: T): number => Math.abs((a as number) - (b as number));
  const rows = CASES.map((item, index) => {
    const gpuDirection: readonly number[] = [projected[index * 4]!, projected[index * 4 + 1]!, projected[index * 4 + 2]!];
    const gpuHit = projected[index * 4 + 3]!;
    const gpuWeight = weights[index]!;
    const probe = ROOM;
    const cpu = reflectionProbeBoxProjectCpu(item.position as readonly number[], item.direction, probe);
    const cpuWeight = reflectionProbeInfluenceWeightCpu(item.position as readonly number[], probe);
    const directionDiff = Math.max(compare(gpuDirection[0], cpu.direction[0]),
      compare(gpuDirection[1], cpu.direction[1]), compare(gpuDirection[2], cpu.direction[2]));
    const hitDiff = compare(gpuHit, cpu.hitDistance);
    const weightDiff = compare(gpuWeight, cpuWeight);
    // 哨兵是语义值,必须逐位一致;数值结果走容差。
    const sentinel = cpu.hitDistance < 0;
    const parityOk = sentinel
      ? hitDiff === 0 && weightDiff === 0
      : directionDiff <= 1e-5 && hitDiff <= 1e-4 && weightDiff <= 1e-5;
    return {
      name: item.name, corrected: cpu.corrected, cpuHit: cpu.hitDistance, gpuHit,
      cpuWeight, gpuWeight, directionDiff, hitDiff, weightDiff, parityOk,
      cpuDirection: cpu.direction, gpuDirection,
    };
  });

  const percentiles = (values: readonly number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return {
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      p50: sorted[Math.floor(sorted.length / 2)]!,
      p95: sorted[Math.floor(sorted.length * 0.95)]!,
    };
  };
  const combined = gpu.timings.durations.map((value, index) =>
    value - gpu.timings.baselineDurations[index]!);
  const passTiming = percentiles(gpu.timings.durations);
  const baselineTiming = percentiles(gpu.timings.baselineDurations);
  const deltaTiming = percentiles(combined);
  const invocationsPerDispatch = gpu.costThreads * gpu.iterations;
  const perInvocationDeltaNs = deltaTiming.mean / invocationsPerDispatch * 1e6;
  // 等效全屏口径:1080p 每像素 1 次核心调用的帧成本与 16.7ms 帧预算占比。
  // Chrome performance.now 以 0.1ms 量化,delta 处于量化噪声层,该口径按上界读。
  const frameEquivalentMs = perInvocationDeltaNs * (1920 * 1080) / 1e6;
  const frameBudgetFraction = frameEquivalentMs / 16.667;

  const parityFails = rows.filter(row => !row.parityOk);
  const checks = {
    noWgslErrors: gpu.messages.every((message: string) => !message.startsWith("error")),
    noQueueErrors: gpu.queueErrors.length === 0,
    parityAllCases: parityFails.length === 0,
    directionParityGate: Math.max(...rows.map(row => row.directionDiff)) <= 1e-5,
    timingSamplesAtLeast: gpu.timings.durations.length === SAMPLES,
    costMeasurable: passTiming.mean > baselineTiming.mean,
  };
  const evidence = {
    task: "I级C15 反射探针盒投影视差校正——真机 headless GPU 采集",
    adapter: gpu.adapter || "headless-chrome-webgpu",
    caseCount: CASES.length,
    warmup: WARMUP, samples: SAMPLES,
    costLoad: { threads: gpu.costThreads, iterations: gpu.iterations, invocationsPerDispatch },
    checks,
    parity: {
      maxDirectionDiff: Math.max(...rows.map(row => row.directionDiff)),
      maxHitDiff: Math.max(...rows.map(row => row.hitDiff)),
      maxWeightDiff: Math.max(...rows.map(row => row.weightDiff)),
      failedCases: parityFails.map(row => row.name),
    },
    cost: {
      note: "成本核=主核(盒投影+权重,每线程 256 迭代)与基线核(同数据流廉价乘加)交替计时,均值差折算逐调用增量;Chrome performance.now 有 0.1ms 量化,delta 在噪声层,等效帧成本按上界读",
      passMs: passTiming, baselineMs: baselineTiming, deltaMs: deltaTiming,
      perInvocationDeltaNs,
      frameEquivalentMs,
      frameBudgetFractionOf16ms: frameBudgetFraction,
      staticAluNote: "盒投影核静态标量 ALU ≈30–45(守卫+逐轴出射+归一化),0 次新增纹理取;相对一次 cubemap 三线性(8 texel fetch)可忽略",
    },
    rows: rows.map(row => ({ ...row, cpuDirection: undefined, gpuDirection: undefined })),
    wgslMessages: gpu.messages,
    quantified: roomParallaxCases(ROOM, [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5])
      .map(item => measureReflectionParallaxCase(item)),
    quantifiedFarContent: roomParallaxCases(ROOM, [1, 2, 3.5], { contentDistance: 30 })
      .map(item => measureReflectionParallaxCase(item)),
  };
  const outputPath = `${outputDir}reflection-parallax-gpu.json`;
  await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  console.log(`cases=${CASES.length} checks=${JSON.stringify(checks)}`);
  console.log(`parity maxDir=${evidence.parity.maxDirectionDiff.toExponential(2)} maxHit=${evidence.parity.maxHitDiff.toExponential(2)} maxWeight=${evidence.parity.maxWeightDiff.toExponential(2)}`);
  console.log(`cost main p50=${passTiming.p50.toFixed(3)}ms baseline p50=${baselineTiming.p50.toFixed(3)}ms delta mean=${deltaTiming.mean.toFixed(3)}ms perInvocation≈${perInvocationDeltaNs.toFixed(3)}ns @${(invocationsPerDispatch / 1e6).toFixed(2)}M calls/dispatch`);
  console.log(`frame-equivalent 1080p≈${(frameEquivalentMs * 1000).toFixed(1)}µs/frame = ${(frameBudgetFraction * 100).toFixed(2)}% of 16.7ms budget (quantization-bounded upper read)`);
  if (!Object.values(checks).every(Boolean)) {
    throw new Error(`C15 GPU gate failed: ${JSON.stringify({ checks, parity: evidence.parity })}`);
  }
  console.log(`evidence -> ${outputPath}`);
} finally {
  await browser.close();
  server.close();
}
