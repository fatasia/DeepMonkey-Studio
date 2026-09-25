import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// R4 生产 HiZ 接线真机对拍 runner（R4 前置切片,接续 docs/development.md §7 路线 2）。
// golden 手写 reduce WGSL（迁移前原文）与 DCIR 生产内核在同一 headless Chrome 内、同输入、同金字塔
// 尺寸下逐级对拍；GLSL 降级（WebGL2/ANGLE）按 R2 合同验证第一档；timestamp 记账新旧路径 GPU 时间。
// 证据写入 test-output/r4-hiz-wiring-20260919-r1/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "r4-hiz-wiring-20260919-r1");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.R4_GPU_TEST_ATTEMPTS ?? 3);

// captureOutputs=false 的 case 只计时不回读输出（体积原因），不参与逐位门。
const CASES = [
  { name: "even-64x64-min", seed: 0x5eed_00a1, width: 64, height: 64, reduceMax: false, flavor: "sentinel", tier: "bitwise", perfRepeats: 0, perfSamples: 0 },
  { name: "even-16x16-max", seed: 0x5eed_00a2, width: 16, height: 16, reduceMax: true, flavor: "sentinel", tier: "bitwise", perfRepeats: 0, perfSamples: 0 },
  { name: "npot-37x23-max", seed: 0x5eed_00a3, width: 37, height: 23, reduceMax: true, flavor: "sentinel", tier: "bitwise", perfRepeats: 0, perfSamples: 0 },
  { name: "npot-13x7-min", seed: 0x5eed_00a4, width: 13, height: 7, reduceMax: false, flavor: "depthlike", tier: "bitwise", perfRepeats: 0, perfSamples: 0 },
  { name: "mixed-48x37-max", seed: 0x5eed_00a5, width: 48, height: 37, reduceMax: true, flavor: "sentinel", tier: "bitwise", perfRepeats: 0, perfSamples: 0 },
  { name: "tiny-2x1-min", seed: 0x5eed_00a6, width: 2, height: 1, reduceMax: false, flavor: "sentinel", tier: "bitwise", perfRepeats: 0, perfSamples: 0 },
  { name: "tiny-1x1-min", seed: 0x5eed_00a7, width: 1, height: 1, reduceMax: false, flavor: "sentinel", tier: "bitwise", perfRepeats: 0, perfSamples: 0 },
  { name: "perf-512x512-max", seed: 0x5eed_00a8, width: 512, height: 512, reduceMax: true, flavor: "depthlike", tier: "bitwise", perfRepeats: 24, perfSamples: 5 },
  { name: "perf-odd-639x479-min", seed: 0x5eed_00a9, width: 639, height: 479, reduceMax: false, flavor: "depthlike", tier: "bitwise", perfRepeats: 16, perfSamples: 5 },
  { name: "denormal-17x9-min", seed: 0x5eed_00aa, width: 17, height: 9, reduceMax: false, flavor: "denormal", tier: "denormal-probe", perfRepeats: 0, perfSamples: 0 },
];

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const base64ToBytes = (value) => Uint8Array.from(Buffer.from(value, "base64"));

/** f32 位型的单调键（±0 视为相等）；NaN 不参与（确定性合同禁止 NaN 进入逐位档）。 */
function orderedKey(bits) {
  if (bits === 0x8000_0000) return 1;
  const magnitude = bits & 0x7fff_ffff;
  return (bits >>> 31) === 0 ? magnitude + 1 : -(magnitude + 1);
}

/** 逐位 + ±0 折叠双档比较；foldedOnly 记录仅 ±0 位型差异（DCIR canonicalize 折叠所致）的格数。 */
function compareOutputs(a, b) {
  const bitsA = new Uint32Array(a.buffer), bitsB = new Uint32Array(b.buffer);
  let mismatches = 0, foldedMismatches = 0, zeroFoldCells = 0, maxAbs = 0, maxUlp = 0;
  const absDiff = (x, y) => (Number.isFinite(x) && Number.isFinite(y)) ? Math.abs(x - y) : (x === y ? 0 : Infinity);
  for (let index = 0; index < bitsA.length; index++) {
    const valueA = a[index], valueB = b[index];
    maxAbs = Math.max(maxAbs, absDiff(valueA, valueB));
    maxUlp = Math.max(maxUlp, Math.abs(orderedKey(bitsA[index]) - orderedKey(bitsB[index])));
    if (bitsA[index] !== bitsB[index]) {
      mismatches++;
      const isZeroPair = (bitsA[index] & 0x7fff_ffff) === 0 && (bitsB[index] & 0x7fff_ffff) === 0;
      if (isZeroPair) zeroFoldCells++; else foldedMismatches++;
    }
  }
  return { bitwiseEqual: mismatches === 0, foldedEqual: foldedMismatches === 0,
    mismatchCells: mismatches, zeroFoldCells, nonZeroMismatchCells: foldedMismatches,
    maxAbsDiff: maxAbs, maxUlpDiff: maxUlp };
}

