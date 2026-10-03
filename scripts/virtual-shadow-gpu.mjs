import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * B1 Brief-VSM 真机验收驱动(esbuild 打包 lab 探针 → playwright headless Chrome
 * WebGPU,模式与 j2-csm-boundary-gpu.mjs 同构)。
 *
 * 四腿:级联计时段 / 级联图像腿 / 虚拟计时段 / 虚拟图像腿(含动态平移+旋转延迟)。
 * 证据:test-output/vsm-20261003/acceptance.json + 截图。门:
 * ① edge.energyPerEdgePixel(virtual) ≤ 0.40×(cascaded)——锯齿能量 ↓≥60%;
 * ② Δp50 = virtual.gpuFrame.p50 − cascaded.gpuFrame.p50 ≤ 2.5ms;
 * ③ translate/rotate 延迟帧 ≤ 2;
 * ④ virtual holes.nonFinite = 0 且 blackSpeckles = 0。
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/vsm-20261003");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/virtualShadowGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser",
  logLevel: "silent" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") {
    response.setHeader("Content-Type", "text/javascript");
    response.end(await readFile(path.join(out, "probe.mjs")));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head>`
      + `<body style="padding:24px;background:var(--bg-0);color:var(--text-strong)">`
      + `<h1>B1 Brief-VSM 真机验收</h1><div id="results"></div></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
