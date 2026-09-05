import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const output = fileURLToPath(new URL("../../../test-output/codex-2026-09-05/report-final/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { createdAt: new Date().toISOString(), cases: [] };
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, errors: [], writes: [], checks: [] };
    report.cases.push(entry);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/**", async route => {
      const request = route.request();
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && new URL(request.url()).pathname !== "/api/auth/login") {
        await route.fulfill({ status: 409, json: { message: "QA 已拦截非预期业务写请求" } });
        return;
      }
      await route.fallback();
    });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) entry.errors.push(message.text()); });
    page.on("request", request => {
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && !request.url().endsWith("/api/auth/login")) entry.writes.push(`${request.method()} ${request.url()}`);
    });
    const shot = name => page.screenshot({ path: `${output}${theme}-${width}-${name}.png` });
    const color = locator => locator.evaluate(node => getComputedStyle(node).backgroundColor);
    const assertTheme = async locator => {
      const rgb = (await color(locator)).match(/[\d.]+/g).slice(0, 3).map(Number);
      assert.equal(rgb.reduce((sum, value) => sum + value, 0) / 3 > 170, theme === "light");
    };
    try {
      await page.goto(`${origin}/manager`);
      await page.getByRole("textbox", { name: "用户名", exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill("admin");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByLabel("当前项目").selectOption({ label: "智造综合案例验证" });
      const primary = await color(page.getByRole("button", { name: "新建场景", exact: true }));
      assert.ok(await page.locator(".scene-card-meta").first().getAttribute("title"));
      await page.locator('summary[aria-label="项目管理"]').click();
      await page.getByRole("button", { name: "新建项目", exact: true }).click();
      const longName = "产线".repeat(110);
      await page.getByRole("textbox", { name: "项目名称", exact: true }).fill(longName);
      assert.equal(await page.getByRole("textbox", { name: "项目名称", exact: true }).inputValue(), longName);
      assert.match(await page.locator("#project-name-hint").innerText(), /220 字符.*完整名称会保留/);
      await shot("project-long-name-guidance");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "重命名场景", exact: true }).first().click();
      await page.getByRole("textbox", { name: "场景名称", exact: true }).fill(longName);
      assert.match(await page.locator("#scene-name-hint").innerText(), /220 字符.*完整名称会保留/);
      await shot("scene-long-name-guidance");
      await page.getByRole("button", { name: "取消", exact: true }).click();
      entry.checks.push("project-scene-long-name-guidance-no-truncation");
      const published = page.locator(".scene-card").filter({ has: page.getByRole("button", { name: "1", exact: true }) }).first();
      const cdp = await context.newCDPSession(page);
      const { targetInfo } = await cdp.send("Target.getTargetInfo");
      const clipboardPermission = async setting => {
        for (const allowWithoutSanitization of [true, false]) await cdp.send("Browser.setPermission", { permission: { name: "clipboard-write", allowWithoutSanitization }, setting, origin, browserContextId: targetInfo.browserContextId });
      };
      await clipboardPermission("denied");
      await published.getByRole("button", { name: "更多场景操作", exact: true }).click();
      await published.getByRole("button", { name: "复制发布链接", exact: true }).click();
      await page.getByText("复制失败，请检查浏览器剪贴板权限后重试", { exact: true }).waitFor();
      assert.equal(await published.locator("details[open]").count(), 0);
      await shot("clipboard-denied");
      entry.checks.push("clipboard-denied-feedback-and-menu-close");
      await clipboardPermission("granted");
      await published.getByRole("button", { name: "更多场景操作", exact: true }).click();
      await published.getByRole("button", { name: "复制发布链接", exact: true }).click();
      await page.getByText("链接已复制", { exact: true }).waitFor();
      entry.checks.push("clipboard-retry-success");
      await page.getByRole("button", { name: "拓扑", exact: true }).click();
      assert.equal(await color(page.getByRole("button", { name: "新建拓扑", exact: true })), primary);
      const preview = page.locator(".manager-topology-preview").first();
      assert.equal(await preview.locator("[data-node]").count(), 5);
      assert.equal(await preview.locator("[data-edge]").count(), 5);
      await shot("topology-real-preview");
      entry.checks.push("topology-real-geometry-and-primary-color");
      await page.getByRole("button", { name: "视觉中心", exact: true }).click();
      const newTask = page.getByRole("button", { name: "新建任务", exact: true });
      await newTask.waitFor();
      assert.equal(await color(newTask), primary);
      entry.checks.push("vision-primary-action-consistent");
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "服务健康", exact: true }).click();
      const details = page.locator(".system-health-detail").first();
      await details.locator("summary").focus();
      await page.keyboard.press("Enter");
      assert.notEqual(await details.getAttribute("open"), null);
      assert.ok((await details.locator("pre").innerText()).length > 0);
      await assertTheme(page.locator(".system-center-page"));
      await assertTheme(page.locator(".system-health-grid article").first());
      await shot("health-keyboard-details");
      entry.checks.push("health-keyboard-full-diagnostic");
      await page.getByRole("button", { name: "审计与日志", exact: true }).click();
      await page.getByRole("textbox", { name: "关键词", exact: true }).fill("vite");
      await Promise.all([
        page.waitForResponse(response => response.url().includes("/api/admin/service-logs?") && response.url().includes("keyword=vite") && response.status() === 200),
        page.getByRole("button", { name: "查询", exact: true }).click(),
      ]);
      await page.getByRole("button", { name: "查询", exact: true }).waitFor();
      assert.doesNotMatch(await page.locator(".system-log-table").innerText(), /\u001b\[|\[(?:2m|22m|36m|39m|1m|0m)/);
      await shot("logs-clean");
      entry.checks.push("real-vite-logs-no-ansi");
      await page.goto(`${origin}/operations?task=energy`);
      await page.getByText("单位产量能耗", { exact: true }).waitFor();
      const energy = await page.locator(".operations-energy-grid").boundingBox();
      const form = await page.locator(".operations-energy-grid > section").boundingBox();
      assert.ok(energy && form && Math.abs(energy.width - form.width) < 2);
      const tabWraps = await page.locator(".operations-tabs button").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).whiteSpace));
      assert.ok(tabWraps.every(value => value === "nowrap"));
      await page.getByRole("button", { name: "临时 CSV", exact: true }).click();
      const csvBounds = await page.getByRole("textbox", { name: "临时能耗 CSV 数据", exact: true }).boundingBox();
      assert.ok(csvBounds.x + csvBounds.width < form.x + form.width, "CSV input must not be clipped by the panel");
      assert.equal(await page.getByRole("button", { name: "分析能耗", exact: true }).isDisabled(), true);
      await shot("energy-balanced-empty");
      entry.checks.push("energy-single-column-empty-state");
      await page.goto(`${origin}/manager`);
      await page.getByRole("button", { name: "AI 助手", exact: true }).click();
      const catalog = page.locator(".ai-capability-catalog:not(.is-loading)");
      await catalog.waitFor();
      for (const chipWidth of [width, 480]) {
        await page.setViewportSize({ width: chipWidth, height: 900 });
        const chips = catalog.locator("div > [title]");
        assert.ok(await chips.count() > 0);
        const bounds = await chips.evaluateAll(nodes => nodes.map(node => {
          const name = node.querySelector("strong"), policy = node.querySelector("small");
          return { title: node.title, nameReadable: name.getBoundingClientRect().width >= Math.min(80, name.scrollWidth) - 1, policyFits: policy.scrollWidth <= policy.clientWidth + 1, inPage: node.getBoundingClientRect().right <= innerWidth };
        }));
        assert.ok(bounds.every(chip => chip.title && chip.nameReadable && chip.policyFits && chip.inPage), JSON.stringify(bounds));
        await catalog.scrollIntoViewIfNeeded();
        await shot(`ai-chips-${chipWidth}`);
      }
      await page.setViewportSize({ width, height: 900 });
      await page.keyboard.press("Escape");
      entry.checks.push("all-visible-ai-chips-480-policy-and-name-readable");
      await page.goto(`${origin}/qa-page-that-does-not-exist`);
      await page.getByText("页面不存在，已返回项目工作台", { exact: true }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/manager");
      await shot("route-fallback-notice");
      entry.checks.push("unknown-route-notice");
      await page.getByRole("button", { name: "关闭页面提示", exact: true }).click();
      assert.equal(await page.getByText("页面不存在，已返回项目工作台", { exact: true }).count(), 0);
      entry.checks.push("route-notice-dismiss");
      assert.deepEqual(entry.writes, []);
      assert.deepEqual(entry.errors, []);
      entry.passed = true;
    } catch (error) {
      entry.failure = String(error);
      await shot("failed");
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
