import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import path from "node:path";
import { compareNormalAttachments, validateWebNormalShadow } from "./lib/j3NormalShadowParity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), require = createRequire(import.meta.url);
const output = path.join(root, "test-output/interrupted-0930/normal-shadow");
const webOnly = process.argv.length === 3 && process.argv[2] === "--web-only";
if (process.argv.length > (webOnly ? 3 : 2)) throw Error("Only --web-only is supported; default requires fresh Native and Web.");
await mkdir(output, { recursive: true });
await rm(path.join(output, "evidence.json"), { force: true }); await rm(path.join(output, "web.json"), { force: true });
const manifest = JSON.parse(await readFile(path.join(root, "packages/deep-engine/fixtures/j3-hdr-flat-normal-v1.json"), "utf8"));
const source = JSON.parse(await readFile(path.join(root, manifest.sourceFixture), "utf8"));
const files = ["packages/deep-engine/lab/j3NormalShadowMatrix.ts", "packages/deep-engine/lab/j3NormalShadowProbe.ts",
  "packages/deep-engine/lab/j3NormalShadowReadbackShader.ts", "scripts/lib/j3NormalShadowParity.mjs", "scripts/j3-normal-shadow-parity.mjs",
  "packages/deep-engine-native/tests/support/j3_normal_attachments.rs", "packages/deep-engine-native/src/forward_targets.rs",
  "packages/deep-engine-native/src/pipeline/mod.rs", "packages/deep-engine-native/src/pipeline/mesh.rs", "packages/deep-engine-native/src/mesh_pass.rs",
  "packages/deep-engine-native/assets/shaders/native_mesh_v1.wgsl", "packages/deep-engine-native/tests/support/shader_material_renderer.rs",
  "packages/deep-engine-native/tests/support/shader_material_observers.rs", "packages/deep-engine/src/webgpu/pbrRenderer.ts",
  "packages/deep-engine/src/webgpu/pbrShader.ts", "packages/deep-engine/src/webgpu/renderTargets.ts", manifest.sourceFixture];
async function identity() {
  return Object.fromEntries(await Promise.all(files.map(async file => [file, createHash("sha256").update(await readFile(path.join(root, file))).digest("hex")])));
}
const before = await identity();
if (!webOnly) {
  await rm(path.join(output, "native.json"), { force: true });
  const cargo = spawnSync("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
    "--test", "gpu_shader_material_draw", "j3_gate_d_actual_normal_attachments", "--", "--ignored", "--nocapture"],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  const log = (cargo.stdout ?? "") + (cargo.stderr ?? ""); await writeFile(path.join(output, "native.log"), log);
  if (cargo.error || cargo.status !== 0 || !/test j3_normal_attachments::j3_gate_d_actual_normal_attachments \.\.\. ok/.test(log)
    || !/test result: ok\. [1-9]\d* passed/.test(log)) throw Error("Actual named Native normal attachment test failed; see normal-shadow/native.log");
}
const { build } = require("../packages/deep-engine/node_modules/esbuild");
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j3NormalShadowMatrix.ts")],
  outfile: path.join(output, "cpu-plan.mjs"), bundle: true, format: "esm", platform: "node" });
const { buildJ3NormalShadowMatrix } = await import(pathToFileURL(path.join(output, "cpu-plan.mjs")));
const plan = buildJ3NormalShadowMatrix(source, manifest); await writeFile(path.join(output, "cpu-plan.json"), JSON.stringify(plan));
await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j3NormalShadowProbe.ts")],
  outfile: path.join(output, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
const server = createServer(async (request, response) => {
  if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(output, "probe.mjs"))); }
  else { response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<html data-theme="dark"><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);padding:24px"><h1>生产法线与阴影附件</h1><p>同一场景 · 固定相机与像素 · 原前向管线</p><canvas width="128" height="128" style="width:512px;height:512px;image-rendering:pixelated"></canvas></body></html>`); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  browser = await chromium.launch({ headless: true, executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", args: ["--enable-unsafe-webgpu"] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, reducedMotion: "reduce" });
  const errors = []; page.on("pageerror", error => errors.push(String(error)));
  await page.exposeFunction("captureNormalFrame", async (id, round) => {
    if (id.endsWith("baseline")) await page.screenshot({ path: path.join(output, `frame-${id}-${round}.png`) });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const web = await page.evaluate(async ({ source, manifest }) => (await import("/probe.mjs")).runJ3NormalShadowProbe(
    document.querySelector("canvas"), source, manifest, (id, round) => window.captureNormalFrame(id, round)), { source, manifest });
  if (errors.length) throw Error(errors.join("\n"));
  await writeFile(path.join(output, "web.json"), JSON.stringify(web));
  const result = webOnly ? validateWebNormalShadow(plan, web)
    : compareNormalAttachments(plan, web, JSON.parse(await readFile(path.join(output, "native.json"), "utf8")));
  const after = await identity();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw Error("Normal/shadow sources changed during run.");
  const evidence = { ...result, currentRun: !webOnly, execution: { web: "fresh-production-attachments", native: webOnly ? "not-executed" : "fresh-named-production-test" },
    sources: before, excluded: result.excluded ?? ["Native normal attachment parity", "shadow matrix parity"] };
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
} finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
