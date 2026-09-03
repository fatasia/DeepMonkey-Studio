import { resolve } from "node:path";
import {
  auditKeyboardNavigation,
  auditPage,
  recordStep,
} from "./onlineFlowAuditSupport.mjs";
import { auditResponsiveWorkspace } from "./onlineFlowResponsiveUx.mjs";

/** 创建、编辑、保存、恢复并复用拓扑，同时验证层级投影和可扩展属性面板。 */
export async function verifyTopologyFlow({
  page,
  productOrigin,
  projectId,
  report,
  outputRoot,
}) {
  await page.goto(productOrigin, { waitUntil: "networkidle" });
  await page.locator(".scene-manager-page").waitFor({ state: "visible" });
  await page.getByLabel("当前项目").selectOption(projectId);
  await page.getByRole("button", { name: "拓扑", exact: true }).click();
  await page.getByRole("button", { name: "新建拓扑", exact: true }).click();
  const editor = page.locator(".topology-editor");
  await editor.waitFor({ state: "visible" });
  await editor.getByRole("button", { name: /工业泵/ }).click();
  await editor.getByRole("button", { name: /控制阀/ }).click();
  const nodes = editor.locator(".topology-editor__node");
  if (await nodes.count() !== 2) throw new Error("拓扑节点未按预期创建");
  await editor.getByTitle("创建连线").click();
  await nodes.nth(0).click();
  await nodes.nth(1).click();
  if (await editor.locator(".topology-editor__edge-line").count() !== 1) throw new Error("拓扑连线未按预期创建");

  await editor.getByTitle("选择 (V)").click();
  await nodes.nth(0).click();
  const inspector = editor.locator(".topology-editor__inspector");
  for (const label of ["节点 ID", "资产编码", "描述", "层高", "数据绑定", "扩展属性"]) {
    await inspector.getByText(label, { exact: true }).waitFor();
  }
  await inspector.getByLabel("资产编码").fill("P-101");
  await inspector.getByLabel("资产编码").press("Enter");
  await inspector.getByLabel("描述").fill("循环水主泵");
  await inspector.getByLabel("描述").press("Enter");
  await inspector.getByLabel("层高").fill("48");
  await inspector.getByLabel("层高").press("Enter");
  await inspector.getByLabel("新扩展属性名称").fill("vendor");
  await inspector.getByLabel("新扩展属性值").fill("示例厂商");
  await inspector.getByRole("button", { name: "添加", exact: true }).click();
  await inspector.getByLabel("扩展属性“vendor”的值").waitFor();

  await editor.getByTitle("分层视图（按标高投影）").click();
  await editor.locator(".topology-editor__viewport.is-2-5d").waitFor();
  const layeredProof = await nodes.nth(0).evaluate((node) => ({
    elevation: node.querySelector(".topology-editor__elevation")?.textContent?.trim(),
    hasFakeExtrusion: ["::before", "::after"].some((pseudo) => getComputedStyle(node, pseudo).display !== "none"),
  }));
  if (layeredProof.elevation !== "H 48" || layeredProof.hasFakeExtrusion) {
    throw new Error(`拓扑层级视图未按标高清晰投影：${JSON.stringify(layeredProof)}`);
  }
  report.pageAudits.push(await auditPage(page, "topology-layered-selected"));
  await page.screenshot({ path: resolve(outputRoot, "04b-topology-layered.png"), fullPage: true });

  await editor.getByRole("button", { name: "保存", exact: true }).click();
  await editor.getByText("所有修改已保存", { exact: true }).waitFor({ state: "visible" });
  await page.reload({ waitUntil: "networkidle" });
  await editor.waitFor({ state: "visible" });
  const restored = {
    nodes: await editor.locator(".topology-editor__node").count(),
    edges: await editor.locator(".topology-editor__edge-line").count(),
  };
  if (restored.nodes !== 2 || restored.edges !== 1) throw new Error(`刷新后拓扑未完整恢复：${JSON.stringify(restored)}`);
  await editor.locator(".topology-editor__node").nth(0).click();
  const restoredAssetCode = await inspector.getByLabel("资产编码").inputValue();
  const restoredDescription = await inspector.getByLabel("描述").inputValue();
  const restoredVendor = await inspector.getByLabel("扩展属性“vendor”的值").inputValue();
  if (restoredAssetCode !== "P-101" || restoredDescription !== "循环水主泵" || restoredVendor !== "示例厂商") {
    throw new Error(`拓扑扩展属性未恢复：${JSON.stringify({ restoredAssetCode, restoredDescription, restoredVendor })}`);
  }
  report.pageAudits.push(await auditPage(page, "topology-editor-restored"));
  await page.screenshot({ path: resolve(outputRoot, "04b-topology-editor.png"), fullPage: true });
  report.keyboardAudits.push(await auditKeyboardNavigation(page, "topology-editor-restored"));
  await auditResponsiveWorkspace({ page, report, outputRoot, id: "04b-topology-editor", scopeSelector: ".topology-editor" });

  const canvasBeforeCollapse = await editor.locator(".topology-editor__viewport").boundingBox();
  await editor.getByRole("button", { name: "收起设备库", exact: true }).click();
  await editor.getByRole("button", { name: "收起属性面板", exact: true }).click();
  const canvasAfterCollapse = await editor.locator(".topology-editor__viewport").boundingBox();
  if (!canvasBeforeCollapse || !canvasAfterCollapse || canvasAfterCollapse.width < canvasBeforeCollapse.width + 400) {
    throw new Error(`拓扑面板收起后画布没有释放有效空间：${JSON.stringify({ canvasBeforeCollapse, canvasAfterCollapse })}`);
  }
  await page.reload({ waitUntil: "networkidle" });
  await editor.getByRole("button", { name: "展开设备库", exact: true }).waitFor({ state: "visible" });
  await editor.getByRole("button", { name: "展开属性面板", exact: true }).waitFor({ state: "visible" });
  report.pageAudits.push(await auditPage(page, "topology-canvas-maximized"));
  await page.screenshot({ path: resolve(outputRoot, "04b-topology-canvas-maximized.png"), fullPage: true });
  recordStep(report, "collapse-persist-and-restore-topology-panels", { canvasBeforeCollapse, canvasAfterCollapse });
  await editor.getByRole("button", { name: "展开设备库", exact: true }).click();
  await editor.getByRole("button", { name: "展开属性面板", exact: true }).click();

  await editor.getByRole("button", { name: "插入看板", exact: true }).click();
  const dashboardTopology = page.locator(".dashboard-topology-widget");
  await dashboardTopology.waitFor({ state: "visible" });
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("所有修改已保存", { exact: true }).waitFor({ state: "visible" });
  await page.reload({ waitUntil: "networkidle" });
  await dashboardTopology.waitFor({ state: "visible" });
  recordStep(report, "topology-create-configure-layer-save-reload-and-insert", { ...restored, layeredProof });
  report.pageAudits.push(await auditPage(page, "dashboard-topology-restored"));
  await page.screenshot({ path: resolve(outputRoot, "04c-dashboard-topology.png"), fullPage: true });
}
