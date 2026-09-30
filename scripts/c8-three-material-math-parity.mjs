import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const out = path.join(root, "test-output/interrupted-0930/c8-three-material");
const sourceFiles = ["packages/deep-engine/wgsl/brdfDirectLighting.wgsl", "packages/deep-engine/src/shader/schlickFactorGlsl.ts",
  "packages/deep-engine/src/threeBridge/threeFresnelShader.ts", "apps/web/src/viewer/threeMaterialMath.ts",
  "apps/web/src/viewer/ViewerEngine.ts", "apps/web/src/viewer/offscreenScene.worker.ts", "packages/deep-engine/lab/threeMaterialMathProbe.ts", "scripts/c8-three-material-math-parity.mjs"];
const sources = Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
await mkdir(out, { recursive: true }); await rm(path.join(out, "evidence.json"), { force: true });
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/threeMaterialMathProbe.ts")], outfile: path.join(out, "probe.mjs"),
  bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const html = `<html><head><meta charset="utf-8"><style>${css}</style></head><body style="padding:24px;background:var(--bg-0);color:var(--text-strong)"><h2>Three 材质 Fresnel · 原 Three / 公共因子</h2><p>每组左：原 Three，右：公共因子。非均匀粗糙度 · 金属 / 非金属 · 自发光 · 真实直射光</p><div id="frames" style="display:grid;grid-template-columns:repeat(2,624px);gap:16px"></div></body></html>`;
const server = createServer(async (request, response) => {
  try { response.setHeader("Content-Type", request.url === "/probe.mjs" ? "text/javascript" : "text/html");
    response.end(request.url === "/probe.mjs" ? await readFile(path.join(out, "probe.mjs")) : html); }
  catch (error) { response.statusCode = 500; response.end(String(error)); }
});
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  browser = await chromium.launch({ headless: true, executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  const errors = []; page.on("pageerror", error => errors.push(String(error)));
  const rounds = [], checks = [];
  for (let round = 1; round <= 2; round++) {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const run = await page.evaluate(async () => (await import("/probe.mjs")).runThreeMaterialMathProbe());
    assert.equal(run.width, 384); assert.equal(run.height, 224); assert.equal(run.frames.length, 8); assert.equal(run.numbers.length, 8); assert.deepEqual(run.errors, []);
    const frames = run.frames.map(frame => {
      assert.equal(frame.baseline.length, 384 * 224 * 4); assert.equal(frame.adapted.length, frame.baseline.length);
      assert(frame.directCoverage > 100 && frame.adaptedDirectCoverage > 100, "real direct light contribution must be observed");
      assert(frame.drawCalls >= 6 && frame.adaptedDrawCalls >= 6 && frame.triangles > 1000 && frame.adaptedTriangles > 1000);
      let maxByteDifference = 0;
      for (let lane = 0; lane < frame.adapted.length; lane++) {
        const value = frame.adapted[lane]; assert(Number.isInteger(value) && value >= 0 && value <= 255);
        maxByteDifference = Math.max(maxByteDifference, Math.abs(value - frame.baseline[lane]));
      }
      assert(maxByteDifference <= 1, `${frame.name}: byte difference ${maxByteDifference}`);
      return { name: frame.name, maxByteDifference, directCoverage: frame.directCoverage };
    });
    const numbers = run.numbers.map(input => {
      const factor = 2 ** ((-5.55473 * input.cosine - 6.98316) * input.cosine);
      const expected = [...input.f0.map(f0 => f0 * (1 - factor) + input.f90 * factor), input.f0[0] * (1 - factor) + input.f90 * factor];
      assert.equal(input.baseline.length, 4); assert.equal(input.adapted.length, 4);
      let maxReferenceError = 0, maxDifference = 0;
      for (let lane = 0; lane < 4; lane++) {
        assert(Number.isFinite(input.baseline[lane]) && Number.isFinite(input.adapted[lane]));
        maxReferenceError = Math.max(maxReferenceError, Math.abs(input.baseline[lane] - expected[lane]), Math.abs(input.adapted[lane] - expected[lane]));
        maxDifference = Math.max(maxDifference, Math.abs(input.baseline[lane] - input.adapted[lane]));
      }
      assert(maxReferenceError <= 2e-6 && maxDifference <= 1e-6, "F0/F90 scalar/vector GPU reference drift");
      return { cosine: input.cosine, f90: input.f90, maxReferenceError, maxDifference };
    }); checks.push({ round, frames, numbers });
    await page.evaluate(run => {
      const host = document.querySelector("#frames");
      for (const frame of run.frames) {
        const card = document.createElement("div"), label = document.createElement("p"); label.textContent = frame.name;
        label.style.cssText = "margin:0 0 8px"; card.append(label);
        for (const key of ["baseline", "adapted"]) {
          const canvas = document.createElement("canvas"); canvas.width = run.width; canvas.height = run.height;
          canvas.style.cssText = "width:288px;height:168px;margin-right:16px";
          const pixels = new Uint8ClampedArray(frame[key]);
          // GPU readback starts at the lower edge; display the actual scene upright.
          const flipped = new Uint8ClampedArray(pixels.length), stride = run.width * 4;
          for (let y = 0; y < run.height; y++) flipped.set(pixels.subarray(y * stride, (y + 1) * stride), (run.height - 1 - y) * stride);
          canvas.getContext("2d").putImageData(new ImageData(flipped, run.width, run.height), 0, 0); card.append(canvas);
        } host.append(card);
      }
    }, run);
    await page.screenshot({ path: path.join(out, `round-${round}.png`) }); rounds.push(run);
  }
  assert.deepEqual(errors, []); assert.deepEqual(rounds[0], rounds[1], "fresh realm rounds must be stable");
  const evidence = { passed: true, stable: true, sources, checks, identities: rounds[0].identities,
    scope: "actual lit Standard/Physical roughness texture/metal/emissive and scalar/vector Fresnel F0/F90", excluded: ["full BRDF unification", "other shader authors", "performance", "actual offscreen worker scene"] };
  await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds)); await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
