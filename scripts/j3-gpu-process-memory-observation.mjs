import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/interrupted-0930/driver-memory-observation");
await mkdir(out, { recursive: true });
const metricsPath = path.join(out, "metrics.json"), stopPath = path.join(out, "stop");
await rm(stopPath, { force: true }); await rm(metricsPath, { force: true });
const require = createRequire(import.meta.url);
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
const server = createServer((_request, response) => response.end('<!doctype html><canvas width="64" height="64"></canvas>'));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browserServer, browser, sampler, samplerDone;
try {
  browserServer = await chromium.launchServer({ headless: true,
    executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    args: ["--enable-unsafe-webgpu"] });
  const rootProcessId = browserServer.process().pid;
  sampler = spawn("pwsh", ["-NoProfile", "-File", path.join(root, "scripts/benchmarks/run-windows-process-tree-metrics.ps1"),
    "-RootProcessId", String(rootProcessId), "-MetricsPath", metricsPath, "-StopFilePath", stopPath,
    "-TimeoutSeconds", "45", "-SampleIntervalMilliseconds", "200"], { cwd: root, windowsHide: true });
  let log = ""; sampler.stdout.on("data", data => { log += data; }); sampler.stderr.on("data", data => { log += data; });
  samplerDone = new Promise((resolve, reject) => { sampler.once("error", reject); sampler.once("exit", code => resolve(code)); });
  browser = await chromium.connect(browserServer.wsEndpoint());
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark" });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const gpu = await page.evaluate(async () => {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: "high-performance" });
    if (!adapter) throw Error("No actual WebGPU adapter");
    const device = await adapter.requestDevice(), errors = [];
    device.addEventListener("uncapturederror", event => errors.push(event.error.message));
    const texture = device.createTexture({ size: [64, 64], format: "rgba8unorm", usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const encoder = device.createCommandEncoder(), pass = encoder.beginRenderPass({ colorAttachments: [
      { view: texture.createView(), clearValue: [0.2, 0.3, 0.4, 1], loadOp: "clear", storeOp: "store" }] });
    pass.end(); device.queue.submit([encoder.finish()]); await device.queue.onSubmittedWorkDone();
    globalThis.releaseProbe = () => { texture.destroy(); device.destroy(); };
    return { errors, adapter: { vendor: adapter.info.vendor, architecture: adapter.info.architecture } };
  });
  assert.deepEqual(gpu.errors, []);
  const deadline = Date.now() + 30000;
  let measured;
  do {
    try { measured = JSON.parse(await readFile(metricsPath, "utf8")); } catch { /* sampler may be writing */ }
    if (measured?.sampleCount >= 3 && measured.gpuSampleCount > 0) break;
    await new Promise(resolve => setTimeout(resolve, 200));
  } while (Date.now() < deadline);
  await writeFile(stopPath, "stop"); assert.equal(await samplerDone, 0);
  const metrics = JSON.parse(await readFile(metricsPath, "utf8"));
  assert(metrics.finished && metrics.stopReason === "stop-file" && metrics.sampleCount >= 1);
  const driverMeasured = metrics.gpuSampleCount > 0 && metrics.observedGpuInstances?.length > 0;
  await writeFile(path.join(out, "sampler.log"), log);
  const evidence = { passed: driverMeasured, currentRun: true, rootProcessId, gpu, metrics,
    scope: "fresh Chrome process tree, actual submitted WebGPU attachment, Windows driver dedicated-memory samples",
    excluded: ["per-renderer VRAM attribution", "disposed graph leak budget", "recovery phase latency", "Native process tree"] };
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: evidence.passed, samples: metrics.sampleCount, gpuSamples: metrics.gpuSampleCount,
    peakGpuBytes: metrics.peakGpuBytes, instances: metrics.observedGpuInstances, error: metrics.gpuCounterError }));
  if (!driverMeasured) process.exitCode = 1;
  await page.evaluate(() => globalThis.releaseProbe());
} finally {
  if (sampler && sampler.exitCode === null) { await writeFile(stopPath, "stop"); await samplerDone; }
  try { await browser?.close(); await browserServer?.close(); } finally { await new Promise(resolve => server.close(resolve)); }
}
