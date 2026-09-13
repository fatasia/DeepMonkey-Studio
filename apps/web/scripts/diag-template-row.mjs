// 诊断:量模板库弹窗内推荐横滚行与分区的布局尺寸与计算样式。
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 1 });
await page.goto("http://127.0.0.1:5173/?__visualQa=dashboard&theme=dark", { waitUntil: "load" });
await page.waitForTimeout(3000);
const resTab = page.locator('.dashboard-left-tabs button:has-text("资源")').first();
await resTab.click().catch(() => {});
await page.waitForTimeout(700);
await page.locator(".dashboard-library-template-button").first().click();
await page.waitForTimeout(1200);
const info = await page.evaluate(() => {
  const pick = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { h: Math.round(rect.height), w: Math.round(rect.width), display: cs.display, position: cs.position, contentVisibility: cs.contentVisibility, containIntrinsic: cs.containIntrinsicSize, overflow: `${cs.overflowX}/${cs.overflowY}` };
  };
  const row = document.querySelector(".dashboard-template-row");
  const sections = [...document.querySelectorAll(".dashboard-template-section")];
  return {
    row: pick(row),
    rowArticle: pick(row?.querySelector(":scope > article")),
    rowPreview: pick(row?.querySelector(".template-layout-preview")),
    rowSvg: pick(row?.querySelector("svg")),
    rowTags: pick(row?.querySelector(".dashboard-template-tags")),
    sections: sections.map((el) => ({ ...pick(el), top: Math.round(el.getBoundingClientRect().top), scrollH: el.scrollHeight, kids: [...el.children].map((c) => `${c.tagName}.${c.className} h=${Math.round(c.getBoundingClientRect().height)}`) })),
    rowArticleDiv: (() => { const el = document.querySelector(".dashboard-template-row article > div"); if (!el) return null; const cs = getComputedStyle(el); const strong = el.querySelector("strong"); return { display: cs.display, flexDirection: cs.flexDirection, hasStrong: Boolean(strong), strongOrder: strong ? getComputedStyle(strong).order : "no-strong", kids: [...el.children].map(c => c.tagName) }; })(),
    rowArticle: (() => { const el = document.querySelector(".dashboard-template-row > article"); if (!el) return null; const cs = getComputedStyle(el); return { display: cs.display, flexDirection: cs.flexDirection, width: Math.round(el.getBoundingClientRect().width) }; })(),
    panel: (() => { const el = document.querySelector(".dashboard-template-library-panel"); const cs = getComputedStyle(el); return { display: cs.display, rows: cs.gridTemplateRows, cols: cs.gridTemplateColumns, top: Math.round(el.getBoundingClientRect().top), h: Math.round(el.getBoundingClientRect().height), scrollH: el.scrollHeight }; })(),
    sectionParent: (() => { const el = document.querySelector(".dashboard-template-section"); const parent = el.parentElement; const cs = getComputedStyle(parent); return { cls: parent.className, display: cs.display, rows: cs.gridTemplateRows, overflow: cs.overflow, h: Math.round(parent.getBoundingClientRect().height) }; })(),
    panelScrollHeight: document.querySelector(".dashboard-template-library-panel")?.scrollHeight,
    rowParent: row ? { cls: row.parentElement.className, display: getComputedStyle(row.parentElement).display } : null,
  };
});
console.log(JSON.stringify({ ...info, strongInfo: await page.evaluate(() => window.__strongInfo) }, null, 2));
await page.screenshot({ path: path.resolve("test-output/assets-template/diag-row.png") });
await browser.close();
