// U1-9a（3D 编辑器缩小后滚动反复跳）+ U1-10（2D 画布缩小抖动、滚动条抖动）resize 调查。
// 方法：编辑器打开后按宽度梯度缩小窗口，逐帧采样滚动容器 scrollTop/scrollLeft 与关键元素位置，检测振荡。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const origin = "http://127.0.0.1:5173";
const sceneId = "d5395a30-4c29-4e8c-8bb0-b6b0d188c615";
const out = { probes: [] };

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
try {
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);

  async function sampleScroll(seconds, tag) {
    return page.evaluate(async (sec) => {
      const scrollers = [...document.querySelectorAll("*")].filter((el) => {
        const s = getComputedStyle(el);
        return (s.overflowY === "auto" || s.overflowY === "scroll") && el.scrollHeight > el.clientHeight + 4;
      }).slice(0, 6).map((el) => ({ cls: String(el.className).slice(0, 40) || el.tagName, el }));
      const series = scrollers.map((s) => ({ cls: s.cls, values: [] }));
      const start = performance.now();
      while (performance.now() - start < sec * 1000) {
        series.forEach((s, i) => s.values.push(scrollers[i].el.scrollTop));
        await new Promise((r) => requestAnimationFrame(r));
      }
      const summary = series.map((s) => {
        const uniq = [...new Set(s.values)];
        const changes = s.values.filter((v, i) => i > 0 && v !== s.values[i - 1]).length;
        return { cls: s.cls, distinct: uniq.length, changes, first: s.values[0], last: s.values.at(-1), range: uniq.length ? `${Math.min(...uniq)}..${Math.max(...uniq)}` : "0" };
      });
      return { tag: sec, scrollers: summary };
    }, seconds);
  }

  // ===== 2D 页面编辑器 =====
  await page.goto(`${origin}/studio/${sceneId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(9000);
  out.probes.push({ step: "2d-baseline-1440", ...(await sampleScroll(2, "2d@1440")) });

  for (const w of [1280, 1120, 980, 1120, 1280, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(2500);
    const probe = await sampleScroll(2.5, `2d@${w}`);
    const canvas = await page.evaluate(() => {
      const c = document.querySelector(".dashboard-workspace-canvas, [class*='dashboard-canvas']");
      const artboard = document.querySelector("[class*='artboard']");
      const scroll = document.querySelector("[class*='canvas-scroll'], .dashboard-workspace-canvas");
      const r = c?.getBoundingClientRect();
      return { canvasRect: r ? `${Math.round(r.width)}x${Math.round(r.height)}` : null, cls: c ? String(c.className).slice(0, 50) : null, hasArtboard: Boolean(artboard), hasHScroll: (() => { const el = scroll || c; return el ? el.scrollWidth > el.clientWidth + 4 : null; })() };
    });
    out.probes.push({ step: `2d-after-resize-${w}`, ...probe, canvas });
  }

  // ===== 3D 场景编辑器（U1-9a）=====
  await page.goto(`${origin}/studio/${sceneId}?mode=3d`, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  // 3D 是同一场景路由的视图切换；若 URL 不生效则经页面点击"三维"切视图
  const tab3d = page.locator("button, [role='tab']", { hasText: "三维" }).first();
  if (await tab3d.count() > 0) { await tab3d.click().catch(() => {}); await page.waitForTimeout(4000); }
  out.probes.push({ step: "3d-baseline", ...(await sampleScroll(2, "3d")) });
  for (const w of [1280, 1100, 980, 1100, 1280]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(2500);
    out.probes.push({ step: `3d-after-resize-${w}`, ...(await sampleScroll(2.5, `3d@${w}`)) });
  }
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u19a-3d-final.png" }).catch(() => {});
} catch (error) {
  out.fatal = String(error).slice(0, 400);
}
await browser.close();
console.log(JSON.stringify(out, null, 2));
