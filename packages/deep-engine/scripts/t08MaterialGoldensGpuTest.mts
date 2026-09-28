import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { evaluateExtendedMaterialDirect, type StandardSurfaceInputs, type Vec3,
} from "../src/shader/materialEvaluate.js";
import { normalizeExtendedMaterialParameters, type ExtendedMaterialParameters,
} from "../src/shader/materialParameters.js";
import { GOLDEN_EXPECTED, GOLDEN_RADIANCE, GOLDEN_SWATCHES, GOLDEN_VIEW_DIRECTIONS,
  goldenGeometry } from "../src/shader/materialGoldens.js";
import { EXTENDED_MATERIAL_EVALUATION_WGSL } from "../src/shader/materialEvaluateWgsl.js";
import { assertIorAbiAlignment, expectedV5InstanceIorSlot, packExtendedParameterBlock,
} from "../src/shader/materialParameterAbi.js";
import { compareMaterialParameters, materialEvaluationResetPolicy,
  nextMaterialEvaluationGeneration } from "../src/shader/materialParameterRevision.js";
import { t08MaterialPageKernel } from "./t08MaterialPageKernel.mjs";

// T08 材质覆盖 GPU 联测（headless Chrome + 真机 GPU，复用 T03/T05 证据链模式）。
// 判定：42 行黄金表 GPU 求值 vs 冻结 CPU 参考，量化 1/255 容差逐通道 ±1 量子；
// 白炉能量守恒 GPU 复测（64×128 半球积分）≤ 1+1e-3 且与 CPU 参考差 ≤5e-3；
// 材质变更重置语义：同一 pipeline/bind group 上重写参数（generation bump）后必须产出新求值。

const WARMUP = 5, SAMPLES = 30, FURNACE_SAMPLES = 10;
const FURNACE_THETA = 64, FURNACE_PHI = 128;
const FURNACE_ANGLES = [0, 15, 30, 45, 60, 75, 85] as const;
const QUANTUM_BUDGET = 1; // ±1/255 量子,不许放宽。
const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/T08/goldens-gpu-r1/", import.meta.url));

const percentiles = (values: readonly number[]): { mean: number; p50: number; p95: number } => {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]! };
};
const quantize = (value: number): number => Math.round(value * 255);

interface GoldenRow { swatch: string; view: string; surface: StandardSurfaceInputs;
  params: ExtendedMaterialParameters; view: Vec3 }
const rows: GoldenRow[] = GOLDEN_SWATCHES.flatMap((swatch) => GOLDEN_VIEW_DIRECTIONS.map(({ label, view }) => ({
  swatch: swatch.id, view: label, surface: swatch.surface,
  params: normalizeExtendedMaterialParameters(swatch.extended), view })));

/** 行布局(32 f32 = 8×vec4):v0 baseColor+metallic · v1 normal+roughness · v2 view · v3 light
 * · v4 tangent · v5 radiance · v6/v7 参数块(6 f32,MATERIAL_PARAMETER_KEYS 顺序)。 */
const packGoldens = (variants: GoldenRow[]): Float32Array => {
  const buffer = new Float32Array(variants.length * 32);
  variants.forEach((row, index) => {
    const base = index * 32, geometry = goldenGeometry(row.view);
    buffer.set([...row.surface.baseColor, row.surface.metallic], base);
    buffer.set([...geometry.normal, row.surface.roughness], base + 4);
    buffer.set([...geometry.view], base + 8);
    buffer.set([...geometry.light], base + 12);
    buffer.set([...geometry.tangent!], base + 16);
    buffer.set([...GOLDEN_RADIANCE], base + 20);
    buffer.set(packExtendedParameterBlock(row.params), base + 24);
  });
  return buffer;
};
rows.forEach((row) => {
  const instance = new Array<number>(36).fill(0);
  instance[15] = expectedV5InstanceIorSlot(row.params);
  assertIorAbiAlignment(row.params, instance);
});

