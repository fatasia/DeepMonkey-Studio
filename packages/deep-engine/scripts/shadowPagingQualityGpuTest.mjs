import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// F7 虚拟化阴影画质真机验收 runner(形态沿用 clearcoatFurnaceGpuTest.mjs):
// 15 条腿 = {atlas-product-512, atlas-256, paged-256-mip1, paged-256-mip3, paged-512-mip3}
// × {1, 4, 16} 灯。同一场景双腿对照(atlas=现行全有/全无图集,paged=mip 页表),
// 画质判据(RMSE/渗漏/边宽,对照 CPU 解析硬影)+ 性能判据(帧级 wall delta/CPU 策略层 p50/
// 深度字节)。**全程跑两轮(独立页面加载)**:规划/画质/PNG 逐字段位级复现检查,
// gpuFrameMs 仅报告波动不设门。证据写入 test-output/shadow-paging-quality-gpu-*/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = process.env.SHADOW_PAGING_GPU_OUTPUT_DIR
  ? path.resolve(process.env.SHADOW_PAGING_GPU_OUTPUT_DIR)
  : path.join(repoRoot, "test-output", "shadow-paging-quality-gpu-20260929-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.SHADOW_PAGING_GPU_TEST_ATTEMPTS ?? 3);
const LEG_CONFIGS = ["atlas-product-512", "atlas-256", "paged-256-mip1", "paged-256-mip3", "paged-512-mip3"];
const LIGHT_COUNTS = [1, 4, 16];
const PASSES = ["A", "B"];
const WARM_FRAMES = 3, MEASURE_FRAMES = 20;
const BUDGET_BYTES = 4 * 1024 * 1024;
const METRIC_EPSILON = 1e-6;
const SCREENSHOT_LEGS = ["atlas-product-512@16", "paged-256-mip3@16"];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 最小 PNG 编码器(8-bit truecolor,filter 0):读回字节确定性 → PNG 哈希可复现。 */
function encodePng(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

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

async function runPass(origin, page, passId) {
  page.on("pageerror", (error) => console.error(`[${passId}][pageerror] ${error.message}`));
  page.on("console", (message) => console.log(`[${passId}][console] ${message.text()}`));
  await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
  const adapter = await page.evaluate(async () => (await import("./probe.bundle.mjs")).probeAdapterInfo());
  const legs = {}, shots = {}, errors = [];
  for (const configId of LEG_CONFIGS) {
    for (const lightCount of LIGHT_COUNTS) {
      const legId = `${configId}@${lightCount}`;
      const failure = await page.evaluate(async ([config, count]) => {
        try { await (await import("./probe.bundle.mjs")).beginLeg(config, count); return null; }
        catch (error) { return String(error instanceof Error ? error.message : error); }
      }, [configId, lightCount]);
      if (failure) { errors.push(`${legId}: ${failure}`); continue; }
      await page.evaluate(async ([warm, measure]) => {
        const module = await import("./probe.bundle.mjs");
        await module.stepLeg(warm);
        await module.stepLeg(measure);
      }, [WARM_FRAMES, MEASURE_FRAMES]);
      legs[legId] = await page.evaluate(async () => (await import("./probe.bundle.mjs")).endLeg());
      if (SCREENSHOT_LEGS.includes(legId)) {
        shots[legId] = Buffer.from(await page.evaluate(async () => {
          const bytes = (await import("./probe.bundle.mjs")).legPngBytes();
          let binary = "";
          for (let index = 0; index < bytes.length; index += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
          }
          return btoa(binary);
        }), "base64");
      }
    }
  }
  return { passId, adapter, legs, shots, errors };
}

/** 复现检查:除 gpuFrameMs(计时波动)外的字段逐项对齐。 */
function compareLegs(left, right) {
  const drift = [];
  const scalarKeys = ["strategy", "lightCount", "coverage", "depthBytes", "budgetBytes",
    "referenceShadowedSamples"];
  for (const key of scalarKeys) {
    if (Math.abs(left[key] - right[key]) > METRIC_EPSILON) drift.push(`${key}: ${left[key]} vs ${right[key]}`);
  }
  for (const key of ["shadowedKeys", "unshadowedKeys"]) {
    if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) drift.push(`${key} mismatch`);
  }
  for (const key of ["rmse", "leakFraction", "edgeWidthP50", "edgeWidthP95"]) {
    if (Math.abs(left.aggregate[key] - right.aggregate[key]) > METRIC_EPSILON) {
      drift.push(`aggregate.${key}: ${left.aggregate[key]} vs ${right.aggregate[key]}`);
    }
  }
  if (left.perLight.length !== right.perLight.length) { drift.push("perLight length"); return drift; }
  left.perLight.forEach((light, index) => {
    const other = right.perLight[index];
    if (light.key !== other.key || light.texels !== other.texels || light.shadowed !== other.shadowed) {
      drift.push(`perLight[${index}] identity`);
      return;
    }
    if ((light.stats === null) !== (other.stats === null)) { drift.push(`perLight[${index}] stats null`); return; }
    if (light.stats) {
      for (const key of ["samples", "shadowedSamples", "rmse", "leakFraction", "edgeWidthP50", "edgeWidthP95"]) {
        if (Math.abs(light.stats[key] - other.stats[key]) > METRIC_EPSILON) {
          drift.push(`perLight[${index}].${key}: ${light.stats[key]} vs ${other.stats[key]}`);
        }
      }
    }
  });
  return drift;
}

function analyse(passA, passB) {
  const checks = [];
  const add = (name, passed, detail) => checks.push({ name, passed, detail });
  add("adapter", Boolean(passA.adapter?.vendor || passA.adapter?.architecture),
    JSON.stringify(passA.adapter));
  for (const pass of [passA, passB]) {
    add(`legs-ran-${pass.passId}`, Object.keys(pass.legs).length === LEG_CONFIGS.length * LIGHT_COUNTS.length
      && pass.errors.length === 0, pass.errors.join("; ") || `legs=${Object.keys(pass.legs).length}`);
  }
  const reproducibilityDrift = [];
  for (const legId of Object.keys(passA.legs)) {
    const left = passA.legs[legId], right = passB.legs[legId];
    if (!right) { reproducibilityDrift.push(`${legId}: missing in B`); continue; }
    const drift = compareLegs(left, right);
    if (drift.length > 0) reproducibilityDrift.push(`${legId}: ${drift.join("; ")}`);
  }
  add("reproducible-metrics", reproducibilityDrift.length === 0,
    reproducibilityDrift.join(" | ") || "两轮规划/画质指标逐字段一致");
  // 预算不变量:paged 驻留 ≤ 预算;atlas 恒为图集保留(4 MiB)。
  const budgetViolations = [];
  for (const [legId, leg] of Object.entries(passA.legs)) {
    if (leg.strategy === "paged" && leg.depthBytes > leg.budgetBytes) {
      budgetViolations.push(`${legId}: ${leg.depthBytes}`);
    }
    if (leg.strategy === "atlas" && leg.depthBytes !== BUDGET_BYTES) {
      budgetViolations.push(`${legId}: atlas ${leg.depthBytes}`);
    }
  }
  add("budget-invariant", budgetViolations.length === 0, budgetViolations.join("; ") || "全部腿满足");
  // 场景健全性:每腿参考影非空(遮挡器真实投影),计时已捕获。
  const sanity = [];
  for (const [legId, leg] of Object.entries(passA.legs)) {
    if (leg.referenceShadowedSamples <= 0) sanity.push(`${legId}: 无参考影样本`);
    if (leg.gpuFrameMs === null || !(leg.gpuFrameMs > 0)) sanity.push(`${legId}: 无帧时`);
  }
  add("scene-sanity", sanity.length === 0, sanity.join("; ") || "全部腿有参考影与帧时");
  // 产品口径镜像:atlas-product-512@16 应有 4 灯有影 + 12 灯被拒(LOCAL_SPOT_SHADOW_ATLAS_OPTIONS)。
  const product = passA.legs["atlas-product-512@16"];
  add("product-atlas-mirror", Boolean(product) && product.shadowedKeys.length === 4
    && product.unshadowedKeys.length === 12,
    product ? `shadowed=${product.shadowedKeys.length} unshadowed=${product.unshadowedKeys.length}`
      : "leg missing");
  const timingWobble = Object.keys(passA.legs).map((legId) => {
    const a = passA.legs[legId].gpuFrameMs, b = passB.legs[legId].gpuFrameMs;
    return { legId, a, b, deltaPct: a && b ? Math.abs(a - b) / Math.max(a, b) : null };
  });
  return { checks, gate: checks.every((check) => check.passed), timingWobble };
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "shadow-paging-gpu-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/shadowPagingQualityGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><html><head><title>Shadow paging quality GPU probe</title></head><body></body></html>`);

  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  let passes;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
        args: ["--enable-unsafe-webgpu"] });
      try {
        const pageA = await browser.newPage({ viewport: { width: 256, height: 256 } });
        const passA = await runPass(origin, pageA, "A");
        const pageB = await browser.newPage({ viewport: { width: 256, height: 256 } });
        const passB = await runPass(origin, pageB, "B");
        passes = [passA, passB];
        if (passA.errors.length === 0 && passB.errors.length === 0) break;
      } finally { await browser.close(); }
    } catch (error) {
      passes = [
        { passId: "A", adapter: {}, legs: {}, shots: {}, errors: [String(error instanceof Error ? error.message : error)] },
        { passId: "B", adapter: {}, legs: {}, shots: {}, errors: [] },
      ];
    } finally { server.close(); }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!passes) throw new Error(`Shadow paging GPU probe failed after ${maxAttempts} attempts.`);

  const [passA, passB] = passes;
  const analysis = analyse(passA, passB);
  await mkdir(outputDirectory, { recursive: true });
  const screenshotHashes = {};
  for (const [pass, suffix] of [[passA, "A"], [passB, "B"]]) {
    for (const [legId, base64] of Object.entries(pass.shots)) {
      const png = encodePng(512, 384, Buffer.from(base64, "base64"));
      const file = `scene-${legId}-${suffix}.png`;
      await writeFile(path.join(outputDirectory, file), png);
      screenshotHashes[`${file}`] = createHash("sha256").update(png).digest("hex");
    }
  }
  const pngMatch = SCREENSHOT_LEGS.map((legId) => {
    const a = screenshotHashes[`scene-${legId}-A.png`], b = screenshotHashes[`scene-${legId}-B.png`];
    return `${legId}: ${a === b ? "match" : `DIFFER ${a?.slice(0, 8)} vs ${b?.slice(0, 8)}`}`;
  });
  analysis.checks.push({ name: "reproducible-png", passed: pngMatch.every((entry) => entry.endsWith("match")),
    detail: pngMatch.join("; ") || "no screenshots" });
  analysis.gate = analysis.checks.every((check) => check.passed);

  const evidence = {
    schema: "deep-engine.f7-shadow-paging-quality-gpu", date: new Date().toISOString(),
    chrome: { path: chromePath }, adapter: passA.adapter, errors: [...passA.errors, ...passB.errors],
    legConfigs: LEG_CONFIGS, lightCounts: LIGHT_COUNTS, budgetBytes: BUDGET_BYTES,
    warmFrames: WARM_FRAMES, measureFrames: MEASURE_FRAMES, metricEpsilon: METRIC_EPSILON,
    legs: Object.fromEntries(LEG_CONFIGS.flatMap((configId) => LIGHT_COUNTS.map((lightCount) => {
      const legId = `${configId}@${lightCount}`;
      return [legId, { A: passA.legs[legId] ?? null, B: passB.legs[legId] ?? null }];
    }))),
    timingWobble: analysis.timingWobble,
    screenshotSha256: screenshotHashes,
    checks: analysis.checks, gate: analysis.gate,
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`adapter: ${JSON.stringify(passA.adapter)}`);
  const legIds = LEG_CONFIGS.flatMap((configId) => LIGHT_COUNTS.map((lightCount) => `${configId}@${lightCount}`));
  console.log("leg | cov | depthMiB | rmse | leak | edgeP50/P95 | gpuMs(A/B) | planUs");
  for (const legId of legIds) {
    const leg = passA.legs[legId];
    if (!leg) { console.log(`${legId}: MISSING`); continue; }
    console.log(`${legId} | ${leg.coverage.toFixed(2)} | ${(leg.depthBytes / 1048576).toFixed(2)}`
      + ` | ${leg.aggregate.rmse.toFixed(4)} | ${(100 * leg.aggregate.leakFraction).toFixed(1)}%`
      + ` | ${leg.aggregate.edgeWidthP50}/${leg.aggregate.edgeWidthP95}`
      + ` | ${leg.gpuFrameMs?.toFixed(3) ?? "null"}/${passB.legs[legId]?.gpuFrameMs?.toFixed(3) ?? "null"}`
      + ` | ${leg.cpuPlanUs.toFixed(1)}`);
  }
  for (const check of analysis.checks) {
    console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }
  console.log(`gate: ${analysis.gate ? "PASS" : "FAIL"} — ${path.join(outputDirectory, "evidence.json")}`);
  if (!analysis.gate) process.exitCode = 1;
}

await main();
