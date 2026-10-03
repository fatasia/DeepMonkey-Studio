import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/**
 * B1 Brief-VSM 真机验收驱动(esbuild 打包 lab 探针 → headless Chrome WebGPU,最小 CDP
 * 驱动:navigate/evaluate/screenshot 三调用面;模式与 j2-csm-boundary-gpu.mjs 同构)。
 *
 * 四腿:级联计时段 / 虚拟计时段 / 级联图像腿 / 虚拟图像腿(含动态平移+旋转延迟)。
 * 证据:test-output/vsm-20261003/acceptance.json + leg-*.png + atlas-layer0.png。
 * 门:①edge ratio ≤0.40(锯齿能量 ↓≥60%);②Δp50 ≤2.5ms;③动态延迟 ≤2 帧;④零洞。
 */

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/vsm-20261003");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url);
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/virtualShadowGpuProbe.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
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

const PREFLIGHT_WGSL = `
      @group(0) @binding(0) var<uniform> frameUniform: f32;
      @group(0) @binding(1) var shadowMap: texture_depth_2d_array;
      @group(0) @binding(2) var shadowSampler: sampler_comparison;
      @group(0) @binding(3) var<storage, read> tileMeta: array<vec4u>;
      @group(0) @binding(4) var<storage, read> pageLayers: array<i32>;
      @group(0) @binding(5) var atlas: texture_2d_array<f32>;
      @group(3) @binding(3) var<storage, read> spotLights: array<f32>;
      @group(3) @binding(4) var<storage, read> clusterHeaders: array<f32>;
      @group(3) @binding(5) var<storage, read> clusterIndices: array<u32>;
      @group(0) @binding(7) var<uniform> sun: f32;
      @vertex fn vs() -> @builtin(position) vec4f { return vec4f(0.0); }
      @fragment fn fs() -> @location(0) f32 {
        let sampled = textureLoad(atlas, vec2i(0, 0), 0, 0).r;
        let compared = textureSampleCompareLevel(shadowMap, shadowSampler, vec2f(0.5), 0, 0.5);
        return sampled + compared + f32(tileMeta[0].x) + f32(pageLayers[0]) + frameUniform + sun
          + spotLights[0] + clusterHeaders[0] + f32(clusterIndices[0]);
      }`;

const PREFLIGHT_FLOW = `(async () => {
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
    const frameBgl = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 384 } },
      { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
      { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
      { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" } },
      { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" } },
      { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      { binding: 6, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 64 } },
      { binding: 8, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform", minBindingSize: 32 } },
      { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" } },
      { binding: 10, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "cube" } },
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
    const module = device.createShaderModule({ code: ${JSON.stringify(PREFLIGHT_WGSL)} });
    const info = await module.getCompilationInfo();
    const shaderErrors = info.messages.filter(m => m.type === "error").map(m => m.lineNum + ": " + m.message);
    let pipelineError = null;
    try {
      device.createRenderPipeline({ layout, vertex: { module, entryPoint: "vs" },
        fragment: { module, entryPoint: "fs", targets: [{ format: "r32float" }] },
        depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "less" } });
    } catch (error) { pipelineError = String(error); }
    await new Promise(resolve => setTimeout(resolve, 50));
    device.destroy();
    return { messages, shaderErrors, pipelineError };
  })()`;

const LEGS_FLOW = `(async () => {
    const probe = await import("/probe.mjs");
    const output = { legs: {}, adapter: await probe.probeAdapterInfo() };
    await probe.beginLeg("cascaded", false);
    await probe.settleLeg();
    const cascadedTiming = await probe.timeLeg();
    output.legs.cascadedTiming = await probe.finishLeg(cascadedTiming);
    await probe.beginLeg("virtual", false);
    await probe.settleLeg();
    const virtualTiming = await probe.timeLeg();
    output.legs.virtualTiming = await probe.finishLeg(virtualTiming);
    await probe.beginLeg("cascaded", true);
    await probe.settleLeg();
    const cascadedImage = await probe.captureStill();
    output.legs.cascadedImage = await probe.finishLeg(cascadedTiming, cascadedImage);
    await probe.beginLeg("virtual", true);
    await probe.settleLeg();
    const virtualImage = await probe.captureStill();
    const atlasDump = await probe.dumpShadowAtlasLayer();
    const step = 4, gw = atlasDump.width / step, gh = atlasDump.height / step;
    const gray = new Uint8Array(gw * gh);
    let nonzeroPages = 0;
    for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
      let written = false;
      for (let y = 0; y < 128; y++) for (let x = 0; x < 128; x++) {
        const value = Math.max(0, Math.min(1, atlasDump.floats[(py * 128 + y) * atlasDump.width + px * 128 + x] ?? 1));
        if (value < 0.999) written = true;
        if ((y & 3) === 0 && (x & 3) === 0) {
          gray[(py * 128 + y) / 4 * gw + (px * 128 + x) / 4] = Math.round((1 - value) * 255);
        }
      }
      nonzeroPages += written ? 1 : 0;
    }
    output.atlasLayer0 = { width: gw, height: gh, nonzeroPages };
    output.atlasCanvasPng = atlasDump.canvasPng;
    const translateLatency = await probe.dynamicLatencyLeg("translate");
    const rotateLatency = await probe.dynamicLatencyLeg("rotate");
    output.legs.virtualImage = await probe.finishLeg(virtualTiming, virtualImage,
      { translateLatencyFrames: translateLatency, rotateLatencyFrames: rotateLatency });
    return output;
  })()`;

