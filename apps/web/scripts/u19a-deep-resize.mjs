// U1-10/U1-9a 资深级深测：跨 resize 连续逐帧采样，不留空窗。
// 指标：scroll 振荡（方向反转次数）、scrollbar 布局位移（clientWidth 突变）、
// ResizeObserver 回调计数、zoom（artboard transform）振荡、3D canvas 尺寸振荡。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const out = { runs: [] };

async function loginAndOpen2d() {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
  await page.locator(".scene-card-actions button[aria-label='编辑场景']").first().click();
  await page.waitForTimeout(9000);
}

// 页内埋点：在采样前安装计数器
async function installInstruments() {
  return page.evaluate(() => {
    window.__u = { roCallbacks: 0, scrollEvents: 0, roSizes: [] };
    const scroller = document.querySelector(".dashboard-canvas-scroll");
    if (!scroller) return { ok: false };
    scroller.addEventListener("scroll", () => { window.__u.scrollEvents += 1; }, { passive: true });
    const OriginalRO = window.ResizeObserver;
    window.ResizeObserver = class extends OriginalRO {
      constructor(cb) {
        super((entries, obs) => { window.__u.roCallbacks += 1; const t = entries[0]?.target; if (t === scroller) window.__u.roSizes.push(`${t.clientWidth}x${t.clientHeight}`); cb(entries, obs); });
      }
    };
    return { ok: true };
  });
}

// 连续采样：与 resize 并发进行，无空窗
async function sampleDuringResize(widths, perStepMs, tag) {
  const sampler = page.evaluate((total) => new Promise((resolve) => {
    const el = document.querySelector(".dashboard-canvas-scroll");
    const artboard = document.querySelector(".dashboard-artboard");
    const frames = [];
    const start = performance.now();
    function tick() {
      frames.push({
        t: Math.round(performance.now() - start),
        st: el.scrollTop, sl: el.scrollLeft,
        cw: el.clientWidth, ch: el.clientHeight,
        aw: artboard ? Math.round((new DOMMatrix(getComputedStyle(artboard).transform === "none" ? "translate(0,0)" : getComputedStyle(artboard).transform)).a * 1000) / 1000 : null,
      });
      if (performance.now() - start < total) requestAnimationFrame(tick); else resolve(frames);
    }
    tick();
  }), widths.length * perStepMs);

  for (const w of widths) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(perStepMs);
  }
  const frames = await sampler;
  // 分析：方向反转 = 振荡；clientWidth 突变 = scrollbar 布局位移
  let stReversals = 0, slReversals = 0, lastStDir = 0, lastSlDir = 0, cwJumps = 0, prev = null;
  for (const f of frames) {
    if (prev) {
      const dSt = Math.sign(f.st - prev.st), dSl = Math.sign(f.sl - prev.sl);
      if (dSt !== 0 && lastStDir !== 0 && dSt !== lastStDir) stReversals += 1;
      if (dSt !== 0) lastStDir = dSt;
      if (dSl !== 0 && lastSlDir !== 0 && dSl !== lastSlDir) slReversals += 1;
      if (dSl !== 0) lastSlDir = dSl;
      if (f.cw !== prev.cw) cwJumps += 1;
    }
    prev = f;
  }
  const scrollLeftValues = [...new Set(frames.map((f) => f.sl))];
  const zoomValues = [...new Set(frames.map((f) => f.aw))];
  const counters = await page.evaluate(() => ({ ...window.__u, roSizes: window.__u.roSizes.slice(-6) }));
  return { tag, frames: frames.length, stReversals, slReversals, cwJumps, scrollLeftValues: scrollLeftValues.slice(0, 8), zoomValues: zoomValues.slice(0, 8), counters };
}

try {
  await loginAndOpen2d();

  // 实验 1：阶梯缩小（采样与 resize 并发）
  await installInstruments();
  out.runs.push(await sampleDuringResize([1360, 1280, 1200, 1120, 1040, 980], 900, "2d-step-down-concurrent"));

  // 实验 2：连续扫掠（模拟拖拽窗缘，10px/步 从 1440 到 900 再回来）
  await installInstruments();
  const sweep = [];
  for (let w = 1440; w >= 900; w -= 15) sweep.push(w);
  out.runs.push(await sampleDuringResize(sweep, 40, "2d-sweep-down"));

  // 实验 3：来回扫掠（放大原路返回，检验双向振荡）
  await installInstruments();
  const sweepBack = [];
  for (let w = 900; w <= 1440; w += 15) sweepBack.push(w);
  out.runs.push(await sampleDuringResize(sweepBack, 40, "2d-sweep-up"));

  // 实验 4：静置 3 秒——稳定后不应有任何变化
  await installInstruments();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(1500);
  out.runs.push(await sampleDuringResize([1440], 3000, "2d-idle-control"));
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u110-deep-final.png" }).catch(() => {});
} catch (error) {
  out.fatal = String(error).slice(0, 400);
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
