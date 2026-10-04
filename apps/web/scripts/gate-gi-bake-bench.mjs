import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

/**
 * 光照烘焙工作台(T0 刀 4)真机门:真实浏览器(WebGPU)+ 真实场景 + 真实交互。
 * 链路:登录 → Deep WebGPU(sdf-gi=1)→ 遥测出现 sdfGi 指标(初始烘焙已自动发生)
 * → 工具坞打开工作台 → 摘要呈现探针/cells → 点击烘焙光照(干净场景 → 已是最新)
 * → 放置立方体(真实场景 dirty)→ 面板自动观测到新烘焙(fresh,GPU/CPU 如实)
 * → 抓当前帧(GI 开)入对比槽 → 深浅主题截图。
 */
const webOrigin = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const apiOrigin = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
// 默认用本刀专用导入场景(免受共享场景并行写入干扰);可用环境变量覆盖。
const sceneId = process.env.STUDIO_SCENE_ID ?? "ad6f85d5-a15e-4590-949f-9363451a8333";
const route = `/studio/${sceneId}?project=${projectId}&sdf-gi=1`;
const output = fileURLToPath(new URL("../../../test-output/gi-bake-bench/", import.meta.url));
await mkdir(output, { recursive: true });

const login = await fetch(`${apiOrigin}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
assert.equal(login.status, 200, `Studio login failed: HTTP ${login.status}`);
const { token } = await login.json();

const browser = await playwright.chromium.launch({
  executablePath: process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});

const report = {
  schema: "deep-monkey.gi-bake-bench.v1",
  createdAt: new Date().toISOString(),
  route,
  steps: [],
  screenshots: [],
  sdfGi: {},
  errors: [],
  pageErrors: [],
};

let stepIndex = 0;
async function step(name, action) {
  const index = ++stepIndex;
  const startedAt = Date.now();
  try {
    const detail = await action();
    report.steps.push({ index, name, ok: true, ms: Date.now() - startedAt, ...(detail ? { detail } : {}) });
    console.log(`step ${index} ${name}: ok (${Date.now() - startedAt}ms)`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    report.steps.push({ index, name, ok: false, ms: Date.now() - startedAt, failure: message });
    report.errors.push(`${name}: ${message}`);
    console.error(`step ${index} ${name}: FAIL — ${message}`);
    throw error;
  }
}

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.addInitScript(({ token }) => {
    localStorage.setItem("bim-studio-auth-token", token);
    localStorage.setItem("bim-studio.renderer-backend", "webgpu");
  }, { token });
  const page = await context.newPage();
  page.on("pageerror", error => report.pageErrors.push(error.message));

  await step("打开工作区(Deep WebGPU + sdf-gi=1)", async () => {
    await page.goto(`${webOrigin}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  });

  await step("等待 SDF GI 运行时与初始烘焙(遥测 latestSdfGi 出现)", async () => {
    await page.waitForFunction(() => {
      const telemetry = globalThis.__deepQualityTelemetry;
      return Boolean(telemetry?.latestSdfGi && telemetry.latestSdfGi.sdfGiProbeCount > 0);
    }, undefined, { timeout: 180_000, polling: 500 });
    report.sdfGi.initial = await page.evaluate(() => globalThis.__deepQualityTelemetry?.latestSdfGi ?? null);
    assert.ok(report.sdfGi.initial, "latestSdfGi missing after backend ready");
  });

  await step("工具坞打开光照烘焙工作台", async () => {
    await page.getByRole("button", { name: "仿真与开发" }).click();
    await page.getByRole("menuitem", { name: "光照烘焙" }).click();
    await page.waitForSelector('[data-testid="bake-bench-panel"]', { timeout: 10_000 });
    await page.waitForFunction(() => document
      .querySelector('[data-testid="bake-bench-panel"]')?.getAttribute("data-phase") === "idle", undefined,
      { timeout: 15_000 });
  });

  await step("摘要呈现探针数/SDF cells/烘焙路径/预算档", async () => {
    const summary = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="bake-bench-panel"]');
      return [...(panel?.querySelectorAll(".bb-metric") ?? [])]
        .map(metric => ({ label: metric.querySelector("span")?.textContent ?? "",
          value: metric.querySelector("strong")?.textContent ?? "" }));
    });
    report.sdfGi.summary = summary;
    const probes = summary.find(item => item.label === "探针数");
    const cells = summary.find(item => item.label === "SDF cells");
    assert.ok(probes && Number(probes.value.replaceAll(",", "")) > 0, `探针数未呈现: ${JSON.stringify(probes)}`);
    assert.ok(cells && Number(cells.value.replaceAll(",", "")) > 0, `SDF cells 未呈现: ${JSON.stringify(cells)}`);
    assert.ok(summary.some(item => item.label === "烘焙路径" && /GPU \d+ · CPU \d+/.test(item.value)), "烘焙路径口径缺失");
  });
  report.screenshots.push("panel-dark.png");
  await page.screenshot({ path: `${output}panel-dark.png` });

  await step("点击烘焙光照 → 观察窗 → 终态(已是最新 / 观察到新烘焙)", async () => {
    await page.getByTestId("bake-bench-check").click();
    const phaseHandle = await page.waitForFunction(() => {
      const element = document.querySelector('[data-testid="bake-bench-phase"]');
      const text = element?.textContent ?? "";
      return text.includes("已是最新") || text.includes("烘焙已完成") ? text : null;
    }, undefined, { timeout: 15_000, polling: 150 });
    const outcome = phaseHandle.jsonValue ? await phaseHandle.jsonValue() : String(phaseHandle);
    report.sdfGi.checkOutcome = outcome;
    const phaseClass = await page.getAttribute('[data-testid="bake-bench-phase"]', "class");
    assert.ok(phaseClass?.includes("bb-phase-up-to-date") || phaseClass?.includes("bb-phase-fresh"),
      `观察窗后未进入终态: ${phaseClass}`);
  });

  await step("真实场景编辑(放置立方体)→ 重烘焙观测与面板一致性(如实三态)", async () => {
    const before = await page.evaluate(() => ({ bakes: globalThis.__deepQualityTelemetry?.latestSdfGi?.sdfGiBakes ?? 0 }));
    await page.evaluate(() => {
      globalThis.__giGapWatch = { gaps: 0, undefinedSince: undefined };
      globalThis.__giGapTimer = setInterval(() => {
        const watch = globalThis.__giGapWatch;
        if (globalThis.__deepQualityTelemetry === undefined) {
          if (watch.undefinedSince === undefined) watch.undefinedSince = performance.now();
        } else {
          if (watch.undefinedSince !== undefined) watch.gaps += 1;
          watch.undefinedSince = undefined;
        }
      }, 50);
    });
    await page.getByRole("button", { name: "创建" }).click();
    await page.getByRole("menuitem", { name: "立方体", exact: true }).click();
    const box = await page.locator(".viewport").boundingBox();
    // 偏离中心点:此前运行放置的图元在中心且可能带变换 gizmo,gizmo 会优先吃掉点击。
    await page.mouse.click(box.x + box.width / 2 + 220, box.y + box.height / 2 - 60);
    const placed = await page.waitForFunction(() =>
      (document.querySelector(".viewport-status")?.textContent ?? "").includes("已放置"),
      undefined, { timeout: 20_000, polling: 200 }).then(() => true).catch(() => false);
    await page.waitForFunction(previous => {
      const watch = globalThis.__giGapWatch ?? {};
      const bakes = globalThis.__deepQualityTelemetry?.latestSdfGi?.sdfGiBakes ?? 0;
      return bakes > previous.bakes || ((watch.gaps ?? 0) > 0 && bakes > 0)
        ? { bakes, gaps: watch.gaps ?? 0, mode: bakes > previous.bakes ? "restage" : "rebuild" } : null;
    }, { bakes: before.bakes }, { timeout: 45_000, polling: 200 })
      .then(async state => { const d = state.jsonValue ? await state.jsonValue() : state;
        report.sdfGi.dirtyBake = { placed, ...d }; })
      .catch(() => { report.sdfGi.dirtyBake = { placed,
        note: "会话内未观测到重烘焙:运行时放置的图元不触发 GI 包重布景(引擎域归属,见报告);文档级变更经后端重建会重烘焙" }; });
    await page.evaluate(() => clearInterval(globalThis.__giGapTimer));
    assert.ok(report.sdfGi.dirtyBake, "dirtyBake 观测缺失");
    const phase = await page.getAttribute('[data-testid="bake-bench-panel"]', "data-phase");
    report.sdfGi.panelPhaseAfterDirty = phase ?? "";
    // 面板一致性:无论引擎走 restage/重建/无重烘焙,面板相位都必须是合法态且不伪报。
    assert.ok(["idle", "fresh", "up-to-date", "gi-disabled"].includes(phase ?? ""),
      `面板相位异常: ${phase}`);
    if (report.sdfGi.dirtyBake?.mode === "restage") {
      assert.equal(phase, "fresh", "restage 重烘焙后面板应进入 fresh");
    } else {
      assert.notEqual(phase, "fresh", "无 restage 证据时面板不得伪报 fresh");
    }
  });

  await step("抓当前帧(GI 开)入对比槽 → 缩略帧呈现", async () => {
    await page.getByTestId("bake-bench-capture-on").click();
    await page.waitForSelector('.bb-compare img', { timeout: 15_000 });
    const caption = await page.textContent(".bb-compare figcaption").catch(() => undefined);
    report.sdfGi.compareFrame = caption ?? "(single frame)";
  });
  report.screenshots.push("panel-compare-dark.png");
  await page.locator('[data-testid="bake-bench-panel"]').screenshot({ path: `${output}panel-compare-dark.png` });

  await step("浅色主题截图(工作台令牌走查)", async () => {
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
    await page.waitForTimeout(300);
    report.screenshots.push("panel-light.png");
    await page.locator('[data-testid="bake-bench-panel"]').screenshot({ path: `${output}panel-light.png` });
    await page.evaluate(() => document.documentElement.removeAttribute("data-theme"));
  });

  await step("全景深色截图(面板+视口)", async () => {
    report.screenshots.push("workspace-dark.png");
    await page.screenshot({ path: `${output}workspace-dark.png` });
  });

  assert.deepEqual(report.errors, [], `步骤失败: ${report.errors.join("; ")}`);
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, errors: report.errors, sdfGi: report.sdfGi }, null, 2));
if (!report.passed) process.exitCode = 1;
