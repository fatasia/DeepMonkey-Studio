// 小功能定向核实探针(u120-probe):优化器步骤按钮/环境面板关闭/工作区更多菜单/AI 助手/画布右键。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "test-output", "ui-sweep-2026-09-12");
mkdirSync(outDir, { recursive: true });
const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const result = { probes: [], console: [] };
let shotN = 100;
async function shot(p, name) {
  const file = `probe-${++shotN}-${name}.png`;
  await p.screenshot({ path: join(outDir, file) });
  return file;
}

const browser = await playwright.chromium.launch({ executablePath: CHROME, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" });
page.on("console", (m) => { if (m.type() === "error") result.console.push(m.text().slice(0, 200)); });
page.on("pageerror", (e) => result.console.push("pageerror: " + String(e?.message ?? e).slice(0, 200)));

async function probe(name, fn) {
  const entry = { name, ok: false, notes: [] };
  try { await fn(entry); entry.ok = true; } catch (e) { entry.error = String(e?.message ?? e).slice(0, 300); }
  result.probes.push(entry);
  console.log(`[${entry.ok ? "OK " : "ERR"}] ${name}${entry.error ? " :: " + entry.error : ""}`);
  for (const n of entry.notes) console.log("   -", String(n).slice(0, 160));
}

// 登录
await page.goto(origin + "/", { waitUntil: "domcontentloaded" });
await page.locator("input[aria-label=用户名]").waitFor({ timeout: 20000 });
await page.locator("input[aria-label=用户名]").fill("admin");
await page.locator("input[aria-label=密码]").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.locator(".scene-manager-page").waitFor({ timeout: 30000 });
await sleep(1200);

await probe("optimizer-step-buttons", async (s) => {
  await page.goto(origin + "/optimizer", { waitUntil: "domcontentloaded" });
  await sleep(2500);
  const texts = await page.locator("button").allTextContents();
  s.notes.push("含『转换』的按钮文本=" + JSON.stringify(texts.filter((t) => t.includes("转换")).slice(0, 5)));
  const btn = page.locator('button:has-text("转换")').first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await sleep(900);
    s.notes.push("点击『转换』OK,截图=" + await shot(page, "optimizer-step-2"));
  } else s.notes.push("『转换』按钮不可见");
});

await probe("workspace-more-menu", async (s) => {
  await page.goto(origin + "/manager?tab=scenes", { waitUntil: "domcontentloaded" });
  await sleep(1500);
  await page.locator('.scene-card button[aria-label="编辑场景"]').first().click();
  await sleep(4000);
  const summary = page.locator('summary[aria-label="更多场景工具"]');
  if (!(await summary.isVisible().catch(() => false))) { s.notes.push("更多场景工具不可见"); return; }
  await summary.click();
  await sleep(600);
  s.screenshot = await shot(page, "workspace-more-menu");
  const items = (await page.locator("details[open] button").allTextContents()).map((t) => t.trim()).filter(Boolean);
  s.notes.push("菜单项=" + JSON.stringify(items.slice(0, 14)));
  await page.keyboard.press("Escape");
  await sleep(400);
  s.notes.push(`Esc 后菜单关闭=${!(await summary.evaluate((el) => el.parentElement.open).catch(() => true))}`);
});

await probe("workspace-ai-assistant", async (s) => {
  const btn = page.locator('button[aria-label="AI 场景助手"]').first();
  if (!(await btn.isVisible().catch(() => false))) { s.notes.push("AI 场景助手按钮不可见"); return; }
  await btn.click();
  await sleep(1500);
  s.screenshot = await shot(page, "workspace-ai-panel");
  const input = page.locator('textarea, input[type="text"]');
  s.notes.push(`面板内输入框数量=${await input.count()}`);
  await btn.click();
  await sleep(500);
  s.notes.push("已收起 AI 面板");
});

await probe("environment-panel-close-control", async (s) => {
  // 确保在三维
  const btn3d = page.locator('.workspace-mode-switch button:text-is("三维")').first();
  if (await btn3d.isVisible().catch(() => false)) { await btn3d.click(); await sleep(4500); }
  const menu = page.locator('button[aria-label*="查看与分析"]').first();
  if (!(await menu.isVisible().catch(() => false))) { s.notes.push("查看与分析不可见"); return; }
  await menu.click();
  await sleep(500);
  const env = page.locator('[role=menuitem]:has-text("环境与灯光")').first();
  if (!(await env.isVisible().catch(() => false))) { s.notes.push("环境与灯光菜单项不可见"); return; }
  await env.click();
  await sleep(1200);
  s.screenshot = await shot(page, "env-panel-open");
  // 枚举面板头部/关闭类按钮的可访问名
  const names = await page.locator('[class*=environment] button, [class*=scene-env] button').evaluateAll(
    (els) => els.slice(0, 20).map((el) => el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent?.trim()).filter(Boolean),
  );
  s.notes.push("环境面板按钮名=" + JSON.stringify(names.slice(0, 14)));
  // 尝试常见关闭
  for (const sel of ['button[aria-label*="关闭环境"]', 'button[title*="关闭环境"]', '[class*=environment] button[aria-label*="关闭"]', '[class*=environment] [class*=close]']) {
    const b = page.locator(sel).first();
    if (await b.isVisible().catch(() => false)) {
      await b.click();
      await sleep(700);
      s.notes.push(`通过 ${sel} 关闭成功`);
      s.screenshot = await shot(page, "env-panel-closed");
      return;
    }
  }
  s.notes.push("未找到环境面板关闭控件,尝试 Esc");
  await page.keyboard.press("Escape");
  await sleep(500);
  s.screenshot = await shot(page, "env-panel-esc");
});

await probe("canvas-context-menu", async (s) => {
  const canvas = page.locator("canvas").first();
  const box = await canvas.boundingBox().catch(() => null);
  if (!box) { s.notes.push("无画布"); return; }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
  await sleep(700);
  const menuVisible = await page.locator('[role=menu], [class*=context-menu]').first().isVisible().catch(() => false);
  s.notes.push(`右键菜单出现=${menuVisible}`);
  s.screenshot = await shot(page, "canvas-context-menu");
  await page.keyboard.press("Escape");
  await sleep(300);
});

await browser.close();
writeFileSync(join(outDir, "probe-report.json"), JSON.stringify(result, null, 2));
console.log("探针报告: " + join(outDir, "probe-report.json"));
