import { resolve } from "node:path";
import { showFlatSceneObjects, auditPage, recordStep } from "./onlineFlowAuditSupport.mjs";
import { auditMaintenanceWideLayout } from "./onlineFlowWideLayout.mjs";

/** 管理器 AI 能力目录 → 运维工作台(虚拟调试/维护诊断/物流/验证研究)全链验收。 */
export async function verifyAiOperationsFlow({ page, productOrigin, project, report, outputRoot }) {
  // AI 目录来自插件注册表；成熟任务必须直接进入对应工作台，且路由可刷新恢复。
  await page.locator(".manager-capability-nav").getByRole("button", { name: "AI 助手", exact: true }).click();
  const platformAssistant = page.locator(".ai-assistant-panel");
  // T9:能力目录收进折叠行,展开才挂载;管理器页同法规矩。
  await platformAssistant.locator(".ai-capability-drawer > summary").click();
  await platformAssistant.locator(".ai-capability-catalog:not(.is-loading)").waitFor({ state: "visible" });
  // 目录默认跨命名空间只显 8 项;成熟任务入口先"显示全部"再点虚拟调试。
  const showAllCapabilities = platformAssistant.locator(".ai-capability-show-all");
  if (await showAllCapabilities.isVisible().catch(() => false)) await showAllCapabilities.click();
  await platformAssistant.locator('.ai-capability-catalog > div > button[title*="simulation.virtual-debug.run"]')
    .first().click();
  // 路由现携带 project 上下文参数;匹配 task 参数而不锚定结尾。
  await page.waitForURL(/\/operations\?.*task=commissioning/);
  await page.locator(".operations-page").waitFor({ state: "visible" });
  await page.locator(".commissioning-workbench").waitFor({ state: "visible" });
  recordStep(report, "ai-capability-opens-controlled-workspace", page.url());

  // 高频 AI 不依赖用户编写提示词：回到维护任务，运行真实模型后一键得到结构化诊断。
  await page.getByRole("button", { name: "预测维护", exact: true }).click();

  // 源数据直跑已收敛:必须绑定现场数据集(否则运行时提示选择数据集)。
  // 选种子遥测数据集(字段含 temperature/vibration,与种子模型特征对齐),按钮文案随之切换。
  await page.getByLabel("运行数据源").selectOption({ label: "设备遥测验收数据" });
  const maintenanceRun = page.getByRole("button", { name: /^(运行源数据验证|运行现场评估)$/ });
  await maintenanceRun.waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = [...document.querySelectorAll("button")].find((item) => ["运行源数据验证", "运行现场评估"].includes(item.textContent?.trim() ?? ""));
    return button instanceof HTMLButtonElement && !button.disabled;
  });
  await maintenanceRun.click();
  await page.locator(".operations-result").waitFor({ state: "visible" });
  await page.getByRole("button", { name: "AI 诊断与下一步", exact: true }).click();
  const diagnosis = page.locator(".maintenance-diagnosis");
  await diagnosis.waitFor({ state: "visible" });
  const diagnosisEvidence = await diagnosis.evaluate((element) => ({
    headline: element.querySelector("header strong")?.textContent?.trim(),
    hypothesisCount: element.querySelectorAll(".maintenance-hypotheses > div").length,
    actionCount: element.querySelectorAll(".maintenance-diagnosis-actions button").length,
    hasPromptInput: Boolean(element.querySelector("input, textarea"))
  }));
  if (!diagnosisEvidence.headline || diagnosisEvidence.actionCount < 2 || diagnosisEvidence.hasPromptInput) {
    throw new Error(`零提示词工业 AI 诊断验收失败：${JSON.stringify(diagnosisEvidence)}`);
  }
  report.pageAudits.push(await auditPage(page, "maintenance-ai-diagnosis"));
  await page.screenshot({ path: resolve(outputRoot, "04a-maintenance-ai-diagnosis.png"), fullPage: true });
  const maintenanceWideLayout = await auditMaintenanceWideLayout({ page, report, outputRoot, auditPage });
  recordStep(report, "maintenance-ai-diagnosis", { ...diagnosisEvidence, wideLayout: maintenanceWideLayout });
  await diagnosis.getByRole("button", { name: "虚拟验证", exact: true }).click();

  await page.getByRole("button", { name: "机器人与控制验证", exact: true }).click();
  const commissioning = page.locator(".commissioning-workbench");
  await commissioning.waitFor({ state: "visible" });
  await commissioning.locator(".commissioning-ai-draft strong").filter({ hasText: "验证任务已保存" }).waitFor({ state: "visible" });
  await commissioning.getByRole("button", { name: "确认用于本次验证", exact: true }).click();
  await commissioning.getByRole("button", { name: "运行快速验证", exact: true }).click();
  await commissioning.locator('.commissioning-steps button').filter({ hasText: "验证控制逻辑" }).click();
  const configuredBindingCount = await commissioning.locator(".commissioning-bindings article").count();
  if (configuredBindingCount < 2) throw new Error(`控制逻辑验证缺少信号映射：${configuredBindingCount}`);
  await commissioning.locator(".commissioning-control-stage .commissioning-run").click();
  await commissioning.locator(".commissioning-evidence > header.passed").waitFor({ state: "visible" });
  const commissioningEvidence = await commissioning.evaluate((element, bindingCount) => ({
    bindings: bindingCount,
    signals: element.querySelectorAll(".commissioning-signal-grid button").length,
    fingerprintLength: element.querySelector(".commissioning-fingerprint code")?.textContent?.trim().length ?? 0,
    hasOverflow: element.scrollWidth > element.clientWidth + 1
  }), configuredBindingCount);
  if (commissioningEvidence.bindings < 2 || commissioningEvidence.signals < 2 || commissioningEvidence.fingerprintLength !== 64 || commissioningEvidence.hasOverflow) {
    throw new Error(`虚拟调试工作台验收失败：${JSON.stringify(commissioningEvidence)}`);
  }
  const validationStudyEvidence = await page.evaluate(async (projectId) => {
    const token = localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token");
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/operations`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    if (!response.ok) throw new Error(`读取验证任务卡失败：HTTP ${response.status}`);
    const snapshot = await response.json();
    const studies = snapshot.validationStudies ?? [];
    const study = studies[0];
    const baseline = studies.find((candidate) => candidate.id === study?.baselineStudyId);
    return study ? {
      status: study.status,
      revision: study.revision,
      studyType: study.studyType,
      hasLineage: Boolean(
        baseline
          && study.baselineStudyId === study.reproductionOf
          && baseline.sourceKind === "maintenance-diagnosis",
      ),
      baselineSourceKind: baseline?.sourceKind,
      baselineRevision: baseline?.revision,
      objectCount: study.objectIds?.length ?? 0,
      fingerprintLength: study.latestResult?.evidenceFingerprint?.length ?? 0
    } : undefined;
  }, project.id);
  if (!validationStudyEvidence
    || validationStudyEvidence.status !== "passed"
    || validationStudyEvidence.revision < 1
    || validationStudyEvidence.studyType !== "virtual-commissioning"
    || !validationStudyEvidence.hasLineage
    || validationStudyEvidence.objectCount < 1
    || validationStudyEvidence.fingerprintLength !== 64) {
    throw new Error(`轻量验证任务卡未完成留证：${JSON.stringify(validationStudyEvidence)}`);
  }
  report.pageAudits.push(await auditPage(page, "virtual-commissioning-passed"));
  await page.screenshot({ path: resolve(outputRoot, "04a-virtual-commissioning.png"), fullPage: true });

  // 物流 Study 必须走完“运行—改参—对比—精确复现—持久化”，不能只验证公式接口。
  await page.getByRole("button", { name: "工厂规划", exact: true }).click();
  // 解析快速估算保留默认入口；DES 有独立按钮，不能让门禁依赖已废弃的泛化文案。
  await page.getByRole("button", { name: "运行快速估算", exact: true }).click();
  await page.locator(".logistics-study-panel .operations-result").waitFor({ state: "visible" });
  await page.getByLabel("工况名称").fill("在线门禁优化工况");
  await page.getByLabel("AGV 数量").fill("7");
  await page.getByRole("button", { name: "运行快速估算", exact: true }).click();
  await page.getByRole("button", { name: "精确复现基线", exact: true }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "精确复现基线", exact: true }).click();
  await page.getByText("复现校验通过：输入、引擎版本和关键结果完全一致。").waitFor({ state: "visible" });
  const logisticsStudyEvidence = await page.evaluate(async (projectId) => {
    const token = localStorage.getItem("bim-studio-auth-token") ?? sessionStorage.getItem("bim-studio-auth-token");
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/operations`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    });
    if (!response.ok) throw new Error(`读取物流 Study 失败：HTTP ${response.status}`);
    const experiments = (await response.json()).logisticsExperiments ?? [];
    const latest = experiments[0];
    const source = experiments.find((item) => item.id === latest?.reproductionOf);
    return {
      count: experiments.length,
      hasLineage: Boolean(source),
      fingerprintMatches: Boolean(source?.execution?.inputFingerprint)
        && source.execution.inputFingerprint === latest?.execution?.inputFingerprint
    };
  }, project.id);
  if (logisticsStudyEvidence.count < 3 || !logisticsStudyEvidence.hasLineage || !logisticsStudyEvidence.fingerprintMatches) {
    throw new Error(`物流 Study 追溯链验收失败：${JSON.stringify(logisticsStudyEvidence)}`);
  }
  report.pageAudits.push(await auditPage(page, "logistics-study-reproduced"));
  await page.screenshot({ path: resolve(outputRoot, "04b-logistics-study.png"), fullPage: true });
  recordStep(report, "logistics-study-compare-and-reproduce", logisticsStudyEvidence);

  await page.getByRole("button", { name: "机器人与控制验证", exact: true }).click();
  await commissioning.waitFor({ state: "visible" });
  await commissioning.locator(".commissioning-signal-grid button").first().click();
  await page.locator(".viewport canvas").waitFor({ state: "visible", timeout: 30_000 });
  await showFlatSceneObjects(page);
  await page.locator(".scene-object-row").filter({ hasText: "设备 001" }).first().waitFor({ state: "visible" });
  recordStep(report, "virtual-commissioning-evidence-and-focus", commissioningEvidence);
  recordStep(report, "validation-study-persisted", validationStudyEvidence);
  recordStep(report, "operations-flow-completed", page.url());
}
