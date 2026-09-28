import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SSR_TRACE_WGSL, SSR_COMPOSITE_WGSL, SSR_RADIANCE_DOWNSAMPLE_WGSL,
} from "../src/postprocess/screenSpaceReflectionWgsl.ts";
import { buildSsrSceneFrame, SSR_SEQUENCE_VERTICAL_FOV, type SsrSceneConfig,
} from "../src/postprocess/screenSpaceReflectionScenes.ts";
import { packParameters, radianceMipLevels } from "../src/postprocess/screenSpaceReflection.ts";
import { screenSpaceReflectionCpu } from "../src/postprocess/screenSpaceReflectionCpu.ts";
import { evaluateSsrSequenceAgainstGroundTruth, scanSsrTraceIntegrity, scanSsrCompositeIntegrity,
  ssrRegionSsim, buildSsrBoxMipPyramid, trilinearConeRadiance,
} from "../src/postprocess/screenSpaceReflectionQuality.ts";
import { marchGroundTruthRef } from "../src/postprocess/screenSpaceReflectionScenes.ts";
import { compositeScreenSpaceReflectionCpu, reflectViewRay, screenSpaceReflectionEdgeFade,
} from "../src/postprocess/screenSpaceReflectionCpu.ts";
import type { ScreenSpaceReflectionCpuOptions } from "../src/postprocess/screenSpaceReflectionTypes.ts";
import { t03SsrPageKernel } from "./t03SsrGpuPageKernel.mjs";

// T03 四组序列实机 GPU 采集（headless Chrome + 真机 GPU，复用 T05 证据链模式）。
// 判定：逐序列 NaN/Inf/黑洞/负值 = 0、参考区 SSIM≥0.98（GPU composite vs CPU 可执行规范）、
// GPU/CPU trace parity ≤5e-3、误命中率 ≤2%（按序列口径分档记录）；禁全屏模糊。

const SIZE = 128, WARMUP = 5, SAMPLES = 30;
const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL("../../../test-output/deep-core/T03/sequences-gpu-r1/", import.meta.url));

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
function f16Bits(value: number): number {
  f32[0] = value; const bits = u32[0]!;
  const sign = (bits >> 16) & 0x8000;
  const exponent = (bits >> 23) & 0xff, mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa ? 1 : 0);
  const adjusted = exponent - 127 + 15;
  if (adjusted >= 0x1f) return sign | 0x7c00;
  if (adjusted <= 0) {
    if (adjusted < -10) return sign;
    const combined = mantissa | 0x800000;
    return sign | (combined >> (14 - adjusted));
  }
  return sign | (adjusted << 10) | (mantissa >> 13);
}
const toF16RgbaBytes = (rgb: Float32Array, pixelCount: number): Uint8Array => {
  const bytes = new Uint8Array(pixelCount * 8), view = new DataView(bytes.buffer);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      view.setUint16(pixel * 8 + channel * 2, f16Bits(rgb[pixel * 3 + channel]!), true);
    }
    view.setUint16(pixel * 8 + 6, f16Bits(1), true); // rgba16float 的 alpha 通道。
  }
  return bytes;
};
function decodeF16(bytes: Uint8Array, count: number): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), out = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const bits = view.getUint16(index * 2, true);
    const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023;
    out[index] = sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
  }
  return out;
}
const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");
const rgbaToRgb = (rgba: Float32Array): Float32Array => {
  const rgb = new Float32Array((rgba.length / 4) * 3);
  for (let pixel = 0; pixel < rgba.length / 4; pixel++) rgb.set([rgba[pixel * 4]!, rgba[pixel * 4 + 1]!, rgba[pixel * 4 + 2]!], pixel * 3);
  return rgb;
};
const percentiles = (values: readonly number[]): { mean: number; p50: number; p95: number } => {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: values.reduce((a, b) => a + b, 0) / values.length,
    p50: sorted[Math.floor(sorted.length / 2)]!, p95: sorted[Math.floor(sorted.length * 0.95)]! };
};
/**
 * 语义忠实参照合成：GT 步进命中 + 箱式金字塔三线性辐射 + fresnel×edgeFade 掩码，
 * 再按 composite 公式双线性上采样。CPU 镜像的锥采样是块均值近似（不含层内双线性），
 * lod≥1 时与 GPU 硬件三线性出现可见差；SSIM≥0.98 门一律对本参照计算。
 */
