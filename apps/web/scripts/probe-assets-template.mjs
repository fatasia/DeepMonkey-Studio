// 模板线 B1/B2 视觉闭环探针:编辑器模板库弹窗 + 资源页模板 tab + 新域插入 + 封面抽样,双主题。
// 用法:node scripts/probe-assets-template.mjs [origin] [round]
import fs from "node:fs";
import path from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const round = process.argv[3] ?? "round1";
const outDir = path.resolve(`test-output/assets-template/${round}`);
fs.mkdirSync(outDir, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const errors = [];

function watch(page, tag) {
  page.on("console", (m) => { if (["error", "warning"].includes(m.type())) errors.push(`[${tag}][${m.type()}] ${m.text().slice(0, 220)}`); });
  page.on("pageerror", (e) => errors.push(`[${tag}][pageerror] ${String(e.message).slice(0, 220)}`));
}

async function shot(page, name) {
  await page.waitForTimeout(420);
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`shot ${name}`);
}

/** 登录 admin/admin;已登录则跳过。 */
async function login(page) {
  const user = page.getByLabel(/用户名|Username/).first();
  if (await user.isVisible().catch(() => false)) {
    await user.fill("admin");
    await page.getByLabel(/密码|Password/).first().fill("admin");
    await page.getByRole("button", { name: /登录|Sign in/i }).first().click();
    await page.waitForTimeout(2200);
  }
}

/** 打开看板工作台的模板库弹窗:左侧"资源"tab → 组件库的"模板"按钮。 */
async function openTemplateLibrary(page) {
  if (await page.locator(".dashboard-template-library-panel").first().isVisible().catch(() => false)) return true;
  const resTab = page.locator('.dashboard-left-tabs button:has-text("资源")').first();
  if (await resTab.isVisible().catch(() => false)) { await resTab.click(); await page.waitForTimeout(800); }
  for (const locator of [
    page.locator(".dashboard-library-template-button").first(),
    page.getByRole("button", { name: "模板", exact: true }).first(),
  ]) {
    if (await locator.isVisible().catch(() => false)) { await locator.click(); await page.waitForTimeout(900); return true; }
  }
  return false;
}

async function dashboardSession(theme) {
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 1.5 });
  watch(page, `dashboard-${theme}`);
  await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "load" });
  await page.waitForTimeout(3200);
  return page;
}

async function selectOption(page, index, value) {
  const select = page.locator(".dashboard-template-library-panel select").nth(index);
  await select.selectOption(value).catch((e) => console.log(`select#${index}=${value} failed: ${String(e).slice(0, 120)}`));
  await page.locator(".dashboard-template-body").first().evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
  await page.waitForTimeout(650);
  const actual = await select.inputValue().catch(() => "?");
  console.log(`select#${index} -> ${actual}`);
}

