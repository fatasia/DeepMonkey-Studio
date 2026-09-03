import { resolve } from "node:path";

export async function auditMaintenanceWideLayout({ page, report, outputRoot, auditPage }) {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.waitForTimeout(160);
  const layout = await page.locator(".operations-grid").evaluate((element) => {
    const content = element.closest(".operations-content")?.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    const panels = [...element.children].filter((child) => {
      const style = getComputedStyle(child);
      const rect = child.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }).map((child) => {
      const rect = child.getBoundingClientRect();
      return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    });
    return {
      visiblePanels: panels.length,
      contentOccupancy: content ? Number((bounds.width / Math.max(1, content.width)).toFixed(2)) : 0,
      panels,
    };
  });
  if (layout.visiblePanels < 2 || layout.contentOccupancy < 0.95) {
    throw new Error(`预测维护宽屏布局存在空栏：${JSON.stringify(layout)}`);
  }
  report.pageAudits.push(await auditPage(page, "maintenance-ai-diagnosis-wide"));
  await page.screenshot({ path: resolve(outputRoot, "04a-maintenance-ai-diagnosis-1920.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(160);
  return layout;
}
