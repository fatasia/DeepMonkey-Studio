import { createServer } from "node:http";
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import sharp from "sharp";
import { compareImageFiles } from "./renderImageSimilarity.mjs";

// Wasm 桥黄金样例对等验收 gate(T00 冻结 FactoryMachine.glb · 双腿:TS Deep WebGPU vs Rust wasm)。
//
// 判据(预登记,测前定义,依据见各条注释):
//   G1 场景装载   两腿渲染成功:webgpu.drawCalls>0 且 wasm ready_generation 前进且无 failure_message。
//   G2 对象清单   runtime package 内 render-packet 计数与 fixture packet 完全一致
//                 (instances/geometries/materials/textures 四元组逐项相等),set_scene_package 接受。
//   G3 相机一致   两腿收到同一 9 元组(构造保证,报告记录);跨腿截图 SSIM 双位姿 ≥ 0.60
//                 作为几何一致性代理(wasm ABI 无相机读回,已声明)。
//                 阈值依据:T00 fair r1 产品场景跨引擎 SSIM(webgl↔webgpu)0.39–0.49、
//                 (webgl↔wasm)0.06–0.16,均为全生产特性档;本 gate 受控 baseline 档,
//                 同光源/同背景/同色调映射,阈值定 0.60,低于产品跨引擎参照即不合格。
//   G4 像素差异   跨腿 changedPixelRatio 与 MAE 只记录不设阈(画风差异不作失败,T00 纪律);
//                 对象覆盖率(亮度>24 像素占比)两腿相对差 ≤ 0.25(对象是否同在画面内的代理)。
//   G5 无黑帧     两腿截图平均亮度 ≥ 5/255(真实黑帧为 0,合法深背景约 13-16)。
//   G6 无错误     pageerror/console.error/webgpu errors/wasm failure 全空。
//   G7 腿内确定性 同腿间隔 400ms 双截图 SSIM ≥ 0.99(T00 fair 同口径)。

