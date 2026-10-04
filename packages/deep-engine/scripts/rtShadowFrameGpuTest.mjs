// M2 方向光 RT 阴影帧链真机探针 runner(harness 沿用 shadowRayGpuTest.mjs)。
// 门:① sceneShader 两档编译零 error ② RT bind group 真机创建 ③ 背景条带 mask==1.0
//    ④ 斜向光遮挡质心沿光方向位移(点积>0)。
// 证据写 test-output/rt-shadow-frame-gpu-20261004/。
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "rt-shadow-frame-gpu-20261004");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.RT_SHADOW_FRAME_GPU_ATTEMPTS ?? 3);

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
      return module.runRtShadowFrameGpuProbe();
    });
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "rt-shadow-frame-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/rtShadowFrameGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"), "<!doctype html><title>RT shadow frame GPU probe</title>");
  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0 && probe.frames.length > 0) break;
    } catch (error) {
      probe = { errors: [String(error instanceof Error ? error.message : error)] };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  await mkdir(outputDirectory, { recursive: true });
  const frames = probe.frames ?? [];
  const vertical = frames.find(frame => frame.name === "vertical") ?? null;
  const tilted = frames.find(frame => frame.name === "tilted") ?? null;
  const gates = {
    shaderDefaultCompiles: (probe.shaderCompiliation?.default ?? 1) === 0,
    shaderRtCompiles: (probe.shaderCompiliation?.rt ?? 1) === 0,
    rtBindGroupCreated: probe.rtBindGroupCreated === true,
    backgroundMaskVisible: frames.length > 0 && frames.every(frame => frame.backgroundCorrect),
    verticalLightAllVisible: frames.find(frame => frame.name === "vertical")?.occludedCount === 0,
    tiltedLightCastsShadow: (frames.find(frame => frame.name === "tilted")?.occludedCount ?? 0) > 0,
    lightRotationShiftsShadow: probe.lightRotation?.lightRotationShiftsShadow === true,
  };
  const gate = probe.errors.length === 0 && Object.values(gates).every(Boolean);
  const evidence = {
    schema: "rt-shadow-frame-gpu-evidence-v1", createdAt: new Date().toISOString(),
    environment: { chromeVersion: probe.browserVersion ?? null, userAgent: probe.userAgent ?? null,
      adapter: probe.adapter, features: probe.features, probeErrors: probe.errors },
    shaderCompiliation: probe.shaderCompiliation, rtBindGroupCreated: probe.rtBindGroupCreated,
    frames, lightRotation: probe.lightRotation,
    verdict: { gate, gates,
      notes: [
        "完整 PbrRenderer 帧(开关关/开全链像素对拍)不在本探针内;开关关=HEAD 的字节级等价由 outputFamilyWgslChecksum strip 恒等断言机器证明。",
        "③ depth 由 writeTexture 直接编码(y=depth 平面;非渲染管线产出),隔离验证 kernel 的 depth 重建/遮挡语义与执行器 encode 合同。",
        "④ 遮挡质心位移以像素坐标的 (x+z) 方向分量与单位光方向点积>0 判定(俯视 x=像素 x,z=像素 y)。",
      ] },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(outputDirectory, "evidence.sha256"),
    `${createHash("sha256").update(JSON.stringify(evidence)).digest("hex")} probe-evidence\n`);
  console.log(JSON.stringify({ gates, errors: probe.errors, frames, adapter: probe.adapter }, null, 2));
  console.log(`Verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
