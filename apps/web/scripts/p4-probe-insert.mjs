/** 探针:两次上传同一 glTF,观察行数与弹窗行为。 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { writeMinimalGltf } from "./onlineFlowAuditSupport.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(repositoryRoot, "test-output/p4-browser-20261002/probe");
await mkdir(outputRoot, { recursive: true });
const fixturePath = resolve(outputRoot, "probe.gltf");
writeMinimalGltf(fixturePath);

const gate = await createIsolatedStudioGate("p4-probe");
try {
  const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  page.on("console", (message) => { if (message.type() === "error") console.log("  [console.error]", message.text().slice(0, 200)); });
  const project = await gate.json("POST", "/api/projects", { name: "P4 探针" });
  await gate.loginPage(page);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("探针场景");
  const application = await (async () => {
    const response = page.waitForResponse((candidate) =>
      candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
    await page.getByRole("button", { name: "创建并进入" }).click();
    return response.then((entry) => entry.json());
  })();
  const scene = application.scenes?.[0];
  const url = `${gate.origin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 90_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor();

  for (let index = 0; index < 2; index += 1) {
    console.log(`--- 上传 ${index + 1} ---`);
    const dialogPromise = page.waitForSelector("[role=dialog], dialog[open]", { timeout: 20_000 }).catch(() => null);
    const uploadResponse = page.waitForResponse((candidate) =>
      candidate.url().includes(`/api/projects/${project.id}/models?`) && candidate.request().method() === "POST");
    await page.locator('input[type="file"][accept*=".glb"]').setInputFiles(fixturePath);
    const uploaded = await uploadResponse.then((entry) => entry.json());
    console.log("  uploaded:", uploaded.id, uploaded.status);
    await page.waitForFunction(async ({ projectId, modelId }) => {
      const token = localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token");
      const entry = await fetch(`/api/projects/${encodeURIComponent(projectId)}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (!entry.ok) return false;
      const body = await entry.json();
      return body.models?.some((model) => model.id === modelId && model.status === "ready");
    }, { projectId: project.id, modelId: uploaded.id }, { timeout: 30_000 });
    const dialog = await dialogPromise;
    console.log("  dialog:", dialog ? (await dialog.evaluate((element) => element.getAttribute("aria-label") ?? element.tagName)) : "none");
    if (dialog) {
      const insert = page.getByRole("button", { name: "直接插入" });
      console.log("  直接插入 count:", await insert.count());
      await insert.click();
      await page.getByRole("dialog").waitFor({ state: "hidden" }).catch(() => console.log("  dialog hide timeout"));
    }
    await page.waitForTimeout(1200);
    const rows = await page.locator(".asset-row").count();
    const flatVisible = await page.locator(".asset-list").count();
    console.log("  rows:", rows, "asset-list count:", flatVisible);
    const projectState = await gate.json("GET", `/api/projects/${project.id}`);
    console.log("  project models:", projectState.models?.length);
    const sceneState = await gate.json("GET", `/api/projects/${project.id}/scenes/${scene.id}`);
    console.log("  scene models:", sceneState.models?.length, sceneState.models?.map((model) => model.name));
  }
  // 行文本抽样:平铺列表与 DOM 中所有 .asset-row。
  const orgToggle = page.getByRole("button", { name: "场景图层与编组" });
  if (await orgToggle.count() && (await orgToggle.getAttribute("class"))?.includes("active")) await orgToggle.click();
  await page.locator(".asset-list").waitFor({ state: "visible", timeout: 20_000 }).catch(() => console.log("  asset-list 不可见"));
  console.log("  flat rows:", JSON.stringify(await page.locator(".asset-row").allInnerTexts()));
  console.log("  tree rows:", JSON.stringify(await page.locator(".scene-tree-row").allInnerTexts()));
} finally {
  await gate.close();
}