const root = fileURLToPath(new URL("../../../", import.meta.url));
const labDir = path.join(root, "packages/deep-engine/lab");
const wasmDir = path.join(root, "apps/web/public/engine-wasm");
const runId = process.env.WASM_PARITY_RUN_ID ?? `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
const output = path.resolve(process.env.WASM_PARITY_OUTPUT_DIR ?? path.join(root, "test-output/wasm-parity-acceptance", runId));
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const origin = process.env.WASM_PARITY_ORIGIN ?? "http://127.0.0.1:5293";
const instances = Number(process.env.WASM_PARITY_INSTANCES ?? 1_024);
const asset = process.env.WASM_PARITY_ASSET === "procedural" ? "procedural" : "FactoryMachine";
// W-2 环境口径(2026-09-29):studio=v8 builtin-ibl(修复后默认)、no-ibl=切片前现状
// (回归对照)、studio-ground=studio+程序化地面注入(GroundPlane 合同缺位的受控实验)。
const environment = ["no-ibl", "studio", "studio-ground"].includes(process.env.WASM_PARITY_ENVIRONMENT)
  ? process.env.WASM_PARITY_ENVIRONMENT : "studio";
// 跨代参考:T00 S1 Deep 产品页黄金帧(2026-09-27,689×388)。与 wasm 帧的 SSIM/亮度差
// 是 W-2 的量化口径(切片前基线 SSIM 0.035 / wasm 亮度 6.2/255),仅记录不设门禁
// (跨引擎代次+产品特性档差异,bloom/vignette 等不在受控档内)。
const referenceImage = process.env.WASM_PARITY_REFERENCE
  ?? path.join(root, "docs/reports/deep-core/assets/t00-s1-factory-browser-2026-09-27-1024-canvas.png");
const orbitPoses = (process.env.WASM_PARITY_POSES ?? "0,30").split(",").map(Number).filter(Number.isFinite);
const coverageThreshold = 24;              // 亮度>24 视为对象像素(背景 0.018 sRGB ≈ 5/255)
const coverageRelativeTolerance = 0.25;    // G4
const crossSsimThreshold = 0.60;           // G3
const minMeanLuminance = 5;                // G5(0-255;真实黑帧为 0,背景约 13-16)

const deepRequire = createRequire(path.join(root, "packages/deep-engine/package.json"));
const esbuild = deepRequire("esbuild");
await mkdir(output, { recursive: true });
const bundlePath = path.join(output, "wasmParity.bundle.js");
// TS 腿引擎口径:默认用共享工作树的 packages/deep-engine(worktree);设
// WASM_PARITY_ENGINE_SNAPSHOT=head|<commit> 时用 git archive 抽取对应提交的
// deep-engine 快照——黄金样例的 TS Deep WebGPU 渲染在当前 HEAD(aa76dd61)与
// dist 快照上均触发已提交缺陷「material parameter pool 160<192」(r2/r9 实测),
// T00 冻结基线 e616677a 是最后有绿色黄金证据的状态,可用它作为参考腿口径。
// git archive 只读仓库,不触碰共享工作树。
let engineRoot = path.join(root, "packages/deep-engine");
let engineSource = "worktree";
const engineLabDir = (snapshotRoot) => path.join(snapshotRoot, "packages/deep-engine/lab");
const snapshotRef = process.env.WASM_PARITY_ENGINE_SNAPSHOT;
if (snapshotRef && snapshotRef !== "worktree") {
  const snapshotRoot = path.join(output, "engine-head");
  mkdirSync(snapshotRoot, { recursive: true });
  const tarPath = path.join(output, "engine-head.tar");
  const ref = snapshotRef === "head" ? "HEAD" : snapshotRef;
  execSync(`git archive ${ref} packages/deep-engine -o "${tarPath}"`, { cwd: root, stdio: "pipe" });
  // 显式用系统 bsdtar:PATH 里的 GNU tar 会把 "D:" 当远程主机(--force-local 不可靠)。
  const systemTar = process.env.SYSTEMROOT ? `${process.env.SYSTEMROOT}/System32/tar.exe` : "C:/Windows/System32/tar.exe";
  execSync(`"${systemTar}" -xf "${tarPath}" -C "${snapshotRoot}"`, { stdio: "pipe" });
  // git archive 只含已提交文件:探针(本切片新增,未跟踪)与 tsconfig.base 需补进快照;
  // deepBenchmarkBackend.ts 的 W-2 环境口径参数(可选第 5 参)也在本切片引入,随探针同步补入。
  for (const file of ["wasmParityProbe.ts", "wasmParityTypes.ts", "deepBenchmarkBackend.ts"]) {
    await copyFile(path.join(labDir, file), path.join(engineLabDir(snapshotRoot), file));
  }
  await copyFile(path.join(root, "tsconfig.base.json"), path.join(snapshotRoot, "tsconfig.base.json"));
  engineRoot = path.join(snapshotRoot, "packages/deep-engine");
  engineSource = `git-archive:${execSync(`git rev-parse ${ref}`, { cwd: root, encoding: "utf8" }).trim()}`;
}
await esbuild.build({
  absWorkingDir: engineRoot,
  entryPoints: ["lab/wasmParityProbe.ts"],
  bundle: true, format: "esm", platform: "browser", target: "es2022",
  // 快照口径下由包自身 exports(development→src)解析;工作树口径此前切到默认
  // 条件消费 dist 快照。两种口径都在报告 engineSource 中声明。
  ...(engineSource === "worktree" ? {} : { conditions: ["development"] }),
  // 快照树没有自己的 node_modules:three 等依赖沿 worktree 的 pnpm 目录解析
  // (与锁文件同源,两口径共用)。
  nodePaths: [path.join(root, "packages/deep-engine/node_modules"), path.join(root, "node_modules")],
  outfile: bundlePath,
  external: ["/engine-wasm/*"], minify: false, sourcemap: false,
  logLevel: "warning",
});

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".wasm": "application/wasm", ".glb": "model/gltf-binary", ".png": "image/png" };
const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", origin);
  if (url.pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
  let file = null;
  if (url.pathname === "/wasm-parity.html") file = path.join(labDir, "wasmParity.html");
  else if (url.pathname === "/wasmParity.bundle.js") file = bundlePath;
  else if (url.pathname.startsWith("/assets/")) file = path.join(labDir, "assets", url.pathname.slice("/assets/".length));
  else if (url.pathname.startsWith("/engine-wasm/")) file = path.join(wasmDir, url.pathname.slice("/engine-wasm/".length));
  if (!file || !existsSync(file)) { response.writeHead(404).end("not found"); return; }
  try {
    const body = await readFile(file);
    response.writeHead(200, { "content-type": mime[path.extname(file)] ?? "application/octet-stream" });
    response.end(body);
  } catch { response.writeHead(500).end("read failed"); }
});
await new Promise((resolve) => server.listen(Number(new URL(origin).port), "127.0.0.1", resolve));

const report = {
  schema: "wasm-parity-acceptance.v1",
  createdAt: new Date().toISOString(),
  chrome: chromePath, origin, instances, asset, environment, referenceImage, orbitPoses, engineSource,
  thresholds: { crossSsimThreshold, coverageRelativeTolerance, minMeanLuminance, coverageLumaCutoff: coverageThreshold },
  runs: [], gates: {}, passed: false,
};
const browser = await playwright.chromium.launch({ executablePath: chromePath, headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
try {
  for (const orbitDegrees of orbitPoses) {
    const context = await browser.newContext({ viewport: { width: 1_000, height: 1_200 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const errors = [], pageErrors = [], warnings = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
      else if (message.type() === "warning") warnings.push(message.text());
    });
    page.setDefaultTimeout(120_000);
    await page.goto(`${origin}/wasm-parity.html`, { waitUntil: "load" });
    await page.waitForFunction(() => globalThis.__wasmParity?.ready === true, undefined, { timeout: 30_000 });
    const probe = await page.evaluate(async ({ instances, orbitDegrees, asset, environment }) =>
      await globalThis.__wasmParity.run({ instances, orbitDegrees, asset, environment }), { instances, orbitDegrees, asset, environment });
    const webgpuPng = path.join(output, `pose${orbitDegrees}-deep-webgpu.png`);
    const wasmPng = path.join(output, `pose${orbitDegrees}-deep-wasm.png`);
    const webgpuRepeatPng = path.join(output, `pose${orbitDegrees}-deep-webgpu-repeat.png`);
    const wasmRepeatPng = path.join(output, `pose${orbitDegrees}-deep-wasm-repeat.png`);
    await page.locator("#parity-webgpu-canvas").screenshot({ path: webgpuPng });
    await page.locator("#parity-wasm-canvas").screenshot({ path: wasmPng });
    await page.waitForTimeout(400);
    await page.locator("#parity-webgpu-canvas").screenshot({ path: webgpuRepeatPng });
    await page.locator("#parity-wasm-canvas").screenshot({ path: wasmRepeatPng });
    const pixelParity = await compareImageFiles(webgpuPng, wasmPng, `pose${orbitDegrees}-deep-webgpu`, `pose${orbitDegrees}-deep-wasm`);
    // 跨代参考比较:T00 S1 Deep 产品页黄金帧 resize 到画布尺寸后与两腿帧比 SSIM/亮度
    // (W-2 量化口径:亮度/地面观感差距;仅记录,不作门禁)。
    const reference = await compareAgainstReference(wasmPng, webgpuPng, orbitDegrees);
    // 腿内确定性:同腿间隔 400ms 的两张截图 SSIM(T00 fair 同口径,≥0.99 视为稳定)。
    const determinism = {
      webgpu: Number((await compareImageFiles(webgpuPng, webgpuRepeatPng,
        `pose${orbitDegrees}-webgpu`, `pose${orbitDegrees}-webgpu-repeat`)).ssim.toFixed(4)),
      wasm: Number((await compareImageFiles(wasmPng, wasmRepeatPng,
        `pose${orbitDegrees}-wasm`, `pose${orbitDegrees}-wasm-repeat`)).ssim.toFixed(4)),
    };
    const luminance = { webgpu: await meanLuminance(webgpuPng), wasm: await meanLuminance(wasmPng) };
    const coverage = {
      webgpu: await objectCoverage(webgpuPng), wasm: await objectCoverage(wasmPng),
    };
    coverage.relativeDifference = coverage.webgpu >= 0 && coverage.wasm >= 0
      ? Math.abs(coverage.webgpu - coverage.wasm) / Math.max(coverage.webgpu, coverage.wasm) : -1;
    report.runs.push({ orbitDegrees, probe, pixelParity: {
      ssim: Number(pixelParity.ssim.toFixed(4)), meanAbsoluteError: Number(pixelParity.meanAbsoluteError.toFixed(5)),
      changedPixelRatio: Number((pixelParity.changedPixelRatio ?? 0).toFixed(4)) },
      reference, determinism, luminance,
      coverage: { ...coverage, webgpu: Number(coverage.webgpu.toFixed(4)), wasm: Number(coverage.wasm.toFixed(4)),
        relativeDifference: Number(coverage.relativeDifference.toFixed(4)) },
      screenshots: { webgpu: path.basename(webgpuPng), wasm: path.basename(wasmPng),
        webgpuRepeat: path.basename(webgpuRepeatPng), wasmRepeat: path.basename(wasmRepeatPng) },
      pageErrors, consoleErrors: errors, consoleWarnings: warnings });
    await context.close();
  }
} catch (error) {
  report.fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  await browser.close();
  server.close();
}

evaluateGates();
await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
await writeFile(path.join(output, "report.md"), renderMarkdown());
console.log(JSON.stringify({ output, passed: report.passed,
  gates: Object.fromEntries(Object.entries(report.gates).map(([key, gate]) => [key, gate.pass])) }));
process.exitCode = report.passed ? 0 : 1;

async function objectCoverage(pngPath) {
  const { data, info } = await sharp(pngPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  let above = 0;
  for (let index = 0; index < data.length; index++) if (data[index] > coverageThreshold) above++;
  return above / (info.width * info.height);
}

async function meanLuminance(pngPath) {
  const { data } = await sharp(pngPath).greyscale().raw().toBuffer({ resolveWithObject: true });
  let total = 0;
  for (let index = 0; index < data.length; index++) total += data[index];
  return total / data.length;
}

/** T00 参考帧 resize 到实际画布帧尺寸(元素截图含边框,不等于 960×540),与两腿帧各比一次 SSIM。 */
async function compareAgainstReference(wasmPng, webgpuPng, orbitDegrees) {
  if (!existsSync(referenceImage)) return { available: false, reason: `reference image missing: ${referenceImage}` };
  const { width, height } = await sharp(wasmPng).metadata();
  const referencePng = path.join(output, `t00-reference-resized-pose${orbitDegrees}.png`);
  await sharp(referenceImage).resize(width, height, { fit: "fill" }).png().toFile(referencePng);
  const referenceLuminance = await meanLuminance(referencePng);
  const [wasm, webgpu] = await Promise.all([
    compareImageFiles(referencePng, wasmPng, "t00-reference", "wasm"),
    compareImageFiles(referencePng, webgpuPng, "t00-reference", "webgpu"),
  ]);
  return { available: true, referenceSize: `${width}x${height}`,
    referenceLuminance: Number(referenceLuminance.toFixed(2)),
    wasm: { ssim: Number(wasm.ssim.toFixed(4)), meanAbsoluteError: Number(wasm.meanAbsoluteError.toFixed(5)) },
    webgpu: { ssim: Number(webgpu.ssim.toFixed(4)), meanAbsoluteError: Number(webgpu.meanAbsoluteError.toFixed(5)) } };
}

function evaluateGates() {
  const runs = report.runs;
  const g1 = runs.length > 0 && runs.every((run) => run.probe.webgpu && run.probe.wasm
    && run.probe.webgpu.drawCalls > 0 && run.probe.wasm.readyGeneration > 0
    && run.probe.wasm.failureMessage === null);
  report.gates.G1Load = { pass: Boolean(g1), note: "两腿装载成功(drawCalls>0 / ready_generation 前进 / 无 failure)" };
  const g2 = runs.length > 0 && runs.every((run) => {
    const counts = run.probe.fixture?.counts, packet = run.probe.package?.packetCounts;
    if (!counts || !packet || run.probe.wasm?.readyGeneration <= 0) return false;
    // studio-ground 口径向包注入 1 geometry/1 material/1 instance(见 package.groundInjection
    // 显式声明):G2 仍要求「包内容 == fixture + 声明注入」,注入未声明或超额均不合格。
    const injected = run.probe.package?.groundInjection ? 1 : 0;
    return counts.instances + injected === packet.instances && counts.geometries + injected === packet.geometries
      && counts.materials + injected === packet.materials && counts.textures === packet.textures;
  });
  report.gates.G2ObjectList = { pass: Boolean(g2),
    note: environment === "studio-ground"
      ? "runtime package render-packet 计数与 fixture packet + 声明地面注入(1/1/1)一致"
      : "runtime package render-packet 计数与 fixture packet 四元组一致" };
  const g3 = runs.length > 0 && runs.every((run) => run.pixelParity.ssim >= crossSsimThreshold
    && run.coverage.relativeDifference >= 0 && run.coverage.relativeDifference <= coverageRelativeTolerance);
  report.gates.G3CameraGeometry = { pass: Boolean(g3),
    note: `相机 9 元组构造一致 + 跨腿 SSIM ≥ ${crossSsimThreshold} + 对象覆盖率相对差 ≤ ${coverageRelativeTolerance}` };
  const g5 = runs.length > 0 && runs.every((run) => run.luminance.webgpu >= minMeanLuminance
    && run.luminance.wasm >= minMeanLuminance);
  report.gates.G5NoBlackFrame = { pass: Boolean(g5), note: `两腿画面平均亮度 ≥ ${minMeanLuminance}/255(黑帧排除)` };
  const g6 = runs.length > 0 && runs.every((run) => run.pageErrors.length === 0 && run.consoleErrors.length === 0
    && (run.probe.webgpu?.errors.length ?? 1) === 0 && run.probe.wasm?.failureMessage === null
    && run.probe.webgpuError === null && run.probe.wasmError === null && !run.probe.fatal);
  report.gates.G6NoErrors = { pass: Boolean(g6), note: "pageerror/console.error/渲染器错误全空" };
  const g7 = runs.length > 0 && runs.every((run) => run.determinism.webgpu >= 0.99 && run.determinism.wasm >= 0.99);
  report.gates.G7SelfDeterminism = { pass: Boolean(g7), note: "腿内重复截图 SSIM ≥ 0.99(T00 同口径)" };
  report.passed = Object.values(report.gates).every((gate) => gate.pass);
}

function renderMarkdown() {
  const lines = [
    `# Wasm 桥黄金样例对等验收 — ${runId}`, "",
    `- 时间:${report.createdAt};实例数:${instances};位姿:${orbitPoses.join("/")}°;环境口径:${environment}`,
    `- 跨代参考:${path.basename(referenceImage)}(resize 960×540;仅记录,不作门禁)`,
    `- 判据阈值:跨腿 SSIM ≥ ${crossSsimThreshold};覆盖率相对差 ≤ ${coverageRelativeTolerance};亮度 ≥ ${minMeanLuminance}/255`, "",
    "| Gate | 结果 | 说明 |", "|---|---|---|",
    ...Object.entries(report.gates).map(([key, gate]) => `| ${key} | ${gate.pass ? "PASS" : "FAIL"} | ${gate.note} |`),
    "", `**总体:${report.passed ? "PASS" : "FAIL"}**`, "",
  ];
  for (const run of report.runs) {
    lines.push(`## 位姿 ${run.orbitDegrees}°`, "",
      `- 跨腿像素:SSIM ${run.pixelParity.ssim} / MAE ${run.pixelParity.meanAbsoluteError} / changedPixelRatio ${run.pixelParity.changedPixelRatio}`,
      `- 跨代参考(vs T00):wasm SSIM ${run.reference?.wasm?.ssim ?? "n/a"} / webgpu SSIM ${run.reference?.webgpu?.ssim ?? "n/a"} / 参考亮度 ${run.reference?.referenceLuminance ?? "n/a"}`,
      `- 对象覆盖率:webgpu ${run.coverage.webgpu} vs wasm ${run.coverage.wasm}(相对差 ${run.coverage.relativeDifference})`,
      `- 亮度:webgpu ${run.luminance.webgpu.toFixed(2)} / wasm ${run.luminance.wasm.toFixed(2)};腿内确定性 SSIM:webgpu ${run.determinism.webgpu} / wasm ${run.determinism.wasm}`,
      `- TS 腿:drawCalls ${run.probe.webgpu?.drawCalls} / 三角形 ${run.probe.webgpu?.triangles} / 几何占比 ${run.probe.webgpu?.capture.geometryDetailFraction?.toFixed(4)}`,
      `- wasm 腿:ready ${run.probe.wasm?.readyGeneration} / failure ${run.probe.wasm?.failureMessage} / 装载耗时 ${JSON.stringify(run.probe.wasm?.timingsMs)}`,
      `- package:sha256 ${run.probe.package?.sha256?.slice(0, 16)}… / ${run.probe.package?.byteLength} 字节 / packetCounts ${JSON.stringify(run.probe.package?.packetCounts)} / groundInjection ${JSON.stringify(run.probe.package?.groundInjection)}`,
      `- fixture:${run.probe.fixture?.id} / counts ${JSON.stringify(run.probe.fixture?.counts)} / 三角形 ${run.probe.fixture?.triangles}`,
      `- 腿错误:webgpu=${run.probe.webgpuError} wasm=${run.probe.wasmError} fatal=${run.probe.fatal}`,
      `- 页面错误:pageErrors ${run.pageErrors.length} / consoleErrors ${run.consoleErrors.length} / warnings ${run.consoleWarnings.length}`,
      "");
  }
  return lines.join("\n");
}
