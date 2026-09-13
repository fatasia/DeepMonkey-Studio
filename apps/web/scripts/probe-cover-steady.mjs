// 微探针:编辑器模板库真渲染稳态性能(区分会话冷启动与页面环境)。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
let project = null;
try {
  const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) }).then(r => r.json());
  const auth = { authorization: `Bearer ${login.token}`, "content-type": "application/json" };
  globalThis.__probeAuth = auth.authorization;
  project = await fetch(`${apiOrigin}/api/projects`, { method: "POST", headers: auth, body: JSON.stringify({ name: "临时-稳态微探针" }) }).then(r => r.json());
  const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
  await page.goto(origin);
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".scene-manager-page").waitFor();
  await page.goto(`${origin}/manager?project=${project.id}`);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("稳态探针");
  const created = page.waitForResponse(r => r.url().endsWith(`/api/projects/${project.id}/applications`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入", exact: true }).click();
  const application = await (await created).json();
  const t0 = Date.now();
  await page.goto(`${origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
  await page.locator(".dashboard-artboard").waitFor();
  await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
  await page.getByRole("button", { name: "模板", exact: true }).first().click();
  await page.locator(".template-layout-preview").first().waitFor();
  // 慢滚触发 IO,然后静置观察队列吞吐
  await page.locator(".template-layout-preview").first().hover();
  for (let step = 0; step < 20; step++) { await page.mouse.wheel(0, 500); await page.waitForTimeout(60); }
  const deadline = Date.now() + 60000;
  let last = -1, stable = 0;
  while (Date.now() < deadline) {
    const photos = await page.locator(".dashboard-template-cover-photo").count();
    if (photos === last) { if (!stable) stable = Date.now(); else if (Date.now() - stable > 6000) break; }
    else { stable = 0; last = photos; }
    await page.waitForTimeout(250);
  }
  const perf = await page.evaluate(() => window.__templateCoverPerf ?? []);
  console.log(JSON.stringify({ elapsedMs: Date.now() - t0, photos: last, perCover: perf }, null, 1));
} finally {
  await browser.close();
  if (project?.id) await fetch(`${apiOrigin}/api/projects/${project.id}`, { method: "DELETE", headers: { authorization: globalThis.__probeAuth } }).catch(() => undefined);
}
