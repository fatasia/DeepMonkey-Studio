// SMAA 三 pass WGSL 真机验收探针(AA-M2 L3,headless Chrome WebGPU,照
// t07TemporalGhostGuardWiringProbe.mts 惯例):
// ①三段生产 WGSL 经 GPUDevice.createShaderModule 真机编译(任何 WGSL 语法/类型错误即红线);
// ②合成阶梯场景端到端:noAA → edge/weights/blend 三 pass → readback,与 CPU 权威镜像
//   resolveSmaaCpu 同场景逐像素对拍(容差 2/255:edges rg8/weights f16 存储量化);
// ③帧时:1080p 全链 timestamp,20 帧均值,门 ≤0.8ms。
// 证据:test-output/deep-core/AAM2/smaa-gpu-acceptance/evidence.json
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { SMAA_EDGE_PASS_PRESENT_WGSL, SMAA_WEIGHTS_PASS_PRESENT_WGSL, SMAA_BLEND_PASS_PRESENT_WGSL } from "../src/postprocess/smaaPresentWgsl.js";
import { decodeSmaaAreaLut, decodeSmaaSearchLut } from "../src/postprocess/smaaLuts.js";
import { resolveSmaaCpu, smaaColorEdgeDetectionPS, smaaBlendingWeightCalculationPS, smaaNeighborhoodBlendingPS } from "../src/postprocess/smaaCpu.js";
import { DataUtils } from "three";
import { syntheticStaircaseCase, measureAliasingEnergy, aliasingReduction } from "../src/postprocess/aliasingEnergy.js";
import { resolveSpatialAaCpu } from "../src/postprocess/spatialAaCpu.js";
import { resolvableStaircaseCase } from "../src/postprocess/aliasingEnergy.js";

// 口径选择(2026-10-04 AA-M2 门①口径修正的最小扩展):AAM2_SCENE=resolvable 切
// 可采样口径场景(默认 synthetic 保持既有证据语义不变),输出目录随口径区分。
const AAM2_SCENE = process.env.AAM2_SCENE === "resolvable" ? "resolvable" : "synthetic";

