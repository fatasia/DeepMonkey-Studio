import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// 独立浏览器只读现有测试项目。AI/登录失败由网络夹具注入，不调用真实模型、不改用户数据。
const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const output = fileURLToPath(new URL("../../../test-output/runs/2026-09-05/ui-report/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { createdAt: new Date().toISOString(), cases: [] };
try {
  for (const theme of ["dark", "light"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ["clipboard-read", "clipboard-write"] });
    // 仅替换这个独立浏览器收到的品牌主题，不写真实品牌设置。
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [], writes = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (["warning", "error"].includes(message.type()) && !message.text().includes("502 (Bad Gateway)")) errors.push(message.text());
    });
    page.on("request", request => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && !/\/api\/(auth\/login|ai\/assistant\/stream)$/.test(request.url())) writes.push(`${request.method()} ${request.url()}`);
    });
    await check(`${theme}-manager`, async () => {
      let releaseMain;
      const blockedMain = new Promise(resolve => { releaseMain = resolve; });
      await page.route("**/src/main.tsx", async route => { await blockedMain; await route.continue(); });
      await page.goto(`${origin}/manager`, { waitUntil: "commit" });
      await page.getByRole("status").filter({ hasText: "正在加载工作台" }).waitFor();
      await page.screenshot({ path: `${output}${theme}-bootstrap.png` });
      releaseMain();
      await page.getByLabel("用户名", { exact: true }).waitFor();
      await page.unroute("**/src/main.tsx");
      await setTheme(page, theme);
      await page.getByLabel("用户名", { exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill("admin");
      await page.route("**/api/auth/login", route => route.fulfill({ status: 502, contentType: "text/plain", body: "Bad Gateway" }));
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByRole("alert").filter({ hasText: "无需修改密码" }).waitFor();
      await page.screenshot({ path: `${output}${theme}-login-502.png` });
      await page.unroute("**/api/auth/login");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.locator(".scene-manager-page").waitFor();
      await page.getByLabel("当前项目").selectOption({ label: "智造综合案例验证" });
      await page.locator(".scene-card").first().waitFor();
      await setTheme(page, theme);
      const layouts = [];
      const surface = await page.locator('.scene-manager-page').evaluate(e => getComputedStyle(e).backgroundColor);
      assert.equal(surface, theme === "light" ? "rgb(237, 242, 244)" : "rgb(11, 17, 20)");
      for (const width of [1440, 980, 800, 480]) {
        await page.setViewportSize({ width, height: 900 });
        const layout = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
          controls: [...document.querySelectorAll('.manager-header nav button')].filter(e => e.checkVisibility()).map(e => {
            const r = e.getBoundingClientRect();
            return { name: e.getAttribute('aria-label'), inside: r.left >= 0 && r.right <= innerWidth, hit: e.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
          }) }));
        assert.ok(layout.scroll <= width + 1, JSON.stringify(layout));
        assert.ok(layout.controls.length >= 10 && layout.controls.every(c => c.inside && c.hit), JSON.stringify(layout));
        await page.screenshot({ path: `${output}${theme}-manager-${width}.png` });
        layouts.push(layout);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.route("**/api/projects/*/scenes/*/publications", route => route.fulfill({ status: 502, contentType: "text/plain", body: "Bad Gateway" }));
      await page.getByRole("button", { name: "版本历史", exact: true }).first().click();
      const history = page.getByRole("dialog", { name: "发布版本", exact: true });
      await history.getByRole("alert").filter({ hasText: "加载失败" }).waitFor();
      assert.equal(await history.getByText("暂无版本记录", { exact: true }).count(), 0);
      await page.screenshot({ path: `${output}${theme}-versions-error.png` });
      await page.unroute("**/api/projects/*/scenes/*/publications");
      await history.getByRole("button", { name: "重新加载", exact: true }).click();
      await history.getByRole("button", { name: "当前发布", exact: true }).waitFor();
      await page.screenshot({ path: `${output}${theme}-versions-legacy.png` });
      await history.getByRole("button", { name: "关闭", exact: true }).click();
      await page.getByRole("button", { name: "数据中心", exact: true }).click();
      await page.getByRole("button", { name: "本机 PostgreSQL 示例 PostgreSQL · bim_studio", exact: true }).waitFor();
      const names = await page.locator(".data-card-main strong").evaluateAll(elements => elements.map(e => ({ name: e.textContent, width: e.clientWidth, scroll: e.scrollWidth })));
      assert.ok(names.length > 0 && names.every(n => n.width >= n.scroll), JSON.stringify(names));
      const monitor = await page.locator(".data-connector-health-panel").boundingBox();
      const firstConnection = await page.locator(".data-resource-card").first().boundingBox();
      assert.ok(monitor && firstConnection && monitor.y < firstConnection.y);
      const monitorContrast = await page.locator('.data-connector-health-panel').evaluate(e => {
        const rgb = value => value.match(/[\d.]+/g).slice(0, 3).map(Number);
        const luminance = value => rgb(value).map(c => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
        const foreground = luminance(getComputedStyle(e.querySelector('strong')).color), background = luminance(getComputedStyle(e).backgroundColor);
        return (Math.max(foreground, background) + .05) / (Math.min(foreground, background) + .05);
      });
      assert.ok(monitorContrast >= 4.5, `监控文字对比度 ${monitorContrast}`);
      await page.screenshot({ path: `${output}${theme}-data-monitor.png` });
      await page.getByRole("button", { name: "返回场景管理", exact: true }).click();
      await page.getByRole("button", { name: "模型优化", exact: true }).click();
      const saveAsset = page.getByRole("button", { name: "保存到项目素材", exact: true });
      assert.ok(await saveAsset.isDisabled());
      assert.ok(await saveAsset.getAttribute("title"));
      assert.equal(await page.locator('.optimizer-page').evaluate(e => getComputedStyle(e).backgroundColor), surface);
      const modelChooser = page.waitForEvent('filechooser');
      await page.getByRole('button', { name: '从文件导入', exact: true }).click();
      assert.ok(await modelChooser);
      await page.screenshot({ path: `${output}${theme}-optimizer-empty.png` });
      await page.getByRole("button", { name: "返回场景管理", exact: true }).click();
      await page.getByRole("button", { name: "示例场景", exact: true }).click();
      await page.getByRole("button", { name: "项目场景", exact: true }).click();
      const menu = page.getByRole("button", { name: "更多场景操作", exact: true }).first();
      await menu.click();
      await page.getByRole("button", { name: "导出场景", exact: true }).first().click();
      await page.getByRole("menuitem").first().press("Escape");
      assert.equal(await page.getByRole("menuitem").count(), 0);
      assert.equal(await page.locator(".scene-card-more[open]").count(), 1);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".scene-card-more[open]").count(), 0);
      await page.getByRole("textbox", { name: "搜索场景", exact: true }).fill("机器人");
      await page.getByLabel("当前项目").selectOption({ label: "QA 回归检查 20260905" });
      await page.waitForFunction(() => document.querySelector('input[aria-label="搜索场景"]')?.value === "");
      await page.getByRole("button", { name: "新建场景", exact: true }).click();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      const chooser = page.waitForEvent("filechooser");
      await page.getByRole("button", { name: "导入", exact: true }).click();
      assert.ok(await chooser, "导入应打开原生文件选择器");
      const previewPromise = context.waitForEvent("page");
      await page.getByRole("button", { name: "预览场景", exact: true }).first().click();
      const preview = await previewPromise;
      await preview.waitForURL(/\/view\//);
      await preview.locator("canvas").first().waitFor({ state: "visible", timeout: 30000 });
      await preview.screenshot({ path: `${output}${theme}-preview-new-tab.png` });
      await preview.close();
      await page.getByRole("button", { name: "AI 助手", exact: true }).click();
      let requests = 0, releaseAi;
      const blockedAi = new Promise(resolve => { releaseAi = resolve; });
      await page.route("**/api/ai/assistant/stream", async route => {
        requests++;
        await blockedAi;
        await route.fulfill({ contentType: "text/event-stream", body: 'event: error\ndata: {"message":"回归夹具：服务暂时不可用"}\n\n' }).catch(() => undefined);
      });
      const prompt = page.getByRole("textbox", { name: "向 AI 助手提问", exact: true });
      await prompt.fill("回归检查等待反馈");
      await prompt.press("Enter");
      await prompt.press("Enter");
      await page.locator(".ai-conversation-turn .ai-user-message").filter({ hasText: "回归检查等待反馈" }).waitFor();
      await page.getByRole("status").filter({ hasText: "正在处理" }).waitFor();
      await page.screenshot({ path: `${output}${theme}-ai-pending.png` });
      releaseAi();
      await page.getByRole("alert").filter({ hasText: "回归夹具" }).waitFor();
      assert.equal(requests, 1, "重复 Enter 不得重复调用 AI");
      await prompt.press("Escape");
      await page.locator(".ai-assistant-panel").waitFor({ state: "hidden" });
      await page.unroute("**/api/ai/assistant/stream");
      assert.deepEqual(writes, []);
      assert.deepEqual(errors, []);
      return { layouts, requests, errors, writes };
    }, page);
    await context.close();
  }
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
assert.ok(report.cases.length === 2 && report.cases.every(c => c.passed), `UI report gate failed: ${output}report.json`);

async function check(id, run, page) {
  const entry = { id, passed: false };
  report.cases.push(entry);
  try { Object.assign(entry, await run(), { passed: true }); }
  catch (error) { entry.error = error.stack; await page.screenshot({ path: `${output}${id}-failed.png` }); }
}
async function setTheme(page, theme) {
  await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
