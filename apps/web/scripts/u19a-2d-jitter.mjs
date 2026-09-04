import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const out = [];
try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
  await page.locator(".scene-card-actions button[aria-label='编辑场景']").first().click();
  await page.waitForTimeout(9000);

  async function sample(ms, tag) {
    const r = await page.evaluate(async (duration) => {
      const el = document.querySelector(".dashboard-canvas-scroll");
      if (!el) return { missing: true };
      const st = [], sl = [];
      const start = performance.now();
      while (performance.now() - start < duration) {
        st.push(el.scrollTop); sl.push(el.scrollLeft);
        await new Promise((res) => requestAnimationFrame(res));
      }
      const changesT = st.filter((v, i) => i > 0 && v !== st[i - 1]).length;
      const changesL = sl.filter((v, i) => i > 0 && v !== sl[i - 1]).length;
      const uniqT = [...new Set(st)], uniqL = [...new Set(sl)];
      return { frames: st.length, scrollTopChanges: changesT, scrollTopRange: uniqT.length > 1 ? `${Math.min(...uniqT)}..${Math.max(...uniqT)}` : `${st[0]}`, scrollLeftChanges: changesL, scrollLeftRange: uniqL.length > 1 ? `${Math.min(...uniqL)}..${Math.max(...uniqL)}` : `${sl[0]}` };
    }, ms);
    out.push({ tag, ...r });
  }

  await sample(1500, "2d@1440-baseline");
  for (const w of [1280, 1120, 980, 900]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(2200);
    await sample(2500, `2d@${w}`);
    // 记录窗口尺寸稳定后 scrollbar 是否存在（无用户输入时不应出现滚动变化）
  }
  for (const w of [1120, 1280, 1440]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.waitForTimeout(2200);
    await sample(2200, `2d-up@${w}`);
  }
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u110-2d-final.png" }).catch(() => {});
} catch (error) {
  out.push({ fatal: String(error).slice(0, 300) });
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
