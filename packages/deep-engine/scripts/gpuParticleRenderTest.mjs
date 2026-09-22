import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// A4 粒子真机渲染证据 runner：headless Chrome + 真 WebGPU，运行既有
// runGpuParticleProbe（模拟读回 + PbrParticlePass 离屏 HDR 绘制 + 像素读回）。
// 证据写入 test-output/gpu-particle-render-20260923/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "gpu-particle-render-20260923");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.GPU_PARTICLE_TEST_ATTEMPTS ?? 3);

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method !== "GET" || !["probe.html", "probe.bundle.mjs"].includes(name)) {
      response.writeHead(404).end(); return;
    }
    response.writeHead(200, { "Content-Type": name.endsWith(".html") ? "text/html; charset=utf-8" : "text/javascript" })
      .end(await readFile(path.join(directory, name)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function runInBrowser(origin) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const result = await page.evaluate(async () => {
      const module = await import("./probe.bundle.mjs");
      return module.runGpuParticleProbeStandalone();
    });
    result.browserVersion = browser.version();
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "gpu-particle-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/gpuParticleProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"), "<!doctype html><title>GPU particle probe</title>");

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.success) break;
    } catch (error) {
      probe = { success: false, validationMessages: [String(error instanceof Error ? error.message : error)] };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  const module = await import(pathToFileURL(bundlePath));
  if (!probe) throw new Error(`GPU particle probe failed after ${maxAttempts} attempts.`);
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(path.join(outputDirectory, "report.json"), JSON.stringify(probe, null, 2));

  const gate = probe.success === true
    && (probe.renderedNonBackgroundPixels ?? 0) > 0
    // A4 多预设证据：三个发射器预设都必须在各自专属取景下产出非背景像素。
    && (probe.expandingRingRenderedNonBackgroundPixels ?? 0) > 0
    && (probe.flowLineRenderedNonBackgroundPixels ?? 0) > 0;
  console.log(JSON.stringify({ gate, success: probe.success, aliveCount: probe.aliveCount,
    indirectCount: probe.indirectCount, renderedNonBackgroundPixels: probe.renderedNonBackgroundPixels,
    expandingRingRenderedNonBackgroundPixels: probe.expandingRingRenderedNonBackgroundPixels,
    flowLineRenderedNonBackgroundPixels: probe.flowLineRenderedNonBackgroundPixels,
    presetsVerified: probe.presetsVerified, timeContinuous: probe.timeContinuous,
    burstBudgetDegraded: probe.burstBudgetDegraded }, null, 2));
  if (!gate) throw new Error("GPU particle render gate failed; see report.json.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
