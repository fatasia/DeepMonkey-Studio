import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { themeContext } from "./gateModelInstancesSupport.mjs";

const baseline = process.argv.includes("--baseline");
const gate = await createIsolatedStudioGate("computed-fields-theme");
const report = { baseline, webIndexSha: createHash("sha256").update(await readFile(resolve(import.meta.dirname, "../dist/index.html"))).digest("hex"), cases: [] };
console.log(JSON.stringify({ output: gate.output, baseline }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const id = `r${round}-${theme}`, entry = { id, passed: false, errors: [], contrast: {} };
    report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `计算字段主题 ${id}` });
    await gate.json("POST", `/api/projects/${project.id}/data-connections`, { name: "计算字段连接", type: "http", enabled: true, config: { url: "https://example.com/records" } });
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => { if (["error", "warning"].includes(message.type())) entry.errors.push(message.text()); });
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.getByRole("button", { name: "数据中心", exact: true }).click();
      const pane = page.locator(".data-center-pane").nth(1);
      await pane.getByRole("button", { name: "新建", exact: true }).click();
      const form = pane.locator(".data-inline-form"), section = form.locator(".data-computed-fields");
      const add = section.getByRole("button", { name: "添加", exact: true });
      await add.scrollIntoViewIfNeeded();
      entry.contrast.heading = await contrast(section.locator("header strong"));
      entry.contrast.headerHint = await contrast(section.locator("header small"));
      entry.contrast.empty = await contrast(section.locator(":scope > p"));
      entry.contrast.add = await contrast(add);
      await page.screenshot({ path: resolve(gate.output, `${id}-empty.png`), fullPage: true });
      await add.focus(); await page.keyboard.press("Enter");
      const article = section.locator("article"); await article.waitFor();
      await article.getByLabel("显示名", { exact: true }).fill("产量换算");
      await article.locator("textarea").fill("ROUND(output, 2)");
      entry.contrast.fieldHeading = await contrast(article.locator(".data-computed-field-heading strong"));
      entry.contrast.label = await contrast(article.locator(".data-form-pair label").first().locator("span"));
      entry.contrast.dependency = await contrast(article.locator(":scope > small"));
      await article.getByLabel("Key", { exact: true }).fill("");
      await article.locator("em").waitFor();
      entry.contrast.error = await contrast(article.locator("em"));
      assert.equal(await form.getByRole("button", { name: "保存数据集", exact: true }).isDisabled(), true);
      await article.locator("em").scrollIntoViewIfNeeded();
      await page.screenshot({ path: resolve(gate.output, `${id}-invalid.png`), fullPage: true });
      await article.getByLabel("Key", { exact: true }).fill("outputRounded");
      await article.locator("textarea").focus();
      await page.screenshot({ path: resolve(gate.output, `${id}-field.png`), fullPage: true });
      await add.click(); assert.equal(await section.locator("article").count(), 2);
      await section.locator("article").nth(1).getByRole("button", { name: "删除字段", exact: true }).focus();
      await page.keyboard.press("Enter"); assert.equal(await section.locator("article").count(), 1);
      const savedResponse = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/datasets"));
      await form.getByRole("button", { name: "保存数据集", exact: true }).click();
      const response = await savedResponse; assert.equal(response.status(), 201);
      const saved = await response.json(); assert.equal(saved.computedFields[0].formula, "ROUND(output, 2)");
      await page.reload(); await page.locator(".data-center-page").waitFor();
      const restored = await gate.json("GET", `/api/projects/${project.id}/datasets`);
      assert.equal(restored.find(item => item.id === saved.id).computedFields[0].key, "outputRounded");
      if (!baseline) for (const [name, ratio] of Object.entries(entry.contrast)) assert.ok(ratio >= 4.5, `${id} ${name}: ${ratio}`);
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = String(error); await page.screenshot({ path: resolve(gate.output, `${id}-failure.png`), fullPage: true }); throw error; }
    finally { await context.close(); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, cases: report.cases.length, baseline, passed: report.cases.every(entry => entry.passed) }));

async function contrast(locator) {
  return locator.evaluate(element => {
    const channels = color => color.match(/[\d.]+/g)?.map(Number) ?? [];
    const luminance = rgb => rgb.slice(0, 3).map(value => value / 255).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((total, value, index) => total + value * [.2126, .7152, .0722][index], 0);
    let current = element, background;
    while (current) {
      const parsed = channels(getComputedStyle(current).backgroundColor);
      if (parsed.length === 3 || parsed[3] === 1) { background = parsed; break; }
      current = current.parentElement;
    }
    if (!background) throw new Error("缺少不透明背景，不能计算对比度");
    const foreground = channels(getComputedStyle(element).color);
    const a = luminance(foreground), b = luminance(background);
    return Number(((Math.max(a, b) + .05) / (Math.min(a, b) + .05)).toFixed(3));
  });
}
