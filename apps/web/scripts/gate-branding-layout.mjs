import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const { chromium } = playwright;
const chromePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const outputRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), "test-output", "visual-compare", "branding-layout");
mkdirSync(outputRoot, { recursive: true });
const browser = await chromium.launch({ executablePath: chromePath, headless: true });
const cases = [
  { width: 1280, height: 720, theme: "dark" },
  { width: 980, height: 640, theme: "light" },
  { width: 480, height: 800, theme: "dark" },
];

try {
  for (const viewport of cases) {
    const page = await browser.newPage({ viewport });
    await page.goto(`${origin}/?__visualQa=branding&theme=${viewport.theme}`, { waitUntil: "networkidle" });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.width}x${viewport.height}-${viewport.theme}.png`) });
    const result = await page.evaluate(() => {
      const shell = document.querySelector(".branding-settings-page");
      const heading = document.querySelector(".secondary-page-heading-row");
      const back = document.querySelector(".secondary-page-back");
      const title = document.querySelector(".secondary-page-title");
      const save = document.querySelector(".branding-save");
      const lastSection = document.querySelector(".branding-sections > section:last-child");
      if (![shell, heading, back, title, save, lastSection].every((element) => element instanceof HTMLElement)) {
        throw new Error("品牌设置页结构未渲染完整");
      }
      const shellElement = shell;
      const backRect = back.getBoundingClientRect();
      const titleRect = title.getBoundingClientRect();
      const saveRect = save.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      const firstRowAligned = backRect.right <= titleRect.left && Math.abs((backRect.top + backRect.bottom) / 2 - (titleRect.top + titleRect.bottom) / 2) < 24;
      const saveOnRight = Math.abs(saveRect.right - headingRect.right) <= 1;
      const shellStyle = getComputedStyle(shellElement);
      shellElement.scrollTop = shellElement.scrollHeight;
      const lastSectionBottom = lastSection.getBoundingClientRect().bottom;
      return {
        firstRowAligned,
        saveOnRight,
        overflowY: shellStyle.overflowY,
        clientHeight: shellElement.clientHeight,
        scrollHeight: shellElement.scrollHeight,
        scrollTop: shellElement.scrollTop,
        lastSectionBottom,
        viewportHeight: window.innerHeight,
      };
    });
    if (!result.firstRowAligned) throw new Error(`${viewport.width}x${viewport.height} 返回与标题未并列：${JSON.stringify(result)}`);
    if (!result.saveOnRight) throw new Error(`${viewport.width}x${viewport.height} 保存按钮未靠右：${JSON.stringify(result)}`);
    if (result.overflowY !== "auto") throw new Error(`${viewport.width}x${viewport.height} 页面未启用纵向滚动：${JSON.stringify(result)}`);
    if (result.scrollHeight > result.clientHeight && (result.scrollTop <= 0 || result.lastSectionBottom > result.viewportHeight + 1)) {
      throw new Error(`${viewport.width}x${viewport.height} 页面底部不可滚动到达：${JSON.stringify(result)}`);
    }
    console.log(`[branding-layout] ${viewport.width}x${viewport.height} ${viewport.theme} 通过 ${JSON.stringify(result)}`);
    await page.close();
  }
} finally {
  await browser.close();
}
