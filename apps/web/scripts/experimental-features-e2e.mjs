import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { mkdirSync } from "node:fs";

/**
 * 配置易用性 E2E:实验性功能面板(发现性闭环)。
 * 流程:登录 → 打开空场景 studio → 工具坞「仿真与开发」→「实验性功能」开面板
 * → 断言 12 个开关行 → 勾选 t25-gpu-pass-timing →「应用并重载」→ 断言 URL 带
 * 参且面板勾选态保持 → 「复制带参链接」读剪贴板 → 全新 context 打开该链接,
 * 断言面板显示开关已启用(带参链接可发现)。另附:系统设置 AI tab 测试连接
 * 内联反馈(data-testid=ai-test-status)截图证据。
 * 输出:test-output/cfg-experimental-panel/
 */

const OUT = "../../test-output/cfg-experimental-panel";
mkdirSync(OUT, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const login = await fetch("http://127.0.0.1:4100/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
if (!login.ok) { console.error("登录失败", login.status); process.exit(1); }
const { token } = await login.json();

const b = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--no-sandbox"],
});

// ---- Context A:开面板 → 切换 → 应用重载 → 复制链接 ----
const ctxA = await b.newContext({ viewport: { width: 1920, height: 1080 } });
await ctxA.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://127.0.0.1:5173" });
await ctxA.addInitScript((token) => localStorage.setItem("bim-studio-auth-token", token), token);
const page = await ctxA.newPage();
page.on("pageerror", (e) => console.log("PAGEERR", e.message.slice(0, 200)));

await page.goto("http://127.0.0.1:5173/studio/new", { waitUntil: "domcontentloaded" });
const develop = page.getByRole("button", { name: /仿真与开发|Simulate & develop/ }).first();
await develop.waitFor({ state: "visible", timeout: 60000 });
check("studio 工具坞出现(空场景 /studio/new)", true);

await develop.click();
const experimentalEntry = page.getByRole("menuitem", { name: /实验性功能|Experimental features/ }).first();
await experimentalEntry.waitFor({ state: "visible", timeout: 5000 });
check("「实验性功能」菜单项存在且可见", true);
await experimentalEntry.click();

const panel = page.locator(".experimental-features-panel");
await panel.waitFor({ state: "visible", timeout: 5000 });
await page.screenshot({ path: `${OUT}/01-panel-open.png` });
check("面板打开", true);

const rowCount = await page.locator("[data-testid^='ef-row-']").count();
check("面板枚举 12 个开关行", rowCount === 12, `rows=${rowCount}`);
const paramChips = await page.locator(".ef-param").allTextContents();
check("参数徽章含 mega-lights 与 t25-gpu-pass-timing",
  paramChips.includes("mega-lights") && paramChips.includes("t25-gpu-pass-timing"), paramChips.slice(0, 12).join(","));

// 勾选 t25-gpu-pass-timing → 应用并重载
const t25Checkbox = page.locator("[data-testid='ef-row-t25-gpu-pass-timing'] input[type='checkbox']");
check("t25 初始未勾选(URL 无参)", !(await t25Checkbox.isChecked()));
await t25Checkbox.setChecked(true);
const applyButton = page.locator(".ef-footer button.primary");
check("草稿待应用时「应用并重载」可用", await applyButton.isEnabled());
await page.waitForTimeout(300);
await applyButton.click();
await page.waitForTimeout(2000);
console.log("URL-After-Click", page.url(), "panelVisible", await panel.isVisible().catch(() => false));
await page.waitForURL("**t25-gpu-pass-timing=1*", { timeout: 15000 });
check("应用后 URL 带参数并重载", page.url().includes("t25-gpu-pass-timing=1"), page.url());

