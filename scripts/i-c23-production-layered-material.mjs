import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const mode = process.env.C23_GATE_MODE ?? "production";
if (!["production", "rehydrated"].includes(mode)) throw Error("Unknown C23 gate mode.");
const rounds = mode === "rehydrated" ? 1 : 2;
const out = path.join(root, `test-output/i-series-0930/layered-material-${mode}`);
await mkdir(out, { recursive: true });
const { build } = require("../packages/deep-engine/node_modules/esbuild"), sharp = require("sharp");
const sources = ["packages/deep-engine/lab/iC23LayeredMaterialProduction.ts", "scripts/i-c23-production-layered-material.mjs"];
for (const folder of ["packages/deep-engine/src", "packages/deep-engine/wgsl"]) {
  for (const entry of await readdir(path.join(root, folder), { recursive: true, withFileTypes: true })) {
    if (entry.isFile() && /\.(ts|wgsl|sha256)$/.test(entry.name)) sources.push(path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll("\\", "/"));
  }
}
sources.sort();
const hashes = async () => Object.fromEntries(await Promise.all(sources.map(async file => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
const sourceHashes = await hashes();
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/iC23LayeredMaterialProduction.ts")],
  outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs"))); }
  else { response.setHeader("Content-Type", "text/html; charset=utf-8"); response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}body{margin:0;overflow:hidden;background:var(--bg-0)}canvas{display:block}</style></head><body></body></html>`); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
const runs = [], errors = []; let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--enable-unsafe-webgpu"] });
  for (let round = 1; round <= rounds; round++) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage(), frames = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.exposeFunction("saveLayeredFrame", async name => {
      const file = path.join(out, `round-${round}-${name}.png`); await page.screenshot({ path: file });
      const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
      const bins = new Set(); let visiblePixels = 0;
      for (let y = 220; y < 860; y++) for (let x = 400; x < 1520; x++) {
        const i = (y * info.width + x) * info.channels;
        if (Math.max(data[i], data[i + 1], data[i + 2]) > 40) { visiblePixels++; bins.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`); }
      }
      frames.push({ name, visiblePixels, colorBins: bins.size });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result = await page.evaluate(async mode => (await import("/probe.mjs")).runIC23LayeredMaterialProduction(name => globalThis.saveLayeredFrame(name), mode), mode);
    result.displayFrames = frames;
    const actual = frames.find(frame => frame.name === (mode === "rehydrated" ? "rehydrated-two-layers" : "two-layers"));
    result.passed &&= actual?.visiblePixels > 100_000 && actual?.colorBins > 5;
    runs.push(result); console.log(JSON.stringify({ round, passed: result.passed, maxCombinationError: result.maxCombinationError,
      textureDelta: result.textureDelta, zeroDelta: result.zeroDelta, alphaZeroDelta: result.alphaZeroDelta,
      maxFurnaceError: result.maxFurnaceError, maxFurnaceLayerDelta: result.maxFurnaceLayerDelta, maxRestoredDelta: result.maxRestoredDelta,
      failure: result.failure, validationError: result.validationError, remainingResources: result.remainingResources, actual }));
    await context.close(); if (!result.passed) break;
  }
} catch (error) { errors.push(error.stack ?? String(error)); }
finally {
  const sourceFresh = JSON.stringify(sourceHashes) === JSON.stringify(await hashes());
  const stable = runs.length === rounds && runs.every(run => run.passed) && runs.every(run => run.shaderHash === runs[0].shaderHash);
  const evidence = { passed: stable && sourceFresh && errors.length === 0, mode, stable, sourceFresh, theme: "dark", width: 1920, height: 1080,
    freshRealms: runs.length, sourceHashes, bundleSha256: createHash("sha256").update(await readFile(path.join(out, "probe.mjs"))).digest("hex"), runs, errors };
  await writeFile(path.join(out, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(JSON.stringify({ output: out, passed: evidence.passed, stable, sourceFresh, errors }));
  if (!evidence.passed) process.exitCode = 1;
  try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); }
}
