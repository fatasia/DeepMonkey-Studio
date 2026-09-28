import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// T10 切片1：硬件 RT 能力真机探测（headless Chrome + 真机 GPU，模式沿用 T05/T03 证据链）。
// 分层探测（能力探测不启用 RT 渲染——主计划 §T10 纪律，本脚本不做任何 RT dispatch）：
//   L1 枚举层  adapter.features.has(name)
//   L2 设备层  requestDevice({ requiredFeatures: [name] }) 不抛（未知 feature 名按规范抛 TypeError）
//   L3 API 面  device 上 RT 相关方法 typeof 检查
// 映射/决策单一来源：esbuild 打包生产 src/rayTracing/rtCapabilityProbe.ts（含 P4 合同
// resolveRayTracingDecision/validate），浏览器腿只提供原始特征名。
// 产出：机读 JSON 落盘 test-output/deep-core/T10/rt-capability-gpu-r1/rtCapability.json 与
// docs/reports/deep-core/assets/t10-rt-capability-<date>.json。
// 门禁语义：判定的是「探测完成 + 合同快照有效 + 决策与特征一致 + 不支持时软件路径决策明确」，
// 不判定「硬件必须支持 RT」——不支持设备明确软件/光栅路径本身就是 T10 验收条款。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "deep-core", "T10", "rt-capability-gpu-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.RT_CAPABILITY_PROBE_ATTEMPTS ?? 3);
const evidenceDate = new Date().toISOString().slice(0, 10);

// 页内自包含探测内核（playwright evaluate 序列化注入；不得引用外部作用域）。
function rtCapabilityPageProbe(payload) {
  const adapterLimitNames = [
    "maxTextureDimension1D", "maxTextureDimension2D", "maxTextureDimension3D",
    "maxBufferSize", "maxStorageBufferBindingSize",
    "maxComputeWorkgroupStorageSize", "maxComputeInvocationsPerWorkgroup", "maxComputeWorkgroupSizeX",
  ];
  const rtMethodNames = [
    "createRayTracingAccelerationStructure", "createAccelerationContainer",
    "createRayTracingPipeline", "createRayQuerySet",
  ];
  const describeAdapterInfo = (info) => {
    if (!info || typeof info !== "object") return null;
    const record = {};
    for (const key of ["vendor", "architecture", "device", "description"]) {
      const value = info[key];
      record[key] = typeof value === "string" ? value : "";
    }
    return record;
  };
  const surfaceProbe = (device) => {
    const surface = {};
    for (const name of rtMethodNames) surface[name] = typeof device[name] === "function";
    return surface;
  };
  return (async () => {
    const attempts = [];
    let adapter = null;
    for (const options of [{ powerPreference: "high-performance" }, {}, undefined]) {
      try {
        adapter = await navigator.gpu.requestAdapter(options);
        if (adapter) { attempts.push({ options: options ?? "default", success: true }); break; }
        attempts.push({ options: options ?? "default", success: false });
      } catch (error) {
        attempts.push({ options: options ?? "default", success: false, error: String(error?.message ?? error) });
      }
    }
    if (!adapter) return { webgpuAvailable: false, adapterAttempts: attempts };
    const featureNames = [...adapter.features].sort();
    const limits = {};
    for (const name of adapterLimitNames) limits[name] = adapter.limits[name] ?? null;
    const featureLayers = [];
    for (const name of payload.rtFeatureCandidateNames) {
      const inAdapterFeatures = adapter.features.has(name);
      let deviceRequestAccepted = false;
      let apiSurface = null;
      let error = null;
      try {
        const device = await adapter.requestDevice({ label: `rt-probe:${name}`, requiredFeatures: [name] });
        deviceRequestAccepted = true;
        apiSurface = surfaceProbe(device);
        device.destroy?.();
      } catch (requestError) {
        error = String(requestError?.message ?? requestError);
      }
      featureLayers.push({ featureName: name, inAdapterFeatures, deviceRequestAccepted, apiSurface, error });
    }
    // 基线设备（不带 RT 特征）的 API 面与默认 limit——区分「API 面存在但特征未开」与「根本没有该 API」。
    const baselineDevice = await adapter.requestDevice({ label: "rt-probe:baseline" });
    const baselineApiSurface = surfaceProbe(baselineDevice);
    const baselineLimits = {};
    for (const name of adapterLimitNames) baselineLimits[name] = baselineDevice.limits[name] ?? null;
    baselineDevice.destroy?.();
    return {
      webgpuAvailable: true,
      adapterAttempts: attempts,
      adapterInfo: describeAdapterInfo(adapter.info),
      isFallbackAdapter: adapter.isFallbackAdapter === true,
      featureNames,
      limits,
      baselineApiSurface,
      featureLayers,
    };
  })();
}

