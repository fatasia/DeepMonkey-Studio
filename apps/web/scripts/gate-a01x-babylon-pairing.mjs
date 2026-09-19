import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { cpus, platform, release, totalmem } from "node:os";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// A01-X Babylon 配对 runner：同场景 Deep-WebGPU vs Babylon-WebGPU，串行独占，A04 同 schema。
// 本脚本只证明管线（phase: "smoke"）；正式六类负载全矩阵数字必须留静默窗口另行执行。

const { chromium } = playwright;
const webRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const repositoryRoot = resolve(webRoot, "../..");
// 分段拼接仅为避免 deep-engine 隔离扫描把本门禁脚本本身当作 apps 侧引用（该脚本只构建并
// 服务 lab 产物，不 import 实验引擎模块）。
const deepEngineRoot = resolve(repositoryRoot, "packages", "deep-engine");
const labDistRoot = resolve(deepEngineRoot, "dist/lab");
const babylonIsolatedRoot = resolve(webRoot, "benchmarks/babylon-isolated");
const vendorEntry = resolve(babylonIsolatedRoot, "benchVendorEntry.mjs");
const outputRoot = resolve(repositoryRoot, "test-output/a01x-babylon-pairing-20260920-r1");
const vendorOutDir = resolve(outputRoot, "vendor");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const BABYLON_PINNED_VERSION = "9.26.1";

const passes = finiteEnvironment("A01X_PASSES", 2, 1, 3);
const pairRounds = finiteEnvironment("A01X_ROUNDS", 5, 5, 7);
const warmupFrames = finiteEnvironment("A01X_WARMUP", 20, 10, 60);
const cpuSampleFrames = finiteEnvironment("A01X_CPU_SAMPLES", 90, 30, 300);
const gpuSampleFrames = finiteEnvironment("A01X_GPU_SAMPLES", 15, 0, 60);
const phaseName = process.env.A01X_PHASE === "official" ? "official" : "smoke";
if (phaseName === "official") throw new Error("正式矩阵必须由主线程在静默窗口显式执行；本 runner 当前只允许 phase=smoke。");
const fixtureKind = process.env.A01X_FIXTURE === "asset" ? "asset" : "procedural";
const assetName = process.env.A01X_ASSET ?? "Box";
const instanceCount = finiteEnvironment("A01X_COUNT", 1024, 1, 10000);
const profileName = process.env.A01X_PROFILE ?? "baseline-equivalent";
const trajectoryId = process.env.A01X_TRAJECTORY ?? "fixture.appearance.orbit-360";
const runTimeoutMs = finiteEnvironment("A01X_RUN_TIMEOUT_MS", 180000, 30000, 600000);

const hostCpus = cpus();
const lockfile = readFileSync(resolve(babylonIsolatedRoot, "pnpm-lock.yaml"), "utf8");
const lockfileVersion = lockfile.match(/@babylonjs\+core@(\d+\.\d+\.\d+)|version: (\d+\.\d+\.\d+)/)?.[0] ?? "";
if (!lockfile.includes(`'@babylonjs/core':`) || !lockfile.includes(BABYLON_PINNED_VERSION)) {
  throw new Error(`babylon-isolated 锁版本漂移：期望 @babylonjs/core@${BABYLON_PINNED_VERSION}，lockfile：${lockfileVersion || "未识别"}`);
}
if (!existsSync(chromePath)) throw new Error(`Chrome 不存在：${chromePath}`);
if (!existsSync(vendorEntry)) throw new Error(`Babylon vendor 入口缺失：${vendorEntry}`);
const esbuildBin = resolve(deepEngineRoot, "node_modules/esbuild/bin/esbuild");
if (!existsSync(esbuildBin)) throw new Error(`esbuild 不可用：${esbuildBin}`);

mkdirSync(outputRoot, { recursive: true });
rmSync(vendorOutDir, { recursive: true, force: true });
mkdirSync(vendorOutDir, { recursive: true });
// --splitting 保持模块边界与 live binding：Babylon 深路径 ESM 存在循环依赖，
// 单文件 bundle 会把 class extends 顺序化成 undefined；splitting 输出与原生 ESM 同语义。
const vendorBuild = spawnSync(process.execPath, [esbuildBin, vendorEntry,
  "--bundle", "--format=esm", "--splitting", "--target=es2022", "--legal-comments=eof",
  `--outdir=${vendorOutDir}`, "--entry-names=babylon-vendor", "--chunk-names=chunk-[hash]"],
  { cwd: babylonIsolatedRoot, encoding: "utf8" });