/** 白炉配置集(镜像 CPU 能量守恒测试的 9 配置;GPU 复测用同一组,不另立口径)。 */
const FURNACE_CONFIGS: readonly (readonly [string, Partial<ExtendedMaterialParameters>, StandardSurfaceInputs])[] = [
  ["dielectric-r0.045", {}, { baseColor: [1, 1, 1], metallic: 0, roughness: 0.045 }],
  ["dielectric-r1.0", {}, { baseColor: [1, 1, 1], metallic: 0, roughness: 1 }],
  ["metal-r0.045", {}, { baseColor: [0.9, 0.87, 0.84], metallic: 1, roughness: 0.045 }],
  ["metal-r1.0", {}, { baseColor: [0.9, 0.87, 0.84], metallic: 1, roughness: 1 }],
  ["clearcoat", { clearcoat: { factor: 1, roughness: 0.5 } }, { baseColor: [0.8, 0.2, 0.1], metallic: 0.2, roughness: 0.4 }],
  ["anisotropy", { anisotropy: { strength: 1, rotation: 1.2 } }, { baseColor: [0.9, 0.87, 0.84], metallic: 1, roughness: 0.35 }],
  ["glass-half", { transmission: { factor: 0.5 } }, { baseColor: [1, 1, 1], metallic: 0, roughness: 0.35 }],
  ["glass-full", { transmission: { factor: 1 }, ior: 1.52 }, { baseColor: [1, 1, 1], metallic: 0, roughness: 0.35 }],
  ["full-stack", { clearcoat: { factor: 0.7, roughness: 0.3 }, anisotropy: { strength: 0.6, rotation: 0.4 },
    transmission: { factor: 0.4 } }, { baseColor: [0.9, 0.9, 0.9], metallic: 0.1, roughness: 0.3 }],
];
const furnaceCases = FURNACE_CONFIGS.flatMap(([name, extended, surface]) =>
  FURNACE_ANGLES.map((degrees) => ({ name, degrees, extended, surface })));
const packFurnace = (): Float32Array => {
  const buffer = new Float32Array(furnaceCases.length * 16);
  furnaceCases.forEach((entry, index) => {
    const base = index * 16, theta = entry.degrees * Math.PI / 180;
    const block = packExtendedParameterBlock(normalizeExtendedMaterialParameters(entry.extended));
    buffer.set([...entry.surface.baseColor, entry.surface.metallic], base);
    buffer.set([Math.sin(theta), 0, Math.cos(theta), entry.surface.roughness], base + 4);
    buffer.set(block.slice(0, 4), base + 8);
    buffer.set(block.slice(4, 6), base + 12);
  });
  return buffer;
};
/** CPU 半球反射率(与求值参考测试同式,网格 64×128 与 GPU 一致)。 */
const cpuReflectance = (surface: StandardSurfaceInputs, extended: Partial<ExtendedMaterialParameters>,
  degrees: number): number => {
  const view: Vec3 = [Math.sin(degrees * Math.PI / 180), 0, Math.cos(degrees * Math.PI / 180)];
  let sum = 0;
  for (let i = 0; i < FURNACE_THETA; i++) {
    const theta = (i + 0.5) * (Math.PI / 2) / FURNACE_THETA;
    const bandWeight = Math.cos(theta) * Math.sin(theta) * Math.PI * Math.PI / (FURNACE_THETA * FURNACE_PHI);
    for (let j = 0; j < FURNACE_PHI; j++) {
      const phi = (j + 0.5) * 2 * Math.PI / FURNACE_PHI;
      const light: Vec3 = [Math.sin(theta) * Math.cos(phi), Math.sin(theta) * Math.sin(phi), Math.cos(theta)];
      const { rgb } = evaluateExtendedMaterialDirect(surface, extended, { normal: [0, 0, 1], view, light }, [1, 1, 1]);
      sum += (rgb[0] + rgb[1] + rgb[2]) / 3 * bandWeight;
    }
  }
  return sum;
};

