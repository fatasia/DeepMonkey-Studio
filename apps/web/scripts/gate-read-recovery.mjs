import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const gate = await createIsolatedStudioGate("read-recovery");
const report = { createdAt: new Date().toISOString(), cases: [] };
const accent = process.env.STUDIO_QA_ACCENT ?? "#d6aa4d";
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["light", 980], ["dark", 1280]]) {
    const project = await gate.json("POST", "/api/projects", { name: `断连验收-${round}-${theme}` });
    const before = await gate.json("GET", `/api/projects/${project.id}`);
    const entry = { round, theme, width, passed: false, errors: [], expectedFaultConsole: [], writes: [], counts: {} };
    report.cases.push(entry);
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme, primaryColor: accent } }); });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      if (/Failed to load resource.*(?:503|401|ERR_CONNECTION_RESET)/.test(message.text())) entry.expectedFaultConsole.push(message.text());
      else entry.errors.push(message.text());
    });
    let mode = "healthy", count = 0, postCount = 0, directoryFault = "", directoryCount = 0;
    const path = "**/api/projects";
    await page.route(path, async route => {
      if (route.request().method() === "POST") {
        postCount++;
        if (postCount === 1) return route.fulfill({ status: 503, json: { message: "隔离门禁：保存暂不可用，请手动重试" } });
        return route.continue();
      }
      if (route.request().method() !== "GET") return route.continue();
      count++;
      if (mode === "network" && count === 1) return route.abort("connectionreset");
      if ((mode === "transient" && count === 1) || mode === "unavailable") return route.fulfill({ status: 503, json: { message: "隔离门禁：目录暂不可用" } });
      if (mode === "unauthorized") return route.fulfill({ status: 401, json: { message: "隔离门禁：读取权限需复核" } });
      return route.continue();
    });
    for (const kind of ["scenes", "applications"]) await page.route(`**/api/projects/*/${kind}`, async route => {
      if (directoryFault !== kind || route.request().method() !== "GET") return route.continue();
      directoryCount++;
      return route.fulfill({ status: 503, json: { message: "隔离门禁：子目录暂不可用" } });
    });
    const selected = async () => {
      await page.locator(`select[aria-label="当前项目"] option[value="${project.id}"]`).waitFor({ state: "attached" });
      assert.equal(await page.getByLabel("当前项目", { exact: true }).inputValue(), project.id);
      assert.equal(await page.locator('input[type="password"]').count(), 0);
    };
    const ready = async () => {
      await selected();
      await page.locator(".manager-directory-state").waitFor({ state: "detached" });
    };
    const directoryError = async kind => {
      const alert = page.locator(".manager-directory-state.is-error");
      await alert.getByRole("heading", { name: `${kind}目录暂时无法读取`, exact: true }).waitFor();
      assert.equal(await page.getByRole("heading", { name: "还没有场景", exact: true }).count(), 0);
      assert.equal(await page.getByRole("heading", { name: "还没有项目", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "新建第一个场景", exact: true }).count(), 0);
      const contrast = await alert.evaluate(collectTextContrast, "h2, p, small, button");
      assert.deepEqual(contrast.filter(item => item.contrast < 4.5), []);
      entry.directoryContrast = contrast;
      return alert;
    };
    const screenshot = async label => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${label}.png`) });
    };
    try {
      await gate.loginPage(page);
      page.on("request", request => { if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) entry.writes.push({ path: new URL(request.url()).pathname, method: request.method() }); });
      for (const transient of ["transient", "network"]) {
        mode = transient; count = 0;
        await page.goto(`${gate.origin}/manager?project=${project.id}`); await ready();
        assert.equal(count, 2); entry.counts[transient] = count;
        assert.equal(await page.locator(".toast.error").count(), 0);
        await screenshot(`${transient}-recovered`);
      }
      mode = "unavailable"; count = 0; await page.reload();
      await directoryError("项目");
      await page.waitForTimeout(5200); await directoryError("项目");
      assert.equal(count, 2); entry.counts.unavailable = count;
      assert.equal(await page.locator('input[type="password"]').count(), 0);
      await screenshot("exhausted-error-keeps-session");
      mode = "healthy"; count = 0;
      let release, started;
      const held = new Promise(resolve => { release = resolve; }), waiting = new Promise(resolve => { started = resolve; });
      const holdRead = async route => { started(); await held; await route.fallback(); };
      await page.route(path, holdRead);
      const retryBounds = await page.getByRole("button", { name: "重新读取", exact: true }).boundingBox();
      assert.ok(retryBounds);
      await page.mouse.dblclick(retryBounds.x + retryBounds.width / 2, retryBounds.y + retryBounds.height / 2);
      await waiting; await page.locator(".manager-directory-state.is-loading").waitFor();
      await screenshot("manual-retry-loading"); release();
      await ready(); await page.unroute(path, holdRead);
      assert.equal(count, 1); entry.counts.manualRetry = count;
      mode = "unauthorized"; count = 0; await page.reload();
      await directoryError("项目");
      await page.waitForTimeout(800); assert.equal(count, 1); entry.counts.unauthorized = count;
      assert.equal(await page.locator('input[type="password"]').count(), 0);
      await screenshot("401-not-replayed-session-rechecked");
      mode = "healthy"; await page.reload(); await ready();
      for (const [kind, label] of [["scenes", "场景"], ["applications", "应用"]]) {
        directoryFault = kind; directoryCount = 0; await page.reload();
        await directoryError(label); await page.waitForTimeout(800);
        assert.equal(directoryCount, 2); entry.counts[kind] = directoryCount;
        await screenshot(`${kind}-error-not-empty`); directoryFault = "";
        await page.getByRole("button", { name: "重新读取", exact: true }).focus(); await page.keyboard.press("Enter"); await ready();
      }
      await page.locator('summary[aria-label="项目管理"]').click();
      await page.getByRole("button", { name: "新建项目", exact: true }).click();
      await page.getByLabel("项目名称", { exact: true }).fill(`手动重试-${round}-${theme}`);
      await page.getByRole("button", { name: "创建并切换", exact: true }).hover();
      const createContrast = await page.locator(".dialog").evaluate(collectTextContrast, ".button.primary");
      assert.equal(createContrast.length, 1); assert.ok(createContrast[0].contrast >= 4.5, JSON.stringify(createContrast));
      entry.projectPrimaryContrast = createContrast;
      await page.getByRole("button", { name: "创建并切换", exact: true }).click();
      await page.locator(".toast.error").filter({ hasText: "隔离门禁：保存暂不可用" }).waitFor();
      await page.waitForTimeout(800); assert.equal(postCount, 1);
      assert.equal(await page.getByLabel("项目名称", { exact: true }).inputValue(), `手动重试-${round}-${theme}`);
      await screenshot("write-failure-draft-preserved");
      await page.getByRole("button", { name: "创建并切换", exact: true }).click();
      await page.locator(".dialog-backdrop").waitFor({ state: "detached" });
      await page.locator(".manager-directory-state").waitFor({ state: "detached" });
      assert.notEqual(await page.getByLabel("当前项目", { exact: true }).inputValue(), project.id);
      assert.equal(await page.locator(".toast.error").count(), 0, "Successful explicit retry must not leave the old failure visible");
      assert.equal(postCount, 2); entry.counts.explicitWriteRetry = postCount;
      const toolbarCreate = page.getByRole("button", { name: "新建场景", exact: true });
      const emptyCreate = page.getByRole("button", { name: "新建第一个场景", exact: true });
      assert.equal(await toolbarCreate.evaluate(button => button.classList.contains("primary")), false);
      assert.equal(await emptyCreate.evaluate(button => button.classList.contains("primary")), true);
      assert.notEqual(await toolbarCreate.evaluate(button => getComputedStyle(button).backgroundColor), await emptyCreate.evaluate(button => getComputedStyle(button).backgroundColor));
      entry.primaryContrast = [];
      for (const interaction of ["idle", "hover", "focus"]) {
        if (interaction === "idle") await page.mouse.move(0, 0);
        if (interaction === "hover") await emptyCreate.hover();
        if (interaction === "focus") { await page.mouse.move(0, 0); await emptyCreate.focus(); }
        const contrast = await page.locator(".manager-empty").evaluate(collectTextContrast, ".button.primary");
        assert.equal(contrast.length, 1); assert.ok(contrast[0].contrast >= 4.5, JSON.stringify(contrast));
        entry.primaryContrast.push({ interaction, accent, ...contrast[0] });
      }
      for (const button of [toolbarCreate, emptyCreate]) {
        await button.click(); await page.getByRole("heading", { name: "新建场景", exact: true }).waitFor();
        await page.keyboard.press("Escape"); await page.locator(".dialog-backdrop").waitFor({ state: "detached" });
      }
      assert.deepEqual(entry.writes, [{ path: "/api/projects", method: "POST" }, { path: "/api/projects", method: "POST" }]);
      assert.deepEqual(await gate.json("GET", `/api/projects/${project.id}`), before);
      await screenshot("explicit-retry-success"); assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await screenshot("failure"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
assert.equal(report.cases.filter(entry => entry.passed).length, 4);