function buildCaseInput(entry, generateHiZInput) {
  const input = generateHiZInput(entry.seed, entry.width, entry.height,
    entry.flavor === "denormal" ? { denormal: true } : {});
  if (entry.flavor === "depthlike") {
    // 覆写 generateHiZInput 注入的 ±0/inf 哨兵（索引 0..7），得到无 -0/inf 的深度式输入：
    // 此时 old/new 差异应严格为 0（连 ±0 折叠差异都不允许），构成最严逐位门。
    const benign = [0.05, 0.15, 0.25, 0.35, 0.45, 0.55, 0.65, 0.75];
    for (let index = 0; index < Math.min(8, input.length); index++) input[index] = benign[index];
  }
  return input;
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

async function runInBrowser(origin, requests) {
  const require = createRequire(import.meta.url);
  const playwright = require("../../../apps/cloud-render-worker/node_modules/playwright-core/index.js");
  const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
    args: ["--enable-unsafe-webgpu"] });
  try {
    const page = await browser.newPage();
    await page.goto(`${origin}/probe.html`, { waitUntil: "load" });
    const result = await page.evaluate(async (caseRequests) => {
      const module = await import("./probe.bundle.mjs");
      return module.runR4HiZWiringProbe(caseRequests);
    }, requests);
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

/** f32 位型单调键见 compareOutputs;计时取中位数降噪。 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "r4-hiz-wiring-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/r4HiZWiringProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  const module = await import(pathToFileURL(bundlePath));

  const requests = [];
  const references = new Map();
  for (const entry of CASES) {
    const input = buildCaseInput(entry, module.generateHiZInput);
    const chain = module.referenceHiZChain(input, entry.width, entry.height,
      module.hiZChainLevelCount(entry.width, entry.height), entry.reduceMax);
    requests.push({ name: entry.name, width: entry.width, height: entry.height, reduceMax: entry.reduceMax,
      inputBase64: Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("base64"),
      perfRepeats: entry.perfRepeats, perfSamples: entry.perfSamples });
    references.set(entry.name, { entry, input, chain });
  }
  await writeFile(path.join(bundleDirectory, "probe.html"), `<!doctype html><title>R4 HiZ wiring probe</title>`);

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin, requests);
      if (probe.errors.length === 0 || (probe.webgpu && probe.webgl)) break;
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe) throw new Error(`GPU probe failed after ${maxAttempts} attempts.`);

  const emitted = {
    anchored: { min: module.emitKernelWgsl(module.buildHiZFirstStageKernel(false)),
      max: module.emitKernelWgsl(module.buildHiZFirstStageKernel(true)) },
    variable: { min: module.emitKernelWgsl(module.buildHiZVariableReduceKernel(false)),
      max: module.emitKernelWgsl(module.buildHiZVariableReduceKernel(true)) },
  };
  const glsl = {
    anchored: { min: module.emitKernelGlsl(module.buildHiZFirstStageKernel(false)),
      max: module.emitKernelGlsl(module.buildHiZFirstStageKernel(true)) },
    variable: { min: module.emitKernelGlsl(module.buildHiZVariableReduceKernel(false)),
      max: module.emitKernelGlsl(module.buildHiZVariableReduceKernel(true)) },
  };
  await mkdir(path.join(outputDirectory, "kernels"), { recursive: true });
  await mkdir(path.join(outputDirectory, "inputs"), { recursive: true });
  for (const [family, modes] of Object.entries(emitted)) {
    for (const [mode, artifact] of Object.entries(modes)) {
      await writeFile(path.join(outputDirectory, "kernels", `hiZReduce.${family}.${mode}.wgsl`), artifact.code);
      await writeFile(path.join(outputDirectory, "kernels", `hiZReduce.${family}.${mode}.frag.glsl`), glsl[family][mode].fragment);
    }
  }
  await writeFile(path.join(outputDirectory, "kernels", "goldenHiZReduce.wgsl"), module.GOLDEN_HI_Z_REDUCE_WGSL);

  const cases = [];
  let productionParityGate = Boolean(probe.webgpu);
  let cpuParityGate = Boolean(probe.webgpu);
  let glslGate = Boolean(probe.webgl);
  for (const entry of CASES) {
    const prepared = references.get(entry.name);
    const webgpuCase = probe.webgpu?.cases[entry.name];
    const webglCase = probe.webgl?.cases[entry.name];
    const mipLevelCount = module.hiZChainLevelCount(entry.width, entry.height);
    const decodeLevels = (repeats) => repeats.map((repeat) => repeat.map((value) =>
      new Float32Array(base64ToBytes(value).buffer.slice(0))));
    const oldRepeats = webgpuCase ? decodeLevels(webgpuCase.oldRepeats) : [];
    const newRepeats = webgpuCase ? decodeLevels(webgpuCase.newRepeats) : [];
    const levels = [];
    for (let level = 1; level < mipLevelCount; level++) {
      const sourceWidth = module.hiZChainLevelSize(entry.width, level - 1);
      const sourceHeight = module.hiZChainLevelSize(entry.height, level - 1);
      const levelResult = {
        level, sourceSize: [sourceWidth, sourceHeight],
        targetSize: [module.hiZChainLevelSize(entry.width, level), module.hiZChainLevelSize(entry.height, level)],
        kernel: module.usesAnchoredReduce(sourceWidth, sourceHeight) ? "anchored" : "variable",
      };
      if (oldRepeats[0] && newRepeats[0]) {
        levelResult.oldVsNew = compareOutputs(oldRepeats[0][level], newRepeats[0][level]);
        levelResult.oldVsNewRepeatStability = compareOutputs(oldRepeats[0][level], oldRepeats[1]?.[level] ?? oldRepeats[0][level]);
        levelResult.newVsCpu = compareOutputs(newRepeats[0][level], prepared.chain[level]);
        levelResult.oldVsCpu = compareOutputs(oldRepeats[0][level], prepared.chain[level]);
        if (entry.tier === "bitwise") {
          productionParityGate &&= levelResult.oldVsNew.foldedEqual && levelResult.oldVsNew.nonZeroMismatchCells === 0;
          cpuParityGate &&= levelResult.newVsCpu.bitwiseEqual;
        }
      }
      levels.push(levelResult);
    }
    let glsl = null;
    if (webglCase && webglCase.outputBase64 && mipLevelCount > 1) {
      const glslOutput = new Float32Array(base64ToBytes(webglCase.outputBase64).buffer.slice(0));
      const kernelKey = module.usesAnchoredReduce(entry.width, entry.height) ? "anchored" : "variable";
      const cpuFirst = kernelKey === "anchored"
        ? module.referenceHiZFirstStage(prepared.input, entry.width, entry.height, entry.reduceMax)
        : module.referenceHiZVariableReduce(prepared.input, entry.width, entry.height,
            module.hiZChainLevelSize(entry.width, 1), module.hiZChainLevelSize(entry.height, 1), entry.reduceMax);
      glsl = {
        kernel: webglCase.kernel, glError: webglCase.glError, otherChannelMaxAbs: webglCase.otherChannelMaxAbs,
        vsCpu: compareOutputs(glslOutput, cpuFirst),
        vsWebgpuLevel1: newRepeats[0] ? compareOutputs(glslOutput, newRepeats[0][1]) : null,
      };
      if (entry.tier === "bitwise") {
        glslGate &&= glsl.vsCpu.foldedEqual && glsl.vsCpu.nonZeroMismatchCells === 0 && glsl.otherChannelMaxAbs === 0
          && (!glsl.vsWebgpuLevel1 || glsl.vsWebgpuLevel1.foldedEqual);
      }
    }
    const perf = webgpuCase && (webgpuCase.perfOldTicks.length > 0) ? {
      method: "GPU timestamp queries (encoder.writeTimestamp) around repeated full reduce chains; same device/units, ratio period-independent",
      chainRepeats: entry.perfRepeats, samples: entry.perfSamples,
      oldTicksPerChainSamples: webgpuCase.perfOldTicks, newTicksPerChainSamples: webgpuCase.perfNewTicks,
      oldTicksPerChainMedian: median(webgpuCase.perfOldTicks), newTicksPerChainMedian: median(webgpuCase.perfNewTicks),
      ratioNewOverOld: median(webgpuCase.perfNewTicks) / median(webgpuCase.perfOldTicks),
      absoluteNsCaveat: "Dawn timestamp period not exposed to JS; absolute ns unverified, use ratio",
    } : null;
    cases.push({ name: entry.name, tier: entry.tier, flavor: entry.flavor, reduceMax: entry.reduceMax,
      sourceSize: [entry.width, entry.height], mipLevelCount,
      inputSha256: sha256(prepared.input.buffer),
      referenceChainSha256: prepared.chain.map((level) => sha256(level.buffer)),
      levels, glsl, perf });
    await writeFile(path.join(outputDirectory, "inputs", `${entry.name}.f32.bin`), Buffer.from(prepared.input.buffer));
    if (oldRepeats[0]) {
      await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
      for (let level = 0; level < mipLevelCount; level++) {
        await writeFile(path.join(outputDirectory, "outputs", `${entry.name}.old.l${level}.f32.bin`), Buffer.from(oldRepeats[0][level].buffer));
        await writeFile(path.join(outputDirectory, "outputs", `${entry.name}.new.l${level}.f32.bin`), Buffer.from(newRepeats[0][level].buffer));
      }
    }
  }

  const evidence = {
    schema: "r4-hiz-wiring-evidence-v1",
    lane: "R4", createdAt: new Date().toISOString(),
    wiring: {
      replaced: "webgpu/hiZPyramid.ts 的 HI_Z_REDUCE_WGSL（手写变窗公式）已删除，reduce 全链改由 DCIR 生成内核执行",
      kernels: {
        anchored: { name: "hi_z_first_stage", source: "shaderCompute/hiZReduce.ts（R2 已认证内核，原样复用）",
          route: "源尺寸偶×偶（窗口恰为 2×2）", irSha256: { min: emitted.anchored.min.irSha256, max: emitted.anchored.max.irSha256 } },
        variable: { name: "hi_z_variable_reduce", source: "shaderCompute/hiZReduceVariable.ts（本切片新增）",
          route: "其余源尺寸（GPU mip floor 链下窗口 ≤3，9-tap masked 定序展开逐位复现变窗公式）",
          irSha256: { min: emitted.variable.min.irSha256, max: emitted.variable.max.irSha256 } },
      },
      unchanged: ["HiZPyramid 类接口与 HiZResult 消费端合同", "HI_Z_COPY_WGSL（depth32float 读取超出 DCIR v0 r32float texel-load 合同）",
        "金字塔分配、缓存、校验与资源编排", "hiZOcclusionCulling / meshletCulling / previousHiZVisibility 等消费点"],
      differences: [
        "DCIR 输出经 canonicalize-f32（-0 折叠为 +0）；原手写路径无折叠——±0 格差异以 foldedEqual 档判定，属修复而非回归（R2 合同 §4.3）",
        "reduce 绑定组增加 binding 2（每级 16 字节 uniform buffer：源/目标尺寸）",
        "管线数 2→4（anchored/variable × min/max，均为 IR 级模式特化）",
        "生产 WebGL2 HiZ 消费路径不存在（R2 审计 §1.3：WebGL2 无着色体系）；GLSL 降级在本 harness 按 R2 合同语义验证",
      ],
    },
    environment: {
      chromeVersion: probe.browserVersion ?? null,
      userAgent: probe.userAgent ?? null,
      webgpu: probe.webgpu ? { adapter: probe.webgpu.adapter, features: probe.webgpu.features,
        timestampQuery: probe.webgpu.timestampQuery, shaderValidationMessages: probe.webgpu.validationMessages } : null,
      webgl: probe.webgl ? { version: probe.webgl.version, unmaskedRenderer: probe.webgl.unmaskedRenderer,
        unmaskedVendor: probe.webgl.unmaskedVendor, floatRenderable: probe.webgl.floatRenderable } : null,
      probeErrors: probe.errors,
    },
    cases,
    verdict: {
      productionParity: productionParityGate,
      cpuParity: cpuParityGate,
      glslParity: glslGate,
      nativeWgpu: "not-connected (shaderCompute/nativeHarness.ts 桩;WGSL 文本直用即可接)",
      notes: [
        "bitwise tier 门:所有非 denormal case 每级 oldVsNew foldedEqual 且非 ±0 差异为 0;newVsCpu 逐位相等。",
        "depthlike flavor 覆写哨兵索引后无 -0/inf,oldVsNew 应严格 bitwiseEqual(逐级记录)。",
        "denormal case 为阈值档风险探针(设计 §4.4),不参与门判定,差异如实记录。",
        "perf-only case 不回读输出(体积),仅计时;其数值与同 flavor 小 case 无关,不受门约束。",
      ],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));

  const summary = cases.map((entry) => {
    const levelStats = entry.levels.map((level) => level.oldVsNew
      ? `l${level.level}:${level.oldVsNew.foldedEqual ? "OK" : "DIFF"}(raw=${level.oldVsNew.mismatchCells},zero=${level.oldVsNew.zeroFoldCells},cpu=${level.newVsCpu?.bitwiseEqual ? "OK" : "DIFF"})`
      : `l${level.level}:n/a`).join(" ");
    const perfText = entry.perf ? ` perf ratio=${entry.perf.ratioNewOverOld?.toFixed(3)}` : "";
    const glslText = entry.glsl ? ` glsl=${entry.glsl.vsCpu.foldedEqual ? "OK" : "DIFF"}` : "";
    return `${entry.name}: ${levelStats}${perfText}${glslText}`;
  });
  console.log(summary.join("\n"));
  const passed = productionParityGate && cpuParityGate;
  if (!passed || !glslGate) {
    console.error(`Gate verdict FAILED (production=${productionParityGate} cpu=${cpuParityGate} glsl=${glslGate}); see evidence.json.`);
    process.exitCode = 1;
  } else {
    console.log(`Gate verdict PASSED; evidence: ${outputDirectory}`);
  }
}

await main();
