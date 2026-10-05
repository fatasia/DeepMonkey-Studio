// 一次性探查 v2:跨后端会话逐腿输出 per-model 世界包围盒,定位 fit 包围盒 x 漂移源。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const webOrigin = "http://127.0.0.1:5173";
const projectId = "38ea81ba-3033-4d3e-86b5-648fd58d98f1";
const sceneId = "fedab835-389b-43a5-99be-6820d0f3afde";

const login = await fetch("http://127.0.0.1:4100/api/auth/login", {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: "admin", password: "admin" }),
});
const { token } = await login.json();
const browser = await playwright.chromium.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true, args: ["--enable-unsafe-webgpu", "--no-sandbox"],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
page.setDefaultTimeout(45_000);
await page.goto(`${webOrigin}/studio/${sceneId}?project=${projectId}`, { waitUntil: "domcontentloaded" });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
await page.waitForTimeout(1_500);

async function openRendererDialog() {
  const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
  if (await dialog.isVisible().catch(() => false)) return dialog;
  await page.getByLabel("更多场景工具", { exact: true }).click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await dialog.waitFor({ state: "visible" });
  return dialog;
}

async function switchBackend(backend) {
  const preference = backend;
  const current = await page.evaluate(() => localStorage.getItem("bim-studio.renderer-backend"));
  if (current !== preference) {
    const dialog = await openRendererDialog();
    const button = backend === "webgl" ? "切换到兼容模式"
      : backend === "webgpu" ? "启用 Deep WebGPU" : "启用 Deep WASM";
    await dialog.getByRole("button", { name: button, exact: true }).click();
    if (backend === "webgl") {
      await page.waitForFunction(() => {
        const c = document.querySelector(".viewport canvas:not([data-renderer-backend])");
        return c && getComputedStyle(c).opacity === "1";
      }, undefined, { timeout: 120_000 });
    } else {
      const presented = backend === "webgpu" ? "deep-webgpu" : "deep-wasm";
      await page.waitForFunction(expected => {
        const canvas = document.querySelector(`.viewport canvas[data-renderer-backend="${expected}"]`);
        const failed = document.querySelector(".renderer-switch-status.failed");
        return failed || (canvas && getComputedStyle(canvas).opacity === "1");
      }, presented, { timeout: 120_000 });
    }
    await dialog.getByRole("button", { name: "关闭", exact: true }).click();
  }
  await page.waitForTimeout(800);
}

const dump = async label => {
  const probe = await page.evaluate(() => globalThis.__studioCameraProbe());
  console.log(`--- ${label} target=${probe.camera.target.map(v => v.toFixed(4)).join(",")}`);
  for (const model of probe.models) {
    console.log(`  ${model.id.slice(0, 8)} ${model.kind.padEnd(9)} min=[${model.worldBox.min.map(v => v.toFixed(3))}] max=[${model.worldBox.max.map(v => v.toFixed(3))}]`);
  }
};

for (const backend of ["webgl", "webgpu", "wasm"]) {
  await switchBackend(backend);
  await page.getByRole("button", { name: "适应整个场景", exact: true }).click();
  await page.waitForTimeout(700);
  await dump(`${backend} fitAll`);
}

await browser.close();
console.log("done");