// ---------- 1) 编辑器模板库弹窗(双主题) ----------
for (const theme of ["dark", "light"]) {
  const page = await dashboardSession(theme);
  if (!(await openTemplateLibrary(page))) { errors.push(`[${theme}] template library entry not found`); await page.close(); continue; }
  const panel = page.locator(".dashboard-template-library-panel").first();
  await page.screenshot({ path: path.join(outDir, `library-all-${theme}.png`) });
  console.log(`shot library-all-${theme}`);

  // 双分区全貌:滚到最新分区
  await panel.evaluate((el) => { el.querySelector(".dashboard-template-grid")?.scrollIntoView({ block: "end" }); }).catch(() => {});
  await shot(page, `library-sections-${theme}`);

  // 行业分组:公共服务(含医疗/政务/交通新域)
  await selectOption(page, 0, "public-service");
  await shot(page, `library-group-public-${theme}`);

  // 新兴领域(通信/文旅/农业)
  await selectOption(page, 0, "emerging");
  await shot(page, `library-group-emerging-${theme}`);

  // 类型=行业包
  await selectOption(page, 0, "all");
  await selectOption(page, 1, "packs");
  await shot(page, `library-type-packs-${theme}`);

  // 类型=推荐(双分区)
  await selectOption(page, 1, "recommended");
  await shot(page, `library-type-recommended-${theme}`);

  // 标签搜索联动
  await selectOption(page, 1, "all");
  await panel.locator(".dashboard-template-search input").fill("排行榜");
  await shot(page, `library-search-tag-${theme}`);
  await page.locator(".dashboard-template-library-panel .dashboard-template-search input").fill("");

  // 主题套件:点击「鎏金」套件卡 → 过滤视图;再退出
  const suiteCard = page.locator(".dashboard-template-suite").first();
  if (await suiteCard.isVisible().catch(() => false)) {
    await suiteCard.click();
    await page.locator(".dashboard-template-body").first().evaluate((el) => { el.scrollTop = 0; }).catch(() => {});
    await shot(page, `library-suite-active-${theme}`);
    const exit = page.locator(".dashboard-template-suite-active button").first();
    if (await exit.isVisible().catch(() => false)) { await exit.click(); await page.waitForTimeout(500); }
  } else errors.push(`[${theme}] suite entry not visible`);

  // ---------- 封面抽样:9 组逐组网格截图(30 域全覆盖) ----------
  const groups = ["manufacturing", "energy", "logistics", "business", "safety-quality", "facility", "water", "public-service", "emerging"];
  for (const group of groups) {
    await selectOption(page, 0, group);
    await shot(page, `covers-${group}-${theme}`);
  }
  await page.close();
}

// ---------- 2) 资源页模板 tab(双主题) ----------
for (const theme of ["dark", "light"]) {
  const page = await browser.newPage({ viewport: { width: 1680, height: 980 }, deviceScaleFactor: 1.5 });
  watch(page, `assets-${theme}`);
  await page.goto(origin, { waitUntil: "load" });
  await page.waitForTimeout(1400);
  await login(page);
  await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
  const assetsTab = page.locator('button[aria-label="资源"], button[aria-label="Assets"]').first();
  if (await assetsTab.isVisible().catch(() => false)) { await assetsTab.click(); await page.waitForTimeout(1500); }
  const kindTemplate = page.locator('button:has-text("看板模板")').first();
  if (await kindTemplate.isVisible().catch(() => false)) { await kindTemplate.click(); await page.waitForTimeout(1400); }
  await shot(page, `assets-templates-${theme}`);
  await page.close();
}

// ---------- 3) 抽样插入 4 个新域模板 ----------
{
  const page = await dashboardSession("dark");
  for (const [domain, label] of [["healthcare", "医疗健康监测"], ["government", "政务服务驾驶舱"], ["finance", "金融风控与经营"], ["tourism", "文化旅游态势"], ["power-grid", "电力电网调度"], ["semiconductor", "半导体晶圆制造"]]) {
    if (!(await page.locator(".dashboard-template-library-panel").first().isVisible().catch(() => false))) {
      if (!(await openTemplateLibrary(page))) { errors.push(`[insert] ${domain}: library entry not found`); break; }
    }
    await page.locator(".dashboard-template-library-panel .dashboard-template-search input").fill(`${label} · 经营总览`);
    await page.waitForTimeout(700);
    const card = page.locator(".dashboard-template-grid article, .dashboard-template-row article").filter({ hasText: `${label}` }).first();
    const insert = card.getByRole("button", { name: /插入当前页面|Insert into page/ }).first();
    if (await insert.isVisible().catch(() => false)) {
      await insert.click();
      await page.waitForTimeout(1800);
      await shot(page, `inserted-${domain}`);
    } else {
      errors.push(`[insert] ${domain} insert button not visible`);
    }
    if (domain !== "tourism") {
      // 刷新恢复干净画布,保证每个新域的插入证据独立。
      await page.reload({ waitUntil: "load" });
      await page.waitForTimeout(3000);
    }
  }
  await page.close();
}

fs.writeFileSync(path.join(outDir, "console-errors.log"), errors.slice(0, 80).join("\n") || "(no console errors)");
console.log(`--- errors(${errors.length}) ---`);
for (const line of errors.slice(0, 12)) console.log(line);
await browser.close();
console.log("probe done");