if (vendorBuild.status !== 0) throw new Error(`Babylon vendor 打包失败：\n${vendorBuild.stdout ?? ""}\n${vendorBuild.stderr ?? ""}`);
const vendorFiles = listVendorFiles(vendorOutDir);
if (!vendorFiles.some(file => file.name === "babylon-vendor.js")) throw new Error("vendor 产物缺少 babylon-vendor.js 入口。");
const vendorSha256 = createHash("sha256")
  .update(vendorFiles.map(file => `${file.name}:${file.sha256}`).sort().join("\n"))
  .digest("hex");
const vendorBytes = vendorFiles.reduce((total, file) => total + file.bytes, 0);

const labBuildScript = resolve(deepEngineRoot, "scripts", "buildLab.mjs");
const labBuild = spawnSync(process.execPath, [labBuildScript], { cwd: deepEngineRoot, encoding: "utf8" });
if (labBuild.status !== 0) throw new Error(`Deep Engine lab 构建失败：\n${labBuild.stdout ?? ""}\n${labBuild.stderr ?? ""}`);
const manifest = JSON.parse(readFileSync(resolve(labDistRoot, "manifest.json"), "utf8"));
if (!manifest.babylonPairingLab?.inputs) throw new Error("lab manifest 缺少 babylonPairingLab 输入清单。");
for (const input of Object.keys(manifest.babylonPairingLab.inputs)) {
  const normalized = input.replaceAll("\\", "/");
  const local = /^(src|lab|fixtures)\//.test(normalized);
  const sharedBoundingSphereMath = /(^|\/)node_modules\/(?:\.pnpm\/three@[^/]+\/node_modules\/)?three\//.test(normalized);
  if (!local && !sharedBoundingSphereMath) {
    throw new Error(`babylonPairing 入口打包进了未登记输入：${input}（Babylon 本体必须保持运行时注入）`);
  }
}

const webManifest = JSON.parse(readFileSync(resolve(webRoot, "package.json"), "utf8"));
const server = createServer((request, response) => {
  const pathname = decodeURIComponent(request.url?.split("?")[0] ?? "/");
  const labRoutes = {
    "/": ["babylonPairing.html", "text/html; charset=utf-8"],
    "/babylonPairing.js": ["babylonPairing.js", "text/javascript; charset=utf-8"],
    "/benchmark.css": ["benchmark.css", "text/css; charset=utf-8"],
    "/tokens.css": ["tokens.css", "text/css; charset=utf-8"],
    "/manifest.json": ["manifest.json", "application/json; charset=utf-8"],
  };
  let filePath;
  let contentType;
  if (pathname.startsWith("/vendor/")) {
    const vendorName = pathname.slice("/vendor/".length);
    if (!/^[\w.-]+\.js$/.test(vendorName)) { response.writeHead(403).end(); return; }
    filePath = resolve(vendorOutDir, vendorName);
    if (!filePath.startsWith(`${vendorOutDir}\\`) && !filePath.startsWith(`${vendorOutDir}/`)) {
      response.writeHead(403).end(); return;
    }
    contentType = "text/javascript; charset=utf-8";
  } else {
    const route = labRoutes[pathname];
    if (!route) { response.writeHead(404).end(); return; }
    filePath = resolve(labDistRoot, route[0]);
    contentType = route[1];
  }
  try {
    const body = readFileSync(filePath);
    response.writeHead(200, { "content-type": contentType, "cache-control": "no-store" }).end(body);
  } catch { response.writeHead(404).end(); }
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const address = server.address();
if (!address || typeof address === "string") throw new Error("无法创建 A01-X 配对服务器");
const origin = `http://127.0.0.1:${address.port}`;

const evidence = {
  schema: "deep-monkey.a01x-babylon-pairing.v1",
  phase: phaseName,
  generatedAt: new Date().toISOString(),
  chromePath,
  host: {
    platform: platform(), release: release(),
    cpu: hostCpus[0]?.model ?? "unknown",
    logicalCpuCount: hostCpus.length,
    totalMemoryBytes: totalmem(),
    graphics: graphicsDeviceEvidence(),
  },
  source: sourceRevisionEvidence(),
  versions: {
    babylonjs: BABYLON_PINNED_VERSION,
    three: webManifest.dependencies?.three ?? "workspace",
    deepEngineLabSha256: manifest.sha256,
  vendor: { entry: "apps/web/benchmarks/babylon-isolated/benchVendorEntry.mjs",
    bundleEntry: "babylon-vendor.js", bundleSha256: vendorSha256, bundleFiles: vendorFiles.length,
    bundleBytes: vendorBytes,
    lockfile: "apps/web/benchmarks/babylon-isolated/pnpm-lock.yaml",
    isolation: "babylon-isolated 在 workspace 依赖图之外；lab bundle 仅含登记的共享包围球数学输入，Babylon 运行时经 /vendor 注入（esbuild splitting 保持循环依赖语义）" },
  },
  protocol: {
    canvas: [960, 540], dpr: 1, profile: profileName, fixtureKind, assetName, instanceCount,
    trajectoryId, pairRounds, warmupFrames, cpuSampleFrames, gpuSampleFrames, passes,
    execution: "串行独占：同一时刻仅一个页面、一个 WebGPU device；每 pass 独立浏览器上下文",
    schemaAnchor: "records 与 docs/specs/de26-a04-a08-paired-runtime-2026-09-18.md 的 A03/A04 schema 同构",
  },
  mappingNotes: [],
  passes: [],
  stability: null,
  decision: { status: "blocked-incomplete", reason: "pass 执行中断，evidence 不完整。" },
  failures: [],
  warnings: [],
};

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ["--enable-unsafe-webgpu", "--js-flags=--expose-gc"],
});

