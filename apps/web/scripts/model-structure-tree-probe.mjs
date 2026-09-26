// 装配结构树面板·视觉闭环探针:上传真实 JT 样本 → 工程资产对话框驱动结构树 → 深浅主题截图。
// 用法:node scripts/model-structure-tree-probe.mjs <round>
import { mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const round = process.argv[2] ?? "round1";
const output = resolve("test-output/model-structure-tree", round);
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

// 页面会话内的裸 fetch 必须手动带 serverClient 同款 Authorization 头。
async function pageFetch(expression) {
  return page.evaluate(async ({ expression, token }) => {
    const authed = (url, init = {}) => fetch(url, { ...init, headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` } });
    return await eval(expression);
  }, { expression, token: await page.evaluate(() => localStorage.getItem("bim-studio-auth-token")) });
}

// 上传 JT 真实样本,等待转换收敛(waiting_converter 也保留 hierarchy/properties sidecar)
const uploaded = await pageFetch(`(async () => {
  const projects = await (await authed("/api/projects")).json();
  const projectId = projects[0]?.id;
  if (!projectId) return { error: "no projects" };
  const form = new FormData();
  form.append("file", new Blob([Uint8Array.from(atob(${JSON.stringify(bytes)}), c => c.charCodeAt(0))]), "probe-coffee-maker.jt");
  const response = await authed("/api/projects/" + projectId + "/models", { method: "POST", body: form });
  const model = await response.json();
  return { projectId, status: response.status, id: model.id, state: model.status };
})()`).catch(reason => ({ error: String(reason) }));
console.log("upload:", JSON.stringify(uploaded));
if (!uploaded?.id) { console.log(JSON.stringify({ errors: ["upload failed", ...errors].slice(0, 6) }, null, 2)); await browser.close(); process.exit(1); }
const projectId = uploaded.projectId;

// 确定性轮询:等转换收敛(ready / waiting_converter / failed 都会带 sidecar 或明确原因)
let finalState;
for (let tick = 0; tick < 90; tick += 1) {
  await page.waitForTimeout(1_000);
  finalState = await pageFetch(`(async () => {
    const project = await (await authed("/api/projects/${projectId}")).json();
    return project.models.find((item) => item.id === "${uploaded.id}");
  })()`);
  if (["ready", "waiting_converter", "failed"].includes(finalState?.status)) break;
}
console.log("settled:", JSON.stringify({ status: finalState?.status, message: finalState?.message, hierarchyUrl: finalState?.manifest?.hierarchyUrl ?? null }));
if (!finalState?.status) { console.log(JSON.stringify({ errors: ["model never settled", ...errors].slice(0, 6) }, null, 2)); await browser.close(); process.exit(1); }

// 端点烟测(页面会话内)
const endpoints = await pageFetch(`(async () => {
  const structure = await authed("/api/projects/${projectId}/models/${uploaded.id}/structure");
  const tree = await structure.json();
  const firstId = tree?.root?.children?.[0]?.id ?? tree?.root?.id;
  const properties = await authed("/api/projects/${projectId}/models/${uploaded.id}/structure/properties?ids=" + encodeURIComponent(firstId));
  const propertyPayload = await properties.json();
  return { structureStatus: structure.status, nodeCount: tree?.nodeCount ?? null, firstNodeName: tree?.root?.children?.[0]?.name ?? null, propertiesStatus: properties.status, propertyKeys: Object.keys(propertyPayload?.elements ?? {}) };
})()`).catch(reason => ({ error: String(reason) }));
console.log("endpoints:", JSON.stringify(endpoints));

// 深链直达上传项目的资源页,并让清单聚焦该模型(manager 路由:tab=assets&scope=project&model=)
await page.goto(`http://127.0.0.1:5173/manager?project=${projectId}&tab=assets&scope=project&model=${uploaded.id}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
await page.waitForTimeout(4_000);
console.log("nav:", await page.url());
const card = page.locator(`[data-model-id="${uploaded.id}"]`);
if (!await card.count()) {
  const cards = await page.locator("[data-model-id]").count();
  console.log(JSON.stringify({ errors: [`uploaded card not found (visible model cards: ${cards})`, ...errors].slice(0, 6) }, null, 2));
  await browser.close();
  process.exit(1);
}
await card.scrollIntoViewIfNeeded().catch(() => {});
await card.locator("button[title*='工程资产']").click();
await page.waitForSelector(".model-structure-panel", { timeout: 10_000 }).catch(() => errors.push("structure panel missing"));
await page.waitForSelector("[role='treeitem']", { timeout: 15_000 }).catch(() => errors.push("tree rows missing"));
await page.waitForTimeout(1_000);

// 交互:展开子装配 → 选中首个节点出属性表
await page.getByRole("button", { name: /^展开 / }).first().click().catch(() => errors.push("no expand toggle"));
await page.waitForTimeout(400);
await page.locator(".model-structure-select").nth(1).click().catch(() => errors.push("select row failed"));
await page.waitForSelector(".model-structure-property-group table", { timeout: 10_000 }).catch(() => errors.push("property table missing"));
await page.waitForTimeout(600);

for (const theme of ["dark", "light"]) {
  await page.evaluate((t) => { if (t === "dark") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", "light"); }, theme);
  await page.waitForTimeout(600);
  await page.screenshot({ path: resolve(output, `${theme}-dialog-selected.png`) });
  await page.locator(".model-structure-panel").screenshot({ path: resolve(output, `${theme}-panel-selected.png`) }).catch(() => {});
}

// 搜索过滤态截图(此时仍处于循环末尾的浅色主题,命名按实际主题)
await page.locator(".model-structure-search input").fill("asm");
await page.waitForTimeout(600);
await page.locator(".model-structure-panel").screenshot({ path: resolve(output, "light-panel-filtered.png") }).catch(() => {});
await page.locator(".model-structure-search input").fill("绝不存在的节点xyz");
await page.waitForTimeout(600);
await page.locator(".model-structure-panel").screenshot({ path: resolve(output, "light-panel-filter-empty.png") }).catch(() => {});

console.log(JSON.stringify({ round, errors: errors.slice(0, 10) }, null, 2));
await browser.close();
