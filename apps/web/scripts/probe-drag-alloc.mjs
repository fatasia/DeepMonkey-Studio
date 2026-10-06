// 拖拽窗口分配采样:CDP HeapProfiler.startSampling,归因每帧分配热点。
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
const webOrigin = "http://127.0.0.1:5173";
const apiOrigin = "http://127.0.0.1:4100";
const login = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "admin", password: "admin" }) });
const { token } = await login.json();
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(({ token }) => {
  localStorage.setItem("bim-studio-auth-token", token);
  localStorage.setItem("bim-studio.renderer-backend", "webgl");
}, { token });
const page = await context.newPage();
page.setDefaultTimeout(60_000);
await page.goto(`${webOrigin}/studio/fedab835-389b-43a5-99be-6820d0f3afde?project=38ea81ba-3033-4d3e-86b5-648fd58d98f1`, { waitUntil: "domcontentloaded" });
await page.locator(".viewport canvas:not([data-renderer-backend])").first().waitFor({ state: "visible" });
await page.waitForTimeout(1_200);
const dialog = page.getByRole("dialog", { name: "渲染引擎设置", exact: true });
await page.getByLabel("更多场景工具", { exact: true }).click();
await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
await dialog.getByRole("button", { name: "启用 Deep WebGPU", exact: true }).click();
await page.waitForFunction(() => {
  const c = document.querySelector('.viewport canvas[data-renderer-backend="deep-webgpu"]');
  return c && getComputedStyle(c).opacity === "1";
}, undefined, { timeout: 120_000 });
await dialog.getByRole("button", { name: "关闭", exact: true }).click();
await page.waitForTimeout(800);
await page.getByRole("button", { name: "适应整个场景", exact: true }).click();
await page.waitForTimeout(700);
const bounds = await page.locator(".viewport canvas:not([data-renderer-backend])").first().boundingBox();
const cdp = await context.newCDPSession(page);
await cdp.send("HeapProfiler.enable");
await cdp.send("HeapProfiler.startSampling", { samplingInterval: 32768 });
const x = bounds.x + bounds.width / 2, y = bounds.y + bounds.height / 2;
await page.mouse.move(x, y);
await page.mouse.down();
for (let i = 0; i < 120; i++) {
  const phase = i / 119 * Math.PI * 4;
  await page.mouse.move(x + Math.sin(phase) * bounds.width * 0.18, y + Math.cos(phase * 0.5) * bounds.height * 0.08);
  await page.waitForTimeout(16);
}
await page.mouse.up();
const stopRaw = await cdp.send("HeapProfiler.stopSampling");
const profile = stopRaw?.profile ?? stopRaw?.result?.profile ?? stopRaw;
if (!profile?.nodes) console.error("[debug] stopSampling keys:", JSON.stringify(Object.keys(stopRaw ?? {})));
await browser.close();
// 聚合 self 分配字节:堆采样为树形(head+samples),先扁平化再按节点求 self。
const nodesById = new Map();
const walk = node => {
  nodesById.set(node.id, node);
  for (const child of node.children ?? []) walk(child);
};
walk(profile.head);
const selfBytes = new Map();
for (const id of nodesById.keys()) selfBytes.set(id, 0);
for (const sample of profile.samples ?? []) {
  selfBytes.set(sample.nodeId, (selfBytes.get(sample.nodeId) ?? 0) + Math.max(0, sample.size ?? 0));
}
const hot = [...selfBytes.entries()].map(([id, bytes]) => {
  const cf = nodesById.get(id)?.callFrame ?? {};
  const file = (cf.url ?? "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/@fs\//, "").slice(-80);
  return { fn: `${cf.functionName || "(anon)"} @ ${file}:${cf.lineNumber ?? "?"}`, mb: Math.round(bytes / 1048576 * 100) / 100 };
}).filter(h => h.mb > 0).sort((a, b) => b.mb - a.mb).slice(0, 25);
console.log(JSON.stringify({ totalMb: Math.round(hot.reduce((s, h) => s + h.mb, 0) * 100) / 100, hot }, null, 1));
