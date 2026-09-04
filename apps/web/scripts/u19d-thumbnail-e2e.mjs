// U1-9d 端到端验证：3D 编辑器保存 → 文档含 thumbnail → 管理页卡片显示真实截图。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const sceneId = "d5395a30-4c29-4e8c-8bb0-b6b0d188c615";
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const out = {};
try {
  await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3000);
  await page.goto(`http://127.0.0.1:5173/studio/${sceneId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(9000);
  // 触发保存
  const saveBtn = page.locator("button", { hasText: "保存项目" }).first();
  await saveBtn.click({ timeout: 10000 });
  await page.waitForTimeout(4000);
  // 从页面上下文带令牌读取保存后的应用文档，检查 thumbnail
  out.doc = await page.evaluate(async (sid) => {
    const token = Object.entries(localStorage).find(([k]) => /token|auth/i.test(k))?.[1];
    let bearer = null;
    try { bearer = JSON.parse(token)?.accessToken ?? token; } catch { bearer = token; }
    const headers = bearer ? { authorization: `Bearer ${bearer}` } : {};
    const projects = await fetch("/api/projects", { headers }).then((r) => r.json());
    for (const project of projects.slice(0, 3)) {
      const apps = await fetch(`/api/projects/${project.id}/applications`, { headers }).then((r) => r.json()).catch(() => []);
      const list = Array.isArray(apps) ? apps : apps.items ?? [];
      for (const app of list) {
        const scenes = app.scenes ?? [];
        const hit = scenes.find((s) => s.id === sid);
        if (hit) return { appId: app.metadata?.id, sceneName: hit.name, hasThumbnail: typeof hit.thumbnail === "string" && hit.thumbnail.startsWith("data:image/jpeg"), thumbnailLength: hit.thumbnail?.length ?? 0 };
      }
    }
    return { found: false };
  }, sceneId);
  // 管理页卡片截图
  await page.goto("http://127.0.0.1:5173/manager", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  const cardImg = await page.evaluate(() => {
    const img = document.querySelector(".scene-card-thumbnail-image");
    return img ? { src: img.src.slice(0, 40), w: img.clientWidth, h: img.clientHeight } : { present: false };
  });
  out.cardImg = cardImg;
  await page.screenshot({ path: "test-output/nightly-2026-09-05/u19d-manager-thumbnail.png" });
} catch (error) {
  out.fatal = String(error).slice(0, 300);
}
console.log(JSON.stringify(out, null, 2));
await browser.close();
