import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const { chromium } = playwright;
const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 120)));
await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60000 });
await page.getByLabel("用户名").fill("admin");
await page.getByLabel("密码").fill("admin");
await page.getByRole("button", { name: "登录" }).click();
await page.waitForTimeout(3000);
const sceneId = "d5395a30-4c29-4e8c-8bb0-b6b0d188c615";
await page.goto(`http://127.0.0.1:5173/studio/${sceneId}`, { waitUntil: "domcontentloaded", timeout: 60000 });
await page.locator(".scene-tree, .model-tree-item, canvas").first().waitFor({ timeout: 30000 });
await page.waitForTimeout(5000);
// 选中第一个场景树节点（模型行）
await page.waitForTimeout(1500);
// 展开“外观、特效与动画”折叠区（对象已默认选中）
const details = page.locator(".material-shader-effect");
await details.locator("summary").click();
await page.waitForTimeout(400);
// 打开着色器效果面板并选择菲涅尔
const shader = page.locator(".material-shader-effect");
if (await shader.count()) {
  await shader.locator("summary").click().catch(() => {});
  await page.waitForTimeout(300);
  await shader.locator("select").selectOption("fresnel-rim");
  await page.waitForTimeout(1500);
  const intensity = shader.locator("input[type='range']");
  if (await intensity.count()) await intensity.first().fill("2.5");
  await page.waitForTimeout(1200);
  await page.screenshot({ path: "../../test-output/codex-2026-09-05/shader-effect-verify.png" });
  // 读取面板状态
  const state = await page.evaluate(() => {
    const details = document.querySelector(".material-shader-effect");
    return { open: details?.open ?? false, select: details?.querySelector("select")?.value };
  });
  console.log(JSON.stringify({ state, errors }));
} else {
  console.log(JSON.stringify({ noShaderPanel: true, body: (await page.evaluate(() => document.body.innerText.slice(0, 200))) }));
}
await browser.close();
