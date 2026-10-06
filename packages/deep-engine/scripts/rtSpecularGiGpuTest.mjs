import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { build } from "esbuild";

// RT specular GI GPU 门 runner(2026-10-06 P1 质量主线;harness 沿用
// reflectionRayGpuTest.mjs)。headless Chrome + WebGPU 完整 API 路径:真实深度 pass →
// RayTraceClosestFramePass(illumination 档:命中记录 + 遮蔽记录)→
// RtSpecularIndirectionPass(一次反弹 indirection)→ RtSpecularFillPass(SSR 合成后
// 屏外填充)。Node 侧 CPU 镜像仲裁。
// 门:G1 开关零变化(全零 indirection fill 输出 == SSR 合成物,逐位);
//    G2 SSR 优先(mask>0 像素逐位透传);
//    G3 RT 屏外替换 == CPU 镜像(容差 = DFG LUT 量化)且 changedPixels ≥ 哨兵;
//    G4 indirection == CPU 镜像(fraction ≤ 2e-2,预乘 rgb 相对 ≤ 2%,miss 全零);
//    G5 栈哨兵 == 0;
//    G6 遮蔽差分(遮挡/受光两族 ≥ 哨兵,遮挡像素严格暗于 visibility=1 基线);
//    G7 反照率差分(非中性材质像素全部产生真实替换差异);
//    perf 仅记录(wall,不作门,如实标注)。
// 证据写 test-output/rt-specular-gi-20261006/。

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = path.resolve(packageRoot, "../..");
const outputDirectory = path.join(repoRoot, "test-output", "rt-specular-gi-20261006");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const maxAttempts = Number(process.env.RT_SPECULAR_GI_TEST_ATTEMPTS ?? 3);
/** fill rgb 对 CPU 镜像的容差:DFG LUT(生成核 f32 + 双线性插值)对 f64 解析积分的量化
 * 包络(实测 ≤2.8%);语义漂移(公式/输入错)会在该量级上放大到显著失配。 */
const RT_FILL_RGB_TOLERANCE = 0.035;

const sha256 = (bytes) => createHash("sha256").update(new Uint8Array(bytes)).digest("hex");
const base64ToBytes = (value) => Uint8Array.from(Buffer.from(value, "base64"));

async function startServer(directory) {
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const name = new URL(request.url ?? "/", "http://127.0.0.1").pathname.replace("/", "");
    if (request.method === "GET" && ["probe.html", "probe.bundle.mjs"].includes(name)) {
      response.writeHead(200, { "Content-Type": name.endsWith(".html")
        ? "text/html; charset=utf-8" : "text/javascript" })
        .end(await readFile(path.join(directory, name)));
      return;
    }
    response.writeHead(404).end();
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
      return module.runRtSpecularGiGpuProbe();
    });
    result.browserVersion = browser.version();
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  } finally {
    await browser.close();
  }
}

/** rgba16float 读回展开(f16 位型 → f64;探测腿同族 unpackRgba16Float 的 Node 侧镜像)。 */
function unpackRgba16(buffer) {
  const bits = new Uint16Array(buffer, 0, buffer.byteLength / 2);
  const out = new Float64Array(bits.length);
  for (let i = 0; i < bits.length; i++) {
    const sign = (bits[i] & 0x8000) ? -1 : 1;
    const exp = (bits[i] >>> 10) & 0x1f;
    const mantissa = bits[i] & 0x3ff;
    out[i] = exp === 0 ? sign * mantissa * 2 ** -24
      : exp === 0x1f ? sign * (mantissa ? NaN : Infinity)
        : sign * (1 + mantissa / 1024) * 2 ** (exp - 15);
  }
  return out;
}

function unpackR32(buffer) {
  return new Float32Array(buffer);
}

