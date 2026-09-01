import { resolve } from "node:path";

/** 在同一业务状态下切换紧凑视口，避免用独立静态页掩盖连续操作回归。 */
export async function auditResponsiveWorkspace({ page, report, outputRoot, id, scopeSelector }) {
  const original = page.viewportSize() ?? { width: 1440, height: 900 };
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.waitForTimeout(180);
  try {
    const scope = page.locator(scopeSelector).first();
    await scope.waitFor({ state: "visible" });
    const audit = await scope.evaluate((element) => {
      const visible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const rect = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll("button, input, select, textarea, [role='button']")].filter(visible);
      const smallTargets = controls.filter((node) => {
        const bounds = node.getBoundingClientRect();
        return bounds.width < 24 || bounds.height < 24;
      });
      const hasScrollableAncestor = (node, axis) => {
        let current = node.parentElement;
        while (current && current !== element) {
          const style = getComputedStyle(current);
          const overflow = axis === "x" ? style.overflowX : style.overflowY;
          if (overflow === "auto" || overflow === "scroll") return true;
          current = current.parentElement;
        }
        return false;
      };
      const outsideTargets = controls.filter((node) => {
        const bounds = node.getBoundingClientRect();
        const outsideX = (bounds.right < 0 || bounds.left > innerWidth) && !hasScrollableAncestor(node, "x");
        const outsideY = (bounds.bottom < 0 || bounds.top > innerHeight) && !hasScrollableAncestor(node, "y");
        return outsideX || outsideY;
      });
      const smallText = [...element.querySelectorAll("small, span, label, button, p")].filter((node) =>
        visible(node) && Number.parseFloat(getComputedStyle(node).fontSize) < 10 && (node.textContent?.trim().length ?? 0) > 0,
      );
      const scroll = element.querySelector(".dashboard-canvas-scroll");
      const artboard = element.querySelector(".dashboard-artboard");
      const canvasFocus = scroll && artboard ? (() => {
        const viewport = scroll.getBoundingClientRect();
        const content = artboard.getBoundingClientRect();
        const visibleWidth = Math.max(0, Math.min(viewport.right, content.right) - Math.max(viewport.left, content.left));
        const visibleHeight = Math.max(0, Math.min(viewport.bottom, content.bottom) - Math.max(viewport.top, content.top));
        return {
          widthOccupancy: Number((content.width / Math.max(1, viewport.width)).toFixed(2)),
          heightOccupancy: Number((content.height / Math.max(1, viewport.height)).toFixed(2)),
          visibleRatio: Number(((visibleWidth * visibleHeight) / Math.max(1, content.width * content.height)).toFixed(2)),
          centerOffsetX: Math.round((content.left + content.width / 2) - (viewport.left + viewport.width / 2)),
          centerOffsetY: Math.round((content.top + content.height / 2) - (viewport.top + viewport.height / 2)),
        };
      })() : undefined;
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1,
        scopeOutsideViewport: rect.left < -1 || rect.top < -1 || rect.right > innerWidth + 1 || rect.bottom > innerHeight + 1,
        smallTargetCount: smallTargets.length,
        smallTargetSamples: smallTargets.slice(0, 8).map((node) => node.getAttribute("aria-label") || node.textContent?.trim().slice(0, 28) || node.tagName),
        outsideTargetCount: outsideTargets.length,
        outsideTargetSamples: outsideTargets.slice(0, 8).map((node) => {
          const bounds = node.getBoundingClientRect();
          return {
            label: node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent?.trim().slice(0, 28) || node.tagName,
            element: `${node.tagName.toLowerCase()}.${node.className || ""}`,
            rect: { left: Math.round(bounds.left), top: Math.round(bounds.top), right: Math.round(bounds.right), bottom: Math.round(bounds.bottom) },
          };
        }),
        smallTextCount: smallText.length,
        smallTextSamples: smallText.slice(0, 8).map((node) => node.textContent?.trim().slice(0, 28)),
        canvasFocus,
      };
    });
    report.responsiveAudits ??= [];
    report.responsiveAudits.push({ id, ...audit });
    await page.screenshot({ path: resolve(outputRoot, `${id}-1024x768.png`), fullPage: true });
    if (audit.documentOverflow || audit.scopeOutsideViewport || audit.outsideTargetCount > 0) {
      throw new Error(`${id} 紧凑视口发生越界：${JSON.stringify(audit)}`);
    }
    if (audit.canvasFocus && (audit.canvasFocus.visibleRatio < 0.96 || audit.canvasFocus.widthOccupancy < 0.62)) {
      throw new Error(`${id} 二维画布默认聚焦不足：${JSON.stringify(audit.canvasFocus)}`);
    }
    return audit;
  } finally {
    await page.setViewportSize(original);
    await page.waitForTimeout(160);
  }
}
