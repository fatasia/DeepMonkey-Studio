// P3-02 缩窄切片总驱动：同一作者 revision 的两个包变体（A→B：bar 数据+背景色，draft+改动+生产 canonical rehash）
// 驱动 Web 宿主（真实 Chrome WebGPU，DashboardCandidateController+composition host）与
// Native producer 读回管线（DEEP_DASHBOARD_PACKAGE_PATH + producer GPU 测试）各自完成 A→B 提交。
// 断言：取消陈旧（Web 会话 abort 复刻 P0-05 迟到候选语义 + Native 进程级等价证据）、
// 选择联动合同核查（预期：合同不支持，如实记录）、坏包失败隔离（篡改字节双端拒绝且不污染当前可见帧）。
// 产物只落 test-output/p03-02-preview-20260918/；不改生产源码。
// 用法: node_modules/.bin/tsx scripts/verify-p03-02-preview.mts
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runtimeContentSha256, runtimePackageSha256 } from "../packages/deep-engine/src/runtimePackage/hash.js";

const repo = resolve(import.meta.dirname, "..");
const output = resolve(repo, "test-output/p03-02-preview-20260918");
const baseFixturePath = resolve(repo, "packages/deep-engine/fixtures/dashboard-composition-v1.json");
const chromePath = process.env.BIM_STUDIO_CHROME_PATH ?? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const NATIVE_WIDTH = 960, NATIVE_HEIGHT = 540, DIFF_PIXEL_THRESHOLD = 1000;
type FixtureId = "a" | "b" | "b2" | "bad";

function fail(message: string): never { console.error(`P03-02 FAIL: ${message}`); process.exit(1); }
if (!existsSync(chromePath)) fail(`Chrome 不存在: ${chromePath}（可用 BIM_STUDIO_CHROME_PATH 覆盖）`);
if (!existsSync(baseFixturePath)) fail(`fixture 缺失: ${baseFixturePath}`);
const requireFrom = (segment: string) => createRequire(join(repo, segment, "package.json"));
const sharp = requireFrom("apps/web")("sharp") as typeof import("sharp");

// ---------- 1. 变体生成（与 P05 rehashedVariant / P08 fixtures 同语义：draft + 改动 + 生产 canonical rehash） ----------
rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, "fixtures"), { recursive: true });
const base = JSON.parse(readFileSync(baseFixturePath, "utf8")) as Record<string, any>;
function rehash(value: Record<string, any>): void {
  for (const resource of value.resources) resource.contentHash.value = runtimeContentSha256(value.payloads[resource.id]);
  value.packageHash.value = runtimePackageSha256(value);
}
{ // hash 口径守卫（与 P08 同款）：原样 rehash 必须等于 committed 哈希，否则本片所有变体身份不可信
  const canonical = structuredClone(base);
  rehash(canonical);
  if (canonical.packageHash.value !== base.packageHash.value) {
    fail("原样 rehash 后 packageHash 变化：hash 口径与 committed fixture 不对齐，禁止继续");
  }
}
/** 编辑：两个 chart 的 bar 数据行 + static 深2D 背景/面板填色；几何与资源字节不动。 */
function applyEdit(value: Record<string, any>, rows: [[number, number], [number, number]], fill: number[]): void {
  for (const id of ["dashboard.chart.a", "dashboard.chart.b"]) {
    const dataset = value.payloads[id].chart.datasets[0];
    dataset.rows[0][1] = rows[0]![0]; dataset.rows[0][2] = rows[0]![1];
    dataset.rows[1][1] = rows[1]![0]; dataset.rows[1][2] = rows[1]![1];
  }
  for (const id of ["dashboard.static.a", "dashboard.static.b"]) {
    for (const command of value.payloads[id].displayList.commands) {
      if (Array.isArray(command.fill)) command.fill = [...fill];
    }
  }
}
const variantB = structuredClone(base);
applyEdit(variantB, [[6, 0.65], [3, 0.35]], [0.05, 0.52, 0.16, 0.94]);
rehash(variantB);
const variantB2 = structuredClone(base);
applyEdit(variantB2, [[8, 0.5], [5, 0.15]], [0.12, 0.10, 0.55, 0.94]);
rehash(variantB2);
const variantBad = structuredClone(variantB);
variantBad.payloads["dashboard.chart.a"].chart.datasets[0].rows[0][1] = 9.99; // 篡改内容字节，故意不 rehash
const hashes: Record<FixtureId, string> = {
  a: base.packageHash.value, b: variantB.packageHash.value, b2: variantB2.packageHash.value,
  bad: variantBad.packageHash.value, // BAD 声明值仍是 B 的哈希——与内容不符即被双端完整性校验拒绝
};
const fixtureBytes: Record<FixtureId, string> = {
  a: readFileSync(baseFixturePath, "utf8"), // A 保持 committed fixture 原字节
  b: JSON.stringify(variantB), b2: JSON.stringify(variantB2), bad: JSON.stringify(variantBad),
};
if (new Set(Object.values(hashes)).size !== 3) fail(`变体哈希集合异常: ${JSON.stringify(hashes)}`);
for (const [id, json] of Object.entries(fixtureBytes) as [FixtureId, string][]) {
  writeFileSync(join(output, "fixtures", `${id}.json`), json + "\n");
}
const manifest = { fixtures: Object.fromEntries(Object.entries(hashes).map(([id, hash]) => [id, { packageHash: hash }])),
  expectations: { webFailureText: "hash mismatch", nativeFailureText: "runtime package hash mismatch" } };
