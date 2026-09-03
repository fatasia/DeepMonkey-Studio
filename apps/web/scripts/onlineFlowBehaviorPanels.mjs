import { resolve } from "node:path";
import { auditPage, recordStep } from "./onlineFlowAuditSupport.mjs";

/** 脚本列表按需收起，保证代码区扩展后仍能无损返回当前编辑状态。 */
export async function verifyBehaviorPanelCollapse({ page, behaviorPanel, report, outputRoot }) {
  const editor = behaviorPanel.locator(".behavior-editor");
  const editorBeforeCollapse = await editor.boundingBox();
  await behaviorPanel.getByRole("button", { name: "收起脚本列表", exact: true }).click();
  await behaviorPanel.getByRole("button", { name: "展开脚本列表", exact: true }).waitFor({ state: "visible" });
  if (await behaviorPanel.locator(".behavior-script-list").count()) throw new Error("脚本列表收起后仍占用编辑区宽度");

  const editorAfterCollapse = await editor.boundingBox();
  if (!editorBeforeCollapse || !editorAfterCollapse || editorAfterCollapse.width < editorBeforeCollapse.width + 120) {
    throw new Error(`脚本列表收起后代码区没有释放有效空间：${JSON.stringify({ editorBeforeCollapse, editorAfterCollapse })}`);
  }
  report.pageAudits.push(await auditPage(page, "behavior-code-maximized"));
  await page.screenshot({ path: resolve(outputRoot, "02bc-behavior-code-maximized.png"), fullPage: true });

  await behaviorPanel.getByRole("button", { name: "展开脚本列表", exact: true }).click();
  await behaviorPanel.locator(".behavior-script-list").waitFor({ state: "visible" });
  recordStep(report, "collapse-and-restore-script-list", { editorBeforeCollapse, editorAfterCollapse });
}

/** 验证依赖入口在窄分屏首屏可达，并校验抽屉的焦点圈定、可读性与恢复。 */
export async function verifyDependencyManagerResponsive({ page, behaviorPanel, report, outputRoot }) {
  const originalViewport = page.viewportSize();
  const viewports = [
    { width: 1024, height: 768 },
    { width: 1280, height: 800 },
    { width: 1366, height: 768 },
    { width: 1440, height: 900 },
    { width: 1920, height: 1080 },
  ];
  const results = [];

  try {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      const actions = behaviorPanel.locator(".behavior-panel-actions");
      await actions.evaluate((element) => { element.scrollLeft = 0; });
      const entry = behaviorPanel.getByRole("button", { name: "项目依赖", exact: true });
      const reachability = await entry.evaluate((button) => {
        const buttonBounds = button.getBoundingClientRect();
        const navigationBounds = button.closest("nav")?.getBoundingClientRect();
        return {
          width: Math.round(buttonBounds.width),
          height: Math.round(buttonBounds.height),
          fullyVisible: Boolean(navigationBounds)
            && buttonBounds.left >= navigationBounds.left - 1
            && buttonBounds.right <= navigationBounds.right + 1,
        };
      });
      if (!reachability.fullyVisible || reachability.width < 28 || reachability.height < 28) {
        throw new Error(`项目依赖入口在 ${viewport.width}px 分屏不可达：${JSON.stringify(reachability)}`);
      }

      await entry.click();
      const dialog = behaviorPanel.getByRole("dialog", { name: "项目依赖", exact: true });
      await dialog.waitFor({ state: "visible" });
      const close = dialog.getByRole("button", { name: "关闭项目依赖", exact: true });
      if (!(await close.evaluate((button) => button === document.activeElement))) throw new Error("依赖抽屉打开后没有接管键盘焦点");

      const add = dialog.getByRole("button", { name: "添加依赖", exact: true });
      await add.focus();
      await page.keyboard.press("Shift+Tab");
      if (!(await dialog.getByRole("textbox", { name: "搜索项目依赖", exact: true }).evaluate((input) => input === document.activeElement))) {
        throw new Error("依赖抽屉的 Shift+Tab 没有在末尾闭环");
      }
      await page.keyboard.press("Tab");
      if (!(await add.evaluate((button) => button === document.activeElement))) throw new Error("依赖抽屉的 Tab 没有回到首个操作");

      const quality = await dialog.evaluate((element) => {
        const undersizedText = Array.from(element.querySelectorAll("button,input,label,small,span,strong,p,dt,dd"))
          .filter((node) => node.getClientRects().length > 0 && Number.parseFloat(getComputedStyle(node).fontSize) < 12)
          .map((node) => ({ text: node.textContent?.trim().slice(0, 24), fontSize: getComputedStyle(node).fontSize }));
        return {
          horizontalOverflow: element.scrollWidth > element.clientWidth + 1,
          undersizedText,
        };
      });
      if (quality.horizontalOverflow || quality.undersizedText.length) {
        throw new Error(`依赖抽屉在 ${viewport.width}px 存在布局或字号问题：${JSON.stringify(quality)}`);
      }
      report.pageAudits.push(await auditPage(page, `behavior-dependencies-${viewport.width}x${viewport.height}`));
      await page.screenshot({ path: resolve(outputRoot, `02be-behavior-dependencies-${viewport.width}x${viewport.height}.png`), fullPage: true });
      await page.keyboard.press("Escape");
      await dialog.waitFor({ state: "hidden" });
      if (!(await entry.evaluate((button) => button === document.activeElement))) throw new Error("关闭依赖抽屉后没有恢复入口焦点");
      results.push({ viewport, reachability, quality });
    }
  } finally {
    if (originalViewport) await page.setViewportSize(originalViewport);
  }
  recordStep(report, "verify-script-dependency-drawer-responsive-focus", results);
}