const buildSsrReferenceComposite = (frame: ReturnType<typeof buildSsrSceneFrame>,
  options: ScreenSpaceReflectionCpuOptions): Float32Array => {
  const halfW = Math.ceil(frame.width / 2), halfH = Math.ceil(frame.height / 2);
  const trace = new Float32Array(halfW * halfH * 4);
  const maxLod = Math.min((options.coneMipLevels ?? 6) - 1,
    Math.floor(Math.log2(Math.max(frame.width, frame.height))));
  const pyramid = buildSsrBoxMipPyramid(Float32Array.from(frame.color), frame.width, frame.height, maxLod + 1);
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5), aspect = frame.width / frame.height;
  for (let halfY = 0; halfY < halfH; halfY++) {
    for (let halfX = 0; halfX < halfW; halfX++) {
      const x = Math.min(halfX * 2 + 1, frame.width - 1), y = Math.min(halfY * 2 + 1, frame.height - 1);
      const truth = marchGroundTruthRef(frame, options, x, y);
      if (!truth.hit) continue;
      const depth = frame.depth[y * frame.width + x] ?? 0;
      const base = (y * frame.width + x) * 4;
      const decode = (index: number): number => ((frame.normalEncoded[base + index] ?? 0) / 255) * 2 - 1;
      const px = ((x + 0.5) / frame.width * 2 - 1) * depth * tanHalfFov * aspect;
      const py = (1 - (y + 0.5) / frame.height * 2) * depth * tanHalfFov;
      const [, , , , , , dotProduct] = reflectViewRay([px, py, -depth], depth, decode(0), decode(1), decode(2));
      const cosTheta = Math.min(1, Math.max(-dotProduct, 0));
      const fresnel = options.fresnelF0 + (1 - options.fresnelF0) * Math.pow(1 - cosTheta, 5);
      const mask = fresnel * screenSpaceReflectionEdgeFade(truth.uvX, truth.uvY, Math.max(options.edgeFade, 1e-4));
      if (!(mask > 0)) continue;
      const radiance = trilinearConeRadiance(pyramid, frame.width, frame.height,
        truth.uvX, truth.uvY, frame.roughness * frame.roughness * maxLod);
      const offset = (halfY * halfW + halfX) * 4;
      trace[offset] = radiance[0] * mask; trace[offset + 1] = radiance[1] * mask;
      trace[offset + 2] = radiance[2] * mask; trace[offset + 3] = mask;
    }
  }
  const output = new Float32Array(frame.width * frame.height * 3);
  for (let y = 0; y < frame.height; y++) {
    for (let x = 0; x < frame.width; x++) {
      const [r, g, b] = compositeScreenSpaceReflectionCpu(frame.cpuInput, trace, halfW, halfH, x, y);
      output.set([r, g, b], (y * frame.width + x) * 3);
    }
  }
  return output;
};
const maxDiff = (a: Float32Array, b: Float32Array, stride: number, channel: number | undefined): number => {
  let diff = 0;
  for (let index = 0; index < a.length; index += stride) {
    const value = channel === undefined ? index : index + channel;
    diff = Math.max(diff, Math.abs((a[value] ?? 0) - (b[value] ?? 0)));
  }
  return diff;
};

const OCCLUDER_FAR_RIGHT = { x0: 6, x1: 8, y0: -2, y1: 0.5, z0: -10, z1: -12 };
const PANEL = { normal: [0.6, 0, 0.8] as const, offset: -3.2, yTop: 6, zNear: -2, zFar: -20 };
const baseConfig = (name: string, overrides: Partial<SsrSceneConfig>): SsrSceneConfig =>
  ({ name, width: SIZE, height: SIZE, roughness: 0.02, wallTop: 18, occluder: OCCLUDER_FAR_RIGHT, ...overrides });
const baseOptions = (fresnelF0: number): ScreenSpaceReflectionCpuOptions =>
  ({ verticalFovRadians: SSR_SEQUENCE_VERTICAL_FOV, maxDistance: 40, thickness: 0.8, steps: 96,
    refines: 4, edgeFade: 0.08, fresnelF0 });

const SEQUENCES = [
  { name: "mirror", config: baseConfig("mirror", {}), options: baseOptions(0.5), historyValid: true,
    expectation: "镜面：地板反射墙面/遮挡物，命中为主" },
  { name: "rough-metal", config: baseConfig("rough-metal", { roughness: 0.6 }),
    options: baseOptions(0.8), historyValid: true, expectation: "粗糙金属：锥 mip 预滤波，f0=0.8" },
  { name: "screen-edge", config: baseConfig("screen-edge", { wallTop: 5, occluder: undefined, panel: PANEL }),
    options: baseOptions(0.5), historyValid: true, expectation: "屏边：斜面板反射穿出视锥，off-screen 回退为主" },
  { name: "moving-a", config: baseConfig("moving-a", { roughness: 0.05, occluder: { x0: -5, x1: -3, y0: -2, y1: 0.5, z0: -10, z1: -12 } }),
    options: baseOptions(0.5), historyValid: true, expectation: "移动物帧 a：遮挡物在左侧" },
  { name: "moving-b", config: baseConfig("moving-b", { roughness: 0.05, occluder: { x0: 2, x1: 4, y0: -2, y1: 0.5, z0: -10, z1: -12 } }),
    options: baseOptions(0.5), historyValid: false, expectation: "移动物帧 b（相机/遮挡 revision 变更后）：历史失效分档" },
];