const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end("<html><body style=\"background:#101820\"><canvas id=\"view\" width=\"448\" height=\"96\" style=\"width:896px;height:192px;image-rendering:pixelated\"></canvas></body></html>"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
await mkdir(outputDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 960, height: 240 } });
  await page.goto(`http://127.0.0.1:${port}`);
  // 重置演示:car-paint(swatch 11,行 33-35)clearcoatFactor 1→0,generation bump。
  const carPaint = GOLDEN_SWATCHES.find(swatch => swatch.id === "car-paint")!;
  const paramsA = normalizeExtendedMaterialParameters(carPaint.extended);
  const paramsB = normalizeExtendedMaterialParameters({ ...carPaint.extended, clearcoat: { factor: 0, roughness: 0.45 } });
  const change = compareMaterialParameters(paramsA, paramsB);
  const resetPolicy = materialEvaluationResetPolicy(change);
  const generationB = nextMaterialEvaluationGeneration(0, change);
  const resetRows: GoldenRow[] = rows.map((row) => row.swatch === "car-paint"
    ? { ...row, params: paramsB } : row);
  const goldensBytes = packGoldens(rows), resetBytes = packGoldens(resetRows), furnaceBytes = packFurnace();
  const gpu = await page.evaluate(t08MaterialPageKernel, {
    rowCount: rows.length, furnaceConfigCount: furnaceCases.length, furnaceTheta: FURNACE_THETA,
    furnacePhi: FURNACE_PHI, warmup: WARMUP, samples: SAMPLES, furnaceSamples: FURNACE_SAMPLES,
    wgsl: EXTENDED_MATERIAL_EVALUATION_WGSL,
    goldensB64: Buffer.from(goldensBytes.buffer, goldensBytes.byteOffset, goldensBytes.byteLength).toString("base64"),
    goldensResetB64: Buffer.from(resetBytes.buffer, resetBytes.byteOffset, resetBytes.byteLength).toString("base64"),
    furnaceB64: Buffer.from(furnaceBytes.buffer, furnaceBytes.byteOffset, furnaceBytes.byteLength).toString("base64") });
  const decodeF32 = (base64Text: string): Float32Array => {
    const bytes = Buffer.from(base64Text, "base64");
    return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  };
  const gpuOut = decodeF32(gpu.goldensB64);
  const gpuReset = decodeF32(gpu.resetB64!);
  const furnaceGpu = decodeF32(gpu.furnaceB64);
  const allFinite = (values: Float32Array): boolean => [...values].every(Number.isFinite);
  const rowReport: Record<string, unknown>[] = [];
  let maxQuantumGpu = 0, maxQuantumCpu = 0, maxAbsRgbDiff = 0, resetMaxAbsDiff = 0, resetQuantumShift = 0;
  rows.forEach((row, index) => {
    const cpu = evaluateExtendedMaterialDirect(row.surface, row.params, goldenGeometry(row.view), GOLDEN_RADIANCE);
    const frozen = GOLDEN_EXPECTED[index]!;
    // 冻结表 12 值从 diffuse 起;GPU 读回 5 槽含 rgb(槽 0),对拍必须跳过 rgb 槽。
    const gpuQuantized = [1, 2, 3, 4].flatMap(lobe =>
      [0, 1, 2].map(channel => quantize(gpuOut[index * 20 + lobe * 4 + channel]!)));
    const cpuQuantized = [...cpu.components.diffuse, ...cpu.components.specular, ...cpu.components.clearcoat,
      ...cpu.components.transmission].map(quantize);
    const quantumGpu = Math.max(...gpuQuantized.map((value, channel) => Math.abs(value - frozen.quantized[channel]!)));
    const quantumCpu = Math.max(...cpuQuantized.map((value, channel) => Math.abs(value - frozen.quantized[channel]!)));
    const rgbDiff = Math.max(...[0, 1, 2].map(channel => Math.abs(gpuOut[index * 20 + channel]! - cpu.rgb[channel]!)));
    maxQuantumGpu = Math.max(maxQuantumGpu, quantumGpu);
    maxQuantumCpu = Math.max(maxQuantumCpu, quantumCpu);
    maxAbsRgbDiff = Math.max(maxAbsRgbDiff, rgbDiff);
    if (row.swatch === "car-paint") {
      // 重置二轮的 CPU 参考 = paramsB(clearcoatFactor 0)的新求值,不是一轮参考。
      const cpuReset = evaluateExtendedMaterialDirect(row.surface, paramsB, goldenGeometry(row.view), GOLDEN_RADIANCE);
      const ccOffset = index * 20 + 12;
      resetMaxAbsDiff = Math.max(resetMaxAbsDiff,
        ...[0, 1, 2].map(channel => Math.abs(gpuReset[ccOffset + channel]! - cpuReset.components.clearcoat[channel]!)));
      resetQuantumShift = Math.max(resetQuantumShift,
        Math.abs(quantize(gpuReset[ccOffset]!) - quantize(gpuOut[ccOffset]!)));
    }
    rowReport.push({ swatch: row.swatch, view: row.view, frozenQuantized: frozen.quantized,
      gpuQuantized, maxQuantumDiff: quantumGpu, gpuRgbVsCpuRgbMaxAbsDiff: Number(rgbDiff.toPrecision(3)) });
  });
  const furnaceReport = FURNACE_CONFIGS.map(([name], configIndex) => {
    const slice = FURNACE_ANGLES.map((_, angle) => configIndex * FURNACE_ANGLES.length + angle);
    const gpuMax = Math.max(...slice.map(index => furnaceGpu[index]!));
    const parityMax = Math.max(...slice.map((index, angle) =>
      Math.abs(furnaceGpu[index]! - cpuReflectance(furnaceCases[index]!.surface,
        furnaceCases[index]!.extended, FURNACE_ANGLES[angle]!))));
    return { name, gpuMaxReflectance: Number(gpuMax.toPrecision(4)),
      gpuVsCpuMaxAbsDiff: Number(parityMax.toPrecision(4)) };
  });
  const furnaceBudgetMax = Math.max(...furnaceReport.map(entry => entry.gpuMaxReflectance));
  const furnaceParityMax = Math.max(...furnaceReport.map(entry => entry.gpuVsCpuMaxAbsDiff));
  const checks = {
    noQueueErrors: gpu.queueErrors.length === 0 && gpu.messages.every(m => !m.startsWith("error")),
    goldensFiniteAndNonNegative: allFinite(gpuOut) && Math.min(...gpuOut) >= 0,
    goldensQuantumWithinBudget: maxQuantumGpu <= QUANTUM_BUDGET,
    cpuGoldenSanityWithinBudget: maxQuantumCpu <= QUANTUM_BUDGET,
    furnaceReflectanceWithinBudget: furnaceBudgetMax <= 1 + 1e-3,
    furnaceCpuParity: furnaceParityMax <= 5e-3,
    resetSemantics: change.changedKeys.includes("clearcoatFactor") && generationB === 1
      && resetPolicy.resetEvaluationCache && resetPolicy.resetAccumulation
      && resetMaxAbsDiff <= 1e-5 && resetQuantumShift >= 1,
  };
  await page.evaluate(({ pixels }: { pixels: number[] }) => {
    const canvas = document.getElementById("view") as HTMLCanvasElement;
    const context = canvas.getContext("2d")!;
    const image = context.createImageData(canvas.width, canvas.height);
    pixels.forEach((value, index) => { image.data[index] = value; });
    context.putImageData(image, 0, 0);
  }, { pixels: (() => {
    const data = new Array<number>(448 * 96 * 4).fill(255); // RGBA
    rows.forEach((_, index) => {
      const column = Math.floor(index / 3), displayRow = index % 3;
      for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) {
        const pixel = ((displayRow * 32 + y + 1) * 448 + column * 32 + x + 1) * 4;
        for (let channel = 0; channel < 3; channel++) {
          const linear = gpuOut[index * 20 + channel]!;
          data[pixel + channel] = Math.round(255 * Math.min(1, Math.max(0, linear / (1 + linear))));
        }
      }
    });
    return data;
  })() });
  await page.screenshot({ path: `${outputDir}swatch-grid.png` });
  const verdict = { allPass: Object.values(checks).every(Boolean), quantumBudget: `±${QUANTUM_BUDGET}/255`,
    note: "黄金表期望值直接 import materialGoldens(GPU 侧未重算);白炉 = 单位 radiance 半球积分(等立体角权重);重置演示 = 同一 pipeline/bind group 上重写参数块后二轮求值,必须与 CPU 新参数参考一致且与一轮输出可分" };
  const evidence = { schema: "t08-material-goldens-gpu-evidence-v1", createdAt: new Date().toISOString(),
    lane: "t08-material-goldens-real-gpu",
    method: "生产 WGSL 求值核(EXTENDED_MATERIAL_EVALUATION_WGSL)+ ABI 6-float 参数块;42 行黄金表逐通道量化对拍;白炉半球积分 64×128;重置演示 car-paint cc 1→0",
    rows: rowReport, furnace: furnaceReport,
    reset: { changedKeys: change.changedKeys, generationB, policy: resetPolicy,
      gpuResetCcLobeVsCpuMaxAbsDiff: Number(resetMaxAbsDiff.toPrecision(3)),
      gpuResetQuantumShift: resetQuantumShift },
    gpuCostMs: { goldens: { ...percentiles(gpu.durations), samples: SAMPLES, warmup: WARMUP },
      furnace: { ...percentiles(gpu.furnaceDurations), samples: FURNACE_SAMPLES, warmup: 5 } },
    gpuAdapter: gpu.adapter, queueErrors: gpu.queueErrors, shaderMessages: gpu.messages,
    maxQuantumDiffGpu: maxQuantumGpu, maxQuantumDiffCpuSanity: maxQuantumCpu,
    gpuVsCpuRgbMaxAbsDiff: Number(maxAbsRgbDiff.toPrecision(3)), checks, verdict };
  await writeFile(`${outputDir}evidence.json`, JSON.stringify(evidence, null, 2));
  await writeFile(fileURLToPath(new URL("../../../docs/reports/deep-core/assets/t08-material-goldens-gpu-2026-09-28.json", import.meta.url)),
    JSON.stringify(evidence, null, 2));
  console.log(`t08 gpu: pass=${verdict.allPass} maxQuantumGpu=${maxQuantumGpu} maxQuantumCpuSanity=${maxQuantumCpu} rgbDiff=${maxAbsRgbDiff.toExponential(2)} furnaceMax=${furnaceBudgetMax.toFixed(4)} furnaceParity=${furnaceParityMax.toExponential(2)} resetDiff=${resetMaxAbsDiff.toExponential(2)} p50=${percentiles(gpu.durations).p50.toFixed(2)}ms`);
  if (!verdict.allPass) process.exitCode = 1;
} finally { await browser.close(); server.close(); }
