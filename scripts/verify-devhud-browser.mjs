import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../apps/cloud-render-worker/node_modules/playwright-core/index.js";

// 刀 6 开发者 HUD 浏览器验收:真实编辑器(studio 视图)内 F9 开 HUD → FPS 数值合理 →
// 折叠/展开 → 拖拽 → 位置持久化(重载保持)→ 深浅主题截图;Deep 段为可选增强
// (headless WebGPU 不可用时如实记录 skip,不阻塞主证据)。不保存场景。
const web = process.env.STUDIO_WEB_ORIGIN ?? "http://127.0.0.1:5173";
const api = process.env.STUDIO_API_ORIGIN ?? "http://127.0.0.1:4100";
const projectId = process.env.STUDIO_PROJECT_ID ?? "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = process.env.STUDIO_SCENE_ID ?? "fedab835-389b-43a5-99be-6820d0f3afde";
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const out = fileURLToPath(new URL(`../test-output/devhud-${stamp}/`, import.meta.url));
await mkdir(out, { recursive: true });

const { token } = await (await fetch(`${api}/api/auth/login`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
})).json();
assert.ok(token, "admin login failed");
const browser = await playwright.chromium.launch({
  executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, colorScheme: "dark", reducedMotion: "reduce" });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
page.setDefaultTimeout(45_000);
const errors = [], steps = [], skips = [], envNoise = [];
page.on("pageerror", (error) => {
  const text = String(error);
  // dev 工作副本上有并行会话的未提交材质改动(setUserMaterialPresets),与本刀无关,记录不阻塞。
  if (/setUserMaterialPresets/.test(text)) { envNoise.push(text); return; }
  errors.push(text);
});
page.on("console", (message) => {
  if (message.type() === "error" && !/Failed to load resource|WebGPU|favicon/.test(message.text())) {
    if (/setUserMaterialPresets/.test(message.text())) { envNoise.push(message.text()); return; }
    errors.push(message.text());
  }
});
const shot = async (name) => { await page.screenshot({ path: `${out}${name}.png` }); steps.push(name); };
const hudBox = async () => page.locator(".dev-hud").evaluate((node) => {
  const rect = node.getBoundingClientRect();
  return { x: Math.round(rect.left), y: Math.round(rect.top), width: Math.round(rect.width), height: Math.round(rect.height) };
});

