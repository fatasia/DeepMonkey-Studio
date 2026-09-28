// T25 视觉闭环截图:深/浅主题、窄断点、零值与满载、折叠与拖拽。
// 用法: node scripts/t25-capture.mjs <round>   (输出 test-output/t25-panel/round<N>/)
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const round = process.argv[2] ?? "1";
const outDir = `../../test-output/t25-panel/round${round}`;
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
page.on("pageerror", (error) => console.log("[pageerror]", String(error).slice(0, 160)));
const shot = (name) => page.screenshot({ path: `${outDir}/${name}.png` });

await page.goto("http://localhost:5199/", { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
await page.locator('input[aria-label*="用户名"]').first().fill("admin");
await page.locator('input[type="password"]').first().fill("admin");
await page.locator('button:has-text("登录")').first().click();
await page.waitForTimeout(7000);
await page.goto("http://localhost:5199/manager?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1&tab=scenes",
  { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await page.locator('button[aria-label="编辑场景"], button[title="编辑"]').first().click({ timeout: 20_000 });
await page.waitForTimeout(6000);
await page.locator('button:has-text("三维"), [role=tab]:has-text("三维")').first().click().catch(() => {});
await page.waitForTimeout(9000);

// 打开质量遥测面板(仿真与开发菜单)
await page.locator('button:has-text("仿真与开发")').first().click();
await page.waitForTimeout(600);
await page.locator('text=质量遥测').first().click();
await page.waitForTimeout(1500);
const panelInfo = await page.evaluate(() => {
  const panel = document.querySelector(".quality-telemetry-panel");
  return panel ? { rect: panel.getBoundingClientRect().toJSON(), text: panel.innerText.replace(/\s+/g, " ").slice(0, 500) } : null;
});
console.log("panel:", JSON.stringify(panelInfo?.text ?? "NOT FOUND"));
await shot("01-webgl-dark");

// 折叠态
await page.locator('.quality-telemetry-panel button[aria-expanded="true"]').click();
await page.waitForTimeout(400);
await shot("02-webgl-dark-collapsed");
await page.locator('.quality-telemetry-panel button[aria-expanded="false"]').click();
await page.waitForTimeout(400);

// 拖拽(header 拖动 240px)
const header = page.locator('.quality-telemetry-panel header[data-drag-handle="true"]');
const box = await header.boundingBox();
if (box) {
  await page.mouse.move(box.x + box.width / 2, box.y + 18);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 240, box.y + 18 + 90, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => document.querySelector(".quality-telemetry-panel").getBoundingClientRect().toJSON());
  console.log("drag delta:", JSON.stringify({ dx: Math.round(after.x - box.x), dy: Math.round(after.y - box.y) }));
  await shot("03-dragged");
}

// 浅色主题
await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
await page.waitForTimeout(600);
await shot("04-light");
await page.evaluate(() => { delete document.documentElement.dataset.theme; });
await page.waitForTimeout(300);

// 窄断点 640×900:重载页面后原生打开面板(拖拽 inline 位置不适用新视口)
await page.setViewportSize({ width: 640, height: 900 });
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
await page.goto("http://localhost:5199/studio/38ea81ba-3033-4d3e-86b5-648fd58d98f1/applications/fedab835-389b-43a5-99be-6820d0f3afde/scenes/fedab835-389b-43a5-99be-6820d0f3afde",
  { waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
await page.locator('button:has-text("仿真与开发")').first().click();
await page.waitForTimeout(600);
await page.locator('text=质量遥测').first().click();
await page.waitForTimeout(1500);
await shot("05-narrow-640");
await page.setViewportSize({ width: 1920, height: 1080 });
await page.waitForTimeout(500);

// 切换 Deep WebGPU(更多场景工具 → 渲染引擎设置 → 启用),完成后关对话框再截面板
await page.locator('summary[aria-label="更多场景工具"], summary[title="更多场景工具"]').first().click();
await page.waitForTimeout(500);
await page.locator('button:has-text("渲染引擎设置")').first().click();
await page.waitForTimeout(4000);
await page.locator('button:has-text("启用 Deep WebGPU")').first().click().catch(async () => {
  console.log("deep button not found");
});
await page.waitForTimeout(20000);
await page.locator('button[aria-label="关闭"], [class*=dialog] button:has(svg.lucide-x)').last().click()
  .catch(() => console.log("dialog close skipped"));
await page.waitForTimeout(2000);
await shot("06-deep-switching-or-active");
await page.waitForTimeout(12000);
const panelAfter = await page.evaluate(() => {
  const panel = document.querySelector(".quality-telemetry-panel");
  return panel ? panel.innerText.replace(/\s+/g, " ").slice(0, 600) : "PANEL GONE";
});
console.log("panel-after-deep:", panelAfter);
await shot("07-deep-quality-window");

await browser.close();
console.log("done round", round);