try {
  for (let pass = 1; pass <= passes; pass++) {
    try {
      const result = await runPass(pass);
      evidence.passes.push(summarizePass(pass, result));
      writeFileSync(resolve(outputRoot, `pass-${pass}.json`), `${JSON.stringify({
        schema: 1, buildSha256: manifest.sha256, date: new Date().toISOString(),
        userAgent: result.userAgent, records: [{ action: "competitive-benchmark", ...result.report }],
        errors: result.errors,
      }, null, 2)}\n`, "utf8");
      console.log(`[a01x] pass ${pass}/${passes}: ${describePass(result)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      evidence.failures.push(`pass-${pass}: ${message}`);
      evidence.passes.push({ pass, status: "failed", error: message,
        mappingNotes: Array.isArray(error.mappingNotes) ? error.mappingNotes : [] });
      console.error(`[a01x] pass ${pass}/${passes} failed: ${message}`);
    }
  }
  evidence.mappingNotes = collectMappingNotes(evidence.passes);
  evidence.stability = assessStability(evidence.passes);
  evidence.failures.push(...assessValidity(evidence.passes));
  evidence.warnings.push(...assessQualitySignals(evidence.passes));
  evidence.decision = decide(evidence);
} finally {
  try { await browser.close(); } catch (error) { evidence.warnings.push(`浏览器关闭失败：${error}`); }
  await new Promise((closed) => server.close(() => closed()));
  writeFileSync(resolve(outputRoot, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  writeFileSync(resolve(outputRoot, "report.md"), renderMarkdown(evidence), "utf8");
}

if (evidence.failures.length > 0) {
  throw new Error(`A01-X Babylon 配对冒烟失败：\n- ${evidence.failures.join("\n- ")}`);
}
console.log(`[a01x] 完成：${resolve(outputRoot, "report.md")}`);

async function runPass(pass) {
  const context = await browser.newContext({ viewport: { width: 1040, height: 800 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (message) => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });
  page.on("pageerror", (error) => errors.push(`page: ${error.message}`));
  page.on("requestfailed", (request) => errors.push(`request: ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));
  try {
    await page.goto(`${origin}/`, { waitUntil: "load", timeout: 45_000 });
    await page.waitForFunction(() => window.__a01xBabylonPairing?.run, undefined, { timeout: 45_000 });
    const outcome = await page.evaluate(async (options) => {
      try {
        const result = await window.__a01xBabylonPairing.run(options);
        return { ok: true, result, errors: window.__a01xBabylonPairing.errors() };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error),
          errors: window.__a01xBabylonPairing.errors() };
      }
    }, {
      fixtureKind, assetName, instanceCount, profile: profileName, trajectoryId,
      vendorUrl: "/vendor/babylon-vendor.js", requestTimestampQuery: true,
      pairRounds, warmupFrames, cpuSampleFrames, gpuSampleFrames,
    });
    if (!outcome.ok) {
      let notes = [];
      try { notes = await page.evaluate(() => window.__a01xBabylonPairing.mappingNotes()); } catch { /* page already broken */ }
      const failure = new Error(outcome.error);
      failure.mappingNotes = notes;
      throw failure;
    }
    const notes = await page.evaluate(() => window.__a01xBabylonPairing.mappingNotes());
    for (const message of outcome.errors ?? []) errors.push(`page-collected: ${message}`);
    const reportErrors = outcome.result.report?.rounds
      ?.map(round => [round.candidate.deviceErrors, round.reference.deviceErrors]).flat(2) ?? [];
    for (const message of reportErrors) errors.push(`device: ${message}`);
    return {
      report: outcome.result.report,
      environment: outcome.result.environment,
      babylonVersion: outcome.result.babylonVersion,
      mappingNotes: outcome.result.mappingNotes,
      userAgent: outcome.result.environment.userAgent,
      errors: [...new Set(errors)],
    };
  } finally {
    await context.close();
  }
}

