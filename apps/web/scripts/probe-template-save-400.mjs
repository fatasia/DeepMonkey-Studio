// 聚焦探针:插入模板后触发保存,归因 application PUT/GET 400 的响应体(临时排障用)。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
let project = null;
try {
  const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) }).then(r => r.json());
  const auth = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
  project = await fetch(`${apiOrigin}/api/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: "临时-保存400探针" }) }).then(r => r.json());

  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/applications/") && response.status() >= 400) {
      let body = "";
      try { body = await response.text(); } catch { body = "<unreadable>"; }
      console.log(`>>> ${response.request().method()} ${response.status()} ${url}\n${body.slice(0, 800)}`);
    }
  });
  await page.goto(origin);
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".scene-manager-page").waitFor();
  await page.goto(`${origin}/manager?project=${project.id}`);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("保存探针");
  const created = page.waitForResponse(r => r.url().endsWith(`/api/projects/${project.id}/applications`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入", exact: true }).click();
  const application = await (await created).json();
  await page.goto(`${origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
  await page.locator(".dashboard-artboard").waitFor();
  await page.waitForTimeout(3000); // 观察加载期是否出现 400
  await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
  await page.getByRole("button", { name: "模板", exact: true }).first().click();
  await page.locator(".template-layout-preview").first().waitFor();
  const card = page.locator("article").filter({ has: page.locator("strong", { hasText: "经营驾驶舱 · 经营总览" }) }).first();
  await card.scrollIntoViewIfNeeded();
  await card.getByRole("button", { name: "插入当前页面", exact: true }).click();
  await page.locator(".dashboard-template-library-backdrop").waitFor({ state: "detached" });
  await page.waitForTimeout(1500);
  console.log("--- 触发手动保存 ---");
  await page.waitForTimeout(4000); // 观察自动保存 + 检查已保存文档
  const saved = await fetch(`${apiOrigin}/api/projects/${project.id}/applications/${application.metadata.id}`, { headers: { authorization: auth.authorization } }).then(r => r.json());
  const nodes = saved.pages?.[0]?.nodes ?? [];
  const samples = nodes.filter(n => n.widget?.sampleData);
  console.log(`已保存文档: 节点=${nodes.length}, 带样例=${samples.length}, 首个样例行数=${samples[0]?.widget?.sampleData?.rows?.length}`);
  console.log("--- done ---");
} finally {
  await browser.close();
  if (project?.id) await fetch(`${apiOrigin}/api/projects/${project.id}`, { method: "DELETE", headers: { authorization: (await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) }).then(r => r.json())).token, "content-type": "application/json" } }).catch(() => undefined);
}
