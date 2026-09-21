import { resolve } from "node:path";

const advancedDisclosureSelector = [
  "details.plant-flow-advanced",
  "details.plant-run-advanced",
  "details.ppr-context-references",
  "details.ppr-advanced-meta",
  "details.commissioning-custom-case",
  "details.commissioning-test-design",
].join(",");

export async function inspectOperationsPlanning(browser, origin, viewport, outputRoot) {
  const page = await workflowPage(browser, viewport);
  const diagnostics = observeDiagnostics(page);
  await page.route("**/api/projects/visual-qa/ppr/bop-versions", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
      return;
    }
    await route.fulfill({ status: 405, contentType: "application/json", body: '{"message":"视觉验收禁止写入"}' });
  });

  try {
    await page.goto(`${origin}/?__visualQa=operations-planning`, { waitUntil: "networkidle" });
    await page.locator(".operations-planning-visual-qa").waitFor({ state: "visible" });
    const overview = await collectSurfaceMetrics(page, {
      rootSelector: ".operations-planning-visual-qa",
      primaryRegions: [".plant-authoring-meta", ".plant-flow-builder", ".plant-energy-evidence", ".plant-equipment-evidence", ".plant-scenario-decision", ".plant-playback", ".plant-material-flow"],
      primaryActions: [".operations-grid > .operations-panel:first-child > header .button.primary", ".ppr-plan-panel > header button"],
    });
    const plantFirstUse = await collectFirstUse(page, {
      scopeSelector: ".operations-content",
      actionScopeSelector: ".operations-grid > .operations-panel:first-child",
      primaryActionSelector: ":scope > header .button.primary:not(:disabled)",
      expectedAction: "运行仿真",
    });
    const plantConclusionBeforeEvidence = await page.evaluate(() => {
      const conclusion = document.querySelector(".plant-bottleneck-advice");
      const evidence = document.querySelector(".logistics-study-panel .logistics-evidence");
      return Boolean(conclusion && evidence && conclusion.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    const plantPlaybackBeforeEvidence = await page.evaluate(() => {
      const playback = document.querySelector(".plant-playback");
      const evidence = document.querySelector(".logistics-study-panel .logistics-evidence");
      return Boolean(playback && evidence && playback.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    const playbackTimeline = page.locator(".plant-playback-timeline");
    const playbackDuration = Number(await playbackTimeline.getAttribute("max"));
    await setRangeValue(playbackTimeline, 5);
    const failedPlaybackNodes = await page.locator(".plant-playback-node.failed, .plant-playback-node.degraded").count();
    await setRangeValue(playbackTimeline, 8);
    const equipmentFailedPlaybackNodes = await page.locator(".plant-playback-node.failed").count();
    const decisionRows = await page.locator(".plant-scenario-table > div[role='row']:not(.plant-scenario-table-head)").count();
    const bestScenarioLabels = await page.locator(".plant-scenario-table > .is-best span:first-child").allTextContents();
    const selectedComparisonBaseline = await page.locator(".logistics-comparison select").inputValue();
    const materialTransferSummary = await page.locator(".plant-material-flow-heading em").innerText();
    const materialRouteRows = await page.locator(".plant-flow-routes > div[role='row']:not(.plant-flow-table-head)").count();
    const materialTimingRows = await page.locator(".plant-flow-timings > div[role='row']:not(.plant-flow-table-head)").count();
    const equipmentEvidenceRows = await page.locator(".plant-equipment-evidence > div").count();
    const equipmentEvidenceText = (await page.locator(".plant-equipment-evidence").innerText()).replace(/\s+/g, " ");
    const energyEvidenceText = (await page.locator(".plant-energy-evidence").innerText()).replace(/\s+/g, " ");
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-planning-overview.png`), fullPage: true });

    const nodeCountBefore = await page.locator(".plant-flow-entry").count();
    await page.getByRole("button", { name: "缓冲区", exact: true }).click();
    const nodeCountAfter = await page.locator(".plant-flow-entry").count();
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-planning-flow-edited.png`), fullPage: true });

    await page.getByRole("button", { name: "工艺规划", exact: true }).click();
    await page.locator(".ppr-plan-panel").waitFor({ state: "visible" });
    const pprEntryFirstUse = await collectFirstUse(page, {
      scopeSelector: ".ppr-plan-panel",
      primaryActionSelector: ":scope > header button:not(:disabled)",
      expectedAction: "打开工作台",
    });
    await page.getByRole("button", { name: "打开工作台", exact: true }).click();
    await page.locator(".ppr-workbench").waitFor({ state: "visible" });
    await page.waitForFunction(() => !document.querySelector(".ppr-workbench-feedback"));
    const pprApplicability = page.locator("details.ppr-context-references");
    await pprApplicability.locator("summary").click();
    const pprConditionInput = pprApplicability.locator("label").filter({ hasText: "适用条件表达式" }).locator("input");
    await pprConditionInput.fill("market == 'EU'");
    const pprConditionValue = await pprConditionInput.inputValue();
    await pprApplicability.locator("summary").click();
    const pprSteps = await page.locator(".ppr-step-list > button strong").allTextContents();
    const activePprStep = await page.locator(".ppr-step-list > button").evaluateAll((items) => items.findIndex((item) => item.classList.contains("active")));
    const pprFirstUse = await collectFirstUse(page, {
      scopeSelector: ".ppr-workbench",
      actionScopeSelector: ".ppr-workbench",
      primaryActionSelector: ".ppr-section-actions button:not(:disabled), .ppr-step-footer button.primary:not(:disabled), .ppr-workbench-actions button.primary:not(:disabled)",
      expectedAction: "添加产品",
    });
    const pprProduct = await collectSurfaceMetrics(page, {
      rootSelector: ".ppr-workbench",
      primaryRegions: [".ppr-workbench-header", ".ppr-workbench-nav", ".ppr-workbench-editor", ".ppr-insights"],
      primaryActions: [".ppr-section-actions button", ".ppr-step-footer button", ".ppr-workbench-actions button.primary"],
    });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-ppr-product.png`), fullPage: true });

    await page.getByRole("button", { name: "添加产品", exact: true }).click();
    const productCount = await page.locator(".ppr-entity-card").count();
    await page.getByRole("button", { name: "继续：工序安排", exact: true }).click();
    await page.getByRole("heading", { name: "工序安排", exact: true }).waitFor({ state: "visible" });
    const pprOperations = await collectSurfaceMetrics(page, {
      rootSelector: ".ppr-workbench",
      primaryRegions: [".ppr-workbench-header", ".ppr-workbench-nav", ".ppr-workbench-editor", ".ppr-insights"],
      primaryActions: [".ppr-section-actions button", ".ppr-step-footer button", ".ppr-workbench-actions button.primary"],
    });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-ppr-operations.png`), fullPage: true });

    await page.getByRole("button", { name: "添加工序", exact: true }).click();
    const ewiEnable = page.locator(".ppr-ewi-enable").first();
    await ewiEnable.getByRole("button", { name: "开始编制", exact: true }).click();
    const ewiEditor = page.locator(".ppr-ewi-editor").first();
    await ewiEditor.locator(".ppr-ewi-group").nth(0).locator("textarea").fill("将模组沿定位销装入夹具并确认到位");
    await ewiEditor.locator(".ppr-ewi-group").nth(1).getByRole("button", { name: "添加", exact: true }).click();
    await ewiEditor.locator(".ppr-ewi-group").nth(1).locator("textarea").fill("夹紧前确认双手离开夹具");
    await ewiEditor.locator(".ppr-ewi-group").nth(2).getByRole("button", { name: "添加", exact: true }).click();
    await ewiEditor.getByLabel("质量控制点 1 特性名称", { exact: true }).fill("装配间隙");
    await ewiEditor.getByLabel("质量控制点 1 快捷规格", { exact: true }).fill("0.5–0.8 mm");
    const ewiPreview = page.locator(".ppr-ewi-preview");
    const ewiPreviewText = (await ewiPreview.innerText()).replace(/\s+/g, " ");
    const ewiDeliveryEnabled = await ewiPreview.getByRole("button", { name: "打印", exact: true }).isEnabled()
      && await ewiPreview.getByRole("button", { name: "离线 HTML", exact: true }).isEnabled();
    const [ewiDownload] = await Promise.all([
      page.waitForEvent("download"),
      ewiPreview.getByRole("button", { name: "离线 HTML", exact: true }).click(),
    ]);
    const ewiDownloadText = await readDownloadText(ewiDownload);
    const ewiDownloadValid = ewiDownload.suggestedFilename().endsWith(".html")
      && /<!doctype html>/i.test(ewiDownloadText)
      && ewiDownloadText.includes("将模组沿定位销装入夹具并确认到位")
      && ewiDownloadText.includes("夹紧前确认双手离开夹具")
      && ewiDownloadText.includes("0.5–0.8 mm");
    const pprEwi = await collectSurfaceMetrics(page, {
      rootSelector: ".ppr-workbench",
      primaryRegions: [".ppr-workbench-header", ".ppr-ewi-editor", ".ppr-ewi-preview"],
      primaryActions: [".ppr-ewi-group > header button", ".ppr-ewi-preview > header button"],
    });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-ppr-ewi.png`), fullPage: true });

    const failures = [
      ...diagnosticFailures(diagnostics),
      ...metricFailures("工厂规划首屏", overview),
      ...metricFailures("工艺规划产品步骤", pprProduct),
      ...metricFailures("工艺规划工序步骤", pprOperations),
      ...metricFailures("电子作业指导书", pprEwi),
      ...firstUseFailures("流程仿真", plantFirstUse),
      ...firstUseFailures("工艺规划入口", pprEntryFirstUse),
      ...firstUseFailures("工艺规划工作台", pprFirstUse),
      ...sequenceFailures("工艺规划", pprSteps, ["产品结构", "工序安排", "资源配置"], activePprStep),
      ...(plantConclusionBeforeEvidence ? [] : ["流程仿真结果没有遵循先结论、后证据的阅读顺序"]),
      ...(plantPlaybackBeforeEvidence ? [] : ["物流回放没有位于业务结论之后、运行证据之前"]),
      ...(playbackDuration > 0 ? [] : ["物流回放没有可拖动的真实事件时间范围"]),
      ...(failedPlaybackNodes === 1 ? [] : [`物流回放没有在故障时刻定位资源：${failedPlaybackNodes}`]),
      ...(equipmentFailedPlaybackNodes === 1 ? [] : [`设备故障没有在回放时刻定位工位：${equipmentFailedPlaybackNodes}`]),
      ...(equipmentEvidenceRows === 1 && equipmentEvidenceText.includes("终检设备") && equipmentEvidenceText.includes("故障损失 21.0 台·分") ? [] : [`设备可靠性没有形成计划利用率与故障损失证据：${equipmentEvidenceText}`]),
      ...(energyEvidenceText.includes("单位能耗") && energyEvidenceText.includes("单位电费") && energyEvidenceText.includes("单位碳排") && energyEvidenceText.includes("主要用能对象") ? [] : [`能耗、成本与碳排没有形成模型驱动证据：${energyEvidenceText}`]),
      ...(decisionRows === 3 ? [] : [`瓶颈实验没有形成基线加两个候选的决策矩阵：${decisionRows}`]),
      ...(bestScenarioLabels.some((label) => label.includes("3 个并行工位") && label.includes("最高吞吐")) ? [] : [`方案矩阵没有按真实统计标出最高吞吐候选：${bestScenarioLabels.join("、")}`]),
      ...(bestScenarioLabels.some((label) => label.includes("Pareto 推荐") && label.includes("单位成本最低")) ? [] : [`方案矩阵没有形成多目标 Pareto 推荐：${bestScenarioLabels.join("、")}`]),
      ...(selectedComparisonBaseline === "plant-study-qa" ? [] : [`方案组没有自动选中保存的实验基线：${selectedComparisonBaseline}`]),
      ...(materialTransferSummary.includes("5 次已采集转移") ? [] : [`物料流没有按真实 exit→enter 事件统计：${materialTransferSummary}`]),
      ...(materialRouteRows === 5 ? [] : [`物料流路径行数与模型边不一致：${materialRouteRows}`]),
      ...(materialTimingRows === 3 ? [] : [`节点耗时没有覆盖两工位与搬运节点：${materialTimingRows}`]),
      ...(nodeCountAfter === nodeCountBefore + 1 ? [] : [`流程节点新增没有生效：${nodeCountBefore} → ${nodeCountAfter}`]),
      ...(productCount === 1 ? [] : [`添加产品没有形成唯一产品卡片：${productCount}`]),
      ...(pprConditionValue === "market == 'EU'" ? [] : [`工艺变体适用条件没有进入草稿：${pprConditionValue}`]),
      ...(ewiPreviewText.includes("将模组沿定位销装入夹具并确认到位") && ewiPreviewText.includes("夹紧前确认双手离开夹具") && ewiPreviewText.includes("0.5–0.8 mm") ? [] : [`EWI 编制没有实时进入工序预览：${ewiPreviewText.slice(0, 180)}`]),
      ...(ewiDeliveryEnabled ? [] : ["EWI 有有效内容后打印或离线 HTML 仍不可用"]),
      ...(ewiDownloadValid ? [] : [`EWI 离线交付文件不可用：${ewiDownload.suggestedFilename()}`]),
    ];
    return { ...viewport, kind: "plant-ppr", overview, pprProduct, pprOperations, pprEwi, plantFirstUse, pprEntryFirstUse, pprFirstUse, pprSteps, pprConditionValue, plantConclusionBeforeEvidence, plantPlaybackBeforeEvidence, playbackDuration, failedPlaybackNodes, equipmentFailedPlaybackNodes, equipmentEvidenceRows, equipmentEvidenceText, energyEvidenceText, decisionRows, bestScenarioLabels, selectedComparisonBaseline, materialTransferSummary, materialRouteRows, materialTimingRows, ewiDeliveryEnabled, ewiDownloadValid, failures, ...diagnostics };
  } finally {
    await page.close();
  }
}

export async function inspectCommissioningWorkflow(browser, origin, viewport, outputRoot) {
  const page = await workflowPage(browser, viewport);
  const diagnostics = observeDiagnostics(page);
  try {
    await page.goto(`${origin}/?__visualQa=commissioning`, { waitUntil: "networkidle" });
    await page.locator(".commissioning-workbench").waitFor({ state: "visible" });
    const firstUse = await collectFirstUse(page, {
      scopeSelector: ".commissioning-visual-qa",
      primaryActionSelector: ".commissioning-selection > button:not(:disabled)",
      expectedAction: "检查任务",
    });
    const initialSelection = await collectSurfaceMetrics(page, {
      rootSelector: ".commissioning-visual-qa",
      primaryRegions: [".commissioning-titlebar", ".commissioning-selection"],
      primaryActions: [".commissioning-selection > button"],
    });
    const prematureSteps = await page.locator(".commissioning-steps").count();
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-task-selection.png`), fullPage: true });

    await page.getByRole("button", { name: "检查任务", exact: true }).click();
    await page.locator(".robot-assistant-panel").waitFor({ state: "visible" });
    const targetCycleInput = page.locator(".robot-assistant-parameter-grid > label").filter({ hasText: "目标节拍" }).locator("input");
    await targetCycleInput.fill("24");
    const parameterSummary = await page.locator(".robot-assistant-setup > summary").innerText();
    const editableTargetTimes = await page.locator(".robot-assistant-target-times input").count();
    const loadPlanningSummary = await page.locator(".robot-load-profile > summary").innerText();
    const loadPlanningInputs = await page.locator(".robot-load-profile input").count();
    const steps = await page.locator(".commissioning-steps > button i").allTextContents();
    const stepState = await page.locator(".commissioning-steps > button").evaluateAll((items) => items.map((item) => ({ active: item.classList.contains("active"), disabled: item.hasAttribute("disabled") })));
    const robotFirstUse = await collectFirstUse(page, {
      scopeSelector: ".robot-assistant-panel",
      primaryActionSelector: ".robot-assistant-run:not(:disabled)",
      expectedAction: "生成任务并验证",
    });
    const robotScreening = await collectSurfaceMetrics(page, {
      rootSelector: ".commissioning-visual-qa",
      primaryRegions: [".commissioning-titlebar", ".commissioning-selection", ".commissioning-steps", ".robot-assistant-panel"],
      primaryActions: [".robot-assistant-run", ".robot-assistant-actions button"],
    });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-robot-screening.png`), fullPage: true });

    await page.locator(".commissioning-selection select").nth(1).selectOption("");
    await page.getByRole("button", { name: "检查任务", exact: true }).click();
    await page.locator(".workcell-audit-panel").waitFor({ state: "visible" });
    const controlStep = page.locator(".commissioning-steps > button").nth(1);
    const controlEnabled = await controlStep.isEnabled();
    await controlStep.click();
    await page.locator("#commissioning-control-validation").waitFor({ state: "visible" });
    const controlFirstUse = await collectFirstUse(page, {
      scopeSelector: "#commissioning-control-validation",
      primaryActionSelector: ".commissioning-run:not(:disabled)",
      expectedAction: "验证控制逻辑",
    });
    const control = await collectSurfaceMetrics(page, {
      rootSelector: ".commissioning-visual-qa",
      primaryRegions: [".commissioning-titlebar", ".commissioning-selection", ".commissioning-steps", "#commissioning-control-validation"],
      primaryActions: [".commissioning-run", ".commissioning-suite-run"],
    });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-control-validation.png`), fullPage: true });

    await page.goto(`${origin}/?__visualQa=commissioning&state=result`, { waitUntil: "networkidle" });
    await page.locator(".commissioning-steps > button").nth(2).click();
    await page.locator(".commissioning-result-stage").waitFor({ state: "visible" });
    const result = await collectSurfaceMetrics(page, {
      rootSelector: ".commissioning-visual-qa",
      primaryRegions: [".commissioning-result-stage > header", ".commissioning-suite-summary", ".commissioning-evidence"],
      primaryActions: [".commissioning-result-stage > header .commissioning-run", ".commissioning-result-stage > header .commissioning-suite-run"],
    });
    const conclusionBeforeEvidence = await page.evaluate(() => {
      const conclusion = document.querySelector(".commissioning-suite-summary");
      const evidence = document.querySelector(".commissioning-evidence");
      return Boolean(conclusion && evidence && conclusion.compareDocumentPosition(evidence) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-validation-result.png`), fullPage: true });

    await page.goto(`${origin}/?__visualQa=commissioning&state=trajectory`, { waitUntil: "networkidle" });
    await page.locator(".workcell-trajectory-player").waitFor({ state: "visible" });
    const trajectory = await collectSurfaceMetrics(page, {
      rootSelector: ".trajectory-visual-qa",
      primaryRegions: [".workcell-trajectory-heading", ".workcell-trajectory-playerbar", ".workcell-trajectory-timeline", ".workcell-trajectory-frame"],
      primaryActions: [".workcell-trajectory-transport .transport-main", ".workcell-trajectory-markers button", ".workcell-trajectory-focus-actions button", ".workcell-trajectory-delivery-actions button"],
    });
    await setRangeValue(page.locator(".workcell-trajectory-range-wrap input"), 3);
    const interpolatedPosition = await page.locator(".workcell-trajectory-position").innerText();
    const truthfulBoundary = await page.locator(".workcell-trajectory-boundary").innerText();
    const trajectoryMarkerCount = await page.locator(".workcell-trajectory-markers button").count();
    const trajectoryDeliveryButtons = await page.locator(".workcell-trajectory-delivery-actions button").count();
    const trajectoryDeliveryStatus = await page.locator(".workcell-trajectory-delivery-actions > span").innerText();
    const [trajectoryJsonDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "交付包 JSON", exact: true }).click(),
    ]);
    const trajectoryJsonText = await readDownloadText(trajectoryJsonDownload);
    const trajectoryPackage = JSON.parse(trajectoryJsonText);
    const [trajectoryCsvDownload] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "关键帧 CSV", exact: true }).click(),
    ]);
    const trajectoryCsvText = await readDownloadText(trajectoryCsvDownload);
    const trajectoryDeliveryValid = trajectoryJsonDownload.suggestedFilename().endsWith(".json")
      && trajectoryCsvDownload.suggestedFilename().endsWith("-keyframes.csv")
      && trajectoryPackage.schema === "bim-studio.workcell-trajectory-delivery.v1"
      && trajectoryPackage.generatedBy === "DeepMonkey Studio"
      && trajectoryPackage.capabilityBoundary?.dispatchable === false
      && trajectoryPackage.summary?.trajectoryCount === trajectoryPackage.trajectoryInputs?.length
      && trajectoryPackage.traceability?.includedTrajectoryIds?.length === trajectoryPackage.trajectoryInputs?.length
      && trajectoryCsvText.includes(trajectoryPackage.packageId)
      && trajectoryCsvText.trim().split(/\r?\n/).length === trajectoryPackage.summary.waypointCount + 1;
    await page.screenshot({ path: resolve(outputRoot, `${viewport.id}-trajectory-evidence.png`), fullPage: true });

    const failures = [
      ...diagnosticFailures(diagnostics),
      ...metricFailures("任务选择", initialSelection),
      ...metricFailures("机器人任务检查", robotScreening),
      ...metricFailures("控制逻辑验证", control),
      ...metricFailures("验证结果", result),
      ...metricFailures("轨迹证据回放", trajectory),
      ...firstUseFailures("机器人与控制验证", firstUse),
      ...firstUseFailures("机器人任务检查", robotFirstUse),
      ...firstUseFailures("控制逻辑验证", controlFirstUse),
      ...sequenceFailures("机器人与控制验证", steps, ["检查任务", "验证控制逻辑", "查看结果"], stepState.findIndex((item) => item.active)),
      ...(prematureSteps === 0 ? [] : ["确认工位与机器人前不应展示后续阶段"]),
      ...(!stepState[0]?.disabled && stepState[1]?.disabled && stepState[2]?.disabled ? [] : ["首次进入时必须只开放第 1 步"]),
      ...(controlEnabled ? [] : ["完成快速检查后仍不能进入控制逻辑验证"]),
      ...(parameterSummary.includes("节拍 24s") ? [] : [`机器人验证参数没有形成实时任务输入：${parameterSummary.replace(/\s+/g, " ")}`]),
      ...(editableTargetTimes >= 2 ? [] : ["机器人目标缺少可编辑的工艺与稳定等待时间"]),
      ...(loadPlanningSummary.includes("参数完整") && loadPlanningInputs >= 10 ? [] : [`机器人负载/TCP规划输入未形成完整闭环：${loadPlanningSummary.replace(/\s+/g, " ")} / ${loadPlanningInputs}`]),
      ...(conclusionBeforeEvidence ? [] : ["验证结果没有遵循先结论、后证据的阅读顺序"]),
      ...(interpolatedPosition.includes("X 2.000 m") && interpolatedPosition.includes("Y 1.000 m") ? [] : [`轨迹时间轴未显示真实插值坐标：${interpolatedPosition.replace(/\s+/g, " ")}`]),
      ...(truthfulBoundary.includes("不驱动机器人骨骼") ? [] : ["轨迹回放没有声明当前三维驱动能力边界"]),
      ...(trajectoryMarkerCount >= 4 ? [] : [`轨迹风险与关键帧标记不足：${trajectoryMarkerCount}`]),
      ...(trajectoryDeliveryButtons === 2 && trajectoryDeliveryStatus.includes("可交付") ? [] : [`轨迹证据没有形成 JSON/CSV 交付闭环：${trajectoryDeliveryButtons} / ${trajectoryDeliveryStatus}`]),
      ...(trajectoryDeliveryValid ? [] : ["轨迹 JSON/CSV 下载内容与交付合同不一致"]),
    ];
    return { ...viewport, kind: "ps", initialSelection, robotScreening, control, result, trajectory, firstUse, robotFirstUse, controlFirstUse, steps, stepState, parameterSummary, editableTargetTimes, loadPlanningSummary, loadPlanningInputs, conclusionBeforeEvidence, interpolatedPosition, trajectoryMarkerCount, trajectoryDeliveryButtons, trajectoryDeliveryStatus, trajectoryDeliveryValid, failures, ...diagnostics };
  } finally {
    await page.close();
  }
}

async function workflowPage(browser, viewport) {
  return browser.newPage({ viewport: { width: viewport.width, height: viewport.height }, deviceScaleFactor: 1 });
}

function observeDiagnostics(page) {
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("requestfailed", (request) => requestFailures.push(`${request.method()} ${request.url()} · ${request.failure()?.errorText ?? "unknown"}`));
  return { consoleErrors, pageErrors, requestFailures };
}

function diagnosticFailures({ consoleErrors, pageErrors, requestFailures }) {
  return [
    ...consoleErrors.map((value) => `console error: ${value}`),
    ...pageErrors.map((value) => `page error: ${value}`),
    ...requestFailures.map((value) => `request failed: ${value}`),
  ];
}

async function collectSurfaceMetrics(page, config) {
  return page.evaluate(({ rootSelector, primaryRegions, primaryActions }) => {
    const root = document.querySelector(rootSelector);
    const visible = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const closed = element.closest("details:not([open])");
      const shownByClosedDetails = !closed || closed.querySelector(":scope > summary")?.contains(element);
      return shownByClosedDetails && bounds.width > 0 && bounds.height > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const business = root ? [...root.querySelectorAll("button,label,small,span,strong,p,h1,h2,h3,h4,summary,em,i")] : [];
    const smallBusinessText = business.filter((element) => visible(element)
      && !element.closest("code,pre,[aria-hidden='true']")
      && /[A-Za-z\u3400-\u9fff]/.test(element.textContent?.trim() ?? "")
      && Number.parseFloat(getComputedStyle(element).fontSize) < 10.95)
      .slice(0, 12)
      .map((element) => `${element.tagName.toLowerCase()}.${String(element.className || "").split(" ")[0]}=${getComputedStyle(element).fontSize}[${element.textContent?.trim().slice(0, 22)}]`);
    const smallPrimaryTargets = root ? [...root.querySelectorAll(primaryActions.join(","))].filter((element) => {
      if (!visible(element)) return false;
      const bounds = element.getBoundingClientRect();
      return bounds.width < 28 || bounds.height < 28;
    }).slice(0, 12).map((element) => `${element.tagName.toLowerCase()}[${element.textContent?.trim().slice(0, 18) || element.getAttribute("aria-label") || "无标签"}]`) : [];
    return {
      horizontalOverflow: Boolean(root && (root.scrollWidth > root.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1)),
      hiddenPrimaryRegions: primaryRegions.filter((selector) => {
        const element = document.querySelector(selector);
        const bounds = element?.getBoundingClientRect();
        return !bounds || bounds.width < 1 || bounds.height < 1;
      }),
      smallBusinessText,
      smallPrimaryTargets,
    };
  }, config);
}

async function collectFirstUse(page, config) {
  return page.evaluate(({ scopeSelector, actionScopeSelector, primaryActionSelector, expectedAction, advancedSelector }) => {
    const scope = document.querySelector(scopeSelector);
    const actionScope = document.querySelector(actionScopeSelector || scopeSelector);
    const visibleInViewport = (element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      const closed = element.closest("details:not([open])");
      const shownByClosedDetails = !closed || closed.querySelector(":scope > summary")?.contains(element);
      return shownByClosedDetails && bounds.width > 0 && bounds.height > 0 && bounds.bottom > 0 && bounds.top < innerHeight && style.display !== "none" && style.visibility !== "hidden";
    };
    const visibleText = scope ? [...scope.querySelectorAll("button,label,small,span,strong,p,h1,h2,h3,h4,summary,em,i")]
      .filter((element) => visibleInViewport(element) && !element.closest("code,pre,[aria-hidden='true']"))
      .map((element) => element.textContent?.trim() ?? "").join("\n") : "";
    const mainActions = actionScope ? [...actionScope.querySelectorAll(primaryActionSelector)]
      .filter((element) => visibleInViewport(element) && !(element instanceof HTMLButtonElement && element.disabled))
      .map((element) => element.textContent?.replace(/\s+/g, "").trim() || element.getAttribute("aria-label") || "无标签") : [];
    const openAdvanced = scope ? [...scope.querySelectorAll(advancedSelector)].filter((element) => element.hasAttribute("open")).map((element) => element.className) : [];
    return { expectedAction, mainActions, openAdvanced, hasTaskLanguage: visibleText.trim().length > 0 };
  }, { ...config, advancedSelector: advancedDisclosureSelector });
}

function metricFailures(label, metrics) {
  return [
    ...(metrics.horizontalOverflow ? [`${label}产生横向溢出`] : []),
    ...(metrics.hiddenPrimaryRegions.length ? [`${label}关键区域不可见：${metrics.hiddenPrimaryRegions.join(", ")}`] : []),
    ...(metrics.smallBusinessText.length ? [`${label}存在小于 11px 的业务文字：${metrics.smallBusinessText.join(", ")}`] : []),
    ...(metrics.smallPrimaryTargets.length ? [`${label}存在小于 28px 的主要操作：${metrics.smallPrimaryTargets.join(", ")}`] : []),
  ];
}

function firstUseFailures(label, result) {
  return [
    ...(result.mainActions.length === 1 ? [] : [`${label}首屏应只有一个明确主动作，实际为：${result.mainActions.join("、") || "无"}`]),
    ...(result.mainActions[0]?.includes(result.expectedAction) ? [] : [`${label}首个主动作应为“${result.expectedAction}”`]),
    ...(result.hasTaskLanguage ? [] : [`${label}首屏缺少可理解的任务说明`]),
    ...(result.openAdvanced.length ? [`${label}高级项没有默认折叠：${result.openAdvanced.join(", ")}`] : []),
  ];
}

function sequenceFailures(label, actual, expected, activeIndex) {
  const normalized = actual.map((value) => value.replace(/\s+/g, ""));
  return [
    ...(expected.every((value, index) => normalized[index] === value) ? [] : [`${label}步骤顺序错误：${normalized.join(" → ")}`]),
    ...(activeIndex === 0 ? [] : [`${label}首次进入没有聚焦第 1 步`]),
  ];
}

async function setRangeValue(locator, value) {
  await locator.evaluate((element, nextValue) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    if (setter) setter.call(element, String(nextValue));
    else element.value = String(nextValue);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}

async function readDownloadText(download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error(`无法读取下载文件：${download.suggestedFilename()}`);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
