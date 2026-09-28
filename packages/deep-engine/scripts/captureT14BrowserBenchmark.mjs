import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "../node_modules/esbuild/lib/main.js";
import playwright from "../../../apps/cloud-render-worker/node_modules/playwright-core/index.js";

const directory = fileURLToPath(new URL(".", import.meta.url));
const bundled = await build({ entryPoints: [join(directory, "benchmarkT14SkinnedActorsBrowser.ts")],
  bundle: true, write: false, format: "iife", platform: "browser", target: "es2022" });
const browser = await playwright.chromium.launch({ headless: true, args: ["--enable-unsafe-webgpu", "--enable-precise-memory-info"],
  executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
const server = createServer((_request, response) => response.writeHead(200, { "Content-Type": "text/html" }).end("<!doctype html><title>T14 GPU benchmark</title>"));
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  const cases = [];
  for (const [actors, bones] of [[100, 24], [1000, 24], [1000, 64]]) {
    cases.push(await page.evaluate(async ([count, joints]) => await globalThis.__t14Benchmark(count, joints, 7, true, true), [actors, bones]));
  }
  const comparison = [];
  for (const enabled of [false, true]) comparison.push(await page.evaluate(
    async active => globalThis.__t14Benchmark(1000, 64, 7, active, true), enabled));
  const result = { schema: 3, scope: "Chrome CPU author-pose projection with certified camera-driven LOD; GPU 64-joint/64-vertex compute readback; excludes production GPU frame upload/draw",
    chromeVersion: browser.version(), cases, comparison, gpuVertex: await page.evaluate(() => globalThis.__t14GpuProbe()) };
  if (process.argv[2]) await writeFile(process.argv[2], `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally { server.close(); await browser.close(); }
