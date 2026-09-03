import { resolve } from "node:path";
import { auditPage, recordStep } from "./onlineFlowAuditSupport.mjs";

/** 验证二维编辑器可临时让出完整画布，且恢复面板不会破坏当前草稿。 */
export async function verifyDashboardPanelCollapse({ page, report, outputRoot }) {
  const workspace = page.locator(".dashboard-workspace");
  const canvas = workspace.locator(".dashboard-canvas-scroll");
  const canvasBeforeCollapse = await canvas.boundingBox();

  await workspace.getByRole("button", { name: "收起资源面板", exact: true }).click();
  await workspace.getByRole("button", { name: "收起属性面板", exact: true }).click();
  await Promise.all([
    workspace.locator(".dashboard-pages-panel").waitFor({ state: "hidden" }),
    workspace.locator(".dashboard-inspector-panel").waitFor({ state: "hidden" }),
  ]);
  const canvasAfterCollapse = await canvas.boundingBox();
  if (!canvasBeforeCollapse || !canvasAfterCollapse || canvasAfterCollapse.width < canvasBeforeCollapse.width + 350) {
    throw new Error(`二维面板收起后画布没有释放有效空间：${JSON.stringify({ canvasBeforeCollapse, canvasAfterCollapse })}`);
  }

  report.pageAudits.push(await auditPage(page, "dashboard-canvas-maximized"));
  await page.screenshot({ path: resolve(outputRoot, "02ab-dashboard-canvas-maximized.png"), fullPage: true });

  await workspace.getByRole("button", { name: "展开资源面板", exact: true }).click();
  await workspace.getByRole("button", { name: "展开属性面板", exact: true }).click();
  await workspace.locator(".dashboard-pages-panel").waitFor({ state: "visible" });
  await workspace.locator(".dashboard-inspector-panel").waitFor({ state: "visible" });
  recordStep(report, "collapse-and-restore-2d-side-panels", { canvasBeforeCollapse, canvasAfterCollapse });
}
