import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const { chromium } = playwright;
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const outputRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), "test-output", "visual-compare", "parametric-layout");
mkdirSync(outputRoot, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const cases = [
  { width: 1920, height: 720 },
  { width: 1280, height: 720 },
  { width: 980, height: 640 },
  { width: 480, height: 800 },
];

try {
  for (const viewport of cases) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${origin}/?__visualQa=parametric&page=1&theme=dark`, { waitUntil: "networkidle" });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.width}x${viewport.height}-dark.png`) });
    const result = await page.evaluate(() => {
      const shell = document.querySelector(".parametric-page-shell");
      const workbench = document.querySelector(".parametric-workbench-page");
      const footer = document.querySelector(".parametric-workbench-page > footer");
      if (!(shell instanceof HTMLElement) || !(workbench instanceof HTMLElement) || !(footer instanceof HTMLElement)) {
        throw new Error("参数化页面结构未渲染完整");
      }
      const footerRect = footer.getBoundingClientRect();
      const shellStyle = getComputedStyle(shell);
      return {
        footerBottom: footerRect.bottom,
        footerHeight: footerRect.height,
        shellClientHeight: shell.clientHeight,
        shellScrollHeight: shell.scrollHeight,
        shellOverflowY: shellStyle.overflowY,
        viewportHeight: window.innerHeight,
        workbenchHeight: workbench.getBoundingClientRect().height,
      };
    });
    const footerVisible = result.footerHeight > 0 && result.footerBottom <= result.viewportHeight + 1;
    const shellCanReachFooter = result.shellScrollHeight > result.shellClientHeight && ["auto", "scroll"].includes(result.shellOverflowY);
    if (!footerVisible && !shellCanReachFooter) {
      throw new Error(`${viewport.width}x${viewport.height} 底部操作行不可见且页面不可滚动：${JSON.stringify(result)}`);
    }
    console.log(`[parametric-layout] ${viewport.width}x${viewport.height} 通过 ${JSON.stringify(result)}`);
    await page.close();
  }
} finally {
  await browser.close();
}
