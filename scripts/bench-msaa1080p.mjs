import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import path from "node:path";
import { build } from "../packages/deep-engine/node_modules/esbuild/lib/main.js";

// AA-M1 性能门探针:1080p 生产默认特性档下 MSAA4 vs 1x 的 gpu-frame/frame-encode
// p50/p95 对比。与 gate-parity 同构(bundle + playwright Chrome + 本地 http),复用
// lab 探针与 web 灯光投影;无硬件 WebGPU 时 fail-closed。
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/msaa-perf");
const argValue = (name, fallback) => {
  const found = process.argv.find(arg => arg.startsWith(`--${name}=`));
  if (found === undefined) return fallback;
  const value = Number(found.slice(name.length + 3));
  return Number.isFinite(value) ? value : fallback;
};
const width = argValue("width", 1920);
const height = argValue("height", 1080);
const frames = argValue("frames", 240);
const configs = (process.argv.find(arg => arg.startsWith("--msaa="))?.slice(7) ?? "4,1").split(",").map(Number)
  .filter(value => value === 1 || value === 4);
if (!configs.length) throw Error("--msaa requires 1 and/or 4");
await mkdir(out, { recursive: true });
const lightsHostPlugin = {
  name: "parity-lights-host",
  setup(builder) {
    builder.onResolve({ filter: /parityGateLightsHost/ },
      () => ({ path: path.join(root, "apps/web/src/viewer/studioDeepEnvironmentLights.ts") }));
  },
};
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/msaaPerfProbe.ts")], outfile: path.join(out, "probe.mjs"),
  bundle: true, format: "esm", platform: "browser", conditions: ["development"], plugins: [lightsHostPlugin], logLevel: "error" });
