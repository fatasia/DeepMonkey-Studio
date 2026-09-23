// 三方案对比 bench 采集:同页切换 Three WebGL / Rust wasm 车道,
// 各采 12 秒,读 window.__benchResult,附截图;结果落 JSON 供报告引用。
import pw from "../../../node_modules/.pnpm/playwright-core@1.62.1/node_modules/playwright-core/index.js";
const chromium = pw.chromium;
import { mkdirSync, writeFileSync } from "node:fs";

const BASE = process.env.BENCH_URL ?? "http://localhost:5173";
const OUT = new URL("../../../../test-output/glm-night-20260923/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
mkdirSync(OUT + "bench3/", { recursive: true });

const browser = await chromium.launch({
  headless: true,
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--no-sandbox"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
page.on("pageerror", e => console.error("[pageerror]", e.message));
    page.on("console", m => { if (m.type() === "error") console.error("[console]", m.text().slice(0, 200)); });
const results = {};

for (const lane of ["three", "wasm"]) {
  await page.goto(`${BASE}/dev/wasm-bench.html`, { waitUntil: "load" });
  await page.locator(`button[data-lane="${lane}"]`).click();
  try {
    await page.waitForFunction(() => window.__benchResult, { timeout: 45000 });
    // 等当前 lane 的结果稳定(结果出来后再等一次刷新)
    await page.waitForTimeout(14000);
    results[lane] = await page.evaluate(() => window.__benchResult);
    await page.screenshot({ path: `${OUT}bench3/${lane}.png` });
    console.log(lane, JSON.stringify(results[lane]));
  } catch (e) {
    results[lane] = { error: String(e.message) };
    await page.screenshot({ path: `${OUT}bench3/${lane}-fail.png` });
    console.error(lane, "FAILED", e.message);
  }
}
writeFileSync(OUT + "bench3/results.json", JSON.stringify(results, null, 2));
await browser.close();
console.log("BENCH_DONE");
