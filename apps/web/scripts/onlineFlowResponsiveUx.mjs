import { resolve } from "node:path";
import {
  assessOnlineFlowVisualEvidence,
  collectOnlineFlowVisualEvidence,
  ONLINE_FLOW_VISUAL_POLICY,
  ONLINE_FLOW_VISUAL_SELECTORS,
} from "./onlineFlowVisualQuality.mjs";

const RESPONSIVE_VIEWPORTS = [
  { width: 1024, height: 768 },
  { width: 1280, height: 800 },
  { width: 1366, height: 768 },
  { width: 1440, height: 900 },
  { width: 1920, height: 1080 },
];

/** 在同一业务状态下切换紧凑视口，避免用独立静态页掩盖连续操作回归。 */
export async function auditResponsiveWorkspace({ page, report, outputRoot, id, scopeSelector }) {
  const original = page.viewportSize() ?? { width: 1440, height: 900 };
  try {
    const audits = [];
    for (const viewport of RESPONSIVE_VIEWPORTS) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(180);
      const audit = await auditViewport({ page, id, scopeSelector, viewport });
      report.responsiveAudits ??= [];
      report.responsiveAudits.push(audit);
      audits.push(audit);
      await page.screenshot({ path: resolve(outputRoot, `${id}-${viewport.width}x${viewport.height}.png`), fullPage: true });
      assertResponsiveAudit(audit);
    }
    return audits;
  } finally {
    await page.setViewportSize(original);
    await page.waitForTimeout(160);
  }
}

async function auditViewport({ page, id, scopeSelector, viewport }) {
  const scope = page.locator(scopeSelector).first();
  await scope.waitFor({ state: "visible" });
  const [layout, visualEvidence] = await Promise.all([scope.evaluate((element) => {
      const visible = (node) => {
        const style = getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return !node.closest('[hidden],[aria-hidden="true"],[inert]')
          && style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
      };
      const rect = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll("button, input, select, textarea, summary, a[href], [role='button'], [role='menuitem'], [role='tab']")].filter(visible);
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
        outsideTargetCount: outsideTargets.length,
        outsideTargetSamples: outsideTargets.slice(0, 8).map((node) => {
          const bounds = node.getBoundingClientRect();
          return {
            label: node.getAttribute("aria-label") || node.getAttribute("title") || node.textContent?.trim().slice(0, 28) || node.tagName,
            element: `${node.tagName.toLowerCase()}.${node.className || ""}`,
            rect: { left: Math.round(bounds.left), top: Math.round(bounds.top), right: Math.round(bounds.right), bottom: Math.round(bounds.bottom) },
          };
        }),
        canvasFocus,
      };
    }), page.evaluate(collectOnlineFlowVisualEvidence, {
      rootSelector: scopeSelector,
      policy: ONLINE_FLOW_VISUAL_POLICY,
      selectors: ONLINE_FLOW_VISUAL_SELECTORS,
    })]);
  const auditId = `${id}-${viewport.width}x${viewport.height}`;
  const quality = assessOnlineFlowVisualEvidence(visualEvidence, auditId);
  return {
    id: auditId,
    ...layout,
    ...visualEvidence,
    smallTargetSamples: visualEvidence.smallTargets.slice(0, 8).map((item) => item.identity),
    smallTextSamples: visualEvidence.smallText.slice(0, 8).map((item) => item.identity),
    qualityFailures: quality.failures,
    qualityAdvisories: quality.advisories,
  };
}

function assertResponsiveAudit(audit) {
  if (audit.documentOverflow || audit.scopeOutsideViewport || audit.outsideTargetCount > 0) {
    throw new Error(`${audit.id} 视口发生越界：${JSON.stringify(audit)}`);
  }
  if (audit.canvasFocus && (audit.canvasFocus.visibleRatio < 0.96 || audit.canvasFocus.widthOccupancy < 0.62)) {
    throw new Error(`${audit.id} 二维画布默认聚焦不足：${JSON.stringify(audit.canvasFocus)}`);
  }
  if (audit.qualityFailures.length > 0) {
    throw new Error(`${audit.id} 视觉质量失败：${audit.qualityFailures.join("；")}`);
  }
}