async function launchCdpBrowser() {
  const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  const chrome = spawn(chromePath, ["--headless=new", "--remote-debugging-port=0",
    "--enable-unsafe-webgpu", "--use-angle=default", "--no-first-run",
    `--user-data-dir=${path.join(out, "chrome-profile")}`, "about:blank"],
    { stdio: ["ignore", "ignore", "pipe"] });
  const wsEndpoint = await new Promise((resolve, reject) => {
    let buffer = "";
    const timer = setTimeout(() => reject(new Error("chrome devtools endpoint timeout")), 30000);
    chrome.stderr.on("data", chunk => {
      buffer += chunk.toString();
      const match = buffer.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    chrome.on("exit", () => { clearTimeout(timer); reject(new Error("chrome exited before devtools endpoint")); });
  });
  const httpBase = wsEndpoint.replace("ws://", "http://");
  const targets = await (await fetch(`${httpBase}/json/list`)).json();
  const page = targets.find(target => target.type === "page");
  if (!page) throw new Error("no page target in chrome devtools list");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    }
  };
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  return {
    chrome, socket,
    async evaluate(expression) {
      const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.exception?.description
          ?? result.exceptionDetails.text ?? "evaluate failed");
      }
      return result.result?.value;
    },
    async screenshot(file) {
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      await writeFile(file, Buffer.from(data, "base64"));
    },
    async close() {
      try { socket.close(); } catch { /* already closed */ }
      chrome.kill();
    },
  };
}

let browser;
const result = { gate: undefined, legs: {}, adapter: undefined, error: undefined,
  executedAt: new Date().toISOString(), viewport: "1920x1080" };
try {
  browser = await launchCdpBrowser();
  await browser.evaluate(`location.href = "http://127.0.0.1:${server.address().port}"`);
  await new Promise(resolve => setTimeout(resolve, 800));
  result.preflight = await browser.evaluate(PREFLIGHT_FLOW);
  await browser.evaluate(`(async () => {
    const probe = await import("/probe.mjs");
    probe.installErrorCapture();
    probe.installPipelineTracing();
  })()`);
  result.deviceRequest = await browser.evaluate(
    `(async () => (await import("/probe.mjs")).probeDeviceRequest())()`);
  const legs = await browser.evaluate(LEGS_FLOW);
  result.legs = legs.legs;
  result.adapter = legs.adapter;
  if (legs.atlasCanvasPng) {
    await writeFile(path.join(out, "atlas-layer0.png"),
      Buffer.from(legs.atlasCanvasPng.split(",").pop(), "base64"));
  }
  result.atlasLayer0 = legs.atlasLayer0;
  for (const [name, leg] of Object.entries(legs.legs)) {
    const png = leg?.image?.canvasPng;
    if (typeof png === "string" && png.startsWith("data:image/png")) {
      await writeFile(path.join(out, `leg-${name}.png`), Buffer.from(png.split(",")[1], "base64"));
    }
  }
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
  await browser.screenshot(path.join(out, "final.png"));
} catch (error) {
  result.error = String(error);
} finally {
  try { result.capturedErrors = await browser.evaluate(
    "({ errors: window.__vsmErrors ?? [], hasFlag: Boolean(window.__vsmErrors) })"); }
  catch (captureError) { result.captureError = String(captureError); }
  if (browser) await browser.close();
  server.close();
}
await writeFile(path.join(out, "acceptance.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ passed: result.passed ?? false, gate: result.gate, error: result.error,
  atlasNonzeroPages: result.atlasLayer0?.nonzeroPages }, null, 2));
if (!result.passed) process.exitCode = 1;
