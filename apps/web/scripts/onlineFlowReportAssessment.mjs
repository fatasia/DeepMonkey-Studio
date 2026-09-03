export function finalizeOnlineFlowReport(report) {
  report.warnings = report.pageAudits.flatMap((audit) => [
    ...(audit.smallText.length ? [`${audit.id} 存在 ${audit.smallTextCount} 处低于业务 12px / 技术区 10px 基线的可见文字：${audit.smallText.join(", ")}`] : []),
    ...(audit.smallTargets.length ? [`${audit.id} 存在 ${audit.smallTargetCount} 个小于 28px 的主要点击目标：${audit.smallTargets.join(", ")}`] : []),
    ...(audit.inaccessibleIconControlCount ? [`${audit.id} 存在 ${audit.inaccessibleIconControlCount} 个缺少可访问名称的纯图标控件：${audit.inaccessibleIconControls.map((item) => item.identity).join(", ")}`] : []),
    ...(audit.iconControlWithoutTooltipCount ? [`${audit.id} 存在 ${audit.iconControlWithoutTooltipCount} 个缺少悬停提示的纯图标控件：${audit.iconControlsWithoutTooltip.map((item) => item.identity).join(", ")}`] : []),
    ...(audit.compressedTextControlCount ? [`${audit.id} 存在 ${audit.compressedTextControlCount} 个文字被挤成竖排的控件：${audit.compressedTextControls.map((item) => item.identity).join(", ")}`] : []),
    ...(audit.topbarIssues.length ? [`${audit.id} 顶栏发生换行、裁切或关键区域重叠：${JSON.stringify(audit.topbarIssues)}`] : []),
  ]);
  report.visualAdvisories = report.pageAudits.flatMap((audit) => audit.qualityAdvisories ?? []);
  report.visualQualityFailures = report.pageAudits.flatMap((audit) => audit.qualityFailures ?? []);
  const failures = [
    ...report.consoleErrors.map((value) => `console error: ${value}`),
    ...report.pageErrors.map((value) => `page error: ${value}`),
    ...report.requestFailures.map((value) => `request failed: ${value}`),
    ...report.pageAudits.filter((audit) => audit.documentOverflow).map((audit) => `${audit.id} 产生页面级横向或纵向溢出`),
    ...report.pageAudits.filter((audit) => Math.abs(audit.documentScrollLeft) > 1 || Math.abs(audit.appShellLeft) > 1).map((audit) => `${audit.id} 工作区发生横向位移：document=${audit.documentScrollLeft}px，shell=${audit.appShellLeft}px`),
    ...report.keyboardAudits.filter((audit) => audit.uniqueTargets < 5).map((audit) => `${audit.id} 键盘导航仅触达 ${audit.uniqueTargets} 个控件`),
    ...report.keyboardAudits.filter((audit) => audit.visibleFocusTargets === 0).map((audit) => `${audit.id} 键盘焦点没有可见指示`),
    ...report.faultChecks.filter((check) => check.actualStatus !== check.expectedStatus).map((check) => `${check.id} 期望 HTTP ${check.expectedStatus}，实际 ${check.actualStatus}`),
    ...report.warnings,
  ];
  report.failures = failures;
  return failures;
}
