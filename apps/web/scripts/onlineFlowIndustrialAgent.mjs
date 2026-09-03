import { resolve } from "node:path";

export async function verifyScriptAgentEntry({ page, behaviorPanel, outputRoot }) {
  const fingerprint = await behaviorPanel.locator(".professional-code-editor").getAttribute("data-content-fingerprint");
  await behaviorPanel.getByRole("button", { name: "AI 脚本助手", exact: true }).click();
  const agentSurface = behaviorPanel.locator(".behavior-agent-workspace");
  await agentSurface.waitFor({ state: "visible" });
  // 统一入口默认进入脚本解释；工业任务位于同一工作区的按需能力页。
  await agentSurface.getByRole("button", { name: "任务", exact: true }).click();
  const workspace = agentSurface.locator(".industrial-agent-workspace");
  await workspace.waitFor({ state: "visible" });
  await workspace.locator(".industrial-agent-capabilities > summary").getByText(/\d+ 项能力/).waitFor({ state: "visible" });
  await page.screenshot({ path: resolve(outputRoot, "02bbb-behavior-agent.png"), fullPage: true });
  await agentSurface.getByRole("button", { name: "返回脚本", exact: true }).click();
  await behaviorPanel.locator(`.professional-code-editor[data-content-fingerprint="${fingerprint}"]`).waitFor({ state: "visible" });
  return { enteredFromScript: true, draftFingerprintPreserved: true };
}

/**
 * 在生产前端中验证 Agent 的完整 UI 状态机。
 * 模型决策用固定 checkpoint 替代，服务端真实生命周期另由 HTTP 聚焦测试覆盖。
 */
