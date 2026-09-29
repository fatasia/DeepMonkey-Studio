import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// C10 屏幕空间接触阴影真机验收 runner(形态沿用 whiteFurnaceGpuTest.mjs):
// 悬浮板场景,castShadow=false——接触阴影是唯一遮蔽项,off/on 双腿对照:
//   1) 中心区(板+接触根部)开启后显著变暗,外场(远地面)不变(净贡献定位);
//   2) F1 逐 pass 计时:contact-shadow pass 毫秒实测 + 全帧毫秒差(帧时开销);
//   3) FrameMetrics.contactShadowTier 遥测接线;
// 证据写入 test-output/contact-shadow-gpu-20260928-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.CONTACT_SHADOW_GPU_OUTPUT_DIR
  ? path.resolve(process.env.CONTACT_SHADOW_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "contact-shadow-gpu-20260928-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.CONTACT_SHADOW_GPU_TEST_ATTEMPTS ?? 3);
const OUTER_DRIFT_MAX = 0.01, CONTACT_PASS_MS_MAX = 3;
const DARKENED_PIXELS_MIN = 200;

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
    const page = await browser.newPage({ viewport: { width: 360, height: 360 } });
    page.on("pageerror", (error) => console.error(`[pageerror] ${error.message}`));
    // console forward
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
    const shots = {}, legs = [], errors = [];
    for (const on of [false, true]) {
      const failure = await page.evaluate(async ([legOn]) => {
        try { await (await import("./probe.bundle.mjs")).beginLeg(legOn); return null; }
        catch (error) { return String(error instanceof Error ? error.message : error); }
      }, [on]);
      if (failure) { errors.push(`${on ? "on" : "off"}: ${failure}`);
        legs.push({ on, error: failure }); continue; }
      await page.evaluate(async ([count]) => (await import("./probe.bundle.mjs")).stepLeg(count), [6]);
      await page.evaluate(async () => (await import("./probe.bundle.mjs")).flushPresent());
      const shot = await page.locator("canvas").screenshot({ type: "png" });
      shots[on ? "on" : "off"] = shot.toString("base64");
      const analysis = await page.evaluate(async () => (await import("./probe.bundle.mjs")).endLeg());
      legs.push(analysis);
    }
    return { legs, adapter, errors, shots };
  } finally { await browser.close(); }
}

function analyse(probe) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  const off = probe.legs.find(leg => leg.on === false), on = probe.legs.find(leg => leg.on === true);
  add("legs-ran", Boolean(off && on && !off.error && !on.error),
    off?.error ?? on?.error ?? `frames off=${off?.frames} on=${on?.frames}`);
  if (!off || !on || off.error || on.error) return { checks, gate: false };
  add("far-field-unchanged", on.brightenedCount === 0,
    `brightenedPixels=${on.brightenedCount}/${on.compared} (limit=0)`);
  add("contact-darkened-pixels", on.darkenedCount >= DARKENED_PIXELS_MIN,
    `darkenedPixels=${on.darkenedCount}/${on.compared} (limit=${DARKENED_PIXELS_MIN}) meanAbsDiff=${on.meanAbsDiff.toFixed(5)}`);
  const gpuDelta = (on.totalGpuMs ?? 0) - (off.totalGpuMs ?? 0);
  add("timing-captured", on.totalGpuMs !== null && off.totalGpuMs !== null,
    `totalGpu off=${off.totalGpuMs?.toFixed(4) ?? "null"} on=${on.totalGpuMs?.toFixed(4) ?? "null"} delta=${gpuDelta.toFixed(4)} | perPass contact-shadow=${on.contactPassMs?.toFixed(4) ?? "n/a"}(F1 槽位 14 pass 时可能截断,以帧级 delta 为准)`);
  add("frame-cost-bounded", gpuDelta <= CONTACT_PASS_MS_MAX,
    `gpuDelta=${gpuDelta.toFixed(4)} limit=${CONTACT_PASS_MS_MAX}`);
  add("telemetry-tier-plumbed", on.tier === "balanced", `tier=${on.tier}`);
  return { checks, gate: checks.every(check => check.passed) };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "contact-shadow-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/contactShadowGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Contact shadow GPU probe</title></head><body></body></html>`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0) break;
    } catch (error) {
      probe = { legs: [], adapter: {}, errors: [String(error instanceof Error ? error.message : error)], shots: {} };
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`Contact shadow GPU probe failed after ${maxAttempts} attempts.`);

  const analysis = analyse(probe);
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, base64] of Object.entries(probe.shots)) {
    await writeFile(path.join(outputDirectory, `scene-${name}.png`), Buffer.from(base64, "base64"));
  }
  const evidence = {
    schema: "deep-engine.c10-contact-shadow-gpu", date: new Date().toISOString(),
    chrome: { path: chromePath }, adapter: probe.adapter, errors: probe.errors,
    legs: probe.legs.map(leg => ({ ...leg,
      centerMeanLuma: Number(leg.centerMeanLuma?.toFixed(6) ?? 0), outerMeanLuma: Number(leg.outerMeanLuma?.toFixed(6) ?? 0),
      darkenedCount: leg.darkenedCount ?? 0, compared: leg.compared ?? 0, meanAbsDiff: Number(leg.meanAbsDiff?.toFixed(5) ?? 0),
    brightenedCount: leg.brightenedCount ?? 0,
      frameCpuMs: Number(leg.frameCpuMs?.toFixed(4) ?? 0),
      contactPassMs: leg.contactPassMs == null ? null : Number(leg.contactPassMs.toFixed(4)),
      totalGpuMs: leg.totalGpuMs == null ? null : Number(leg.totalGpuMs.toFixed(4)) })),
    thresholds: { OUTER_DRIFT_MAX, CONTACT_PASS_MS_MAX, DARKENED_PIXELS_MIN },
    screenshots: Object.keys(probe.shots).map(name => `${name}: scene-${name}.png (sha256 ${createHash("sha256").update(probe.shots[name]).digest("hex").slice(0, 16)}...)`),
    checks: analysis.checks, gate: analysis.gate,
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(probe.adapter)}`);
  for (const check of analysis.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${path.join(outputDirectory, "evidence.json")}`);
  if (!analysis.gate) process.exitCode = 1;
}

await main();
