/**
 * 浏览器 UI 可读性门槛。12px / 28px 是阻断线，32px 是建议值；
 * 技术画布中的紧凑标尺、代码和元信息仍不得低于 10px。
 */
export const ONLINE_FLOW_VISUAL_POLICY = Object.freeze({
  businessTextMinimumPx: 12,
  technicalTextMinimumPx: 10,
  targetMinimumPx: 28,
  targetRecommendedPx: 32,
  overlapTolerancePx: 2,
  rowTolerancePx: 10,
});

export const ONLINE_FLOW_VISUAL_SELECTORS = Object.freeze({
  technicalText: [
    '[data-visual-audit~="technical"]',
    '[data-visual-audit~="technical-text"]',
    ".dashboard-ruler",
    ".dashboard-artboard",
    ".monaco-editor",
    ".minimap",
    ".thumbnail",
    '[class$="-thumbnail"]',
    '[class*="__thumbnail"]',
    ".meta",
    '[class$="-meta"]',
    '[class*="__meta"]',
    '[class$="-metadata"]',
    '[class*="__metadata"]',
    "pre",
    "code",
    "kbd",
  ].join(","),
  technicalTarget: [
    '[data-visual-audit~="technical-target"]',
    ".dashboard-ruler",
    ".dashboard-artboard",
    ".monaco-editor",
    ".minimap",
  ].join(","),
  topbar: ".topbar, .manager-header, .dashboard-workspace-topbar, .behavior-panel-actions",
});

/**
 * 此函数直接交给 Playwright page.evaluate，必须保持无模块闭包依赖。
 * 返回证据而不是直接抛错，方便报告同时保留阻断项与 32px 改进建议。
 */
