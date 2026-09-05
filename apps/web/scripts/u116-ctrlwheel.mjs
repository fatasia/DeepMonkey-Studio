import assert from "node:assert/strict";
import { blankPoint, runDashboardGate, settleFrames } from "./dashboardInteractionGate.mjs";

await runDashboardGate("ctrl-wheel", async (page, output) => {
  const { box } = await blankPoint(page);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.down("Control");
  try {
    for (let i = 0; i < 25; i++) {
      await page.mouse.wheel(0, 300);
      await settleFrames(page);
    }
  } finally { await page.keyboard.up("Control"); }
  await page.waitForFunction(() => document.querySelector(".dashboard-page-bar output")?.textContent === "10%");
  await settleFrames(page);
  // 静置后逐帧采样，不能把正常缩放滚动误判为抖动。
  const frames = await page.evaluate(() => new Promise((resolve) => {
    const el = document.querySelector(".dashboard-canvas-scroll");
    const samples = [];
    const tick = () => {
      samples.push({ left: el.scrollLeft, top: el.scrollTop });
      if (samples.length < 60) requestAnimationFrame(tick); else resolve(samples);
    };
    requestAnimationFrame(tick);
  }));
  const range = (key) => Math.max(...frames.map((f) => f[key])) - Math.min(...frames.map((f) => f[key]));
  assert.ok(range("left") <= 1 && range("top") <= 1, "低缩放停止操作后不应自行抖动");
  await page.screenshot({ path: `${output}-10percent.png` });
  await page.keyboard.down("Control");
  try { await page.mouse.wheel(0, -300); await settleFrames(page); } finally { await page.keyboard.up("Control"); }
  await page.waitForFunction(() => document.querySelector(".dashboard-page-bar output")?.textContent === "11%");
  return { lowerBound: "10%", zoomBack: "11%", frames: frames.length, horizontalDrift: range("left"), verticalDrift: range("top") };
});
