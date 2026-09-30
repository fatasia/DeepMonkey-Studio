import { createServer } from "node:http";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { compareDeviceRecovery } from "./lib/j3DeviceRecoveryParity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = path.join(root, "test-output/interrupted-0930/device-recovery");
const flags = new Set(process.argv.slice(2));
for (const flag of flags) if (!["--compare", "--web-only"].includes(flag)) throw Error(`Unknown option ${flag}`);
if (flags.size > 1) throw Error("Choose --compare or --web-only");
await mkdir(out, { recursive: true });
const manifest = JSON.parse(await readFile(path.join(root, "packages/deep-engine/fixtures/j3-device-recovery-v1.json"), "utf8"));
const nativePath = path.join(out, "native.json"), webPath = path.join(out, "web.json"), evidencePath = path.join(out, "evidence.json");
if (!flags.has("--compare")) {
  await rm(evidencePath, { force: true }); await rm(webPath, { force: true });
  if (!flags.has("--web-only")) {
    await rm(nativePath, { force: true });
    const cargo = spawnSync("cargo", ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml",
      "--locked", "--test", "gpu_shader_material_draw", "j3_gate_e_actual_device_recovery", "--", "--ignored"], {
      cwd: root, encoding: "utf8", windowsHide: true, timeout: 600000,
    });
    const log = (cargo.stdout ?? "") + (cargo.stderr ?? ""); await writeFile(path.join(out, "native.log"), log);
    if (cargo.error || cargo.status !== 0 || !/test j3_device_recovery::j3_gate_e_actual_device_recovery \.\.\. ok/.test(log)
      || !/test result: ok\. [1-9]\d* passed/.test(log)) {
      await rm(nativePath, { force: true }); throw Error(`Current Native recovery test failed or did not execute (${cargo.status}); see native.log`);
    }
    // Reject a successful log without a fresh file before acquiring any browser GPU.
    await readFile(nativePath, "utf8");
  }
  const require = createRequire(import.meta.url), { build } = require("../packages/deep-engine/node_modules/esbuild");
  await build({ entryPoints: [path.join(root, "packages/deep-engine/lab/j3DeviceRecoveryProbe.ts")],
    outfile: path.join(out, "probe.mjs"), bundle: true, format: "esm", platform: "browser" });
  const source = JSON.parse(await readFile(path.join(root, manifest.sourceFixture), "utf8"));
  const css = await readFile(path.join(root, "apps/web/src/styles/base.css"), "utf8");
  const server = createServer(async (request, response) => {
    if (request.url === "/probe.mjs") { response.setHeader("Content-Type", "text/javascript"); response.end(await readFile(path.join(out, "probe.mjs"))); }
    else { response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(`<html><head><meta charset="utf-8"><style>${css}</style></head><body style="background:var(--bg-0);color:var(--text-strong);padding:24px"><h1>真实设备重建</h1><p>相同 CPU 包 · 实际 PBR 首帧</p><canvas width="128" height="128" style="width:128px;height:128px"></canvas><pre id="result"></pre></body></html>`); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { chromium } = require("../apps/cloud-render-worker/node_modules/playwright-core");
  let browser;
  try {
    browser = await chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
      headless: true, args: ["--enable-unsafe-webgpu"] });
    const page = await browser.newPage({ viewport: { width: 980, height: 720 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.exposeFunction("captureRecoveryFrame", async (round, phase) => {
      await page.screenshot({ path: path.join(out, `frame-${round}-${phase}.png`), fullPage: true });
    });
    const result = await page.evaluate(async ({ manifest, source }) =>
      (await import("/probe.mjs")).runJ3DeviceRecoveryProbe(document.querySelector("canvas"), manifest, source,
        (round, phase) => window.captureRecoveryFrame(round, phase)), { manifest, source });
    await writeFile(webPath, `${JSON.stringify(result, null, 2)}\n`);
    await page.evaluate(result => { document.querySelector("#result").textContent = JSON.stringify(result.runs, null, 2); }, result);
    await page.screenshot({ path: path.join(out, "recovery.png"), fullPage: true });
  } finally { try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); } }
}
if (flags.has("--web-only")) console.log(`Web-only real device recovery evidence: ${webPath}`);
else {
  const evidence = compareDeviceRecovery(manifest, JSON.parse(await readFile(webPath, "utf8")), JSON.parse(await readFile(nativePath, "utf8")));
  const result = { ...evidence, currentRun: !flags.has("--compare"),
    evidenceMode: flags.has("--compare") ? "historical file comparison; no host executed this run" : "both hosts executed in this run" };
  await writeFile(evidencePath, `${JSON.stringify(result, null, 2)}\n`); console.log(JSON.stringify(result, null, 2));
}