export function collectOnlineFlowVisualEvidence(options) {
  const root = document.querySelector(options.rootSelector) ?? document.body;
  const { policy, selectors } = options;
  const textSelector = "button,input,select,textarea,summary,label,small,span,strong,p,a,li,dt,dd,h1,h2,h3,h4,h5,h6,td,th";
  const controlSelector = "button,input,select,textarea,summary,a[href],[role='button'],[role='menuitem'],[role='tab'],[role='checkbox'],[role='switch'],label";

  const visible = (element) => {
    if (!(element instanceof HTMLElement) || element.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return bounds.width > 0 && bounds.height > 0 && element.getClientRects().length > 0
      && style.display !== "none" && style.visibility !== "hidden" && Number.parseFloat(style.opacity || "1") > 0.01;
  };
  const normalizedText = (element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return (element.value || element.placeholder || "").trim();
    }
    if (element instanceof HTMLSelectElement) return element.selectedOptions[0]?.textContent?.trim() ?? "";
    return element.textContent?.replace(/\s+/g, " ").trim() ?? "";
  };
  const hasEquivalentTextChild = (element, text) => [...element.children].some((child) =>
    child.matches?.(textSelector) && normalizedText(child) === text && visible(child),
  );
  const identity = (element) => {
    const className = typeof element.className === "string" ? element.className.split(/\s+/)[0] : "";
    const formIdentity = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
      ? `${element instanceof HTMLInputElement ? element.type : element.tagName.toLowerCase()}:${element.getAttribute("name") || "unnamed"}`
      : "";
    const label = element.getAttribute("aria-label") || element.getAttribute("title") || normalizedText(element).slice(0, 24) || formIdentity || "图标控件";
    return `${element.tagName.toLowerCase()}${className ? `.${className}` : ""}[${label}]`;
  };
  const evidence = (element, extra = {}) => ({ identity: identity(element), ...extra });

  const textElements = [...root.querySelectorAll(textSelector)].filter((element) => {
    if (!visible(element)) return false;
    const text = normalizedText(element);
    const textBearingControl = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
    return (Boolean(text) || textBearingControl) && !hasEquivalentTextChild(element, text);
  });
  const smallText = [];
  const technicalTextExemptions = [];
  for (const element of textElements) {
    const fontSize = Number.parseFloat(getComputedStyle(element).fontSize);
    if (!Number.isFinite(fontSize) || fontSize <= 0) continue;
    const technical = Boolean(element.closest(selectors.technicalText));
    const minimum = technical ? policy.technicalTextMinimumPx : policy.businessTextMinimumPx;
    const item = evidence(element, { fontSize, minimum, technical });
    if (fontSize < minimum) smallText.push(item);
    else if (technical && fontSize < policy.businessTextMinimumPx) technicalTextExemptions.push(item);
  }

  const controls = [...root.querySelectorAll(controlSelector)].filter((element) => {
    if (!visible(element) || element.closest(selectors.technicalTarget)) return false;
    if (element instanceof HTMLInputElement && ["checkbox", "radio", "color", "range", "hidden"].includes(element.type)) return false;
    // 正文内联链接允许随行高排版；导航、按钮式链接仍执行 28px 目标门槛。
    if (element instanceof HTMLAnchorElement && getComputedStyle(element).display === "inline" && !element.getAttribute("role")) return false;
    if (element instanceof HTMLLabelElement && !element.htmlFor && !element.querySelector("input,select,textarea")) return false;
    return true;
  });
  const smallTargets = [];
  const belowRecommendedTargets = [];
  const inaccessibleIconControls = [];
  const iconControlsWithoutTooltip = [];
  const compressedTextControls = [];
  for (const element of controls) {
    const bounds = element.getBoundingClientRect();
    const item = evidence(element, { width: Math.round(bounds.width * 10) / 10, height: Math.round(bounds.height * 10) / 10 });
    if (bounds.width < policy.targetMinimumPx || bounds.height < policy.targetMinimumPx) smallTargets.push(item);
    else if (bounds.width < policy.targetRecommendedPx || bounds.height < policy.targetRecommendedPx) belowRecommendedTargets.push(item);
    const text = normalizedText(element);
    const accessibleName = element.getAttribute("aria-label") || element.getAttribute("aria-labelledby");
    if (!text && element.querySelector("svg,img")) {
      if (!accessibleName) inaccessibleIconControls.push(item);
      if (!element.getAttribute("title")) iconControlsWithoutTooltip.push(item);
    }
    if (text && !(element instanceof HTMLInputElement) && !(element instanceof HTMLTextAreaElement) && !(element instanceof HTMLSelectElement)) {
      const range = document.createRange();
      range.selectNodeContents(element);
      const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
      const fontSize = Number.parseFloat(getComputedStyle(element).fontSize) || 12;
      if (lines.length >= 3 && bounds.width < Math.max(44, fontSize * 3.5)) {
        compressedTextControls.push(evidence(element, { width: Math.round(bounds.width), lineCount: lines.length }));
      }
    }
  }

  const topbars = [...new Set([
    ...(root.matches?.(selectors.topbar) ? [root] : []),
    ...root.querySelectorAll(selectors.topbar),
  ])].filter(visible);
  const topbarIssues = topbars.flatMap((topbar) => {
    const barBounds = topbar.getBoundingClientRect();
    const children = [...topbar.children].filter((child) => {
      if (!visible(child)) return false;
      const position = getComputedStyle(child).position;
      return position !== "absolute" && position !== "fixed";
    });
    const childBounds = children.map((child) => ({ child, bounds: child.getBoundingClientRect() }));
    const rowCenters = [];
    for (const { bounds } of childBounds) {
      const center = bounds.top + bounds.height / 2;
      if (!rowCenters.some((candidate) => Math.abs(candidate - center) <= policy.rowTolerancePx)) rowCenters.push(center);
    }
    const overlaps = [];
    for (let left = 0; left < childBounds.length; left += 1) {
      for (let right = left + 1; right < childBounds.length; right += 1) {
        const first = childBounds[left];
        const second = childBounds[right];
        const overlapWidth = Math.min(first.bounds.right, second.bounds.right) - Math.max(first.bounds.left, second.bounds.left);
        const overlapHeight = Math.min(first.bounds.bottom, second.bounds.bottom) - Math.max(first.bounds.top, second.bounds.top);
        if (overlapWidth > policy.overlapTolerancePx && overlapHeight > policy.overlapTolerancePx) {
          overlaps.push(`${identity(first.child)} ↔ ${identity(second.child)}`);
        }
      }
    }
    const clipped = childBounds.filter(({ bounds }) =>
      bounds.left < barBounds.left - 1 || bounds.right > barBounds.right + 1
      || bounds.top < barBounds.top - 1 || bounds.bottom > barBounds.bottom + 1,
    ).map(({ child }) => identity(child));
    const wrappedText = [...topbar.querySelectorAll(textSelector)].filter(visible).filter((element) => {
      if (element.closest('[data-visual-audit~="allow-wrap"]')) return false;
      const directTextNodes = [...element.childNodes].filter((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim());
      return directTextNodes.some((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        const lineTops = [...range.getClientRects()].map((rect) => Math.round(rect.top));
        return new Set(lineTops).size > 1;
      });
    }).map(identity);
    if (rowCenters.length <= 1 && overlaps.length === 0 && clipped.length === 0 && wrappedText.length === 0) return [];
    return [evidence(topbar, {
      rowCount: rowCenters.length,
      wrappedText: wrappedText.slice(0, 8),
      overlaps: overlaps.slice(0, 8),
      clipped: clipped.slice(0, 8),
    })];
  });

  return {
    smallTextCount: smallText.length,
    smallText: smallText.slice(0, 160),
    technicalTextExemptionCount: technicalTextExemptions.length,
    technicalTextExemptions: technicalTextExemptions.slice(0, 40),
    smallTargetCount: smallTargets.length,
    smallTargets: smallTargets.slice(0, 80),
    belowRecommendedTargetCount: belowRecommendedTargets.length,
    belowRecommendedTargets: belowRecommendedTargets.slice(0, 40),
    inaccessibleIconControlCount: inaccessibleIconControls.length,
    inaccessibleIconControls: inaccessibleIconControls.slice(0, 40),
    iconControlWithoutTooltipCount: iconControlsWithoutTooltip.length,
    iconControlsWithoutTooltip: iconControlsWithoutTooltip.slice(0, 40),
    compressedTextControlCount: compressedTextControls.length,
    compressedTextControls: compressedTextControls.slice(0, 40),
    topbarIssueCount: topbarIssues.length,
    topbarIssues,
  };
}

export function assessOnlineFlowVisualEvidence(evidence, id = "page") {
  const failures = [];
  const advisories = [];
  if (evidence.smallTextCount > 0) failures.push(`${id} 存在 ${evidence.smallTextCount} 处低于文字基线的可见内容`);
  if (evidence.smallTargetCount > 0) failures.push(`${id} 存在 ${evidence.smallTargetCount} 个小于 28px 的主要点击目标`);
  if ((evidence.inaccessibleIconControlCount ?? 0) > 0) failures.push(`${id} 存在 ${evidence.inaccessibleIconControlCount} 个缺少可访问名称的纯图标控件`);
  if ((evidence.iconControlWithoutTooltipCount ?? 0) > 0) failures.push(`${id} 存在 ${evidence.iconControlWithoutTooltipCount} 个缺少悬停提示的纯图标控件`);
  if ((evidence.compressedTextControlCount ?? 0) > 0) failures.push(`${id} 存在 ${evidence.compressedTextControlCount} 个文字被挤成竖排的控件`);
  if (evidence.topbarIssueCount > 0) failures.push(`${id} 顶栏存在换行、裁切或区域重叠`);
  if (evidence.belowRecommendedTargetCount > 0) advisories.push(`${id} 有 ${evidence.belowRecommendedTargetCount} 个点击目标低于推荐的 32px`);
  return { failures, advisories };
}