// 重载后重开面板,勾选态保持
await page.getByRole("button", { name: /仿真与开发|Simulate & develop/ }).first().click();
await page.getByRole("menuitem", { name: /实验性功能|Experimental features/ }).first().click();
await panel.waitFor({ state: "visible", timeout: 5000 });
const t25After = page.locator("[data-testid='ef-row-t25-gpu-pass-timing'] input[type='checkbox']");
check("重载后面板勾选态与 URL 一致(已启用)", await t25After.isChecked());
await page.screenshot({ path: `${OUT}/02-panel-after-reload.png` });

// 复制带参链接(草稿=当前生效态)→ 读剪贴板
// 再勾选一项(mega-lights)使草稿含两项,验证链接生成器编码
const megaCheckbox = page.locator("[data-testid='ef-row-mega-lights'] input[type='checkbox']");
await megaCheckbox.setChecked(true);
await page.locator(".ef-footer button", { hasText: /复制带参链接|Copy link/ }).click();
await page.waitForTimeout(400);
const copied = await page.evaluate(() => navigator.clipboard.readText());
const copiedUrl = new URL(copied);
check("复制链接:含 t25 与 mega-lights 两个非默认参数",
  copiedUrl.searchParams.get("t25-gpu-pass-timing") === "1" && copiedUrl.searchParams.get("mega-lights") === "1", copied);
check("复制链接:保留 studio 场景路由", copiedUrl.pathname.startsWith("/studio/"), copiedUrl.pathname);
await ctxA.close();

// ---- Context B:全新会话打开带参链接,验证可发现性 ----
const ctxB = await b.newContext({ viewport: { width: 1920, height: 1080 } });
await ctxB.addInitScript((token) => localStorage.setItem("bim-studio-auth-token", token), token);
const pageB = await ctxB.newPage();
await pageB.goto(copied, { waitUntil: "domcontentloaded" });
await pageB.getByRole("button", { name: /仿真与开发|Simulate & develop/ }).first().waitFor({ state: "visible", timeout: 60000 });
await pageB.getByRole("button", { name: /仿真与开发|Simulate & develop/ }).first().click();
await pageB.getByRole("menuitem", { name: /实验性功能|Experimental features/ }).first().click();
await pageB.locator(".experimental-features-panel").waitFor({ state: "visible", timeout: 5000 });
const megaB = pageB.locator("[data-testid='ef-row-mega-lights'] input[type='checkbox']");
const t25B = pageB.locator("[data-testid='ef-row-t25-gpu-pass-timing'] input[type='checkbox']");
check("新 context:复制链接打开后 mega-lights 显示已启用", await megaB.isChecked());
check("新 context:t25-gpu-pass-timing 显示已启用", await t25B.isChecked());
await pageB.screenshot({ path: `${OUT}/03-fresh-context-link.png` });
await ctxB.close();

// ---- 附加:AI 配置测试连接内联反馈 ----
const ctxC = await b.newContext({ viewport: { width: 1920, height: 1080 } });
await ctxC.addInitScript((token) => localStorage.setItem("bim-studio-auth-token", token), token);
const pageC = await ctxC.newPage();
await pageC.goto("http://127.0.0.1:5173/system?tab=ai", { waitUntil: "domcontentloaded" });
const testButton = pageC.getByRole("button", { name: /测试连接|Test/ }).first();
await testButton.waitFor({ state: "visible", timeout: 60000 });
await testButton.click();
const status = pageC.locator("[data-testid='ai-test-status']");
await status.waitFor({ state: "visible", timeout: 30000 }).catch(() => undefined);
const statusText = (await status.isVisible().catch(() => false)) ? await status.textContent() : "(未出现)";
check("AI 测试连接:反馈内联呈现(role=status,不再用阻塞 alert)", await status.isVisible().catch(() => false), String(statusText).slice(0, 120));
await pageC.screenshot({ path: `${OUT}/04-ai-test-inline-status.png`, fullPage: false });
await ctxC.close();

await b.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nSUMMARY ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) { for (const f of failed) console.log("FAILED:", f.name, f.detail); process.exit(1); }
