import { createServer } from "node:http";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = new URL("../../../", import.meta.url);
const clearcoatOnly = process.argv.includes("--clearcoat-only");
const round = Number(process.env.B1_GPU_ROUND ?? "1");
const output = new URL(clearcoatOnly ? `test-output/hc7p4-b1-author-profile-recovery-20261002/gpu-round${round}/` : `test-output/r12-frame-capture-${Date.now()}/`, root);
const entrypoint = clearcoatOnly ? "../lab/deepSlCsmProbe.ts" : "../lab/r12FrameCaptureProbe.ts";
const bundle = await build({ absWorkingDir: fileURLToPath(root), entryPoints: [fileURLToPath(new URL(entrypoint, import.meta.url))],
  bundle: true, format: "esm", platform: "browser", conditions: ["development"], write: false, metafile: true });
const sourceHashes = async () => Object.fromEntries(await Promise.all(Object.keys(bundle.metafile.inputs).map(async path =>
  [path, createHash("sha256").update(await readFile(new URL(path, root))).digest("hex")])));
const before = await sourceHashes();
const server = createServer((request, response) => {
  if (request.url === "/probe.mjs") response.writeHead(200, { "Content-Type": "text/javascript" }).end(bundle.outputFiles[0].contents);
  else if (request.url === "/") response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>R12 frame capture</title>");
  else response.writeHead(204).end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const require = createRequire(import.meta.url);
const { chromium } = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const result = await page.evaluate(async mode => {
    const probe = await import("/probe.mjs");
    if (!mode) return probe.runR12FrameCaptureProbe();
    const adapter = await navigator.gpu?.requestAdapter();
    if (!adapter) throw new Error("A real WebGPU adapter is required.");
    const device = await adapter.requestDevice();
    try { return await probe.verifyDeepSlClearcoatPackage(device); }
    finally { device.destroy(); }
  }, clearcoatOnly);
  const after = await sourceHashes();
  const sourceStable = JSON.stringify(before) === JSON.stringify(after);
  const evidence = { ...result, success: result.success && errors.length === 0 && sourceStable, errors,
    sourceStable, before, after, bundleSha256: createHash("sha256").update(bundle.outputFiles[0].contents).digest("hex"),
    metafile: bundle.metafile, frameTimingMeasured: false, cargoExecuted: false,
    chrome: browser.version(), capturedAt: new Date().toISOString() };
  await mkdir(output, { recursive: true });
  await writeFile(new URL("evidence.json", output), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ success: evidence.success, output: fileURLToPath(output),
    cases: evidence.cases.map(entry => ({ name: entry.name ?? entry.id, success: entry.success, error: entry.error,
      ...(entry.sample ? { instanceStride: entry.sample.instanceStride, raw16: entry.sample.raw16 } : {}) })), errors }, null, 2));
  if (!evidence.success) process.exitCode = 1;
} finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); }