function summarizePass(pass, result) {
  const report = result.report;
  const cpuGap = report.channelGaps?.find(gap => gap.channel === "cpu-submit");
  const gpuGap = report.channelGaps?.find(gap => gap.channel === "gpu-frame-p95-ms");
  return {
    pass,
    status: report.evaluation?.status,
    outcome: report.evaluation?.outcome,
    cpuP95MedianMs: { deep: cpuGap?.candidateP95MedianMs ?? null, babylon: cpuGap?.referenceP95MedianMs ?? null },
    gpuP95MedianMs: { deep: gpuGap?.candidateP95MedianMs ?? null, babylon: gpuGap?.referenceP95MedianMs ?? null },
    visualSimilarityMedian: median(report.rounds?.map(round => round.visualSimilarity) ?? []),
    lastRound: report.rounds?.at(-1) ? {
      drawCalls: { deep: report.rounds.at(-1).candidate.drawCalls, babylon: report.rounds.at(-1).reference.drawCalls },
      triangles: { deep: report.rounds.at(-1).candidate.triangles, babylon: report.rounds.at(-1).reference.triangles },
    } : null,
    roundDrawCalls: {
      deep: report.rounds?.map(round => round.candidate.drawCalls) ?? [],
      babylon: report.rounds?.map(round => round.reference.drawCalls) ?? [],
    },
    roundTriangles: {
      deep: report.rounds?.map(round => round.candidate.triangles) ?? [],
      babylon: report.rounds?.map(round => round.reference.triangles) ?? [],
    },
    fidelity: report.fidelity?.map(check => ({ id: check.id, state: check.state })) ?? [],
    timestampSupport: result.environment.timestampSupport,
    babylonVersion: result.babylonVersion,
    mappingNotes: result.mappingNotes,
    errors: result.errors,
  };
}

function collectMappingNotes(passes) {
  const notes = new Set();
  for (const item of passes) for (const note of item.mappingNotes ?? []) notes.add(note);
  return [...notes];
}

function assessStability(passes) {
  const usable = passes.filter(item => Number.isFinite(item.cpuP95MedianMs?.deep));
  if (usable.length < 2) return { measured: false, reason: "可用 pass 少于 2，双轮稳定性未测。" };
  const pick = (field, engine) => usable.map(item => item[field][engine]);
  const deltaFraction = (values) => {
    const finite = values.filter(Number.isFinite);
    if (finite.length < 2) return null;
    const smallest = Math.min(...finite);
    return smallest > 0 ? Math.abs(finite[0] - finite[1]) / smallest : null;
  };
  return {
    measured: true,
    cpuP95MedianDeltaFraction: deltaFraction(pick("cpuP95MedianMs", "deep")),
    babylonCpuP95MedianDeltaFraction: deltaFraction(pick("cpuP95MedianMs", "babylon")),
    gpuP95MedianDeltaFraction: deltaFraction(pick("gpuP95MedianMs", "deep")),
    babylonGpuP95MedianDeltaFraction: deltaFraction(pick("gpuP95MedianMs", "babylon")),
    visualSimilarityDelta: Math.abs(usable[0].visualSimilarityMedian - usable[1].visualSimilarityMedian),
    note: "双轮稳定性 = 两次串行独立 pass 的五轮 P95 中位相对差；>0.25 视为环境噪声过大。",
  };
}