let page;
const result = { gate: undefined, legs: {}, adapter: undefined, error: undefined,
  executedAt: new Date().toISOString(), viewport: "1920x1080" };
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--enable-unsafe-webgpu", "--use-angle=default"] });
  page = await browser.newPage({ viewport: { width: 1920, height: 1100 } });
  page.on("pageerror", error => { result.error = String(error); });
  page.on("console", message => { if (message.type() === "error") result.error = message.text(); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  // 前置诊断:直接以裸 WebGPU 复现扩展 group-2 布局 + 主管线形态,未捕获错误
  // 监听器打印 Dawn 完整校验消息(定位 Invalid PipelineLayout 的具体条目)。
  result.preflight = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { error: "no adapter" };
    const device = await adapter.requestDevice();
    const messages = [];
    device.addEventListener("uncapturederror", event => messages.push(event.error.message));
    const cascaded = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform", minBindingSize: 640 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "depth", viewDimension: "2d-array" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT,
        texture: { sampleType: "unfilterable-float", viewDimension: "2d-array" } },
    ] });
    const bgl = cascaded;
    // 复刻 plainLayout 四组形态:frame + emptyMaterial + cascaded + forwardPlus(逐段资源计数对齐)。
    const frameBgl = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 384 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      ...[3, 4].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" } })),
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 64 } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 32 } },
      ...[9, 10].map(binding => ({ binding, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" } })),
      { binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 128 } },
    ] });
    const forwardBgl = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 16 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 16 } },
      { binding: 3, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 4, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
      { binding: 5, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "read-only-storage" } },
    ] });
    const emptyMaterial = device.createBindGroupLayout({ entries: [] });
    const layout = device.createPipelineLayout({ bindGroupLayouts: [frameBgl, emptyMaterial, cascaded, forwardBgl] });
    void bgl;
    const module = device.createShaderModule({ code: `
      @group(0) @binding(0) var<uniform> frame: f32;
      @group(0) @binding(1) var shadowMap: texture_depth_2d_array;
      @group(0) @binding(2) var shadowSampler: sampler_comparison;
      @group(0) @binding(3) var<storage, read> tileMeta: array<vec4u>;
      @group(0) @binding(4) var<storage, read> pageLayers: array<i32>;
      @group(0) @binding(5) var atlas: texture_2d_array<f32>;
      @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0); }
      @fragment fn fs() -> @location(0) f32 {
        let sampled = textureLoad(atlas, vec2i(0, 0), 0, 0).r;
        let compared = textureSampleCompareLevel(shadowMap, shadowSampler, vec2f(0.5), 0, 0.5);
        return sampled + compared + f32(tileMeta[0].x) + f32(pageLayers[0]);
      }` });
    const info = await module.getCompilationInfo();
    const shaderErrors = info.messages.filter(m => m.type === "error").map(m => `${m.lineNum}: ${m.message}`);
    let pipelineError = null;
    try {
      device.createRenderPipeline({ layout, vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: "r32float" }] },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" } });
    } catch (error) { pipelineError = String(error); }
    await device.queue.onSubmittedWorkDone?.().catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 50));
    device.destroy();
    return { messages, shaderErrors, pipelineError };
  });
  // 安装 + 自检独立 evaluate(即使腿失败,自检结果与错误镜像也已落窗口)。
  await page.evaluate(async () => {
    const probe = await import("/probe.mjs");
    probe.installErrorCapture();
    probe.installPipelineTracing();
  });
  result.deviceRequest = await page.evaluate(async () => (await import("/probe.mjs")).probeDeviceRequest());
  result.traceSelfTest = await page.evaluate(async () => {
    const adapter = await navigator.gpu.requestAdapter();
    const device = await adapter.requestDevice();
    const bgl = device.createBindGroupLayout({ entries: [] });
    device.createPipelineLayout({ bindGroupLayouts: [bgl] });
    await new Promise(resolve => setTimeout(resolve, 30));
    return (window.__vsmErrors ?? []).slice(0, 4);
  });
  const legs = await page.evaluate(async () => {
    const probe = await import("/probe.mjs");
    const output = { legs: {}, adapter: await probe.probeAdapterInfo() };
    // 计时段(无读回,timestamp 查询):级联 → 虚拟。
    await probe.beginLeg("cascaded", false);
    await probe.settleLeg();
    const cascadedTiming = await probe.timeLeg();
    output.legs.cascadedTiming = await probe.finishLeg(cascadedTiming);
    await probe.beginLeg("virtual", false);
    await probe.settleLeg();
    const virtualTiming = await probe.timeLeg();
    output.legs.virtualTiming = await probe.finishLeg(virtualTiming);
    // 图像腿(读回):级联 → 虚拟(含动态平移/旋转延迟)。
    await probe.beginLeg("cascaded", true);
    await probe.settleLeg();
    const cascadedImage = await probe.captureStill();
    output.legs.cascadedImage = await probe.finishLeg(cascadedTiming, cascadedImage);
    await probe.beginLeg("virtual", true);
    await probe.settleLeg();
    const virtualImage = await probe.captureStill();
    const translateLatency = await probe.dynamicLatencyLeg("translate");
    const rotateLatency = await probe.dynamicLatencyLeg("rotate");
    output.legs.virtualImage = await probe.finishLeg(virtualTiming, virtualImage,
      { translateLatencyFrames: translateLatency, rotateLatencyFrames: rotateLatency });
    return output;
  });
  result.legs = legs.legs;
  result.adapter = legs.adapter;
  const cascadeEdge = result.legs.cascadedImage?.image?.edge?.energyPerEdgePixel;
  const virtualEdge = result.legs.virtualImage?.image?.edge?.energyPerEdgePixel;
  const deltaP50 = (result.legs.virtualTiming?.timing?.p50Ms ?? Number.NaN)
    - (result.legs.cascadedTiming?.timing?.p50Ms ?? Number.NaN);
  const deltaP95 = (result.legs.virtualTiming?.timing?.p95Ms ?? Number.NaN)
    - (result.legs.cascadedTiming?.timing?.p95Ms ?? Number.NaN);
  const edgeRatio = cascadeEdge > 0 ? virtualEdge / cascadeEdge : null;
  const dynamic = result.legs.virtualImage?.dynamic;
  const holes = result.legs.virtualImage?.image?.holes;
  result.gate = {
    "① edge alias energy ratio (virtual/cascaded ≤ 0.40)": {
      cascadeEdge, virtualEdge, ratio: edgeRatio, passed: edgeRatio !== null && edgeRatio <= 0.40 },
    "② shadow cost Δp50 ≤ 2.5ms": { deltaP50Ms: deltaP50, deltaP95Ms: deltaP95,
      cascadedP50Ms: result.legs.cascadedTiming?.timing?.p50Ms,
      virtualP50Ms: result.legs.virtualTiming?.timing?.p50Ms, passed: deltaP50 <= 2.5 },
    "③ dynamic shadow latency ≤ 2 frames": { ...dynamic, passed: (dynamic?.translateLatencyFrames ?? 9) <= 2
      && (dynamic?.rotateLatencyFrames ?? 9) <= 2 },
    "④ zero holes": { ...holes, passed: (holes?.nonFinite ?? 1) === 0 && (holes?.blackSpeckles ?? 1) === 0 },
  };
  result.passed = Object.values(result.gate).every(entry => entry.passed);
  await page.screenshot({ path: path.join(out, "final.png"), fullPage: true });
} catch (error) {
  result.error = String(error);
  try { result.capturedErrors = await page.evaluate(() => ({
    errors: window.__vsmErrors ?? [], hasFlag: Boolean(window.__vsmErrors) })); }
  catch (captureError) { result.captureError = String(captureError); }
  if (result.capturedErrors && !Array.isArray(result.capturedErrors)) {
    result.capturedErrors = result.capturedErrors.errors ?? [];
    result.vsmFlagPresent = result.capturedErrors.hasFlag;
  }
} finally {
  if (browser) await browser.close();
  server.close();
}
await writeFile(path.join(out, "acceptance.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed: result.passed ?? false, preflight: result.preflight,
  gate: result.gate, error: result.error }, null, 2));
if (!result.passed) process.exitCode = 1;
