import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));

const out = path.join(root, "test-output/i-series-0930", "particle-flow");
await mkdir(out, { recursive: true });
const require = createRequire(import.meta.url), { build } = require("../packages/deep-engine/node_modules/esbuild");
const sourcePaths = ["packages/deep-engine/lab/iC17ParticleFlowProduction.ts", "packages/deep-engine/src/webgpu/gpuParticleRuntime.ts", "packages/deep-engine/src/webgpu/gpuParticleFlowFieldStage.ts", "packages/deep-engine/src/webgpu/gpuParticleFlowFieldTypes.ts", "packages/deep-engine/src/webgpu/gpuParticleFlowFieldWgsl.ts", "packages/deep-engine/src/webgpu/gpuParticleEmitters.ts", "packages/deep-engine/src/webgpu/gpuParticleTypes.ts", "packages/deep-engine/src/webgpu/gpuParticleWgsl.ts", "packages/deep-engine/src/particles/flowFieldNoise.ts", "packages/deep-engine/src/particles/flowFieldParticleCpu.ts", "packages/deep-engine/src/webgpu/pbrParticlePass.ts", "packages/deep-engine/src/webgpu/pbrRenderer.ts", "packages/deep-engine/src/webgpu/pbrRendererTypes.ts", "packages/deep-engine/wgsl/particleFlowField.wgsl"];
for (const folder of ["packages/deep-engine/src", "packages/deep-engine/wgsl"]) {
  const entries = await readdir(path.join(root, folder), { recursive: true, withFileTypes: true });
  for (const entry of entries) if (entry.isFile() && /\.(ts|wgsl|sha256)$/.test(entry.name)) {
    const file = path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/");
    if (!sourcePaths.includes(file)) sourcePaths.push(file);
  }
}
sourcePaths.sort();
const sourceHashes = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file =>
  [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
const sourcesBefore = await sourceHashes();
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/iC17ParticleFlowProduction.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") {
    response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs")));
  } else {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}
body{margin:0;overflow:hidden;background:var(--bg-0)}canvas{display:block}</style></head><body></body></html>`);
  }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
let browser;
const runs = [], errors = [];
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH
    ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
  for (let round = 1; round <= 2; round++) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("saveParticleFlowFrame", async name => {
      await page.screenshot({ path: path.join(out, `round-${round}-${name}.png`) });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async () => (await import("/probe.mjs")).runIC17ParticleFlowProduction(
      name => globalThis.saveParticleFlowFrame(name)));
    runs.push(result);
    console.log(JSON.stringify({ round, passed: result.passed, cpuError: result.flow?.maxError, deterministic: result.deterministic, zeroIdentity: result.zeroIdentity, changedPixels: result.changedPixels, validationError: result.validationError, remainingResources: result.remainingResources }));
    await context.close();
    if (!result.passed) break;
  }
} catch (error) { errors.push(error.stack ?? String(error)); }
finally {
  const stable = runs.length === 2 && runs[0].shaderHash === runs[1].shaderHash
    && runs[0].deterministic === runs[1].deterministic && runs[0].zeroIdentity === runs[1].zeroIdentity && runs[0].flow.maxError === runs[1].flow.maxError;
  const sourcesAfter = await sourceHashes(), sourceFresh = JSON.stringify(sourcesBefore) === JSON.stringify(sourcesAfter);
  const bundleSha256 = createHash("sha256").update(await readFile(path.join(out, "probe.mjs"))).digest("hex");
  const evidence = { passed: stable && sourceFresh && errors.length === 0 && runs.every(run => run.passed), stable, sourceFresh,
    sourceHashes: sourcesBefore, bundleSha256, freshRealms: runs.length, theme: "dark", width: 1920, height: 1080, runs, errors };
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output: out, passed: evidence.passed, stable, errors }));
  if (!evidence.passed) process.exitCode = 1;
  try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); }
}