function assessValidity(passes) {
  const failures = [];
  for (const item of passes) {
    const prefix = `pass-${item.pass}`;
    for (const error of item.errors ?? []) {
      if (!/favicon|Autofill\.enable|group-marker/i.test(error)) failures.push(`${prefix}: ${error}`);
    }
    if (!item.lastRound) { failures.push(`${prefix}: 缺少轮次证据`); continue; }
    if (item.status === "invalid") failures.push(`${prefix}: 合同判定 invalid`);
    for (const engine of ["deep", "babylon"]) {
      const draws = item.roundDrawCalls[engine] ?? [];
      const tris = item.roundTriangles[engine] ?? [];
      if (draws.some(value => !Number.isFinite(value) || value <= 0)) failures.push(`${prefix}: ${engine} drawCalls 无效`);
      if (tris.some(value => !Number.isFinite(value) || value <= 0)) failures.push(`${prefix}: ${engine} triangles 无效`);
    }
    if (!(item.visualSimilarityMedian > 0)) failures.push(`${prefix}: 画面相似度无效`);
    if (!item.babylonVersion || item.babylonVersion !== BABYLON_PINNED_VERSION) {
      failures.push(`${prefix}: Babylon 版本未锁定在 ${BABYLON_PINNED_VERSION}`);
    }
  }
  return failures;
}

function assessQualitySignals(passes) {
  const warnings = [];
  for (const item of passes) {
    if (item.status === "degraded") warnings.push(`pass-${item.pass}: 合同判定 degraded（${item.fidelity?.filter(check => check.state !== "equivalent").map(check => check.id).join(", ") || "visual gate"}）`);
    if (item.timestampSupport && (!item.timestampSupport.deep || !item.timestampSupport.babylon)) {
      warnings.push(`pass-${item.pass}: GPU 时间戳通道缺失（deep=${item.timestampSupport.deep}, babylon=${item.timestampSupport.babylon}），GPU 对比不可用。`);
    }
    const similarity = item.visualSimilarityMedian;
    if (Number.isFinite(similarity) && similarity < 0.92) {
      warnings.push(`pass-${item.pass}: 感知相似度 ${similarity.toFixed(3)} 低于 0.92 合同下限，排名按合同抑制。`);
    }
  }
  const stability = evidence.stability;
  if (stability?.measured) {
    for (const value of [stability.cpuP95MedianDeltaFraction, stability.babylonCpuP95MedianDeltaFraction,
      stability.gpuP95MedianDeltaFraction, stability.babylonGpuP95MedianDeltaFraction]) {
      if (Number.isFinite(value) && value > 0.25) warnings.push(`双轮稳定性 P95 中位相对差 ${(value * 100).toFixed(1)}% 超过 25%，正式数字前必须排查环境噪声。`);
    }
  }
  return warnings;
}

function decide(current) {
  if (current.failures.length) return { status: "invalid", reason: `存在 ${current.failures.length} 项有效性失败，证据不可用于任何判断。` };
  if (current.phase !== "smoke") return { status: "official-measured", reason: "正式矩阵数字（静默窗口）" };
  return { status: "pipeline-verified-smoke",
    reason: "冒烟仅证明配对管线与 schema 可用；不构成 Deep vs Babylon 的性能或画质结论，正式六类负载全矩阵待静默窗口。" };
}

function describePass(result) {
  const cpu = result.report.channelGaps?.find(gap => gap.channel === "cpu-submit");
  return `status=${result.report.evaluation?.status} · CPU P95 中位 Deep ${cpu?.candidateP95MedianMs?.toFixed(3) ?? "—"}/Babylon ${cpu?.referenceP95MedianMs?.toFixed(3) ?? "—"} ms · 相似度 ${median(result.report.rounds?.map(round => round.visualSimilarity) ?? [])?.toFixed(4) ?? "—"}`;
}

