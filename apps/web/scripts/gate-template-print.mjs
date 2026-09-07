import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("template-print");
const report = { cases: [] }; console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], expectedNetworkErrors: [] }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(25000); observeDiagnostics(page, entry);
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${name}.png`) });
    try {
      const project = await gate.json("POST", "/api/projects", { name: `模板打印-${round}-${theme}` });
      const { application, appPath } = await createScene(gate, page, project.id);
      const authored = structuredClone(application);
      authored.pages[0].nodes = [];
      authored.pages[0].width = theme === "light" ? 1080 : 1920;
      authored.pages[0].height = theme === "light" ? 1920 : 1080;
      await gate.json("PUT", appPath, authored);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
      await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
      const trigger = page.getByRole("button", { name: "模板", exact: true }); await trigger.click();
      const modal = page.getByRole("dialog", { name: "看板模板库", exact: true }); await modal.waitFor();
      const query = modal.getByRole("textbox", { name: "搜索模板或行业" });
      assert.ok(await query.evaluate(element => element === document.activeElement));
      await query.fill("not-a-template-91832");
      await modal.getByText("没有匹配的模板", { exact: true }).waitFor(); await shot("empty");
      const clear = modal.getByRole("button", { name: "查看全部模板", exact: true });
      await clear.focus(); await page.keyboard.press("Tab");
      assert.ok(await modal.getByRole("button", { name: "关闭", exact: true }).evaluate(element => element === document.activeElement));
      await page.keyboard.press("Shift+Tab"); assert.ok(await clear.evaluate(element => element === document.activeElement));
      await clear.click(); assert.equal(await modal.locator("article").count(), 120);
      const first = modal.locator("article").first(), title = await first.locator("strong").innerText();
      await first.getByRole("button", { name: "收藏模板", exact: true }).click();
      await modal.getByLabel("模板分类").selectOption("favorites"); assert.equal(await modal.locator("article").count(), 1);
      await shot("favorite");
      for (const small of [800, 480]) {
        await page.setViewportSize({ width: small, height: 1000 }); await shot(`narrow-${small}`);
        const bounds = await modal.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= small);
        assert.equal(await modal.evaluate(element => element.scrollWidth > element.clientWidth), false);
      }
      await page.setViewportSize({ width, height: 1000 });
      await page.keyboard.press("Escape"); await modal.waitFor({ state: "detached" });
      assert.ok(await trigger.evaluate(element => element === document.activeElement));
      await trigger.click(); await modal.locator("article").first().getByRole("button", { name: "插入当前页面", exact: true }).click();
      await modal.waitFor({ state: "detached" }); assert.equal(await page.locator(".dashboard-artboard .dashboard-node").count(), 9);
      await trigger.click(); await modal.getByRole("button", { name: "关闭", exact: true }).focus();
      await page.keyboard.press("Delete"); await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Escape"); await modal.waitFor({ state: "detached" });
      assert.equal(await page.locator(".dashboard-artboard .dashboard-node").count(), 9, "弹窗键盘不能删除后台画布节点");
      const save = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存", exact: true }).click(); assert.ok((await save).ok());
      const saved = await gate.json("GET", appPath); assert.equal(saved.pages[0].nodes.length, 9); assert.deepEqual(saved.scenes, application.scenes);
      await page.reload(); await page.locator(".dashboard-artboard .dashboard-node").first().waitFor();
      await page.getByRole("button", { name: "浏览", exact: true }).click();
      const runtime = page.locator(".dashboard-runtime-preview"); await runtime.waitFor(); await shot("runtime");
      const before = await runtime.locator(".dashboard-runtime-artboard").boundingBox();
      await page.emulateMedia({ media: "print" });
      const printed = await runtime.locator(".dashboard-runtime-artboard").boundingBox();
      const paper = await runtime.boundingBox();
      assert.ok(Math.abs(printed.width / printed.height - authored.pages[0].width / authored.pages[0].height) < 0.001);
      assert.ok(printed.x >= paper.x - 1 && printed.y >= paper.y - 1 && printed.x + printed.width <= paper.x + paper.width + 1 && printed.y + printed.height <= paper.y + paper.height + 1);
      assert.equal(await page.locator(".dashboard-workspace-topbar").isVisible(), false);
      assert.equal(await page.locator(".dashboard-runtime-back").isVisible(), false);
      await shot("print");
      const pdf = await page.pdf({ path: resolve(gate.output, `r${round}-${theme}.pdf`), preferCSSPageSize: true, printBackground: true });
      entry.pdfPages = [...pdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length; assert.equal(entry.pdfPages, 1);
      await page.emulateMedia({ media: "screen" });
      const restored = await runtime.locator(".dashboard-runtime-artboard").boundingBox();
      assert.ok(Math.abs(restored.width - before.width) < 1); assert.ok(await page.locator(".dashboard-runtime-back").isVisible());
      await page.getByRole("button", { name: "返回编辑", exact: true }).click();
      const published = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "发布", exact: true }).click(); assert.ok((await published).ok());
      const publicContext = await gate.browser.newContext({ viewport: { width, height: 1000 } });
      const publicPage = await publicContext.newPage();
      await publicPage.goto(`${gate.origin}/apps/${application.metadata.id}`); await publicPage.locator(".dashboard-runtime-artboard").waitFor();
      assert.equal(await publicPage.locator(".dashboard-runtime-artboard .dashboard-node").count(), 9);
      await publicPage.emulateMedia({ media: "print" });
      const publicPdf = await publicPage.pdf({ path: resolve(gate.output, `r${round}-${theme}-public.pdf`), preferCSSPageSize: true, printBackground: true });
      assert.equal([...publicPdf.toString("latin1").matchAll(/\/Type\s*\/Page\b/g)].length, 1);
      await publicPage.screenshot({ path: resolve(gate.output, `r${round}-${theme}-public-print.png`) });
      await publicContext.close(); entry.template = title;
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, passed: report.cases.every(entry => entry.passed) }));
