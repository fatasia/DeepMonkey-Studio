import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// 诊断探针:验证「放置立方体 → 包重布景 → sdfGi 重烘焙」链路是否在真机发生。
const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const route = "/studio/ad6f85d5-a15e-4590-949f-9363451a8333?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1&sdf-gi=1";
const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const { token } = await login.json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(t => { localStorage.setItem("bim-studio-auth-token", t); localStorage.setItem("bim-studio.renderer-backend", "webgpu"); }, token);
const page = await context.newPage();
page.on("console", m => { if (m.type() === "warn" || m.type() === "error") console.log("[console]", m.type(), m.text().slice(0, 200)); });
await page.goto(webOrigin + route, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__deepQualityTelemetry?.latestSdfGi?.sdfGiProbeCount > 0, undefined, { timeout: 90_000, polling: 500 }).catch(() => console.log("telemetry timeout"));
// 种一个 1x1 JPEG 的「GI 关基准」到 sessionStorage,验证跨重载基准恢复 + 双帧滑块。
await page.evaluate(() => {
  const canvas = document.createElement("canvas"); canvas.width = 4; canvas.height = 4;
  sessionStorage.setItem("bim-studio.gi-bake-bench.gi-off-baseline",
    JSON.stringify({ dataUrl: canvas.toDataURL("image/jpeg", 0.8), sdfGiOn: false,
      backend: "webgpu", capturedAtMs: Date.now() - 60_000 }));
});
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(() => globalThis.__deepQualityTelemetry?.latestSdfGi?.sdfGiProbeCount > 0, undefined, { timeout: 120_000, polling: 500 });
await page.getByRole("button", { name: "仿真与开发" }).click();
await page.getByRole("menuitem", { name: "光照烘焙" }).click();
await page.waitForSelector('[data-testid="bake-bench-panel"]', { timeout: 10_000 });
await page.waitForTimeout(600);
await page.getByTestId("bake-bench-capture-on").click();
await page.waitForSelector(".bb-compare-clip", { timeout: 15_000 });
const compare = await page.evaluate(() => ({
  imgs: document.querySelectorAll(".bb-compare img").length,
  clip: Boolean(document.querySelector(".bb-compare-clip")),
  caption: document.querySelector(".bb-compare figcaption")?.textContent ?? "",
  range: Boolean(document.querySelector('.bb-compare input[type="range"]')),
}));
console.log("COMPARE:", JSON.stringify(compare));
await page.locator('[data-testid="bake-bench-panel"]').screenshot({ path: "../../test-output/gi-bake-bench/panel-split-dark.png" });
console.log("SPLIT SCREENSHOT SAVED");
await browser.close();
