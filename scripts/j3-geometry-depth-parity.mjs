import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { compareGeometryDepth } from "./lib/j3GeometryDepthParity.mjs";
import { compareHdrFlat } from "./lib/j3HdrFlatParity.mjs";
import { snapshotLayerSources, requireUnchangedLayerSources } from "./lib/j3LayerSourceIdentity.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const flags = new Set(process.argv.slice(2));
const hdrMode = flags.delete("--hdr"), out = path.join(root, `test-output/interrupted-0930/${hdrMode ? "hdr-flat-normal" : "geometry-depth"}`);
for (const flag of flags) if (!["--compare", "--web-only"].includes(flag)) throw Error(`Unknown option ${flag}`);
if (flags.size > 1) throw Error("Choose --compare or --web-only");
await mkdir(out, { recursive: true });
const manifestSource = await readFile(path.join(root, `packages/deep-engine/fixtures/${hdrMode ? "j3-hdr-flat-normal-v1" : "j3-geometry-depth-v1"}.json`), "utf8");
const manifest = JSON.parse(manifestSource), manifestHash = createHash("sha256").update(manifestSource).digest("hex");
const nativePath = path.join(out, "native.json"), webPath = path.join(out, "web.json"), evidencePath = path.join(out, "evidence.json");
const sourceFiles = ["scripts/j3-geometry-depth-parity.mjs", "scripts/lib/j3GeometryDepthParity.mjs",
  "scripts/lib/j3HdrFlatParity.mjs", "packages/deep-engine/lab/j3GeometryDepthProbe.ts",
  "packages/deep-engine/fixtures/j3-geometry-depth-v1.json", "packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json",
  manifest.sourceFixture, "packages/deep-engine-native/tests/gpu_shader_material_draw.rs",
  "packages/deep-engine-native/tests/support/lod_draw_readback.rs",
  "packages/deep-engine-native/tests/support/j3_geometry_depth.rs", "packages/deep-engine-native/tests/support/j3_geometry_depth_readback.rs",
  "packages/deep-engine-native/tests/support/j3_hdr_frame.rs", "packages/deep-engine-native/tests/support/shader_material_renderer.rs",
  "packages/deep-engine-native/tests/support/shader_material_observers.rs"];
const stored = flags.has("--compare") ? JSON.parse(await readFile(evidencePath, "utf8")) : undefined;
await rm(evidencePath, { force: true });
const before = await snapshotLayerSources(sourceFiles);
if (stored) requireUnchangedLayerSources(stored.sourceIdentity, before);
if (!flags.has("--compare")) {
  await rm(evidencePath, { force: true }); await rm(webPath, { force: true });
  if (!flags.has("--web-only")) {
    await rm(nativePath, { force: true });
    const cargo = spawnSync("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
      "--test", "gpu_shader_material_draw", "j3_gate_d_actual_geometry_depth", "--", "--ignored"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 600000,
      env: { ...process.env, BIM_J3_HDR_PARITY: hdrMode ? "1" : "0" },
    });
    const log = (cargo.stdout ?? "") + (cargo.stderr ?? ""); await writeFile(path.join(out, "native.log"), log);
    if (cargo.error || cargo.status !== 0 || !/test j3_geometry_depth::j3_gate_d_actual_geometry_depth \.\.\. ok/.test(log)
      || !/test result: ok\. [1-9]\d* passed/.test(log)) {
      await rm(nativePath, { force: true }); throw Error(`Current Native geometry test failed or did not execute (${cargo.status}); see native.log`);
    }
    await readFile(nativePath, "utf8");
  }
  const require = createRequire(import.meta.url), { build } = require("../packages/deep-engine/node_modules/esbuild");
  await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j3GeometryDepthProbe.ts")],
    outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
  const source = JSON.parse(await readFile(path.join(root, manifest.sourceFixture), "utf8"));
  const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
  const server = createServer(async (request, response) => {
    if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs"))); }
    else { response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);padding:24px"><h1>共同几何与深度</h1><p>相同 CPU 包 · 固定相机 · 生产附件读回</p><canvas width="${manifest.width}" height="${manifest.height}" style="width:${manifest.width}px;height:${manifest.height}px"></canvas></body></html>`); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core"); let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true, args: ["--enable-unsafe-webgpu"] });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.exposeFunction("captureGeometryFrame", async (cameraId, round) => {
      await page.screenshot({ path: path.join(out, `frame-${cameraId}-${round}.png`), fullPage: true });
    });
    const result = await page.evaluate(async ({ manifest, source, hdrMode }) =>
      (await import("/probe.mjs")).runJ3GeometryDepthProbe(document.querySelector("canvas"), manifest, source,
        (cameraId, round) => window.captureGeometryFrame(cameraId, round), hdrMode ? manifest : undefined), { manifest, source, hdrMode });
    if (hdrMode) result.manifestHash = manifestHash;
    await writeFile(webPath, `${JSON.stringify(result)}\n`);
  } finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
}
if (flags.has("--web-only")) console.log(`Web-only actual geometry evidence: ${webPath}`);
else {
  const web = JSON.parse(await readFile(webPath, "utf8")), native = JSON.parse(await readFile(nativePath, "utf8"));
  if (hdrMode && (native.manifestHash !== manifestHash || web.manifestHash !== manifestHash)) throw Error("Actual HDR manifest identity drift");
  const evidence = hdrMode ? compareHdrFlat(manifest, web, native) : compareGeometryDepth(manifest, web, native);
  const result = { ...evidence, currentRun: !flags.has("--compare"),
    sourceIdentity: stored?.sourceIdentity ?? before,
    evidenceMode: flags.has("--compare") ? "historical file comparison; no host executed" : "both production hosts executed in this run" };
  requireUnchangedLayerSources(before, await snapshotLayerSources(sourceFiles));
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result, null, 2));
}
