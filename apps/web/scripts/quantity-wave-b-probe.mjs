// 素材数量波次 B 视觉验证:4 新行业域(电力交易/化工安全/冷链物流/会展活动)
// 逐域封面截图 + 每域抽样插入画布渲染,双主题 × 2 轮(非正式门禁,人工目检取材)。
// 用法:node scripts/quantity-wave-b-probe.mjs [origin]
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.argv[2] ?? "http://127.0.0.1:5173";
const output = resolve("test-output/quantity-wave-b");
await mkdir(output, { recursive: true });
const DOMAINS = [
  { key: "power-trading", query: "电力交易运营" },
  { key: "chem-safety", query: "化工安全管控" },
  { key: "cold-chain", query: "冷链物流监控" },
  { key: "expo", query: "会展活动指挥" },
];
const report = { rounds: [], failures: [] };
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true,
});

for (const round of [1, 2]) {
  for (const theme of ["dark", "light"]) {
    const entry = { round, theme, domains: [] };
    report.rounds.push(entry);
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    try {
      // 登录(已登录则跳过):等待登录表单或管理页二者之一渲染完成再判断
      await page.goto(origin);
      const loginInput = page.getByLabel("用户名");
      await loginInput.or(page.locator(".scene-manager-page")).first().waitFor();
      if (await loginInput.count()) {
        await loginInput.fill("admin");
        await page.getByLabel("密码").fill("admin");
        await page.getByRole("button", { name: "登录", exact: true }).click();
      }
      await page.locator(".scene-manager-page").waitFor();
      // 确保主题与轮次一致(走品牌设置页真实用户路径)
      await page.getByRole("button", { name: "品牌设置", exact: true }).click();
      const themeSelect = page.getByRole("combobox").filter({ has: page.locator("option[value='light']") }).first();
      await themeSelect.selectOption(theme);
      await page.getByRole("button", { name: /保存并应用|Save & apply/ }).click();
      await page.waitForTimeout(800);
      // 建项目与看板应用(项目走 API,应用走 UI 先例流程)
      const projectId = await page.evaluate(async () => {
        const token = localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token") ?? "";
        const response = await fetch("/api/projects", {
          method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ name: `数量波次B ${Date.now()}` }),
        });
        if (!response.ok) throw new Error(`创建项目失败: ${response.status}`);
        const project = await response.json();
        return project.id ?? project.metadata?.id;
      });
      await page.goto(`${origin}/manager?project=${projectId}`);
      const created = page.waitForResponse((response) => response.url().endsWith(`/api/projects/${projectId}/applications`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "新建场景", exact: true }).click();
      await page.getByLabel("场景名称").fill("波次B看板");
      await page.getByRole("button", { name: "创建并进入", exact: true }).click();
      const application = await (await created).json();
      // 进入看板工作台
      await page.goto(`${origin}/studio/${projectId}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
      await page.locator(".dashboard-artboard").waitFor();
      for (const domain of DOMAINS) {
        const item = { domain: domain.key, covers: 0, coverPhotos: 0, inserted: false, undone: false };
        entry.domains.push(item);
        // 打开模板库
        await page.getByRole("button", { name: "资源", exact: true }).click();
        await page.locator(".dashboard-library-template-button").click();
        const modal = page.getByRole("dialog", { name: "看板模板库", exact: true });
        await modal.waitFor();
        // 等封面截帧管线就绪:首批截帧请求早于 runtime 就绪会被丢弃,导致首查域退化为 SVG 保底
        await page.waitForTimeout(2500);
        await modal.getByRole("textbox").fill(domain.query);
        // 面板含"推荐(前8)+最新(全部)"两分区,article 数 = min(8,N) + N;按"最新"分区断言恰 10 卡
        const newestCards = modal.locator("section:has(strong:text-is('最新')) article");
        await newestCards.first().waitFor();
        item.covers = await newestCards.count();
        // 滚动触发封面运行时截帧(懒加载),等待真实封面淡入(推荐+最新重复展示,共 2N 张)
        await modal.locator(".dashboard-template-body").evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await page.waitForTimeout(600);
        await modal.locator(".dashboard-template-body").evaluate((element) => { element.scrollTop = 0; });
        try {
          await page.waitForFunction(
            ([expected]) => document.querySelectorAll(".dashboard-template-cover-photo").length >= expected,
            [Math.min(item.covers * 2, 36)], { timeout: 10000 },
          );
          item.coverPhotos = await modal.locator("img.dashboard-template-cover-photo").count();
        } catch { item.coverPhotos = await modal.locator("img.dashboard-template-cover-photo").count(); }
        // 分三段滚动截图,保证"最新"分区 10 个模板封面全部入镜(逐模板目检取证)
        const body = modal.locator(".dashboard-template-body");
        await modal.screenshot({ path: resolve(output, `r${round}-${theme}-${domain.key}-covers-top.png`) });
        await body.evaluate((element) => { element.scrollTop = (element.scrollHeight - element.clientHeight) / 2; });
        await page.waitForTimeout(900);
        await modal.screenshot({ path: resolve(output, `r${round}-${theme}-${domain.key}-covers-mid.png`) });
        await body.evaluate((element) => { element.scrollTop = element.scrollHeight; });
        await page.waitForTimeout(900);
        await modal.screenshot({ path: resolve(output, `r${round}-${theme}-${domain.key}-covers-bot.png`) });
        // 抽样插入最新分区第一个模板并截图画布
        await newestCards.first().getByRole("button", { name: "插入当前页面", exact: true }).click();
        await modal.waitFor({ state: "detached" });
        await page.waitForTimeout(1800);
        await page.screenshot({ path: resolve(output, `r${round}-${theme}-${domain.key}-canvas.png`) });
        item.inserted = true;
        // 撤销插入,保持画布干净供下一域
        await page.locator(".dashboard-artboard").click({ position: { x: 8, y: 8 } });
        await page.keyboard.press("Control+z");
        await page.waitForTimeout(600);
        item.undone = true;
      }
      entry.passed = entry.domains.every((item) => item.covers === 10 && item.inserted && item.undone);
    } catch (error) {
      entry.passed = false;
      report.failures.push({ round, theme, error: String(error).slice(0, 500) });
      await page.screenshot({ path: resolve(output, `r${round}-${theme}-failed.png`) }).catch(() => {});
    } finally {
      await context.close();
    }
  }
}
await browser.close();
await writeFile(resolve(output, "probe-report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