async function main() {
  const bundleDirectory = await mkdtemp(path.join(tmpdir(), "rt-specular-gi-"));
  const bundlePath = path.join(bundleDirectory, "probe.bundle.mjs");
  await build({ absWorkingDir: packageRoot, entryPoints: ["lab/rtSpecularGiGpuProbe.ts"], bundle: true,
    format: "esm", target: "es2022", outfile: bundlePath, logLevel: "silent" });
  await writeFile(path.join(bundleDirectory, "probe.html"),
    `<!doctype html><title>RT specular GI GPU probe</title>`);
  const module = await import(pathToFileURL(bundlePath));

  let probe;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { server, origin } = await startServer(bundleDirectory);
    try {
      probe = await runInBrowser(origin);
      if (probe.errors.length === 0 && probe.hitRecordsBase64) break;
    } catch (error) {
      probe = { errors: [String(error instanceof Error ? error.message : error)] };
    } finally {
      server.close();
    }
    if (attempt < maxAttempts) await new Promise((resolve) => setTimeout(resolve, 4000));
  }
  await rm(bundleDirectory, { recursive: true, force: true });
  if (!probe || !probe.hitRecordsBase64) {
    throw new Error(`GPU probe failed after ${maxAttempts} attempts: ${probe?.errors ?? "no data"}`);
  }

  await mkdir(path.join(outputDirectory, "outputs"), { recursive: true });
  const resolution = module.REFLECTION_RESOLUTION;
  const pixels = resolution * resolution;
  const hitRecords = new Float32Array(base64ToBytes(probe.hitRecordsBase64).buffer);
  const linearDepth = unpackR32(base64ToBytes(probe.linearDepthBase64).buffer);
  const bounceShading = unpackR32(base64ToBytes(probe.bounceShadingBase64).buffer);
  const indirectionGpu = unpackRgba16(base64ToBytes(probe.indirectionBase64).buffer);
  const fillOn = unpackRgba16(base64ToBytes(probe.fillOnBase64).buffer);
  const fillOff = unpackRgba16(base64ToBytes(probe.fillOffBase64).buffer);
  const ssrOutput = unpackRgba16(base64ToBytes(probe.ssrOutputBase64).buffer);
  const trace = unpackRgba16(base64ToBytes(probe.traceBase64).buffer);

  // 视法线 GBuffer:浏览器腿回传 upload 字节(CPU 单源 buildReceiverViewNormals 生成,
  // 双腿同一字节,防口径分叉)。CPU 镜像输入 = GPU 读回的命中记录 + 遮蔽记录(同输入
  // 仲裁;遮蔽/反照率语义的差分在 G6/G7 以显式双基线展开)。
  if (!probe.viewNormalBase64) throw new Error("probe did not return view normal bytes.");
  if (!probe.bounceShadingBase64) throw new Error("probe did not return bounce shading bytes.");
  const reference = module.buildRtSpecularCpuReference(hitRecords, linearDepth,
    base64ToBytes(probe.viewNormalBase64), ssrOutput, trace, bounceShading);

  // G1 开关零变化:fillOff == ssrOutput 逐位(f16 位级)。
  let g1Mismatches = 0; let firstG1 = null;
  for (let i = 0; i < pixels * 4; i++) {
    if (fillOff[i] !== ssrOutput[i]) {
      g1Mismatches++;
      firstG1 ??= { index: i, pixel: i >> 2, channel: i & 3, fillOff: fillOff[i], ssrOutput: ssrOutput[i],
        rt: [indirectionGpu[i & ~3], indirectionGpu[(i & ~3) + 1], indirectionGpu[(i & ~3) + 2], indirectionGpu[(i & ~3) + 3]],
        traceA: trace[(i & ~3) + 3] };
    }
  }
  // G2 SSR 优先 + G3 RT 替换差分。
  let g2Mismatches = 0, g3Mismatches = 0, changedPixels = 0, ssrOwnedPixels = 0, rtReplacedPixels = 0;
  let maxFillDelta = 0, maxFractionDelta = 0, maxRadianceDelta = 0, indirectionMissViolations = 0;
  let firstFillMismatch = null;
  for (let p = 0; p < pixels; p++) {
    const base = p * 4;
    const traceAlpha = trace[base + 3];
    if (traceAlpha > 0) {
      ssrOwnedPixels++;
      for (let c = 0; c < 4; c++) {
        if (fillOn[base + c] !== ssrOutput[base + c]) g2Mismatches++;
      }
      continue;
    }
    // mask==0:期望 = CPU 镜像(RT 替换或双 miss 透传)。rgb 对 CPU 镜像(容差 =
    // DFG LUT 双线性插值 vs f64 解析积分的包络);alpha 是合成合同直通(current.a),
    // 与 SSR 合成物逐位对拍。
    for (let c = 0; c < 3; c++) {
      const expected = reference.fill[base + c];
      const actual = fillOn[base + c];
      const tolerance = RT_FILL_RGB_TOLERANCE * (Math.abs(expected) + 0.1);
      if (!(Math.abs(actual - expected) <= tolerance)) {
        g3Mismatches++;
        firstFillMismatch ??= { pixel: p, channel: c, expected, actual };
      }
      const delta = Math.abs(actual - ssrOutput[base + c]);
      if (delta > maxFillDelta) maxFillDelta = delta;
    }
    if (fillOn[base + 3] !== ssrOutput[base + 3]) {
      g3Mismatches++;
      firstFillMismatch ??= { pixel: p, channel: 3, expected: ssrOutput[base + 3], actual: fillOn[base + 3] };
    }
    if (indirectionGpu[base + 3] > 0) rtReplacedPixels++;
    if (reference.indirection[base + 3] > 0 || indirectionGpu[base + 3] > 0) changedPixels++;
    // G4 indirection 语义。
    const fractionDelta = Math.abs(indirectionGpu[base + 3] - reference.indirection[base + 3]);
    if (fractionDelta > maxFractionDelta) maxFractionDelta = fractionDelta;
    for (let c = 0; c < 3; c++) {
      const bound = Math.abs(reference.indirection[base + c]) + 0.05;
      const delta = Math.abs(indirectionGpu[base + c] - reference.indirection[base + c]);
      if (delta / bound > maxRadianceDelta) maxRadianceDelta = delta / bound;
    }
    if (hitRecords[base] <= 0 && indirectionGpu[base + 3] !== 0) indirectionMissViolations++;
  }

  let gpuHitRecords = 0, positiveLinear = 0;
  let linMin = Infinity, linMax = -Infinity;
  for (let p = 0; p < pixels; p++) {
    if (hitRecords[p * 4] > 0) gpuHitRecords++;
    const ld = linearDepth[p];
    if (ld > 0) positiveLinear++;
    if (ld < linMin) linMin = ld;
    if (ld > linMax) linMax = ld;
  }

  // G6 遮蔽差分:对 N·L>0.05 的命中像素,以同一输入分别在 visibility=0(遮挡)与
  // visibility=1(受光基线)下重建 CPU 期望 —— 遮挡族必须严格更暗(直接项归零,
  // 环境项存活),且两族各有哨兵量(遮蔽项真实改变着色,非空转)。
  // G7 反照率差分:遮蔽记录 rgb 偏离中性 0.5 的命中像素( fraction>0 ),真实表镜像
  // 必须 != 中性表镜像(GPU 侧已由 G4 对同一输入对拍),证明反照率真值进入着色。
  const lighting = module.RT_SPECULAR_PROBE_LIGHT;
  let occludedNdotl = 0, litNdotl = 0, occlusionDiffViolations = 0, firstOcclusionViolation = null;
  let albedoDistinct = 0, albedoDiffViolations = 0, firstAlbedoViolation = null;
  let maxOcclusionDrop = 0;
  for (let p = 0; p < pixels; p++) {
    const base = p * 4;
    if (!(hitRecords[base] > 0) || indirectionGpu[base + 3] <= 0) continue;
    const shading = { albedo: [bounceShading[base], bounceShading[base + 1], bounceShading[base + 2]],
      visibility: bounceShading[base + 3] };
    const hitNormal = [hitRecords[base + 1], hitRecords[base + 2], hitRecords[base + 3]];
    const ndotl = Math.max(0, hitNormal[0] * lighting.surfaceToLightWorld[0]
      + hitNormal[1] * lighting.surfaceToLightWorld[1] + hitNormal[2] * lighting.surfaceToLightWorld[2]);
    if (ndotl <= 0.05) continue;
    const common = { tanHalfFov: Math.tan(50 * Math.PI / 360), aspect: 1, ...lighting,
      fresnelF0: module.RT_SPECULAR_PROBE_FRESNEL_F0 };
    const pixel = p % resolution, row = Math.floor(p / resolution);
    const mirrorArgs = [hitRecords.slice(base, base + 4), [0, 0, 1], 0.25, linearDepth[p] || 1,
      pixel, row, resolution, resolution, common];
    if (shading.visibility < 0.5) {
      occludedNdotl++;
      const lit = module.rtSpecularIndirectionRecordCpu(...mirrorArgs.slice(0, 9),
        { ...shading, visibility: 1 });
      const drop = lit[0] - indirectionGpu[base];
      if (drop > maxOcclusionDrop) maxOcclusionDrop = drop;
      // 遮挡像素必须严格低于受光基线(至少 1% 相对差;直接项占比由 N·L>0.05 保证)。
      if (!(indirectionGpu[base] < lit[0] * 0.99)) {
        occlusionDiffViolations++;
        firstOcclusionViolation ??= { pixel: p, ndotl, litR: lit[0], gpuR: indirectionGpu[base] };
      }
    } else {
      litNdotl++;
    }
    const isNeutral = Math.abs(shading.albedo[0] - 0.5) < 0.01
      && Math.abs(shading.albedo[1] - 0.5) < 0.01 && Math.abs(shading.albedo[2] - 0.5) < 0.01;
    if (!isNeutral) {
      albedoDistinct++;
      const neutral = module.rtSpecularIndirectionRecordCpu(...mirrorArgs.slice(0, 9),
        { albedo: [0.5, 0.5, 0.5], visibility: 1 });
      const differs = [0, 1, 2].some((c) =>
        Math.abs(neutral[c] - indirectionGpu[base + c]) > 1e-3 * (Math.abs(neutral[c]) + 0.05));
      if (!differs) {
        albedoDiffViolations++;
        firstAlbedoViolation ??= { pixel: p, albedo: shading.albedo, neutralRgb: [neutral[0], neutral[1], neutral[2]],
          gpuRgb: [indirectionGpu[base], indirectionGpu[base + 1], indirectionGpu[base + 2]] };
      }
    }
  }

  console.log(`diag: positiveLinear=${positiveLinear}/${pixels} linRange=[${linMin.toFixed(3)}, ${linMax.toFixed(3)}] browserDiag=${JSON.stringify(probe.diagnostics ?? null)}`);
  if (probe.errors.length > 0) console.log(`probe.errors: ${JSON.stringify(probe.errors)}`);
  const g1 = g1Mismatches === 0;
  const g2 = g2Mismatches === 0;
  const g3 = g3Mismatches === 0 && changedPixels >= module.RT_SPECULAR_CHANGED_PIXEL_GATE;
  // fraction 容差 0.02(实测 LUT 插值 ≤0.0084);rgb 相对容差与 G3 同包络(0.035)。
  const g4 = maxFractionDelta <= 0.02 && maxRadianceDelta <= RT_FILL_RGB_TOLERANCE && indirectionMissViolations === 0;
  const g5 = probe.stackOverflows === 0;
  // G6 遮蔽差分:遮挡/受光两族 ≥ 哨兵 且无违例(遮挡像素严格暗于受光基线)。
  const g6 = occludedNdotl >= module.RT_SPECULAR_OCCLUSION_PIXEL_GATE
    && litNdotl >= module.RT_SPECULAR_OCCLUSION_PIXEL_GATE && occlusionDiffViolations === 0;
  // G7 反照率差分:非中性反照率像素 ≥ 哨兵 且全部与中性镜像产生实际差异。
  const g7 = albedoDistinct >= module.RT_SPECULAR_ALBEDO_PIXEL_GATE && albedoDiffViolations === 0;
  const gate = g1 && g2 && g3 && g4 && g5 && g6 && g7 && probe.errors.length === 0;

  const evidence = {
    schema: "rt-specular-gi-gpu-evidence-v2",
    lane: "rt-specular-gi/one-bounce-indirection+occlusion+albedo+ssr-offscreen-fill(P1 质量主线)",
    createdAt: new Date().toISOString(),
    kernels: {
      indirection: { entryPoint: "rt_specular_indirection", output: "rgba16float [radiance*frac, frac]",
        shadingInput: "rgba32float [albedo.rgb, visibility](closest 通道 illumination 档遮蔽记录)" },
      fill: { entryPoint: "rt_specular_fill", output: "rgba16float(composite replace form)" },
    },
    environment: {
      chromeVersion: probe.browserVersion ?? null, userAgent: probe.userAgent ?? null,
      adapter: probe.adapter ?? null, features: probe.features, probeErrors: probe.errors,
    },
    scene: {
      resolution, instances: ["reflection-wall", "reflection-mirror-box", "reflection-lean-panel", "specular-blocker"],
      ssrTraceRegion: module.SSR_TRACE_REGION, roughness: module.RT_SPECULAR_PROBE_ROUGHNESS,
      fresnelF0: module.RT_SPECULAR_PROBE_FRESNEL_F0, light: module.RT_SPECULAR_PROBE_LIGHT,
      instanceAlbedos: [...module.RT_SPECULAR_PROBE_INSTANCE_ALBEDOS],
      note: "SSR 合成物为 upload 合成(trace 矩形 mask + composite 输出);命中记录/线性深度/遮蔽记录为真机 GPU 读回;视法线为 CPU 主射线单源 upload;遮光板使部分命中点→光源路径被遮挡(G6 两族平衡)。",
    },
    gates: {
      g1ToggleZeroChange: { pass: g1, bitwiseMismatches: g1Mismatches, ...(firstG1 ? { firstG1 } : {}),
        note: "全零 indirection fill 输出 == SSR 合成物(f16 位级,开关零变化)" },
      g2SsrPriority: { pass: g2, bitwiseMismatches: g2Mismatches, ssrOwnedPixels,
        note: "mask>0 像素逐位透传(SSR 命中含半权双线性边缘优先)" },
      g3RtReplace: { pass: g3, mismatches: g3Mismatches, rgbTolerance: RT_FILL_RGB_TOLERANCE, changedPixels,
        changedPixelGate: module.RT_SPECULAR_CHANGED_PIXEL_GATE, rtReplacedPixels,
        maxFillDelta, note: "RT 屏外替换 == CPU 镜像(容差 2%×(|期望|+0.1));changedPixels ≥ 哨兵 = 屏外反射可见" },
      g4IndirectionParity: { pass: g4, maxFractionDelta, maxRadianceDelta,
        indirectionMissViolations, tolerance: { fraction: 0.02, radianceRelative: RT_FILL_RGB_TOLERANCE },
        cpuHits: reference.hits, gpuHitRecords,
        note: "fraction/radiance == CPU 镜像(输入含 GPU 读回遮蔽记录;DFG LUT f16 量化容差);miss 记录全零 fail-closed" },
      g5StackSentinel: { pass: g5, stackOverflows: probe.stackOverflows },
      g6OcclusionDifferential: { pass: g6, occludedNdotlPixels: occludedNdotl, litNdotlPixels: litNdotl,
        occlusionPixelGate: module.RT_SPECULAR_OCCLUSION_PIXEL_GATE, violations: occlusionDiffViolations,
        maxOcclusionDrop, ...(firstOcclusionViolation ? { firstOcclusionViolation } : {}),
        note: "遮挡命中(N·L>0.05 且 visibility=0)indirection 严格暗于 visibility=1 基线(直接项归零、环境项存活);两族 ≥ 哨兵防空转" },
      g7AlbedoDifferential: { pass: g7, albedoDistinctPixels: albedoDistinct,
        albedoPixelGate: module.RT_SPECULAR_ALBEDO_PIXEL_GATE, violations: albedoDiffViolations,
        ...(firstAlbedoViolation ? { firstAlbedoViolation } : {}),
        note: "非中性反照率(命中实例材质表)全部与中性 0.5 镜像产生实际替换差异 = 反照率真值进入着色" },
      perf: {
        source: "wall incl. onSubmittedWorkDone(GPU 完成;p95,20 次;evidence-only,不作门)",
        wallP95Ms: probe.wallMs,
        note: "closest(illumination)+indirection / +fill / closest-only 基线;增量 = fillOn − ssrOnly,帧预算披露口径",
      },
    },
    artifacts: {
      fillOn: sha256(base64ToBytes(probe.fillOnBase64)),
      fillOff: sha256(base64ToBytes(probe.fillOffBase64)),
      indirection: sha256(base64ToBytes(probe.indirectionBase64)),
      bounceShading: sha256(base64ToBytes(probe.bounceShadingBase64)),
      ...(firstFillMismatch ? { firstFillMismatch } : {}),
    },
    verdict: {
      gate,
      notes: [
        "门①:开关零变化为逐位门(off-case fill 输出与 SSR 合成物上传位级恒等)。",
        "门③:changedPixels 计 mask==0 且 RT 命中(任一方判定)像素数;低于哨兵=特性未产生可见收益,判 FAIL。",
        "遮蔽项(命中点→光源 visibility trace)与命中实例反照率(G7)已入链;如实登记剩余边界:",
        "反照率 = 平面 per-instance baseColor(无纹理/顶点色采样);环境项无 AO 遮蔽;二反弹不做;",
        "ReSTIR-DI 灯池跨域借表属下一切片;生产宿主材质表经 rtReflectionsBounceAlbedos 钩子供给(缺省中性 0.5)。",
      ],
    },
  };
  await writeFile(path.join(outputDirectory, "evidence.json"), JSON.stringify(evidence, null, 2));
  await writeFile(path.join(outputDirectory, "outputs", "fill-on.bin"), Buffer.from(base64ToBytes(probe.fillOnBase64)));
  await writeFile(path.join(outputDirectory, "outputs", "fill-off.bin"), Buffer.from(base64ToBytes(probe.fillOffBase64)));
  await writeFile(path.join(outputDirectory, "outputs", "indirection.bin"), Buffer.from(base64ToBytes(probe.indirectionBase64)));
  await writeFile(path.join(outputDirectory, "outputs", "bounce-shading.bin"), Buffer.from(base64ToBytes(probe.bounceShadingBase64)));
  console.log(`G1 toggleZeroChange: ${g1 ? "PASS" : "FAIL"} (mismatches=${g1Mismatches})`);
  console.log(`G2 ssrPriority: ${g2 ? "PASS" : "FAIL"} (mismatches=${g2Mismatches}, ssrOwned=${ssrOwnedPixels})`);
  console.log(`G3 rtReplace: ${g3 ? "PASS" : "FAIL"} (mismatches=${g3Mismatches}, changed=${changedPixels} >= ${module.RT_SPECULAR_CHANGED_PIXEL_GATE}, maxDelta=${maxFillDelta.toFixed(5)})`);
  console.log(`G4 indirectionParity: ${g4 ? "PASS" : "FAIL"} (fractionΔ=${maxFractionDelta.toFixed(5)}<=0.02, radianceRelΔ=${maxRadianceDelta.toFixed(5)}<=${RT_FILL_RGB_TOLERANCE}, missViolations=${indirectionMissViolations}, cpuHits=${reference.hits}, gpuHitRecords=${gpuHitRecords})`);
  console.log(`G5 stackSentinel: ${g5 ? "PASS" : "FAIL"} (${probe.stackOverflows})`);
  console.log(`G6 occlusionDifferential: ${g6 ? "PASS" : "FAIL"} (occluded=${occludedNdotl}, lit=${litNdotl} >= ${module.RT_SPECULAR_OCCLUSION_PIXEL_GATE}, violations=${occlusionDiffViolations}, maxDrop=${maxOcclusionDrop.toFixed(5)})`);
  console.log(`G7 albedoDifferential: ${g7 ? "PASS" : "FAIL"} (distinct=${albedoDistinct} >= ${module.RT_SPECULAR_ALBEDO_PIXEL_GATE}, violations=${albedoDiffViolations})`);
  console.log(`perf(p95 wall incl. GPU done, evidence-only): closest+indirection=${probe.wallMs.indirection?.toFixed?.(3)}ms full-chain=${probe.wallMs.fillOn?.toFixed?.(3)}ms ssrOnly-baseline=${probe.wallMs.ssrOnly?.toFixed?.(3)}ms`);
  console.log(`Verdict: ${gate ? "PASSED" : "FAILED"}; evidence: ${outputDirectory}`);
  if (!gate) process.exitCode = 1;
}

await main();