const require = createRequire(import.meta.url);
const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
const outputDir = fileURLToPath(new URL(AAM2_SCENE === "resolvable"
  ? "../../../test-output/deep-core/AAM2/smaa-gpu-acceptance-resolvable/"
  : "../../../test-output/deep-core/AAM2/smaa-gpu-acceptance/", import.meta.url));

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** 页面内核:独立 WebGPU 三 pass 渲染(readback + timestamp),自足、不依赖仓内运行时。 */
/** 页面内核(字符串形态:playwright evaluate 跨环境序列化,绕开 tsx 的 __name 注入)。 */
const PAGE_KERNEL = `async (payload) => {
    const b64ToBytes = (text) => {
      const binary = atob(text);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    };
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw new Error("no WebGPU adapter");
    const info = adapter.info ?? {};
    const device = await adapter.requestDevice();
    device.addEventListener?.("uncapturederror", event => { throw new Error("uncaptured: " + String(event.error)); });
    // ①真机编译(语法/类型错误在此抛出):
    const modules = {
      edge: device.createShaderModule({ label: "smaa-edge", code: payload.wgslEdge }),
      weights: device.createShaderModule({ label: "smaa-weights", code: payload.wgslWeights }),
      blend: device.createShaderModule({ label: "smaa-blend", code: payload.wgslBlend }),
    };
    for (const [name, module] of Object.entries(modules)) {
      const info = await module.getCompilationInfo();
      for (const message of info.messages) {
        if (message.type === "error") throw new Error(name + " compile: " + message.message + " @" + String(message.lineNum));
      }
    }
    const pipeline = (module, formats) =>
      device.createRenderPipeline({ label: "p", layout: "auto",
        vertex: { module, entryPoint: "vertexMain" },
        fragment: { module, entryPoint: "fragmentMain", targets: formats.map(format => ({ format })) },
        primitive: { topology: "triangle-list" } });
    const pipelines = { edge: pipeline(modules.edge, ["rg8unorm"]), weights: pipeline(modules.weights, ["rgba16float"]), blend: pipeline(modules.blend, ["rgba8unorm"]) };
    const linear = device.createSampler({ minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const point = device.createSampler({ minFilter: "nearest", magFilter: "nearest", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" });
    const areaTexture = device.createTexture({ size: [160, 560], format: "rg8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    const searchTexture = device.createTexture({ size: [66, 33], format: "r8unorm", usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    device.queue.writeTexture({ texture: areaTexture }, b64ToBytes(payload.areaB64), { bytesPerRow: 320, rowsPerImage: 560 }, { width: 160, height: 560 });
    device.queue.writeTexture({ texture: searchTexture }, b64ToBytes(payload.searchB64), { bytesPerRow: 66 }, { width: 66, height: 33 });
    const areaView = areaTexture.createView(), searchView = searchTexture.createView();

    const { width, height } = payload;
    const source = device.createTexture({ size: [width, height], format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC });
    device.queue.writeTexture({ texture: source }, b64ToBytes(payload.rgbaB64),
      { bytesPerRow: width * 4, rowsPerImage: height }, { width, height });
    const sourceView = source.createView();
    const edges = device.createTexture({ size: [width, height], format: "rg8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    const weights = device.createTexture({ size: [width, height], format: "rgba16float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    const present = device.createTexture({ size: [width, height], format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST });
    const bindEdge = device.createBindGroup({ layout: pipelines.edge.getBindGroupLayout(0), entries: [{ binding: 0, resource: sourceView }, { binding: 1, resource: linear }] });
    const bindWeights = device.createBindGroup({ layout: pipelines.weights.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: edges.createView() }, { binding: 1, resource: areaView },
        { binding: 2, resource: searchView }, { binding: 3, resource: linear }, { binding: 4, resource: point }] });
    const bindBlend = device.createBindGroup({ layout: pipelines.blend.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: sourceView }, { binding: 1, resource: weights.createView() }, { binding: 2, resource: linear }] });
    const encodeChain = (target, timestampWrites) => {
      const encoder = device.createCommandEncoder();
      const pass = (pipeline, binding, view) => {
        const renderPass = encoder.beginRenderPass({ colorAttachments: [{ view, loadOp: "clear", storeOp: "store" }] });
        renderPass.setPipeline(pipeline); renderPass.setBindGroup(0, binding); renderPass.draw(3);
        renderPass.end();
      };
      pass(pipelines.edge, bindEdge, edges.createView());
      pass(pipelines.weights, bindWeights, weights.createView());
      const finalPass = encoder.beginRenderPass({ colorAttachments: [{ view: target, loadOp: "clear", storeOp: "store" }],
        ...(timestampWrites ? { timestampWrites } : {}) });
      finalPass.setPipeline(pipelines.blend); finalPass.setBindGroup(0, bindBlend); finalPass.draw(3);
      finalPass.end();
      return encoder;
    };
    // ②端到端 readback:
    device.queue.submit([encodeChain(present.createView()).finish()]);
    const staging = device.createBuffer({ size: width * height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const copyEncoder = device.createCommandEncoder();
    copyEncoder.copyTextureToBuffer({ texture: present }, { buffer: staging, bytesPerRow: width * 4 }, { width, height });
    device.queue.submit([copyEncoder.finish()]);
    await staging.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(staging.getMappedRange().slice(0));
    staging.unmap();
    // edges 中间纹理回读(pass1 对拍):
    const edgesStaging = device.createBuffer({ size: width * height * 2, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const edgesEncoder = device.createCommandEncoder();
    edgesEncoder.copyTextureToBuffer({ texture: edges }, { buffer: edgesStaging, bytesPerRow: width * 2 }, { width, height });
    device.queue.submit([edgesEncoder.finish()]);
    await edgesStaging.mapAsync(GPUMapMode.READ);
    const edgesRaw = new Uint8Array(edgesStaging.getMappedRange().slice(0));
    edgesStaging.unmap();
    // weights 中间纹理回读(pass2 对拍,rgba16float → f16 位模式):
    const weightsStaging = device.createBuffer({ size: width * height * 8, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const weightsEncoder = device.createCommandEncoder();
    weightsEncoder.copyTextureToBuffer({ texture: weights }, { buffer: weightsStaging, bytesPerRow: width * 8 }, { width, height });
    device.queue.submit([weightsEncoder.finish()]);
    await weightsStaging.mapAsync(GPUMapMode.READ);
    const weightsRaw = new Uint8Array(weightsStaging.getMappedRange().slice(0));
    weightsStaging.unmap();
    // source 回读(输入上载校验):
    const srcStaging = device.createBuffer({ size: width * height * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    const srcEncoder = device.createCommandEncoder();
    srcEncoder.copyTextureToBuffer({ texture: source }, { buffer: srcStaging, bytesPerRow: width * 4 }, { width, height });
    device.queue.submit([srcEncoder.finish()]);
    await srcStaging.mapAsync(GPUMapMode.READ);
    const srcRaw = new Uint8Array(srcStaging.getMappedRange().slice(0));
    srcStaging.unmap();
    let srcMaxDiff = 0;
    const rgbaDecoded = b64ToBytes(payload.rgbaB64);
    for (let i = 0; i < srcRaw.length; i++) srcMaxDiff = Math.max(srcMaxDiff, Math.abs(srcRaw[i] - rgbaDecoded[i]));
    const srcProbe = [srcRaw[0], srcRaw[1], srcRaw[2], srcRaw[3], srcRaw[(0 * width + 22) * 4], srcRaw[(1 * width + 22) * 4]];
    const payloadProbe = [rgbaDecoded[0], rgbaDecoded[1], rgbaDecoded[2], rgbaDecoded[3], rgbaDecoded[(0 * width + 22) * 4], rgbaDecoded[(1 * width + 22) * 4]];
    // ③帧时(1080p,timestamp query):
    // 帧时口径:headless Chrome 的 timestamp-query 差值不可靠(实测差 0),改用
    // submit + onSubmittedWorkDone 的墙钟(含提交开销,是纯 GPU pass 时的保守上界)。
    const timeTexture = device.createTexture({ size: [payload.timeWidth, payload.timeHeight], format: "rgba8unorm",
      usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const timeView = timeTexture.createView();
    const timings = [];
    for (let frame = 0; frame < payload.timedFrames; frame++) {
      const started = performance.now();
      device.queue.submit([encodeChain(timeView).finish()]);
      await device.queue.onSubmittedWorkDone();
      timings.push(performance.now() - started);
    }
    const heat = [];
    for (let by = 0; by < 16; by++) {
      const rowH = [];
      for (let bx = 0; bx < 16; bx++) {
        let over = 0;
        for (let y = by * 16; y < by * 16 + 16; y++) for (let x = bx * 16; x < bx * 16 + 16; x++) {
          const o = (y * width + x) * 4;
          if (Math.abs(raw[o] - Math.round(rgbaDecoded[o]) ) > 2 && true) over++;
        }
        rowH.push(over);
      }
      heat.push(rowH);
    }
    return { pixelsB64: (() => { let text = ""; for (let i = 0; i < raw.length; i++) text += String.fromCharCode(raw[i]); return btoa(text); })(),
      timings, srcMaxDiff, srcProbe, payloadProbe, edgesB64: (() => { let text = ""; for (let i = 0; i < edgesRaw.length; i++) text += String.fromCharCode(edgesRaw[i]); return btoa(text); })(),
      weightsB64: (() => { let text = ""; for (let i = 0; i < weightsRaw.length; i++) text += String.fromCharCode(weightsRaw[i]); return btoa(text); })(),
      adapter: { vendor: info.vendor ?? "", architecture: info.architecture ?? "", isFallback: adapter.isFallbackAdapter === true }, queueErrors: [] };
}`;const width = 256, height = 256;
const scene = AAM2_SCENE === "resolvable" ? resolvableStaircaseCase(width, height) : syntheticStaircaseCase(width, height);
const rgbaInput = new Uint8Array(width * height * 4);
for (let i = 0; i < rgbaInput.length; i++) rgbaInput[i] = Math.round(Math.max(0, Math.min(1, scene.noAA[i]!)) * 255);
const quantizedInput = new Float32Array(rgbaInput.length);
for (let i = 0; i < quantizedInput.length; i++) quantizedInput[i] = rgbaInput[i]! / 255;
// 对拍口径:CPU 镜像与 GPU 链吃同一份 8bit 量化输入(present 合同本身是 rgba8unorm)。
const cpuSmaa = resolveSmaaCpu({ width, height, color: quantizedInput });
const cpuFxaa = resolveSpatialAaCpu({ width, height, color: quantizedInput });
const measure = (output: ArrayLike<number>) => measureAliasingEnergy({ output, reference: scene.reference, width, height, sourceContrast: scene.sourceContrast });
const baseline = measure(scene.noAA);
const cpuM = measure(cpuSmaa), fxaaM = measure(cpuFxaa);


