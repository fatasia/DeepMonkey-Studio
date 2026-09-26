// 装配结构树 ↔ 3D 视口联动·视觉闭环探针：上传真实 JT 样本 → 工程资产对话框（含三维预览）→
// 双向联动验证：树点击 → 视口选中提示；视口点选 → 树定位高亮。深浅主题截图。
// 用法:node scripts/model-structure-linkage-probe.mjs <round>
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const round = process.argv[2] ?? "round1";
const output = resolve("test-output/model-structure-linkage", round);
mkdirSync(output, { recursive: true });
const fixture = resolve("../../data/external-assets/format-fixtures/jt/voyager-coffee-maker-jt9.5.jt");
const bytes = readFileSync(fixture).toString("base64");

const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
page.on("console", message => { if (message.type() === "error") errors.push(`console: ${message.text()}`); });

await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(2_500);
if (await page.getByLabel("用户名").count()) {
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill("admin");
  await page.getByRole("button", { name: "登录" }).click();
  await page.waitForTimeout(3_000);
}

async function pageFetch(expression) {
  return page.evaluate(async ({ expression, token }) => {
    const authed = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    return await eval(expression);
  }, { expression, token: await page.evaluate(() => localStorage.getItem("bim-studio-auth-token")) });
}

const uploaded = await pageFetch(`(async () => {
  const projects = await (await authed("/api/projects")).json();
  const projectId = projects[0]?.id;
  if (!projectId) return { error: "no projects" };
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(atob(${JSON.stringify(bytes)}), c => c.charCodeAt(0))]), "probe-linkage-coffee-maker.jt");
  const response = await authed("/api/projects/" + projectId + "/models", { method: "POST", body: form });
  const model = await response.json();
  return { projectId, status: response.status, id: model.id, state: model.status };
})()`).catch(reason => ({ error: String(reason) }));
console.log("upload:", JSON.stringify(uploaded));
if (!uploaded?.id) { console.log(JSON.stringify({ errors: ["upload failed", ...errors].slice(0, 6) }, null, 2)); await browser.close(); process.exit(1); }
const projectId = uploaded.projectId;

let finalState;
for (let tick = 0; tick < 120; tick += 1) {
  await page.waitForTimeout(1_000);
  finalState = await pageFetch(`(async () => {
    const project = await (await authed("/api/projects/${projectId}")).json();
    return project.models.find((item) => item.id === "${uploaded.id}");
  })()`);
  if (["ready", "waiting_converter", "failed"].includes(finalState?.status)) break;
}
console.log("settled:", JSON.stringify({
  status: finalState?.status, message: finalState?.message ?? null,
  geometryUrl: finalState?.manifest?.geometryUrl ?? null, hierarchyUrl: finalState?.manifest?.hierarchyUrl ?? null,
}));
if (finalState?.status === "failed" || !finalState?.manifest?.hierarchyUrl) {
  console.log(JSON.stringify({ errors: ["model unusable for linkage probe", ...errors].slice(0, 6) }, null, 2));
  await browser.close(); process.exit(1);
}

await page.goto(`http://127.0.0.1:5173/manager?project=${projectId}&tab=assets&scope=project&model=${uploaded.id}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4_000);
const card = page.locator(`[data-model-id="${uploaded.id}"]`);
if (!await card.count()) { console.log(JSON.stringify({ errors: ["card not found", ...errors].slice(0, 6) }, null, 2)); await browser.close(); process.exit(1); }
await card.scrollIntoViewIfNeeded().catch(() => {});
await card.locator("button[title*='工程资产']").click();
await page.waitForSelector(".model-structure-panel", { timeout: 10_000 }).catch(() => errors.push("structure panel missing"));
await page.waitForSelector("[role='treeitem']", { timeout: 15_000 }).catch(() => errors.push("tree rows missing"));
const hasViewport = await page.waitForSelector(".model-engineering-viewport canvas", { timeout: 90_000 })
  .then(() => true).catch(() => false);
console.log("viewport:", JSON.stringify({ hasViewport }));
await page.waitForTimeout(2_000);

async function viewportNoteText() {
  return page.evaluate(() => document.querySelector(".model-structure-viewport-note")?.textContent?.trim() ?? "");
}
async function selectedRowName() {
  return page.evaluate(() => document.querySelector("[role='treeitem'][aria-selected='true'] .model-structure-name")?.textContent?.trim() ?? "");
}
async function setTheme(theme) {
  await page.evaluate(t => { if (t === "dark") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", "light"); }, theme);
  await page.waitForTimeout(500);
}

// —— 方向 A：树 → 视口。先点模型根（应选中整模型），再展开装配并点首个子节点。
await page.locator(".model-structure-select").first().click();
await page.waitForTimeout(600);
const rootNote = await viewportNoteText();
console.log("tree-pick-root:", JSON.stringify({ rootNote }));
await setTheme("dark");
await page.screenshot({ path: resolve(output, "dark-dialog-tree-pick-root.png") });
await page.locator(".model-structure-panel").screenshot({ path: resolve(output, "dark-panel-tree-pick-root.png") }).catch(() => {});

await page.getByRole("button", { name: /^展开 / }).first().click().catch(() => errors.push("no expand toggle"));
await page.waitForTimeout(500);
await page.locator(".model-structure-select").nth(1).click();
await page.waitForTimeout(600);
const childNote = await viewportNoteText();
console.log("tree-pick-child:", JSON.stringify({ childNote }));
await page.screenshot({ path: resolve(output, "dark-dialog-tree-pick-child.png") });
await page.locator(".model-structure-panel").screenshot({ path: resolve(output, "dark-panel-tree-pick-child.png") }).catch(() => {});
await setTheme("light");
await page.locator(".model-structure-panel").screenshot({ path: resolve(output, "light-panel-tree-pick-child.png") }).catch(() => {});

// —— 方向 B：视口 → 树。点预览画布若干点位直到树里出现选中行（引擎拾取网格 → 面板定位）。
let pickRow = "";
const canvas = page.locator(".model-engineering-viewport canvas").first();
const box = await canvas.boundingBox();
if (box) {
  const offsets = [[0.5, 0.5], [0.35, 0.45], [0.65, 0.55], [0.5, 0.35], [0.42, 0.6], [0.58, 0.42]];
  for (const [fx, fy] of offsets) {
    await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
    await page.waitForTimeout(700);
    pickRow = await selectedRowName();
    if (pickRow) break;
  }
}
const pickNote = await viewportNoteText();
console.log("viewport-pick:", JSON.stringify({ pickRow, pickNote }));
await setTheme("dark");
await page.screenshot({ path: resolve(output, "dark-dialog-viewport-pick.png") });
await page.locator(".model-structure-panel").screenshot({ path: resolve(output, "dark-panel-viewport-pick.png") }).catch(() => {});
await setTheme("light");
await page.screenshot({ path: resolve(output, "light-dialog-viewport-pick.png") });

console.log(JSON.stringify({ round, hasViewport, rootNote, childNote, pickRow, pickNote, errors: errors.slice(0, 10) }, null, 2));
await browser.close();