export async function verifyIndustrialAgentBrowser({ page, assistantPanel, projectId, outputRoot }) {
  const routePattern = "**/api/projects/**/ai/agent-**";
  let runSequence = 0;
  let firstApproved = false;
  const now = "2026-09-01T00:00:00.000Z";
  const tools = [
    { id: "operations.maintenance.assess", label: "设备健康评估", description: "读取设备数据并形成诊断证据", effect: "analyze", risk: "low", requiresApproval: false },
    { id: "operations.control.apply", label: "应用现场控制", description: "把已审查参数写入现场并回读验证", effect: "control", risk: "high", requiresApproval: true },
  ];
  const base = (id, objective) => ({
    schemaVersion: 1, id, projectId, principal: "online-flow-editor", role: "editor", objective, context: {}, status: "running",
    budget: { maxSteps: 10, maxDurationMs: 90_000, maxToolCalls: 6 },
    usage: { steps: 1, toolCalls: 0, activeDurationMs: 320 }, allowedToolIds: tools.map((tool) => tool.id),
    decisions: [{ step: 1, decidedAt: now, decision: { kind: "call-tool", rationale: "先取得现场证据", call: { toolId: tools[0].id, arguments: {}, resources: [{ kind: "project", id: projectId, projectId }] } } }],
    toolRecords: [], seenToolFingerprints: [], createdAt: now, updatedAt: now, revision: 2,
  });
  const waiting = () => ({
    ...base("browser-agent-1", "检查设备风险，涉及控制时先确认"), status: "awaiting-approval", revision: 3,
    pendingTool: {
      step: 2, fingerprint: "browser-control-scope", effect: "control", state: "awaiting-approval",
      call: { toolId: tools[1].id, arguments: { target: "pump-01", enabled: false }, resources: [{ kind: "object", id: "pump-01", projectId }] },
    },
  });
  const completed = () => ({
    ...base("browser-agent-1", "检查设备风险，涉及控制时先确认"), status: "completed", revision: 6,
    usage: { steps: 3, toolCalls: 2, activeDurationMs: 1_420 },
    completion: { kind: "finish", rationale: "控制反馈已验证", summary: "泵站风险已处理，目标状态与回读信号一致。", decisionStatus: "production", evidenceIds: ["browser-evidence-1"] },
    toolRecords: [{
      step: 2, fingerprint: "browser-control-scope", effect: "control", startedAt: now, completedAt: now,
      call: { toolId: tools[1].id, arguments: { target: "pump-01", enabled: false }, resources: [{ kind: "object", id: "pump-01", projectId }] },
      outcome: {
        status: "completed", output: { verificationStatus: "passed" },
        evidence: [{ id: "browser-evidence-1", kind: "state-readback", label: "泵站状态回读", source: "online-flow-gateway", fingerprint: "browser-evidence-fingerprint" }],
        verificationEvidence: [{ id: "browser-evidence-1", kind: "state-readback", label: "泵站状态回读", source: "online-flow-gateway", fingerprint: "browser-evidence-fingerprint" }],
      },
    }],
  });

  await page.route(routePattern, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname.endsWith("/agent-tools")) return json(route, 200, { tools });
    if (request.method() === "POST" && url.pathname.endsWith("/agent-runs")) {
      runSequence += 1;
      const body = request.postDataJSON();
      return json(route, 202, base(`browser-agent-${runSequence}`, body.objective));
    }
    if (request.method() === "POST" && url.pathname.endsWith("/approve")) {
      firstApproved = true;
      return json(route, 200, { ...waiting(), status: "running", pendingTool: { ...waiting().pendingTool, state: "ready" }, revision: 4 });
    }
    if (request.method() === "DELETE") {
      const running = base("browser-agent-2", "验证取消路径");
      return json(route, 200, { ...running, status: "cancelled", failure: { code: "cancelled", message: "Agent 运行已取消", retryable: false }, revision: 4 });
    }
    if (request.method() === "GET" && url.pathname.includes("/agent-runs/browser-agent-1")) {
      return json(route, 200, firstApproved ? completed() : waiting());
    }
    if (request.method() === "GET" && url.pathname.includes("/agent-runs/browser-agent-2")) return json(route, 200, base("browser-agent-2", "验证取消路径"));
    return json(route, 409, { message: "运行正在推进" });
  });

  try {
    await assistantPanel.getByRole("tab", { name: "执行任务", exact: true }).click();
    const workspace = assistantPanel.locator(".industrial-agent-workspace");
    await workspace.waitFor({ state: "visible" });
    await workspace.getByText("2 项能力", { exact: true }).waitFor({ state: "visible" });
    const initialDisclosure = await workspace.locator(".industrial-agent-capabilities").evaluate((element) => ({
      open: element.hasAttribute("open"),
      overflow: element.scrollWidth > element.clientWidth + 1,
    }));
    if (initialDisclosure.open || initialDisclosure.overflow) throw new Error(`Agent 渐进披露不合格：${JSON.stringify(initialDisclosure)}`);

    await workspace.getByLabel("用一句话说明要完成的目标").fill("检查设备风险，涉及控制时先确认");
    await workspace.locator(".industrial-agent-capabilities > summary").click();
    await page.screenshot({ path: resolve(outputRoot, "03ab-agent-capability-preview.png"), fullPage: true });
    await workspace.getByRole("button", { name: "预览并运行", exact: true }).click();
    await workspace.getByText("等待确认", { exact: true }).waitFor({ state: "visible", timeout: 8_000 });
    await workspace.getByText("object:pump-01", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(outputRoot, "03ac-agent-confirmation.png"), fullPage: true });
    await workspace.getByRole("button", { name: "确认并继续", exact: true }).click();
    await workspace.getByText("证据结论", { exact: true }).waitFor({ state: "visible", timeout: 8_000 });
    await workspace.getByText("泵站状态回读", { exact: true }).waitFor({ state: "visible" });
    await page.screenshot({ path: resolve(outputRoot, "03ad-agent-evidence.png"), fullPage: true });

    await workspace.getByRole("button", { name: "开始新任务", exact: true }).click();
    await workspace.getByLabel("用一句话说明要完成的目标").fill("验证取消路径");
    await workspace.getByRole("button", { name: "预览并运行", exact: true }).click();
    await workspace.getByRole("button", { name: "取消", exact: true }).click();
    await workspace.getByText("已取消", { exact: true }).waitFor({ state: "visible" });
    const result = {
      toolCount: tools.length,
      defaultDisclosureCollapsed: !initialDisclosure.open,
      confirmationScopeVisible: true,
      evidenceVisible: true,
      cancellationVisible: true,
    };
    await assistantPanel.getByRole("tab", { name: "问答与生成", exact: true }).click();
    await assistantPanel.locator(".ai-capability-catalog:not(.is-loading)").waitFor({ state: "visible" });
    return result;
  } finally {
    await page.unroute(routePattern);
  }
}

function json(route, status, body) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}