const html = "<html><body style='margin:0'></body></html>";
const server = createServer(async (request, response) => {
  response.setHeader("Content-Type", request.url === "/probe.mjs" ? "text/javascript" : "text/html");
  response.end(request.url === "/probe.mjs"
    ? await readFile(path.join(out, "probe.mjs")) : html);
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  const executablePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
  if (!existsSync(executablePath)) throw Error(`Chrome not found at ${executablePath}; set BIM_STUDIO_CHROME_PATH`);
  browser = await chromium.launch({ headless: true, executablePath, args: process.env.BIM_STUDIO_CHROME_ARGS?.split(" ").filter(Boolean) ?? [] });
  const page = await browser.newPage({ viewport: { width: Math.max(width, 1280), height: Math.max(height, 720) },
    reducedMotion: "reduce" });
  const pageErrors = []; page.on("pageerror", error => pageErrors.push(String(error)));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const adapter = await page.evaluate(async () => {
    const found = await navigator.gpu?.requestAdapter(); if (!found) return null;
    return { vendor: found.info?.vendor, architecture: found.info?.architecture, isFallbackAdapter: found.isFallbackAdapter === true };
  });
  if (!adapter || adapter.isFallbackAdapter) throw Error("no hardware WebGPU adapter; perf evidence requires a real GPU");
  await page.evaluate(() => {
    window.__gpuErrors = [];
    const origAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
    navigator.gpu.requestAdapter = async (...args) => {
      const adapter = await origAdapter(...args);
      if (!adapter) return adapter;
      const origDevice = adapter.requestDevice.bind(adapter);
      adapter.requestDevice = async (...a) => {
        const device = await origDevice(...a);
        device.addEventListener("uncapturederror", event => window.__gpuErrors.push(event.error.message));
        const origAsync = device.createRenderPipelineAsync.bind(device);
        device.createRenderPipelineAsync = async descriptor => {
          try { return await origAsync(descriptor); }
          catch (error) {
            window.__gpuErrors.push(`createRenderPipelineAsync FAILED for label=${JSON.stringify(descriptor.label)}: ${String(error)}`);
            throw error;
          }
        };
        const origBGL = device.createBindGroupLayout.bind(device);
        device.createBindGroupLayout = descriptor => {
          try { return origBGL(descriptor); }
          catch (error) {
            window.__gpuErrors.push(`createBindGroupLayout FAILED ${JSON.stringify(descriptor.label ?? null)}: ${String(error)}`);
            throw error;
          }
        };
        const origLayout = device.createPipelineLayout.bind(device);
        device.createPipelineLayout = descriptor => {
          try { return origLayout(descriptor); }
          catch (error) {
            window.__gpuErrors.push(`createPipelineLayout FAILED bindGroupLayouts=${descriptor.bindGroupLayouts.length}: ${String(error)}`);
            throw error;
          }
        };
        const origBuffer = device.createBuffer.bind(device);
        device.createBuffer = descriptor => {
          try { return origBuffer(descriptor); }
          catch (error) {
            window.__gpuErrors.push(`createBuffer FAILED size=${descriptor.size} usage=${descriptor.usage}: ${String(error)}`);
            throw error;
          }
        };
        const origSync = device.createRenderPipeline.bind(device);
        device.createRenderPipeline = descriptor => {
          try { return origSync(descriptor); }
          catch (error) {
            window.__gpuErrors.push(`createRenderPipeline FAILED for label=${JSON.stringify(descriptor.label)}: ${String(error)}`);
            throw error;
          }
        };
        return device;
      };
      return adapter;
    };
  });
  const results = [];
  for (const msaaSampleCount of configs) {
    let result;
    try {
      result = await page.evaluate(async options =>
        (await import("/probe.mjs")).runMsaaPerfProbe(options), { msaaSampleCount, width, height, frames });
    } catch (error) {
      const gpuErrors = await page.evaluate(() => window.__gpuErrors ?? []);
      throw new Error(`${String(error).slice(0, 400)}${String.fromCharCode(10)}GPU errors (${gpuErrors.length}):${String.fromCharCode(10)}${gpuErrors.slice(0, 6).map(value => value.slice(0, 300)).join(String.fromCharCode(10))}`);
    }
    results.push(result);
    console.error(`msaa=${msaaSampleCount}: submitDone p50/p95 = ${result.submitDoneP50?.toFixed(3)}/${result.submitDoneP95?.toFixed(3)} ms, frame-encode p50/p95 = ${result.frameEncode?.p50Ms?.toFixed(3)}/${result.frameEncode?.p95Ms?.toFixed(3)} ms, gpuTimer=${result.gpuTimerSupported}`);
  }
  assertDeepEqual(pageErrors, []);
  const withMsaa = results.find(result => result.msaaSampleCount === 4);
  const withoutMsaa = results.find(result => result.msaaSampleCount === 1);
  const delta = withMsaa && withoutMsaa ? {
    gpuFrameP50DeltaMs: withMsaa.gpuFrame && withoutMsaa.gpuFrame
      ? +(withMsaa.gpuFrame.p50Ms - withoutMsaa.gpuFrame.p50Ms).toFixed(3) : null,
    gpuFrameP95DeltaMs: withMsaa.gpuFrame && withoutMsaa.gpuFrame
      ? +(withMsaa.gpuFrame.p95Ms - withoutMsaa.gpuFrame.p95Ms).toFixed(3) : null,
    frameEncodeP50DeltaMs: +(withMsaa.frameEncode.p50Ms - withoutMsaa.frameEncode.p50Ms).toFixed(3),
    frameEncodeP95DeltaMs: +(withMsaa.frameEncode.p95Ms - withoutMsaa.frameEncode.p95Ms).toFixed(3),
    submitDoneP50DeltaMs: +(withMsaa.submitDoneP50 - withoutMsaa.submitDoneP50).toFixed(3),
    submitDoneP95DeltaMs: +(withMsaa.submitDoneP95 - withoutMsaa.submitDoneP95).toFixed(3),
  } : null;
  // 门口径:优先 GPU 时间戳(gpu-frame 真实逐帧 GPU 执行);timestamp-query 不可用时
  // 退 submit-done 墙钟(逐帧背压下 ≈ max(CPU,GPU))。p50 与 p95 都须 ≤ +2ms。
  const primary = delta ? (withMsaa.gpuFrame && withoutMsaa.gpuFrame
    ? { metric: "gpu-frame(p50/p95)", p50: delta.gpuFrameP50DeltaMs, p95: delta.gpuFrameP95DeltaMs }
    : { metric: "submit-done(p50/p95)", p50: delta.submitDoneP50DeltaMs, p95: delta.submitDoneP95DeltaMs }) : null;
  const evidence = { adapter, width, height, frames, results, delta, primary,
    gate: primary ? { metric: primary.metric, incrementalP50Ms: primary.p50, incrementalP95Ms: primary.p95,
      budgetMs: 2, passed: primary.p50 <= 2 && primary.p95 <= 2 } : null };
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); }
}

function assertDeepEqual(actual, expected) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw Error(`page errors: ${actual.join(" | ")}`);
}
