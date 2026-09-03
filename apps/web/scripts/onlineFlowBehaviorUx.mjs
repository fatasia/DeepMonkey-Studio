/** 验证脚本首屏的可读性、操作面积和默认信息密度。 */
export async function auditBehaviorWorkbench(panel) {
  return panel.evaluate((root) => {
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const textNodes = [...root.querySelectorAll("button,input,select,small,span,strong,em")]
      .filter((element) => visible(element) && element.textContent?.trim());
    const controls = [...root.querySelectorAll("button,input,select")].filter((element) => {
      if (!visible(element)) return false;
      if (element instanceof HTMLInputElement && ["checkbox", "radio"].includes(element.type)) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width < 24 || bounds.height < 24;
    });
    const bounds = root.getBoundingClientRect();
    const heading = root.querySelector(".behavior-panel-heading")?.getBoundingClientRect();
    const actions = root.querySelector(".behavior-panel-actions")?.getBoundingClientRect();
    return {
      inspectorCollapsed: root.classList.contains("inspector-collapsed"),
      logsCollapsed: root.classList.contains("logs-collapsed"),
      horizontalOverflow: root.scrollWidth > root.clientWidth + 1,
      smallText: textNodes
        .filter((element) => {
          const iconOnlyControl = element instanceof HTMLButtonElement && element.querySelector("svg") && (element.title || element.getAttribute("aria-label"));
          return !iconOnlyControl && Number.parseFloat(getComputedStyle(element).fontSize) < 10;
        })
        .slice(0, 12)
        .map((element) => `${element.tagName.toLowerCase()}=${getComputedStyle(element).fontSize}[${element.textContent?.trim().slice(0, 18)}]`),
      smallTargets: controls.slice(0, 12).map((element) => element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 18) ?? element.tagName),
      headerOverlap: Boolean(heading && actions && heading.right > actions.left && Math.min(heading.bottom, actions.bottom) > Math.max(heading.top, actions.top)),
      withinViewport: bounds.left >= 0 && bounds.top >= 0 && bounds.right <= innerWidth + 1 && bounds.bottom <= innerHeight + 1,
      editorHeight: Math.round(root.querySelector(".professional-code-editor")?.getBoundingClientRect().height ?? 0),
    };
  });
}

export function behaviorUxFailures(audit) {
  return [
    ...(!audit.inspectorCollapsed ? ["脚本设置未按需收起，首屏信息密度过高"] : []),
    ...(!audit.logsCollapsed ? ["运行日志未默认收起"] : []),
    ...(audit.horizontalOverflow ? ["脚本工作台产生横向溢出"] : []),
    ...(audit.smallText.length ? [`脚本工作台存在小于 10px 的文字：${audit.smallText.join(", ")}`] : []),
    ...(audit.smallTargets.length ? [`脚本工作台存在小于 24px 的点击目标：${audit.smallTargets.join(", ")}`] : []),
    ...(audit.headerOverlap ? ["脚本标题与操作区发生重叠"] : []),
    ...(!audit.withinViewport ? ["脚本工作台超出浏览器视口"] : []),
    ...(audit.editorHeight < 320 ? [`脚本编辑区域高度不足：${audit.editorHeight}px`] : []),
  ];
}