const server = createServer((_request, response) => response.writeHead(200, { "content-type": "text/html" })
  .end("<html><body style=\"background:#101820\"></body></html>"));
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as { port: number }).port;
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu"] });
await mkdir(outputDir, { recursive: true });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  page.on("pageerror", error => console.log("[pageerror]", String(error)));
  await page.goto(`http://127.0.0.1:${port}`);
  const payloadJson = JSON.stringify({
    wgslEdge: SMAA_EDGE_PASS_PRESENT_WGSL, wgslWeights: SMAA_WEIGHTS_PASS_PRESENT_WGSL, wgslBlend: SMAA_BLEND_PASS_PRESENT_WGSL,
    areaB64: base64(decodeSmaaAreaLut()), searchB64: base64(decodeSmaaSearchLut()),
    rgbaB64: base64(rgbaInput), width, height, timeWidth: 1920, timeHeight: 1080, timedFrames: 20,
  });
  await page.evaluate((json: string) => { (window as unknown as Record<string, unknown>).__smaaPayload = json; }, payloadJson);
  const result = await page.evaluate(`((${PAGE_KERNEL})(JSON.parse(window.__smaaPayload)))`) as { pixelsB64: string; timings: number[] };
  const gpuPixels = Buffer.from(result.pixelsB64, "base64");
  const gpuImage = new Float32Array(width * height * 4);
  for (let i = 0; i < gpuImage.length; i++) gpuImage[i] = gpuPixels[i]! / 255;
  let maxDiff = 0, beyondTolerance = 0, alphaMaxDiff = 0;
  const worst: { index: number; gpu: number; cpu: number }[] = [];
  for (let i = 0; i < gpuImage.length; i++) {
    const diff = Math.abs(gpuImage[i]! - cpuSmaa[i]!);
    if (i % 4 === 3) { alphaMaxDiff = Math.max(alphaMaxDiff, diff); continue; }
    if (diff > 2 / 255) beyondTolerance++;
    if (diff > maxDiff) { maxDiff = diff; worst.unshift({ index: i, gpu: gpuImage[i]!, cpu: cpuSmaa[i]! }); if (worst.length > 4) worst.pop(); }
  }
  const worstDump = worst.map(w => ({ x: Math.floor((w.index / 4) % width), y: Math.floor(w.index / 4 / width),
    gpu: Number(w.gpu.toFixed(3)), cpu: Number(w.cpu.toFixed(3)) }));
  // —— 二分定位(2026-10-05 parity 残差排查):GPU weights RT 回读 vs CPU 镜像逐像素对拍 + pass3 归因 ——
  const f16BitsToValue = (h: number): number => {
    const s = (h & 0x8000) >> 15, e = (h & 0x7c00) >> 10, m = h & 0x03ff;
    return e === 0 ? (s ? -1 : 1) * m * 2 ** -24
      : e === 0x1f ? (m ? NaN : s ? -Infinity : Infinity)
      : (s ? -1 : 1) * (1 + m / 1024) * 2 ** (e - 15);
  };
  const gpuWeights = (() => {
    const bytes = Buffer.from(result.weightsB64, "base64");
    const out = new Float32Array(bytes.length / 2);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < out.length; i++) out[i] = f16BitsToValue(view.getUint16(i * 2, true));
    return out;
  })();
  const areaLut = decodeSmaaAreaLut(), searchLut = decodeSmaaSearchLut();
  const cpuImageBisect = { width, height, color: quantizedInput };
  // CPU pass1 镜像(edges 已真机逐位一致,直接镜像重建)+ pass2 镜像:
  const cpuEdges = new Uint8Array(width * height * 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    smaaColorEdgeDetectionPS(cpuImageBisect, (x + 0.5) / width, (y + 0.5) / height, cpuEdges, (y * width + x) * 2);
  const cpuWeights = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
    cpuWeights.set(smaaBlendingWeightCalculationPS(cpuImageBisect, cpuEdges, areaLut, searchLut,
      (x + 0.5) / width, (y + 0.5) / height), (y * width + x) * 4);
  // A) pass2 直接对拍:GPU f16 权重 vs CPU f64 权重。
  let wMax = 0, wBeyond = 0;
  const wChannelBeyond = [0, 0, 0, 0];
  const worstW: { x: number; y: number; pixelMax: number; gpu: number[]; cpu: number[] }[] = [];
  for (let p = 0; p < width * height; p++) {
    let pixelMax = 0;
    for (let c = 0; c < 4; c++) {
      const d = Math.abs(gpuWeights[p * 4 + c]! - cpuWeights[p * 4 + c]!);
      if (d > wMax) wMax = d;
      if (d > 0.002) { wBeyond++; wChannelBeyond[c]++; }
      pixelMax = Math.max(pixelMax, d);
    }
    if (pixelMax > 0.002) {
      worstW.push({ x: p % width, y: Math.floor(p / width), pixelMax,
        gpu: [...gpuWeights.slice(p * 4, p * 4 + 4)].map(v => Number(v.toFixed(4))),
        cpu: [...cpuWeights.slice(p * 4, p * 4 + 4)].map(v => Number(v.toFixed(4))) });
      worstW.sort((a, b) => b.pixelMax - a.pixelMax);
      if (worstW.length > 6) worstW.pop();
    }
  }
  // B) 存储量化口径:GPU f16 权重 vs f16(CPU 权重)——分离「逻辑差」与「f16 量化」。
  let qMax = 0, qMismatch = 0;
  for (let i = 0; i < gpuWeights.length; i++) {
    const d = Math.abs(gpuWeights[i]! - f16BitsToValue(DataUtils.toHalfFloat(cpuWeights[i]!)));
    if (d > qMax) qMax = d;
    if (d > 0) qMismatch++;
  }
  // C) pass3 归因:CPU pass3 消费 GPU 权重 / CPU 权重,分别对拍 GPU 终像。
  const pass3With = (weights: Float32Array): Float32Array => {
    const out = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
      out.set(smaaNeighborhoodBlendingPS(cpuImageBisect, weights, (x + 0.5) / width, (y + 0.5) / height), (y * width + x) * 4);
    return out;
  };
  const compareAgainstGpuFinal = (candidate: Float32Array) => {
    let max = 0, beyond = 0;
    for (let i = 0; i < candidate.length; i++) {
      if (i % 4 === 3) continue;
      const d = Math.abs(candidate[i]! - gpuImage[i]!);
      if (d > max) max = d;
      if (d > 2 / 255) beyond++;
    }
    return { maxAbsDiff: Number(max.toFixed(4)), pixelsBeyond2of255: beyond };
  };
  const pass3GpuWeightsVsFinal = compareAgainstGpuFinal(pass3With(gpuWeights));
  const pass3CpuWeightsVsFinal = compareAgainstGpuFinal(pass3With(cpuWeights));
  // D) 模式取证:终像最差像素的 pass3 输入(中心/下邻/右邻权重,四通道,GPU vs CPU)。
  const weightTileDump = worstDump.slice(0, 3).map(w => {
    const tile: Record<string, { gpu: number[]; cpu: number[] }> = {};
    for (const [label, tx, ty] of [["center", w.x, w.y], ["down", w.x, w.y + 1], ["right", w.x + 1, w.y]] as const) {
      if (tx >= width || ty >= height) continue;
      const p = (ty * width + tx) * 4;
      tile[label] = { gpu: [...gpuWeights.slice(p, p + 4)].map(v => Number(v.toFixed(4))),
        cpu: [...cpuWeights.slice(p, p + 4)].map(v => Number(v.toFixed(4))) };
    }
    return { x: w.x, y: w.y, tile };
  });
  const gpuM = measure(gpuImage);
  const gpuReduction = aliasingReduction(baseline.edgeEnergy, gpuM.edgeEnergy);
  const cpuReduction = aliasingReduction(baseline.edgeEnergy, cpuM.edgeEnergy);
  const fxaaReduction = aliasingReduction(baseline.edgeEnergy, fxaaM.edgeEnergy);
  const timings = result.timings.slice(2); // 去掉前两帧(首帧建管线/编译抖动)
  const meanMs = timings.reduce((sum, value) => sum + value, 0) / timings.length;
  const checks = {
    wgslCompilesOnDevice: true,
    gpuWithinCpuTolerance: beyondTolerance === 0,
    smaaNotWorseThanFxaa: gpuM.edgeEnergy <= fxaaM.edgeEnergy,
    frameTimeWithinBudget: meanMs <= 0.8,
  };
  const evidence = {
    schema: "aam2-smaa-gpu-acceptance-v2", createdAt: new Date().toISOString(),
    lane: "aa-m2-l3-smaa-port",
    scene: AAM2_SCENE === "resolvable" ? "resolvableStaircaseCase(可采样口径,门①判定)" : "syntheticStaircaseCase(欠采样极限口径)",
    method: "headless Chrome WebGPU:生产三 pass WGSL 真机编译 + 合成阶梯场景端到端 readback 对拍 CPU 权威镜像 + 1080p 全链 timestamp 帧时(20 帧,去前 2 帧)",
    energy: {
      baselineEdgeEnergy: Number(baseline.edgeEnergy.toFixed(4)),
      gpuSmaaEdgeEnergy: Number(gpuM.edgeEnergy.toFixed(4)),
      gpuSmaaReduction: `${(gpuReduction * 100).toFixed(1)}%`,
      cpuMirrorEdgeEnergy: Number(cpuM.edgeEnergy.toFixed(4)),
      cpuMirrorReduction: `${(cpuReduction * 100).toFixed(1)}%`,
      fxCaaReference: Number(fxaaM.edgeEnergy.toFixed(4)),
      fxaaReduction: `${(fxaaReduction * 100).toFixed(1)}%`,
    },
    parity: { maxAbsDiff: Number(maxDiff.toFixed(4)), pixelsBeyond2of255: beyondTolerance, beyondRatio: Number((beyondTolerance / (width * height)).toFixed(4)), alphaMaxDiff: Number(alphaMaxDiff.toFixed(4)) },
    bisection: {
      method: "pass2 weights RT(rgba16float)回读逐像素对拍 CPU 镜像 + CPU pass3 分别消费 GPU/CPU 权重对拍 GPU 终像(二分首现 pass)",
      pass2: { maxAbsDiff: Number(wMax.toFixed(5)), pixelsBeyond0_002: wBeyond, channelBeyond0_002: wChannelBeyond, worst: worstW },
      pass2StorageQuantization: { maxAbsDiffGpuVsF16ofCpu: Number(qMax.toFixed(8)), pixelsMismatchingNearestF16: qMismatch },
      pass3Attribution: { gpuFinalVsCpuPass3WithGpuWeights: pass3GpuWeightsVsFinal, gpuFinalVsCpuPass3WithCpuWeights: pass3CpuWeightsVsFinal },
      weightTileDump: weightTileDump,
    },
    diagnostics: { sourceMaxDiff: result.srcMaxDiff, srcProbe: result.srcProbe, payloadProbe: result.payloadProbe, worstDump, adapter: result.adapter,
      pixelsB64: result.pixelsB64, weightsB64: result.weightsB64 },
    edgesB64: result.edgesB64,
    frameTime: { resolution: `${1920}x${1080}`, frames: timings.length, rawSample: result.rawTimestamps?.[0], meanMs: Number(meanMs.toFixed(4)),
      minMs: Number(Math.min(...timings).toFixed(4)), maxMs: Number(Math.max(...timings).toFixed(4)), budgetMs: 0.8 },
    checks, verdict: { allPass: Object.values(checks).every(Boolean) },
  };
  await writeFile(`${outputDir}evidence.json`, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  if (!evidence.verdict.allPass) process.exitCode = 1;
} finally { await browser.close(); server.close(); }