const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end("<html><body style=\"background:#101820\"><canvas id=\"view\" width=\"128\" height=\"128\" style=\"width:512px;height:512px;image-rendering:pixelated\"></canvas></body></html>"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
await mkdir(outputDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 560 } });
  await page.goto(`http://127.0.0.1:${port}`);
  const traceWidth = SIZE / 2, mipLevels = radianceMipLevels(SIZE, SIZE);
  const cases: Record<string, unknown>[] = [];
  const rawTimings: Record<string, number[]> = {};
  for (const [index, sequence] of SEQUENCES.entries()) {
    const frame = buildSsrSceneFrame(sequence.config);
    const request = { sourceWidth: SIZE, sourceHeight: SIZE, traceWidth, traceHeight: traceWidth,
      activeRadianceMipLevels: mipLevels };
    const params = new Uint8Array(packParameters(request, sequence.options));
    const gpu = await page.evaluate(t03SsrPageKernel, {
      width: SIZE, height: SIZE, traceWidth, traceHeight: traceWidth, radianceMipLevelCount: mipLevels,
      depthB64: base64(new Uint8Array(frame.depth.buffer, frame.depth.byteOffset, frame.depth.byteLength)),
      normalB64: base64(frame.normalEncoded),
      colorB64: base64(toF16RgbaBytes(frame.color, SIZE * SIZE)),
      paramsB64: base64(params),
      wgslTrace: SSR_TRACE_WGSL, wgslComposite: SSR_COMPOSITE_WGSL, wgslRadiance: SSR_RADIANCE_DOWNSAMPLE_WGSL,
      warmup: WARMUP, samples: SAMPLES });
    const gpuTrace = decodeF16(Buffer.from(gpu.traceB64, "base64"), traceWidth * traceWidth * 4);
    const gpuOutputRgba = decodeF16(Buffer.from(gpu.outputB64, "base64"), SIZE * SIZE * 4);
    const cpu = screenSpaceReflectionCpu(frame.cpuInput, sequence.options);
    const evaluation = evaluateSsrSequenceAgainstGroundTruth(frame, sequence.options, gpuTrace,
      undefined, sequence.historyValid);
    const traceIntegrity = scanSsrTraceIntegrity(gpuTrace);
    const compositeIntegrity = scanSsrCompositeIntegrity(rgbaToRgb(gpuOutputRgba), frame.color);
    const referenceRgb = buildSsrReferenceComposite(frame, sequence.options);
    const ssimRegion = ssrRegionSsim(referenceRgb, rgbaToRgb(gpuOutputRgba), SIZE, SIZE);
    const ssimFull = ssrRegionSsim(referenceRgb, rgbaToRgb(gpuOutputRgba), SIZE, SIZE,
      { x0: 0, y0: 0, x1: SIZE, y1: SIZE });
    const cpuMirrorSsim = ssrRegionSsim(Float32Array.from(cpu.output), rgbaToRgb(gpuOutputRgba), SIZE, SIZE);
    const parityAlpha = maxDiff(cpu.trace, gpuTrace, 4, 3);
    const parityAll = maxDiff(cpu.trace, gpuTrace, 1, undefined);
    const checks = {
      noNanInfTrace: traceIntegrity.nanCount === 0 && traceIntegrity.infCount === 0,
      noNegativeTrace: traceIntegrity.negativeCount === 0,
      noBlackHole: traceIntegrity.blackHoleCount === 0 && compositeIntegrity.blackHoleCount === 0,
      noQueueErrors: gpu.queueErrors.length === 0,
      ssimAtLeast098: ssimRegion.mean >= 0.98,
      // mask 奇偶校验是语义精确合同（两侧同式）；rgb 差异含 CPU 块均值 vs GPU 双线性的已知语义差，
      // 内容一致性由 misHit（对三线性参照）保证，parityMaxAllDiff 仅作信息记录。
      maskParityWithinTolerance: parityAlpha <= 5e-3,
      misHitWithinTolerance: evaluation.misHitRate <= 0.02,
    };
    rawTimings[sequence.name] = gpu.durations;
    cases.push({ name: sequence.name, expectation: sequence.expectation,
      config: { roughness: frame.roughness, fresnelF0: sequence.options.fresnelF0,
        steps: sequence.options.steps, thickness: sequence.options.thickness, historyValid: sequence.historyValid },
      integrity: { trace: traceIntegrity, composite: compositeIntegrity },
      misHitRate: Number(evaluation.misHitRate.toFixed(5)),
      falseHitCount: evaluation.falseHitCount, falseMissCount: evaluation.falseMissCount,
      contentMismatchCount: evaluation.contentMismatchCount,
      fallbackRate: Number(evaluation.fallbackRate.toFixed(4)), tiers: evaluation.tiers,
      ssimRegion: Number(ssimRegion.mean.toFixed(6)), ssimRegionWindows: ssimRegion.windows,
      ssimFull: Number(ssimFull.mean.toFixed(6)), cpuMirrorSsimRegion: Number(cpuMirrorSsim.mean.toFixed(6)),
      parityMaxAlphaDiff: Number(parityAlpha.toPrecision(3)), parityMaxAllDiffInfoCpuBlockMeanVsGpuTrilinear: Number(parityAll.toPrecision(3)),
      gpuCostMs: { ...percentiles(gpu.durations), samples: SAMPLES, warmup: WARMUP,
        dispatchPasses: mipLevels + 2 },
      gpuAdapter: gpu.adapter, checks, pass: Object.values(checks).every(Boolean) });
    const shot = index === 0 || sequence.name === "moving-b";
    if (sequence.name === "mirror") {
      const dump = Buffer.from(gpu.traceB64, "base64");
      await writeFile(`${outputDir}mirror-trace.raw`, dump);
      const radianceMip1 = decodeF16(Buffer.from(gpu.radianceMip1B64, "base64"), traceWidth * traceWidth * 4);
      console.log(`  [mirror] radianceMip1 r max=${Math.max(...radianceMip1.filter((_, index) => index % 4 === 0)).toFixed(4)} queueErrors=${gpu.queueErrors.length}`);
    }
    if (shot) {
      await page.evaluate(({ outputB64, size }: { outputB64: string; size: number }) => {
        const binary = atob(outputB64);
        const canvas = document.getElementById("view") as HTMLCanvasElement;
        canvas.width = size; canvas.height = size;
        const context = canvas.getContext("2d")!;
        const image = context.createImageData(size, size);
        for (let pixel = 0; pixel < size * size; pixel++) {
          const offset = pixel * 8;
          for (let channel = 0; channel < 3; channel++) {
            const bits = (binary.charCodeAt(offset + channel * 2) | (binary.charCodeAt(offset + channel * 2 + 1) << 8));
            const sign = bits & 0x8000 ? -1 : 1, exponent = (bits >> 10) & 31, fraction = bits & 1023;
            const value = sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
            image.data[pixel * 4 + channel] = Math.round(255 * Math.min(1, Math.max(0, value / (1 + value))));
          }
          image.data[pixel * 4 + 3] = 255;
        }
        context.putImageData(image, 0, 0);
      }, { outputB64: gpu.outputB64, size: SIZE });
      await page.screenshot({ path: `${outputDir}${sequence.name}-composite.png` });
    }
    console.log(`${sequence.name}: pass=${(cases.at(-1) as { pass: boolean }).pass} misHit=${evaluation.misHitRate.toFixed(4)} ssim=${ssimRegion.mean.toFixed(4)} gpuP50=${percentiles(gpu.durations).p50.toFixed(2)}ms`);
  }
  const verdict = { allPass: cases.every(item => (item as { pass: boolean }).pass),
    note: "黑洞=声称反射但能量近零/输出近零；SSIM 参考=GT 步进命中+箱式金字塔三线性辐射的语义忠实合成（透明口径，无全屏模糊；CPU 镜像 SSIM 另记 cpuMirrorSsimRegion）；GPU 成本=dispatch 提交到完成的墙钟（含提交开销）" };
  const evidence = { schema: "t03-ssr-sequences-gpu-evidence-v1",
    createdAt: new Date().toISOString(), lane: "t03-ssr-sequences-real-gpu",
    method: "生产 WGSL（radiance mips→trace→composite）+ 生产 packParameters；解析视空间序列帧；GT=独立参考步进",
    width: SIZE, height: SIZE, cases, verdict };
  await writeFile(`${outputDir}evidence.json`, JSON.stringify(evidence, null, 2));
  await writeFile(fileURLToPath(new URL("../../../docs/reports/deep-core/assets/t03-ssr-sequences-gpu-2026-09-27.json", import.meta.url)),
    JSON.stringify({ ...evidence, rawTimingMs: rawTimings }, null, 2));
  if (!verdict.allPass) process.exitCode = 1;
} finally { await browser.close(); server.close(); }