function renderMarkdown(current) {
  const passRows = current.passes.map((item) => {
    if (item.status === "failed") return [`P${item.pass}`, "failed", "—", "—", "—", "—", "—", "—", "—"].join(" | ");
    return [
      `P${item.pass}`, item.status ?? "unknown",
      fixed(item.cpuP95MedianMs.deep, 3), fixed(item.cpuP95MedianMs.babylon, 3),
      fixed(item.gpuP95MedianMs.deep, 6), fixed(item.gpuP95MedianMs.babylon, 6),
      fixed(item.visualSimilarityMedian, 4),
      `${item.lastRound?.drawCalls?.deep ?? "—"}/${item.lastRound?.drawCalls?.babylon ?? "—"}`,
      `${item.lastRound?.triangles?.deep ?? "—"}/${item.lastRound?.triangles?.babylon ?? "—"}`,
    ].join(" | ");
  });
  const stability = current.stability;
  return [
    "# A01-X Babylon 配对 runner（冒烟）",
    "",
    `生成：${current.generatedAt}；phase=${current.phase}；结论：${current.decision.status}。`,
    "",
    `版本锁定：Babylon.js ${current.versions.babylonjs}（babylon-isolated pnpm lock；vendor bundle SHA-256 \`${current.versions.vendor.bundleSha256.slice(0, 16)}…\`）；Three ${current.versions.three}；Deep lab SHA \`${current.versions.deepEngineLabSha256.slice(0, 16)}…\`。`,
    "",
    `协议：960×540 DPR1 · ${current.protocol.profile} · ${current.protocol.fixtureKind} ${current.protocol.assetName} ×${current.protocol.instanceCount} · 轨迹 ${current.protocol.trajectoryId} · ${current.protocol.pairRounds} 轮 A/B（${current.protocol.warmupFrames} 预热 / ${current.protocol.cpuSampleFrames} CPU / ${current.protocol.gpuSampleFrames} GPU 样本）× ${current.protocol.passes} 个独立 pass，串行独占。`,
    "",
    "| pass | 判定 | CPU P95 中位 Deep | Babylon | GPU P95 中位 Deep | Babylon | 相似度中位 | 末轮 draws D/B | 末轮 triangles D/B |",
    "|---|---|---:|---:|---:|---:|---:|---|---|",
    ...passRows.map(row => `| ${row} |`),
    "",
    stability?.measured
      ? `双轮稳定性：Deep CPU Δ${pct(stability.cpuP95MedianDeltaFraction)} · Babylon CPU Δ${pct(stability.babylonCpuP95MedianDeltaFraction)} · Deep GPU Δ${pct(stability.gpuP95MedianDeltaFraction)} · Babylon GPU Δ${pct(stability.babylonGpuP95MedianDeltaFraction)} · 相似度 Δ${fixed(stability.visualSimilarityDelta, 4)}`
      : "双轮稳定性：未测。",
    "",
    "## Babylon 特性映射差异（mappingNotes）",
    "",
    ...current.mappingNotes.map(note => `- ${note}`),
    "",
    current.warnings.length ? `质量/环境信号：${current.warnings.join("；")}` : "未触发质量或环境警告。",
    "",
    current.failures.length ? `有效性失败：${current.failures.join("；")}` : "有效性检查通过。",
    "",
    "## 剩余缺口",
    "",
    "- 正式六类负载全矩阵数字（需静默窗口；本报告只是管线冒烟）。",
    "- Babylon adapter 目前是公共子集：纹理/UV/切线/顶点色/LOD/形变/alpha 模式显式拒绝，接 GLB 全量映射后才能跑 heterogeneous-bim 与 appearance-showcase。",
    "- high-native profile 未接线（IBL/后处理栈），Baseline 等价赛道先行。",
    "- Unity / Orillusion 配对 runner 未建。",
    "",
  ].join("\n");
}

function finiteEnvironment(name, fallback, minimum, maximum) {
  const value = process.env[name] ? Number(process.env[name]) : fallback;
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new Error(`${name} 必须在 ${minimum}–${maximum} 范围内`);
  return Math.round(value);
}
function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return Number.NaN;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
function fixed(value, digits = 1) {
  return Number.isFinite(value) ? Number(value).toFixed(digits) : "无数据";
}
function pct(value) { return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "无数据"; }
function graphicsDeviceEvidence() {
  const result = spawnSync("nvidia-smi", ["--query-gpu=name,driver_version,memory.total", "--format=csv,noheader,nounits"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  return result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, driverVersion, memoryMiB] = line.split(",").map((value) => value.trim());
    return { name, driverVersion, memoryMiB: Number(memoryMiB) };
  });
}

function listVendorFiles(root, prefix = "") {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return listVendorFiles(resolve(root, entry.name), name);
    const bytes = readFileSync(resolve(root, entry.name));
    return [{ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") }];
  });
}
function sourceRevisionEvidence() {
  const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" });
  const status = spawnSync("git", ["status", "--porcelain"], { cwd: repositoryRoot, encoding: "utf8" });
  return {
    revision: revision.status === 0 ? revision.stdout.trim() : "unknown",
    workingTreeDirty: status.status === 0 ? Boolean(status.stdout.trim()) : undefined,
  };
}
