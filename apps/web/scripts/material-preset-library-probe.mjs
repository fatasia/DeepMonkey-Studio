import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// 编辑器"工业材质预设库"行为与视觉闭环(1920×1080):选对象 → 套用自发光屏(污染外观)→
// 套用不锈钢(断言金属度=1/粗糙度=0.22/自发光被中性值覆盖)→ 撤销复验(金属度回 0)→
// 重做 → 存为自定义预设(卡片出现)→ 库操作不入撤销 → 浅色主题截图。不保存场景(关闭自动保存)。
const web = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173", api = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const out = fileURLToPath(new URL("../../../test-output/material-preset-library/", import.meta.url));
await mkdir(out, { recursive: true });
const { token } = await (await fetch(`${api}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) })).json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion: "reduce" });
await context.addInitScript(({ token }) => { localStorage.setItem("bim-studio-auth-token", token); localStorage.setItem("bim-studio.renderer-backend", "webgl"); }, { token });
const page = await context.newPage(); page.setDefaultTimeout(45_000);
const errors = [], report = { steps: [], errors, assertions: [] };
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const shot = async (name) => { await page.screenshot({ path: `${out}${name}.png` }); report.steps.push(name); };
const check = (name, ok, detail = "") => { report.assertions.push({ name, ok, detail }); assert.ok(ok, `${name} ${detail}`); };
const library = () => page.locator(".material-preset-library");
const slider = (label) => page.locator(`.material-editor label:has(span:text-is("${label}")) input[type=range]`).first();
const sliderValue = async (label) => Number(await slider(label).inputValue());
const rangeSet = async (label, value) => {
  await slider(label).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await page.waitForTimeout(300);
};
const applyPreset = async (name) => {
  await library().getByRole("button", { name, exact: true }).click();
  await page.waitForTimeout(450);
};

await page.goto(`${web}/studio/${sceneId}?project=${projectId}`, { waitUntil: "domcontentloaded" });
await page.locator('.viewport canvas:not([aria-hidden="true"])').first().waitFor({ state: "visible" });
await page.waitForTimeout(3000);
const auto = page.getByLabel("自动保存"); if (await auto.isChecked()) await auto.uncheck();
await page.getByText("立方体 1", { exact: false }).first().click();
await page.getByText("外观、特效与动画", { exact: false }).first().click();
await page.waitForTimeout(600);
await library().scrollIntoViewIfNeeded();

// 1. 预设库结构:分组 × 3,内置卡 ≥ 12
const groupLabels = await library().locator(".material-preset-group-label").allInnerTexts();
check("分组标签(金属/非金属/玻璃与屏)", ["金属", "非金属", "玻璃与屏"].every(g => groupLabels.includes(g)), JSON.stringify(groupLabels));
const cardCount = await library().locator(".material-preset-card-wrap").count();
check("内置预设卡 ≥ 12", cardCount >= 12, `实际 ${cardCount}`);

// 2. 污染外观:先套自发光屏(emissive #58c6f2,intensity 2.5)
await applyPreset("自发光屏");
check("套用自发光屏后自发光颜色", (await page.locator(".material-editor .material-emissive input[type=color]").inputValue()) === "#58c6f2");
await shot("01-emissive-panel-applied-dark");

// 3. 套用不锈钢:金属度=1、粗糙度=0.22,且中性值覆盖残留自发光
await applyPreset("不锈钢");
check("不锈钢金属度 = 1", await sliderValue("金属度") === 1, `实际 ${await sliderValue("金属度")}`);
check("不锈钢粗糙度 = 0.22", Math.abs(await sliderValue("粗糙度") - 0.22) < 1e-6, `实际 ${await sliderValue("粗糙度")}`);
check("残留自发光被中性值覆盖(黑)", (await page.locator(".material-editor .material-emissive input[type=color]").inputValue()) === "#000000");
// 说明:面板受控值即引擎回读——selectionMaterial 由 useAppDerivedState 调 engine.getSelectionMaterial() 派生,
// 套用命令经引擎 setSelectionMaterial 落 Three 材质后回读,故滑杆/取色器值即引擎侧事实。
await library().scrollIntoViewIfNeeded();
await shot("02-stainless-applied-dark");

// 4. 撤销复验:回到自发光屏(金属度 0),再重做(金属度 1)
// 撤销经 applyScene 整快照恢复,画布重建后面板可能失焦隐藏——每步重新点选对象并确保外观区展开,与真实用户动线一致。
const reselect = async () => {
  await page.getByText("立方体 1", { exact: false }).first().click();
  await page.waitForTimeout(400);
  const appearance = page.locator(".inspector-appearance-settings > summary").first();
  if (await appearance.count() && !(await page.locator(".inspector-appearance-settings").first().evaluate(el => el.open))) {
    await appearance.click();
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(300);
};
await page.keyboard.press("Control+z");
await page.waitForTimeout(1200);
await reselect();
check("撤销后金属度 = 0(回到自发光屏)", await sliderValue("金属度") === 0, `实际 ${await sliderValue("金属度")}`);
check("撤销后自发光恢复", (await page.locator(".material-editor .material-emissive input[type=color]").inputValue()) === "#58c6f2");
await shot("03-undo-restores-emissive-dark");
await page.keyboard.press("Control+y");
await page.waitForTimeout(1200);
await reselect();
check("重做后金属度 = 1", await sliderValue("金属度") === 1, `实际 ${await sliderValue("金属度")}`);

// 5. 存为自定义预设 → 卡片出现在自定义组
await page.getByRole("button", { name: "存为预设", exact: true }).click();
await page.locator(".material-preset-save input").fill("E2E 测试涂层");
await page.locator(".material-preset-save button:text-is('保存')").click();
await page.waitForTimeout(500);
check("自定义预设卡出现", await library().getByRole("button", { name: "E2E 测试涂层", exact: true }).count() === 1);

// 6. 库操作不入撤销栈:再撤销一次应仍是材质历史(金属度回 0),自定义卡仍在
await page.keyboard.press("Control+z");
await page.waitForTimeout(1200);
await reselect();
check("撤销不删除自定义预设(库级不入撤销)", await library().getByRole("button", { name: "E2E 测试涂层", exact: true }).count() === 1);
await page.keyboard.press("Control+y");
await page.waitForTimeout(800);
await reselect();

// 7. 浅色主题视觉
await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
await page.waitForTimeout(400);
await library().scrollIntoViewIfNeeded();
await shot("04-presets-light-theme");
await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

report.toasts = await page.evaluate(() => [...document.querySelectorAll("[role=alert], .toast, .app-toast")].map((e) => e.textContent?.trim()).filter(Boolean));
await writeFile(`${out}report.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify({ ok: report.assertions.every(a => a.ok), assertions: report.assertions.length, errors }, null, 2));
