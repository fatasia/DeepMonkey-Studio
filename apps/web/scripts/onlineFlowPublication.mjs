import { resolve } from "node:path";

/** 验证发布者能明确控制浏览工具栏，并确认选择进入公开快照。 */
export async function publishWithViewerToolbar({ page, sceneCard, apiOrigin, outputRoot, readJsonResponse }) {
  await sceneCard.getByTitle("发布").click();
  const dialog = page.locator(".publication-dialog");
  await dialog.waitFor({ state: "visible" });
  const showTools = dialog.getByRole("button", { name: /显示查看工具/ });
  const hideTools = dialog.getByRole("button", { name: /隐藏工具栏/ });
  await showTools.waitFor({ state: "visible" });
  await hideTools.click();
  if (await hideTools.getAttribute("aria-pressed") !== "true") throw new Error("发布工具栏隐藏选项没有可读的选中状态");
  await showTools.click();
  if (await showTools.getAttribute("aria-pressed") !== "true") throw new Error("发布工具栏显示选项没有可读的选中状态");

  const originalViewport = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(120);
  const compactLayout = await dialog.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      insideViewport: bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight,
      scrollable: element.scrollHeight <= element.clientHeight + 1 || ["auto", "scroll"].includes(getComputedStyle(element).overflowY),
    };
  });
  await page.screenshot({ path: resolve(outputRoot, "05-publication-dialog-1024x768.png"), fullPage: true });
  await page.setViewportSize(originalViewport);
  if (!compactLayout.insideViewport || !compactLayout.scrollable) throw new Error(`发布弹窗紧凑布局不可用：${JSON.stringify(compactLayout)}`);

  const publicationResponse = page.waitForResponse((response) => response.url().endsWith("/publish") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "发布", exact: true }).click();
  const publication = await readJsonResponse(publicationResponse, 201);
  await sceneCard.getByText("已发布").waitFor({ state: "visible" });
  const publicResponse = await fetch(`${apiOrigin}/api/public/scenes/${encodeURIComponent(publication.sceneId)}`);
  if (!publicResponse.ok) throw new Error(`公开场景读取失败：HTTP ${publicResponse.status}`);
  const publicScene = await publicResponse.json();
  if (publicScene.snapshot?.publicationToolbarVisible !== true) throw new Error("公开快照没有保留浏览工具栏选择");
  return { sceneId: publication.sceneId, toolbarVisible: true, compactLayout };
}