writeFileSync(join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// ---------- 2. Native producer 读回管线（每跑一次 cargo test，独立捕获目录） ----------
async function rgbaToPng(rgbaPath: string, pngPath: string): Promise<void> {
  const rgba = readFileSync(rgbaPath);
  const raw = await sharp(rgba, { raw: { width: NATIVE_WIDTH, height: NATIVE_HEIGHT, channels: 4 } })
    .removeAlpha().png().toBuffer();
  writeFileSync(pngPath, raw);
}
async function readRgb(path: string): Promise<{ data: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(path).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}
function diffRgb(a: { data: Buffer }, b: { data: Buffer }): number {
  let different = 0;
  for (let offset = 0; offset < a.data.length; offset += 3) {
    if (a.data[offset] !== b.data[offset] || a.data[offset + 1] !== b.data[offset + 1]
      || a.data[offset + 2] !== b.data[offset + 2]) different += 1;
  }
  return different;
}
interface NativeRun { id: string; ok: boolean; ms: number; coloredPages: number[]; captures: string[]; outputTail: string; outputFull?: string }
async function runNative(id: string, fixtureId: FixtureId): Promise<NativeRun> {
  const captureDir = join(output, "native", id);
  mkdirSync(captureDir, { recursive: true });
  const start = Date.now();
  let ok = true, text = "";
  try {
    text = execFileSync("cargo",
      ["test", "--manifest-path", "packages/deep-engine-native/Cargo.toml", "--locked",
        "--bin", "deep-engine-native", "producer_package_renders_real_pixels", "--", "--ignored", "--nocapture"],
      { cwd: repo, encoding: "utf8", timeout: 600_000,
        env: { ...process.env, DEEP_DASHBOARD_PACKAGE_PATH: join(output, "fixtures", `${fixtureId}.json`),
          DEEP_DASHBOARD_CAPTURE_DIR: captureDir } });
  } catch (error) {
    ok = false;
    text = `${(error as { stdout?: Buffer | string }).stdout ?? ""}\n${(error as { stderr?: Buffer | string }).stderr ?? ""}`;
  }
  const ms = Date.now() - start;
  const coloredPages = [...text.matchAll(/producer page (\d+): (\d+) colored pixels/g)]
    .map(match => Number(match[2]));
  const captures: string[] = [];
  const pngNames: Record<string, string> = {
    "producer-page-0": `native-${id}.png`, "producer-page-1": `native-${id}-page1.png`,
  };
  for (const [stem, name] of Object.entries(pngNames)) {
    const rgba = join(captureDir, `${stem}.rgba`);
    if (existsSync(rgba)) {
      await rgbaToPng(rgba, join(output, name));
      captures.push(`${stem}.rgba -> ${name}`);
    }
  }
  return { id, ok, ms, coloredPages, captures, outputTail: text.slice(-400), ...(ok ? {} : { outputFull: text }) };
}
const nativeRuns: NativeRun[] = [];
console.log("native a1 (A 提交)...");
nativeRuns.push(await runNative("a1", "a"));
console.log("native b (B 提交)...");
nativeRuns.push(await runNative("b", "b"));
console.log("native bad (坏包拒绝)...");
nativeRuns.push(await runNative("bad", "bad"));
console.log("native a2 (A 重跑)...");
nativeRuns.push(await runNative("a2", "a"));
const [runA1, runB, runBad, runA2] = nativeRuns;
const nativeAssertions: { name: string; pass: boolean; expected: unknown; actual: unknown }[] = [];
const assertNative = (name: string, pass: boolean, expected: unknown, actual: unknown): void =>
  { nativeAssertions.push({ name, pass, expected, actual }); };
const dimensions = JSON.parse(readFileSync(join(output, "native", "a1", "dimensions.json"), "utf8")) as Record<string, unknown>;
assertNative("native 读回尺寸 960x540 rgba8unorm-srgb",
  dimensions.width === NATIVE_WIDTH && dimensions.height === NATIVE_HEIGHT && dimensions.format === "rgba8unorm-srgb",
  { width: NATIVE_WIDTH, height: NATIVE_HEIGHT, format: "rgba8unorm-srgb" }, dimensions);
assertNative("A 提交（producer 校验+渲染+捕获）", runA1!.ok && runA1!.coloredPages.length >= 1, true,
  { ok: runA1!.ok, coloredPages: runA1!.coloredPages });
assertNative("B 提交（producer 校验+渲染+捕获）", runB!.ok && runB!.coloredPages.length >= 1, true,
  { ok: runB!.ok, coloredPages: runB!.coloredPages });
const nativeA = await readRgb(join(output, "native-a1.png"));
const nativeB = await readRgb(join(output, "native-b.png"));
const nativeA2 = await readRgb(join(output, "native-a2.png"));
assertNative("Native A/B 像素可区分", diffRgb(nativeA, nativeB) > DIFF_PIXEL_THRESHOLD, `>${DIFF_PIXEL_THRESHOLD}`,
  diffRgb(nativeA, nativeB));
assertNative("坏包被拒绝（cargo test 失败）", !runBad!.ok, false, runBad!.ok);
assertNative("坏包错误指向哈希完整性", new RegExp(manifest.expectations.nativeFailureText, "i").test(runBad!.outputFull ?? ""), true,
  (runBad!.outputFull ?? "").match(/runtime package hash mismatch/i)?.[0] ?? "(message absent)");
assertNative("坏包运行无任何帧捕获写出",
  readdirSync(join(output, "native", "bad")).filter(name => name.endsWith(".rgba")).length === 0, 0,
  readdirSync(join(output, "native", "bad")).join(",") || "(empty)");
const nativeA2Page1 = await readRgb(join(output, "native-a2-page1.png"));
assertNative("失败后 A 重跑与首跑逐位一致（page0+page1，不污染）", runA2!.ok
  && diffRgb(nativeA, nativeA2) === 0 && diffRgb(await readRgb(join(output, "native-a1-page1.png")), nativeA2Page1) === 0, 0,
  { ok: runA2!.ok, diffPage0: diffRgb(nativeA, nativeA2), diffPage1: diffRgb(await readRgb(join(output, "native-a1-page1.png")), nativeA2Page1) });

// ---------- 3. Web 宿主（真实 Chrome WebGPU） ----------
const { build } = requireFrom("apps/api")("esbuild") as typeof import("esbuild");
await build({ absWorkingDir: repo, entryPoints: ["scripts/verify-p03-02-preview-page.ts"],
  outfile: join(output, "page.js"), bundle: true, platform: "browser", format: "esm",
  conditions: ["development"], define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });
const pageJs = readFileSync(join(output, "page.js"));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>P03-02 preview verify</title></head>
<body><script type="module" src="/page.js"></script></body></html>`;
writeFileSync(join(output, "page.html"), html + "\n");
const servedFixtures = new Map(Object.entries(fixtureBytes).map(([id, json]) => [id, Buffer.from(json)]));
const server = createServer((request, response) => {
  const path = request.url?.split("?")[0] ?? "/";
  const fixtureMatch = path.match(/^\/fixture\/([\w.-]+)\.json$/);
  const body = path === "/page.js" ? { type: "text/javascript; charset=utf-8", data: pageJs }
    : path === "/manifest.json" ? { type: "application/json; charset=utf-8", data: Buffer.from(JSON.stringify(manifest)) }
    : fixtureMatch && servedFixtures.has(fixtureMatch[1]!) ? { type: "application/json; charset=utf-8", data: servedFixtures.get(fixtureMatch[1]!)! }
    : path === "/page.html" ? { type: "text/html; charset=utf-8", data: Buffer.from(html) } : null;
  if (!body) { response.writeHead(404).end("not found"); return; }
  response.setHeader("content-type", body.type);
  response.end(body.data);
});
await new Promise<void>(ready => server.listen(0, "127.0.0.1", ready));
const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const pnpmRoot = join(repo, "node_modules/.pnpm");
const pwDirName = readdirSync(pnpmRoot).find(name => name.startsWith("playwright-core@"));
if (!pwDirName) fail("node_modules/.pnpm 下未找到 playwright-core");
const { chromium } = await import(pathToFileURL(join(pnpmRoot, pwDirName, "node_modules/playwright-core/index.mjs")).href);
const browser = await chromium.launch({ executablePath: chromePath, headless: true, args: ["--enable-unsafe-webgpu"] });
let web: any;
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", error => console.error("pageerror:", String(error).slice(0, 400)));
  page.on("requestfailed", request => console.error("requestfailed:", request.url(), request.failure()?.errorText));
  page.on("response", response => { if (response.status() >= 400) console.error(`http ${response.status()}:`, response.url()); });
  page.on("console", message => console.error(`console.${message.type()}:`, message.text().slice(0, 400)));
  await page.goto(baseUrl + "/page.html", { waitUntil: "load", timeout: 30_000 });
  try {
    await page.waitForFunction(() => (window as any).__P0302_RESULT !== undefined, null, { timeout: 240_000 });
  } catch (error) {
    console.error("diagnostics:", await page.evaluate(() => ({
      readyState: document.readyState, result: (window as any).__P0302_RESULT ?? null })), String(error).slice(0, 200));
    throw error;
  }
  web = await page.evaluate(() => (window as any).__P0302_RESULT);
} finally {
  await browser.close();
  server.close();
}
if (!web || typeof web.ok !== "boolean") fail(`Web 宿主无有效结果（stage=${web?.stage ?? "?"}）: ${web?.message ?? JSON.stringify(web)?.slice(0, 300)}`);
const webScenarios = (web.scenarios ?? []) as any[];

// ---------- 4. 落盘证据 ----------
const webFrames: string[] = [];
for (const scenario of webScenarios) {
  for (const [name, dataUrl] of Object.entries(scenario.frames ?? {}) as [string, string][]) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/png;base64,")) continue;
    writeFileSync(join(output, name), Buffer.from(dataUrl.slice("data:image/png;base64,".length), "base64"));
    webFrames.push(name);
  }
}
// 跨端像素对（信息性，不做门槛判定——跨端像素相等归 P0-08 管辖）
const { compareImageFiles } = await import(pathToFileURL(resolve(repo, "apps/web/scripts/renderImageSimilarity.mjs")).href);
const pairs: Record<string, unknown> = {};
for (const [pairName, nativeFile, webFile] of [
  ["A", "native-a1.png", "web-w1-A.png"], ["B", "native-b.png", "web-w1-B.png"],
] as [string, string, string][]) {
  if (existsSync(join(output, nativeFile)) && existsSync(join(output, webFile))) {
    try {
      const comparison = await compareImageFiles(join(output, nativeFile), join(output, webFile), `native-${pairName}`, `web-${pairName}`);
      pairs[pairName] = { ssim: comparison.ssim, changedPixelRatio: comparison.changedPixelRatio, informational: "跨端像素相等归 P0-08，此处仅记录" };
    } catch (error) {
      pairs[pairName] = { error: String(error).slice(0, 200) };
    }
  }
}
const nativeOk = nativeAssertions.every(assertion => assertion.pass);
const result = {
  generatedAt: "2026-09-18",
  purpose: "P3-02 缩窄切片：同一作者 revision 驱动 Web 与 Native 双端预览（取消陈旧/选择联动核查/失败隔离）",
  fixtures: { hashes, bytes: Object.fromEntries(Object.entries(fixtureBytes).map(([id, json]) => [id, json.length])),
    edit: "B/B′=bar 数据行+static 背景填色；BAD=B 篡改 chart 行值且不 rehash" },
  native: { pipeline: "cargo test --bin deep-engine-native producer_package_renders_real_pixels -- --ignored（Rgba8UnormSrgb 960x540 读回）",
    runs: nativeRuns.map(({ id, ok, ms, coloredPages, captures }) => ({ id, ok, ms, coloredPages, captures })),
    assertions: nativeAssertions, badOutputTail: (runBad!.outputFull ?? "").slice(-1200) },
  web: { ok: web.ok, adapter: web.adapter, canvasFormat: web.canvasFormat,
    scenarios: webScenarios, observations: web.observations ?? null,
    failure: web.ok ? null : { stage: web.stage, message: web.message }, frames: webFrames },
  crossEndPairs: pairs,
  totals: {
    ok: nativeOk && web.ok === true,
    nativeAssertions: nativeAssertions.length,
    webChecks: webScenarios.reduce((sum, scenario) => sum + scenario.checks.length, 0),
    webChecksFailed: webScenarios.reduce((sum, scenario) => sum + scenario.checks.filter((check: any) => !check.pass).length, 0),
  },
  boundaries: [
    "真实编辑器 UI 会话不做（宿主/producer 直驱）",
    "Three/场景通道与真实 OS 窗口交互归后续",
    "Native 读回管线为进程级同步，无在途编译窗口；陈旧取消的 Native 在途语义（候选抢占）已有 native-full-retry-reuse-2026-09-17 证据，本片以进程级等价（坏包无捕获写出+A 重跑逐位一致）佐证",
    "选择联动：候选状态合同不支持选择迁移（见 web.observations.selectionContract），留待 G01",
  ],
};
writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");

// ---------- 5. 摘要与退出 ----------
console.log(`\nNative 轨迹: A(committed, ${runA1!.coloredPages.join("/")}) -> B(committed, ${runB!.coloredPages.join("/")})`
  + ` -> BAD(rejected, 无捕获) -> A(committed, 逐位一致)`);
for (const assertion of nativeAssertions) {
  if (!assertion.pass) console.log(`  NATIVE FAIL ${assertion.name}: expected=${JSON.stringify(assertion.expected)} actual=${JSON.stringify(assertion.actual)}`);
}
for (const scenario of webScenarios) {
  console.log(`${scenario.id} :: ${scenario.ok ? "PASS" : "FAIL"} (${scenario.steps.map((step: any) => step.name).join(" -> ")})`);
  for (const check of scenario.checks as any[]) {
    if (!check.pass) console.log(`  FAIL ${check.name}: expected=${JSON.stringify(check.expected)} actual=${JSON.stringify(check.actual)}`);
  }
}
console.log(`P03-02: ${result.totals.ok ? "committed" : "FAILED"}; native assertions=${nativeAssertions.length}`
  + `, web checks failed=${result.totals.webChecksFailed}/${result.totals.webChecks}`);
console.log(`output: ${output}`);
if (!result.totals.ok) fail("断言未全过（明细见上方 FAIL 行与 result.json）");
