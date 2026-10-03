// Independent same-pass diagnostic. Original production/Three outputs and strict gates stay intact.
import { createServer } from "node:http";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const hash = value => createHash("sha256").update(value).digest("hex");
const out = path.join(root, "test-output/interrupted-0930/c8-f32-mrt-witness");
await mkdir(out, { recursive: true });
await rm(path.join(out, "evidence.json"), { force: true });
const files = ["packages/deep-engine/lab/c8F32MrtShader.ts", "packages/deep-engine/lab/c8F32MrtDevice.ts", "packages/deep-engine/lab/c8F32MrtProbe.ts",
  "packages/deep-engine/lab/c8FragmentObservablesShader.ts", "packages/deep-engine/lab/c8SharedSceneProbe.ts", "packages/deep-engine/lab/c8SharedSceneReadback.ts",
  "packages/deep-engine/lab/c8SharedSceneFixture.ts", "packages/deep-engine/src/webgpu/pbrShader.ts", "packages/deep-engine/src/webgpu/frameCaptureReadback.ts",
  "packages/deep-engine/src/webgpu/pipelines.ts", "packages/deep-engine/src/webgpu/pbrOpaquePass.ts", "apps/web/src/viewer/threeMaterialMath.ts", "scripts/c8-f32-mrt-witness.mjs"];
const sourceIdentity = Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(path.join(root, file)))])));
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, files[2])], outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser", conditions: ["development"] });
const bundleHash = hash(await readFile(path.join(out, "probe.mjs")));
const baselineFile = path.join(root, "test-output/interrupted-0930/c8-direct-material-chain/rounds.json");
const baselineBytes = await readFile(baselineFile), baseline = JSON.parse(baselineBytes)[0].find(row => row.view === "near" && row.attachment === "raw").run;
const server = createServer(async (request, response) => { response.setHeader("Content-Type", request.url === "/probe.mjs" ? "text/javascript" : "text/html"); response.end(request.url === "/probe.mjs" ? await readFile(path.join(out, "probe.mjs")) : "<!doctype html><title>C8 same-pass F32 witness</title>"); });
let browser;
try {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  browser = await chromium.launch({ headless: true, executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe" });
  const rounds = [], errors = [], samples = [], preservation = [];
  for (let round = 0; round < 2; round++) {
    const captures = [];
    for (const mode of ["single", "multi", "full"]) {
      const page = await browser.newPage(); page.on("pageerror", error => errors.push(String(error))); let capture;
      try { await page.goto(`http://127.0.0.1:${server.address().port}`);
        capture = { mode, ...await page.evaluate(async mode => (await import("/probe.mjs")).runF32MrtWitness(mode), mode) };
      } finally { await page.close(); }
      assert.equal(capture.receipt.qualityCertified, false); assert.equal(capture.receipt.attachmentBytesPerSample, 24);
      assert.equal(capture.receipt.originalColorFormat, "rgba16float"); assert.equal(capture.receipt.witnessFormat, "rgba32float");
      assert.equal(capture.receipt.three.format, "rgba32float"); assert.equal(capture.receipt.passCount, 5); assert.equal(capture.receipt.submitted, 5);
      assert.equal(capture.receipt.hookCount, 4); assert.equal(capture.receipt.armedFrameCount, 4); assert.equal(capture.validationWitness.length, 1);
      assert.deepEqual(capture.run.errors, []); assert.equal(capture.witness.length, 4); captures.push(capture);
      for (const [index, frame] of capture.run.frames.entries()) {
        const old = baseline.frames.find(previous => previous.name === frame.name); assert(old, "current S5 near raw frame missing");
        assert.equal(frame.rootHash, old.rootHash); assert.equal(frame.packetHash, old.packetHash); assert.equal(frame.profileHash, old.profileHash);
        const witness = capture.witness[index]; assert.equal(witness.name, frame.name); assert.equal(witness.format, "rgba32float"); assert.equal(witness.bytesPerRow, 5120);
        // Record compiler/store effects against S5 instead of declaring the inserted witness bit-neutral by construction.
        const max = (a, b) => a.reduce((value, sample, i) => Math.max(value, Math.abs(sample - b[i])), 0);
        if (round === 0) preservation.push({ mode, frame: frame.name, deepHalfMaxDelta: max(frame.deep.hdr, old.deep.hdr), deepDisplayMaxDelta: max(frame.deep.display, old.deep.display), threeFull32MaxDelta: max(frame.three.hdr, old.three.hdr) });
        if (round === 0 && frame.stage === "direct-diagnostic") {
          const [x, y] = frame.camera === 0 ? [62, 40] : [76, 46], pixel = y * capture.run.width + x;
          samples.push({ mode, frame: frame.name, x, y, deepWitness32: witness.rgba.slice(pixel * 4, pixel * 4 + 4),
            deepOriginal16: frame.deep.hdr.slice(pixel * 3, pixel * 3 + 3), threeOriginalFull32: frame.three.hdr.slice(pixel * 3, pixel * 3 + 3) });
        }
      }
      if (captures.length > 1) assert.deepEqual(capture.run, captures[0].run, "F32 modes altered original full/display outputs");
    }
    rounds.push(captures); await writeFile(path.join(out, "rounds.json"), JSON.stringify(rounds));
  }
  assert.deepEqual(errors, []); assert.deepEqual(rounds[0], rounds[1], "two fresh F32 witness rounds drifted");
  for (const file of files) assert.equal(hash(await readFile(path.join(root, file))), sourceIdentity[file], `diagnostic source changed: ${file}`);
  assert.equal(hash(await readFile(baselineFile)), hash(baselineBytes), "S5 baseline changed during diagnostic");
  const evidence = { passed: true, qualityCertified: false, stable: true, sourceIdentity, bundleHash, baselineHash: hash(baselineBytes), samples, preservation,
    scope: "Deep same-pass pre-store single/multi/full F32; original Deep half/full and original Three full32 retained; Three single/multi32 not measured; no strict threshold change or production adoption" };
  await writeFile(path.join(out, "evidence.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} catch (error) { await writeFile(path.join(out, "failure.json"), JSON.stringify({ passed: false, sourceIdentity, bundleHash, error: String(error) }, null, 2)); throw error; }
finally { try { await browser?.close(); } finally { if (server.listening) await new Promise(resolve => server.close(resolve)); } }
