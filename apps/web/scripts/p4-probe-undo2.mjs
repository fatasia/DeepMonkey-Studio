/** 探针:深度 2 撤销阻塞边界(重做后再撤/延时再撤)。 */
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";

const repositoryRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const outputRoot = resolve(repositoryRoot, "test-output/p4-browser-20261002/probe");
await mkdir(outputRoot, { recursive: true });
const gate = await createIsolatedStudioGate("p4-probe-undo2");
try {
  const context = await gate.browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();
  page.setDefaultTimeout(20_000);
  const project = await gate.json("POST", "/api/projects", { name: "P4 undo2 探针" });
  await gate.loginPage(page);
  await page.getByLabel("当前项目").selectOption(project.id);
  await page.getByRole("button", { name: "项目场景", exact: true }).click();
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill("undo2 探针");
  const application = await (async () => {
    const response = page.waitForResponse((candidate) =>
      candidate.url().includes(`/api/projects/${project.id}/applications`) && candidate.request().method() === "POST");
    await page.getByRole("button", { name: "创建并进入" }).click();
    return response.then((entry) => entry.json());
  })();
  const scene = application.scenes?.[0];
  await page.goto(`${gate.origin}/studio/${encodeURIComponent(project.id)}/applications/${encodeURIComponent(application.metadata.id)}/scenes/${encodeURIComponent(scene.id)}`, { waitUntil: "networkidle", timeout: 90_000 });
  await page.locator('.viewport canvas:not([aria-hidden="true"])').waitFor();

  const undoButton = page.locator(".scene-history-controls button").nth(0);
  const redoButton = page.locator(".scene-history-controls button").nth(1);
  const state = async () => ({
    undoDisabled: await undoButton.isDisabled(),
    undoTitle: (await undoButton.getAttribute("title").catch(() => "?"))?.slice(0, 30),
    redoDisabled: await redoButton.isDisabled(),
    rows: await page.evaluate(() => document.querySelectorAll(".asset-row").length),
  });
  const placeCube = async () => {
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("menuitem", { name: "立方体", exact: true }).click();
    await page.waitForTimeout(400);
    await page.locator('.viewport canvas:not([aria-hidden="true"])').click({ position: { x: 800, y: 420 } });
    await page.waitForTimeout(900);
  };
  const showRows = async () => {
    const list = page.locator(".asset-list");
    if (!(await list.isVisible().catch(() => false))) {
      const toggle = page.getByRole("button", { name: "项目资源" });
      if (await toggle.count()) await toggle.click().catch(() => undefined);
    }
  };
  const placeTwo = async () => {
    await placeCube();
    await page.getByRole("button", { name: "创建", exact: true }).click();
    await page.getByRole("menuitem", { name: "立方体", exact: true }).click();
    await page.waitForTimeout(400);
    await page.locator('.viewport canvas:not([aria-hidden="true"])').click({ position: { x: 560, y: 620 } });
    await page.waitForTimeout(900);
  };

  await showRows();
  console.log("A) 两次创建,一次撤销:", JSON.stringify({ before: await state() }));
  await placeTwo();
  console.log("  after 2 creates:", JSON.stringify(await state()));
  await undoButton.click();
  await page.waitForTimeout(2000);
  console.log("  after undo#1:", JSON.stringify(await state()));
  await undoButton.click();
  await page.waitForTimeout(2000);
  console.log("  after undo#2 (immediate):", JSON.stringify(await state()));
  await page.waitForTimeout(8000);
  await undoButton.click();
  await page.waitForTimeout(2000);
  console.log("  after undo#3 (+8s):", JSON.stringify(await state()));
  await redoButton.click();
  await page.waitForTimeout(2000);
  console.log("  after redo#1:", JSON.stringify(await state()));
  await undoButton.click();
  await page.waitForTimeout(2000);
  console.log("  after undo after redo:", JSON.stringify(await state()));
} finally {
  await gate.close();
}