try {
  await page.goto(`${web}/studio/${sceneId}?project=${projectId}`, { waitUntil: "domcontentloaded" });
  await page.locator(".viewport canvas").first().waitFor({ state: "visible" });
  await page.waitForTimeout(2500);
  const auto = page.getByLabel("自动保存"); if (await auto.isChecked()) await auto.uncheck();
  assert.equal(await page.locator(".dev-hud").count(), 0, "HUD 默认必须关闭");

  // Orbit 一下确保有渲染帧(FPS 采样需要 ≥2 帧)。
  await page.mouse.move(960, 540); await page.mouse.down();
  await page.mouse.move(1010, 520, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(600);

  // F9 开 HUD:FPS 数值存在且合理。
  await page.keyboard.press("F9");
  await page.locator(".dev-hud").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const value = document.querySelector(".dev-hud header strong")?.textContent ?? "";
    const fps = Number(value);
    return Number.isFinite(fps) && fps > 0 && fps <= 1000;
  }, undefined, { timeout: 20_000 });
  const fps = await page.locator(".dev-hud header strong").innerText();
  assert.ok(await page.locator(".dev-hud .hud-body").isVisible(), "HUD 默认展开");
  for (const label of ["帧时 P50", "帧时 P95", "Draw / Tris", "品质档", "JS 堆"]) {
    assert.ok(await page.locator(".dev-hud .hud-row", { hasText: label }).first().isVisible(), `缺少行:${label}`);
  }
  await shot("01-webgl-dark-expanded");

  // 折叠:单行摘要,不渲染指标体。
  await page.locator(".dev-hud header button[aria-expanded]").click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator(".dev-hud").getAttribute("data-collapsed"), "true", "折叠态标记缺失");
  assert.equal(await page.locator(".dev-hud .hud-body").count(), 0, "折叠后不应渲染指标体");
  await shot("02-collapsed");
  await page.locator(".dev-hud header button[aria-expanded]").click();
  await page.waitForTimeout(300);

  // 拖拽 header 到视口中左,断言位置改变并持久化。
  const before = await hudBox();
  const header = page.locator(".dev-hud header");
  const headerBox = await header.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.move(headerBox.x, headerBox.y);
  await page.mouse.down();
  await page.mouse.move(420, 460, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await hudBox();
  assert.ok(Math.abs(after.x - before.x) > 80 && Math.abs(after.y - before.y) > 80,
    `拖拽未生效:${JSON.stringify({ before, after })}`);
  const persisted = await page.evaluate(() => localStorage.getItem("bim-studio.devhud.position"));
  assert.ok(persisted, "拖拽后位置未写入 localStorage");
  await shot("03-dragged");

  // 重载:F9 重开后位置恢复到持久化点。
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".viewport canvas").first().waitFor({ state: "visible" });
  await page.waitForTimeout(2000);
  assert.equal(await page.locator(".dev-hud").count(), 0, "重载后 HUD 默认仍关闭");
  await page.keyboard.press("F9");
  await page.locator(".dev-hud").waitFor({ state: "visible" });
  await page.waitForTimeout(500);
  const restored = await hudBox();
  assert.ok(Math.abs(restored.x - after.x) <= 2 && Math.abs(restored.y - after.y) <= 2,
    `位置未恢复:persisted=${persisted} restored=${JSON.stringify(restored)}`);

  // 浅色主题:直接切主题令牌(不改用户偏好),HUD 令牌随主题生效。
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.waitForTimeout(300);
  await shot("04-light");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));

  // 窄视口不越界。
  await page.setViewportSize({ width: 640, height: 720 });
  await page.waitForTimeout(400);
  const narrow = await hudBox();
  assert.ok(narrow.x >= 0 && narrow.x + narrow.width <= 640, `窄视口越界:${JSON.stringify(narrow)}`);
  await shot("05-narrow-640");
  await page.setViewportSize({ width: 1920, height: 1080 });

  // 可选 Deep 段:切 Deep WebGPU + t25-gpu-pass-timing=1 重载,HUD 应出现逐 pass 列表。
  try {
    await page.evaluate(() => localStorage.setItem("bim-studio.devhud.position", JSON.stringify({ x: 16, y: 16 })));
    await page.goto(`${web}/studio/${sceneId}?project=${projectId}&t25-gpu-pass-timing=1`, { waitUntil: "domcontentloaded" });
    await page.locator(".viewport canvas").first().waitFor({ state: "visible" });
    await page.waitForTimeout(2000);
    await page.getByLabel("更多场景工具", { exact: true }).click();
    await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
    await page.getByRole("button", { name: "启用 Deep WebGPU", exact: true }).click();
    await page.locator('.viewport canvas[data-renderer-backend="deep-webgpu"]').waitFor({ state: "attached", timeout: 90_000 });
    await page.waitForTimeout(6000); // 等 Deep 首帧 + 遥测采样窗口(4Hz)
    // 关掉渲染引擎设置对话框,避免遮挡 HUD 证据截图。
    await page.locator(".renderer-diagnostics-dialog").evaluate((dialog) => dialog instanceof HTMLDialogElement && dialog.close());
    await page.waitForTimeout(500);
    await page.keyboard.press("F9");
    await page.locator(".dev-hud").waitFor({ state: "visible" });
    await page.waitForFunction(() => (document.querySelector(".dev-hud .hud-badge")?.textContent ?? "").includes("Deep WebGPU"),
      undefined, { timeout: 20_000 });
    const badge = await page.locator(".dev-hud .hud-badge").innerText();
    const passRows = await page.locator(".dev-hud .hud-pass-row").count();
    if (passRows > 0) {
      const topPass = await page.locator(".dev-hud .hud-pass-row").first().innerText();
      assert.match(topPass, /ms$/, `逐 pass 行缺少毫秒值:${topPass}`);
      await shot("06-deep-pass-timings");
      steps.push(`deep-badge=${badge}`, `deep-pass-rows=${passRows}`);
    } else {
      skips.push("Deep 已接入但逐 pass 计时无读回(headless timestamp-query 限制);HUD 应显示未开启/不可用引导");
      const note = await page.locator(".dev-hud .hud-note").first().innerText().catch(() => "");
      assert.ok(/t25-gpu-pass-timing|不可用|未开启/.test(note), `缺测引导缺失:${note}`);
      await shot("06-deep-timing-off-note");
      steps.push(`deep-badge=${badge}`, "deep-pass-rows=0");
    }
  } catch (deepError) {
    skips.push(`Deep 段跳过:${String(deepError).slice(0, 220)}`);
    await page.screenshot({ path: `${out}06-deep-skipped.png` }).catch(() => {});
  }

  assert.deepEqual(errors, [], `页面错误:${JSON.stringify(errors)}`);
} catch (error) {
  await page.screenshot({ path: `${out}failed.png` }).catch(() => {});
  throw error;
} finally {
  await browser.close();
  await writeFile(path_json(out), JSON.stringify({
    scope: "DevHud F9/折叠/拖拽/位置持久化/深浅主题/窄视口 + 可选 Deep 逐 pass(真实编辑器)",
    steps, skips, errors, envNoise,
  }, null, 2));
}
assert.deepEqual(skips, [], "存在未覆盖段,见 result.json");

function path_json(dir) { return `${dir}result.json`; }