async function main() {
  // 生产映射层 bundle（Node 侧单一来源；不含 GPU 依赖）。
  const bundleDirectory = await mkdtempSafe();
  const bundlePath = path.join(bundleDirectory, "rtCapabilityProbe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["src/rayTracing/rtCapabilityProbe.ts"],
    bundle: true, format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const probeModule = await import(pathToFileURL(bundlePath));

  const { server, origin } = await startServer();
  let leg;
  try {
    leg = await runInBrowser(origin, { rtFeatureCandidateNames: [...probeModule.ALL_RT_FEATURE_CANDIDATE_NAMES] });
  } finally {
    server.close();
  }
  await rmSafe(bundleDirectory);

  const mapped = mapProbeLeg(probeModule, leg);
  const evidence = buildEvidence(probeModule, leg, mapped);
  await mkdir(outputDirectory, { recursive: true });
  const evidencePath = path.join(outputDirectory, "rtCapability.json");
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  const assetPath = path.join(repoRoot, "docs", "reports", "deep-core", "assets", `t10-rt-capability-${evidenceDate}.json`);
  await writeFile(assetPath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({
    webgpuAvailable: evidence.webgpu.legAvailable,
    adapter: evidence.webgpu.adapterInfo,
    rtFeatureNames: evidence.webgpu.featureNames.filter((name) => name.includes("ray") || name.includes("rt")),
    fullFeatureCount: evidence.webgpu.featureNames.length,
    capabilities: mapped.snapshot.capabilities,
    decision: mapped.t10.decision,
    softwarePathRequired: mapped.t10.softwarePathRequired,
    toleranceComparison: evidence.toleranceComparison,
    gate: evidence.verdict.passed,
    evidencePath, assetPath,
  }, null, 2));
  if (!evidence.verdict.passed) process.exitCode = 1;
}

function mapProbeLeg(probeModule, leg) {
  const featureNames = leg.webgpuAvailable ? leg.featureNames : [];
  const snapshot = probeModule.buildRayTracingCapabilitiesSnapshot({
    adapterId: adapterId(leg), featureNames });
  const t10 = probeModule.resolveT10PathDecision(snapshot.capabilities, "pipeline");
  return { snapshot, t10 };
}

function adapterId(leg) {
  if (!leg.webgpuAvailable) return "no-webgpu-adapter";
  const info = leg.adapterInfo ?? {};
  return [info.vendor, info.architecture, info.device].filter((part) => part && part.length > 0).join("-")
    || "unnamed-adapter";
}

function buildEvidence(probeModule, leg, mapped) {
  const { snapshot, t10 } = mapped;
  // 软↔硬容差对照：硬件 RT 特征未暴露（decision 关闭）→ 本切片如实标 unmeasured；
  // 若未来设备暴露特征，本切片也未实现硬件对拍腿 → "not-instrumented-in-this-slice"，不虚报。
  const toleranceComparison = !t10.decision.enabled
    ? { status: "unmeasured",
      reason: "当前 wgpu 路径（本机 Chrome/Dawn）未暴露任何 RT 候选特征，硬件命中无从取得；软件参考（bvhBuilder/rayTrace）为唯一仲裁基准，其确定性边界语义见 rtReferenceSemantics.test.ts。" }
    : { status: "not-instrumented-in-this-slice",
      reason: "硬件 RT 特征可用，但本切片未实现硬件对拍腿（能力探测切片不做 RT 渲染）；对拍留在后续切片。" };
  const checks = {
    contractValid: snapshot.contractValid === true,
    tierConsistentWithFeatures: snapshot.tierDerived === snapshot.capabilities.tier,
    decisionExplicit: t10.decision.enabled === false
      ? JSON.stringify([...t10.decision.fallbacks]) === JSON.stringify(["raster", "software-gi", "software-shadows"])
      : t10.decision.fallbacks.length === 0 || t10.decision.reason !== null,
    noProbeFatal: (leg.errors ?? []).length === 0,
  };
  return {
    schema: "t10-rt-capability-evidence-v1",
    createdAt: new Date().toISOString(),
    lane: "t10-rt-capability-real-gpu",
    method: "分层能力探测（枚举/设备请求/API 面）× 生产映射层 buildRayTracingCapabilitiesSnapshot/resolveT10PathDecision；能力探测不启用 RT 渲染，无任何 dispatch",
    webgpu: {
      legAvailable: leg.webgpuAvailable === true,
      chromeVersion: leg.browserVersion ?? null,
      userAgent: leg.userAgent ?? null,
      adapterInfo: leg.adapterInfo ?? null,
      isFallbackAdapter: leg.isFallbackAdapter ?? null,
      adapterAttempts: leg.adapterAttempts ?? [],
      featureNames: leg.featureNames ?? [],
      limits: leg.limits ?? null,
      baselineApiSurface: leg.baselineApiSurface ?? null,
      featureLayers: leg.featureLayers ?? [],
      featureListSha256: sha256Text(JSON.stringify(leg.featureNames ?? [])),
    },
    capabilities: snapshot.capabilities,
    capabilitiesSupport: snapshot.support,
    tierDerived: snapshot.tierDerived,
    t10Decision: { ...t10.decision, softwarePathRequired: t10.softwarePathRequired },
    toleranceComparison,
    nativeDxrLeg: {
      status: "not-run-in-this-slice",
      note: "native ray_tracing_capability.rs（D3D12_OPTIONS5）为独立桌面探针，本切片不构建 native 腿；其结果不启用 RT 渲染（探针纪律）。",
    },
    verdict: { checks, passed: Object.values(checks).every(Boolean) },
  };
}

async function runInBrowser(origin, payload) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage();
    await page.goto(origin, { waitUntil: "load" });
    const result = await page.evaluate(rtCapabilityPageProbe, payload);
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    result.errors = [];
    return result;
  } catch (error) {
    return { webgpuAvailable: false, errors: [String(error instanceof Error ? error.message : error)] };
  } finally {
    await browser.close();
  }
}

async function startServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      .end("<!doctype html><title>T10 RT capability probe</title>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function mkdtempSafe() {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(tmpdir(), "rt-capability-"));
}

async function rmSafe(directory) {
  const { rm } = await import("node:fs/promises");
  await rm(directory, { recursive: true, force: true });
}

const invokedDirectly = process.argv[1] !== undefined &&
  pathToFileURL(process.argv[1]).href === import.meta.url;
if (invokedDirectly) await main();
