import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const output = resolve("test-output", "deep-core", "timeline-transient");
mkdirSync(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

try {
  for (const [theme, width, height] of [["dark", 1280, 800], ["light", 480, 800]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`${origin}/?__visualQa=workspace-chrome&theme=${theme}`, { waitUntil: "networkidle" });
    const time = page.locator(".timeline-time");
    await time.waitFor();
    const before = await time.textContent();
    await page.screenshot({ path: resolve(output, `01-before-${theme}-${width}.png`) });
    await page.evaluate(() => window.__qaPublishAnimation?.(2.75));
    await page.waitForFunction(() => document.querySelector(".timeline-time")?.textContent?.includes("2.75"));
    const after = await time.textContent();
    await page.screenshot({ path: resolve(output, `02-after-${theme}-${width}.png`) });
    const layout = await page.evaluate(() => {
      const timeline = document.querySelector(".timeline-panel")?.getBoundingClientRect();
      return {
        viewportWidth: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        timelineLeft: timeline?.left,
        timelineRight: timeline?.right,
        timelineWidth: timeline?.width,
      };
    });
    if (errors.length || before === after || layout.documentWidth > width || layout.timelineLeft < 0 || layout.timelineRight > width) {
      throw new Error(JSON.stringify({ theme, before, after, layout, errors }));
    }
    const rail = page.locator(".timeline-ruler-rail");
    const railWidth = await rail.evaluate(element => element.getBoundingClientRect().width);
    await rail.click({ position: { x: railWidth * 0.7, y: 8 } });
    await page.waitForFunction(() => document.querySelector(".timeline-time")?.textContent?.startsWith("7."));
    const seekTime = await time.textContent();
    console.log(JSON.stringify({ theme, width, before, after, seekTime, layout, errors }));
    await page.close();
  }
} finally {
  await browser.close();
}
