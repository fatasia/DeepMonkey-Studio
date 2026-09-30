import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const mode = process.env.C1_GATE_MODE ?? "bare", temporalAa = mode === "taa";
const out = path.join(root, "test-output/i-series-0930", `gaussian-splats-${mode}`);
await mkdir(out, { recursive: true });
const { build } = require("../packages/deep-engine/node_modules/esbuild"), sharp = require("sharp");
const sources = ["packages/deep-engine/lab/iC1GaussianSplatProduction.ts", "packages/deep-engine/lab/iC1SharedReactiveMask.ts", "scripts/i-c1-production-gaussian-splats.mjs"];
for (const folder of ["packages/deep-engine/src", "packages/deep-engine/wgsl"]) {
  for (const entry of await readdir(path.join(root, folder), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.(ts|wgsl|sha256)$/.test(entry.name)) sources.push(path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  }
}
sources.sort();
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
const sourceHashes = await hashes();
const sample = await readFile(process.env.C1_GATE_SAMPLE ?? "D:/Download/bonsai-7k-mini.splat");
const sampleSha256 = createHash("sha256").update(sample).digest("hex");
if (sampleSha256 !== "9e67a38943cd02aa0388c5abf3cb0465a330b7b45ad8aa3d3decc82e5cc8fbb1") throw Error("C1 sample identity differs from the fixed official file");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/iC1GaussianSplatProduction.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs"))); }
  else if (request.url === "/sample.splat") { response.setHeader("Content-Type", "application/octet-stream"); response.end(sample); }
  else { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}body{margin:0;overflow:hidden;background:var(--bg-0)}canvas{display:block}</style></head><body></body></html>`); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
const runs = [], errors = []; let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--enable-unsafe-webgpu"] });
  for (let round = 1; round <= 2; round++) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage(), frames = []; let background;
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("saveGaussianFrame", async name => {
      const file = path.join(out, `round-${round}-${name}.png`); await page.screenshot({ path: file });
      const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      if (name === "background") background = data;
      let changedPixels = 0; const bins = new Set();
      if (background && name.startsWith("bonsai")) for (let i = 0; i < data.length; i += info.channels) {
        if (Math.max(Math.abs(data[i] - background[i]), Math.abs(data[i + 1] - background[i + 1]), Math.abs(data[i + 2] - background[i + 2])) > 20) {
          changedPixels++; bins.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
        }
      }
      frames.push({ name, changedPixels, colorBins: bins.size });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async taa => (await import("/probe.mjs")).runIC1GaussianSplatProduction(name => globalThis.saveGaussianFrame(name), taa), temporalAa);
    result.displayFrames = frames;
    const realFrames = frames.filter(frame => frame.name.startsWith("bonsai"));
    result.passed = result.passed && realFrames.length === 2 && realFrames.every(frame => frame.changedPixels > 20_000 && frame.colorBins > 32);
    runs.push(result); console.log(JSON.stringify({ round, passed: result.passed, maxProjectionError: result.maxProjectionError,
      maxSortBlendError: result.maxSortBlendError, splatCount: result.splatCount, failure: result.failure, validationError: result.validationError,
      realFrames, remainingResources: result.remainingResources }));
    await context.close(); if (!result.passed) break;
  }
} catch (error) { errors.push(error.stack ?? String(error)); }
finally {
  const sourceFresh = JSON.stringify(sourceHashes) === JSON.stringify(await hashes());
  const stable = runs.length === 2 && runs.every(run => run.passed) && runs[0].shaderHash === runs[1].shaderHash && runs[0].splatCount === runs[1].splatCount;
  const evidence = { passed: stable && sourceFresh && errors.length === 0, stable, sourceFresh, mode, theme: "dark", width: 1920, height: 1080,
    freshRealms: runs.length, sourceHashes, sampleSha256,
    bundleSha256: createHash("sha256").update(await readFile(path.join(out, "probe.mjs"))).digest("hex"), runs, errors };
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output: out, passed: evidence.passed, stable, sourceFresh, errors }));
  if (!evidence.passed) process.exitCode = 1;
  try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); }
}
