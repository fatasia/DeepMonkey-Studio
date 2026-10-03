import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// 编辑器"高级材质"分组视觉与行为闭环(深色 1920×1080):展开 → 设置 lobe → three 路径外观 →
// 在 three 路径设置 lobe → 切到 Deep(创建时按编译快照自动启用 advancedMaterials 变体)→ 仍在 Deep、无失败,三路外观截图对照。不保存场景(关闭自动保存)。
const web = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173", api = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const out = fileURLToPath(new URL("../../../test-output/advanced-material-editor/", import.meta.url));
await mkdir(out, { recursive: true });
const { token } = await (await fetch(`${api}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) })).json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion: "reduce" });
await context.addInitScript(({ token }) => { localStorage.setItem("bim-studio-auth-token", token); localStorage.setItem("bim-studio.renderer-backend", "webgl"); }, { token });
const page = await context.newPage(); page.setDefaultTimeout(45_000);
const errors = [], report = { steps: [], errors };
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
const shot = async (name) => { await page.screenshot({ path: `${out}${name}.png` }); report.steps.push(name); };
const backend = () => page.evaluate(() => document.querySelector("canvas[data-renderer-backend]")?.getAttribute("data-renderer-backend") ?? "webgl");
const lobes = () => page.locator(".material-advanced-lobes");
const setRange = async (label, value) => {
  await page.locator(`.material-advanced-lobes input[type=range][aria-label="${label}"]`).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setter.call(el, String(v)); el.dispatchEvent(new Event("input", { bubbles: true }));
  }, value);
  await page.waitForTimeout(250);
};

await page.goto(`${web}/studio/${sceneId}?project=${projectId}`, { waitUntil: "domcontentloaded" });
await page.locator(".viewport canvas").first().waitFor({ state: "visible" });
await page.waitForTimeout(3000);
const auto = page.getByLabel("自动保存"); if (await auto.isChecked()) await auto.uncheck();
await page.getByText("立方体 1", { exact: false }).first().click();
await page.getByText("外观、特效与动画", { exact: false }).first().click();
await page.waitForTimeout(600);
await lobes().scrollIntoViewIfNeeded();
await shot("01-collapsed-default");
assert.equal(await lobes().evaluate((el) => el.open), false, "高级材质默认必须收起");
await lobes().locator("summary").click(); await page.waitForTimeout(300);
await shot("02-expanded-neutral");

// three 路径:工程塑料底 + 清漆 + 光泽 + 薄膜;面板摘要;聚焦所选对象后截图
await page.getByRole("button", { name: "亮面陶瓷", exact: true }).click(); await page.waitForTimeout(300);
await setRange("清漆强度", 0.9); await setRange("光泽强度", 0.7); await setRange("薄膜干涉", 1);
await page.waitForTimeout(500);
assert.match(await lobes().locator("summary small").innerText(), /已启用 3 项/);
await lobes().scrollIntoViewIfNeeded();
await page.mouse.click(643, 85); await page.waitForTimeout(1800);
await shot("03-three-active");
report.threeCanvas = await backend();

// 切 Deep:快照含激活 lobe → 自动启用变体
await page.getByLabel("更多场景工具", { exact: true }).click();
await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
await page.getByRole("button", { name: "启用 Deep WebGPU Beta", exact: true }).click();
await page.locator(`.viewport canvas[data-renderer-backend="deep-webgpu"]`).waitFor({ state: "attached", timeout: 60_000 });
await page.getByRole("button", { name: "关闭", exact: true }).click();
await page.waitForTimeout(10000);
report.deepAfter = await backend();
report.marks = await page.evaluate(() => performance.getEntriesByType("mark").filter(m => /deep-webgpu:pipeline-.*-advanced-start/.test(m.name)).map(m => m.name));
await page.getByLabel("更多场景工具", { exact: true }).click(); await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click(); await page.waitForTimeout(500);
await shot("04-deep-active");
if (report.deepAfter === "webgl") console.log(JSON.stringify({ errors, text: await page.evaluate(() => [...document.querySelectorAll("body *:not(style):not(script)")].map(e => e.children.length === 0 ? e.textContent.trim() : "").filter(s => s.length < 300 && /准备失败|运行失败|适配|错误|failed/i.test(s)).slice(0, 12)) }));
assert.notEqual(report.deepAfter, "webgl", "Deep 应保持激活(未因高级材质回退)");
assert.ok(report.marks.length > 0, "场景含激活 lobe 时 Deep 管线应带 -advanced 变体");
report.toasts = await page.evaluate(() => [...document.querySelectorAll("[role=alert], .toast, .app-toast")].map((e) => e.textContent?.trim()).filter(Boolean));
await writeFile(`${out}report.json`, JSON.stringify(report, null, 2));
await browser.close();
console.log(JSON.stringify(report, null, 2));