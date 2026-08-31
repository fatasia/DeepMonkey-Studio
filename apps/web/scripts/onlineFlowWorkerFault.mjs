/** 在真实 Dedicated Worker 中制造未捕获异常，并验证脚本工作台可见故障且可重启。 */
export async function verifyBehaviorWorkerCrash({ page, behaviorPanel, report }) {
  const worker = page.workers().find((candidate) => candidate.url().includes("sceneBehavior.worker"));
  if (!worker) throw new Error("行为脚本运行后未发现 Dedicated Worker");
  const message = "online-flow-worker-crash";
  await worker.evaluate((errorMessage) => {
    setTimeout(() => { throw new Error(errorMessage); }, 0);
  }, message).catch(() => undefined);

  const problemsButton = behaviorPanel.locator(".professional-code-problems.has-problems");
  await problemsButton.waitFor({ state: "visible", timeout: 15_000 });
  await problemsButton.click();
  const workerProblem = behaviorPanel.locator(".professional-code-problem-list button").filter({ hasText: message });
  await workerProblem.waitFor({ state: "visible", timeout: 15_000 });

  // 重跑必须创建新 Worker 并清空运行时错误，不要求用户重新打开场景或刷新页面。
  await behaviorPanel.getByRole("button", { name: /^(应用并运行|重新运行)$/ }).click();
  await behaviorPanel.locator(".professional-code-problems.healthy").waitFor({ state: "visible", timeout: 15_000 });
  const replacement = await waitForReplacementWorker(page, worker);
  if (!replacement) throw new Error("行为 Worker 故障后未创建隔离的新实例");
  report.faultChecks.push({ id: "behavior-worker-crash-restart", expected: "visible diagnostic + restart", actual: "passed" });
}

async function waitForReplacementWorker(page, failedWorker) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const replacement = page.workers().find((candidate) => candidate !== failedWorker && candidate.url().includes("sceneBehavior.worker"));
    if (replacement) return replacement;
    await page.waitForTimeout(50);
  }
  return undefined;
}
