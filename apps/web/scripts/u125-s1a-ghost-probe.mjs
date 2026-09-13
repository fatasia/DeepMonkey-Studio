// S1-A 幽灵板修复验证:轮廓(outline)开启 + 栀注标签,近景截图应无黑色斜四边形残影。
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const output = resolve("test-output/fix-s1a-ghost");
mkdirSync(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", e => errors.push(e.message));
// effects=on 使 qa-primitive-65 开启 outline(OutlinePass 激活);夹具自带 P-101 栀注标签。
await page.goto("http://127.0.0.1:5173/?__visualQa=viewer&renderer=webgl&objects=120&effects=on", { waitUntil: "commit" });
await page.waitForFunction(() => window.__viewerQa?.ready || window.__viewerQa?.error, undefined, { timeout: 60000 });
await page.waitForTimeout(2500);
const canvas = page.locator(".viewer-visual-qa-canvas canvas");
const bounds = await canvas.boundingBox();
// 满视截图(远/中景)
await page.screenshot({ path: resolve(output, "far.png") });
// 拖拽拉近:绕中心滚转+滚轮缩近
await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
await page.mouse.wheel(0, -600);
await page.waitForTimeout(800);
await page.mouse.down();
for (let step = 0; step < 30; step += 1) {
  await page.mouse.move(bounds.x + bounds.width / 2 + Math.sin(step / 6) * 60, bounds.y + bounds.height / 2 + Math.cos(step / 6) * 40);
  await page.waitForTimeout(30);
}
await page.mouse.up();
await page.mouse.wheel(0, -1200);
await page.waitForTimeout(1200);
await page.screenshot({ path: resolve(output, "near-outline-on.png") });
console.log(JSON.stringify({ errors: errors.slice(0, 5) }));
await browser.close();
