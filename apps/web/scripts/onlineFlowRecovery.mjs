/** 读取浏览器中的恢复副本；事务完成后再返回，避免把尚未提交的请求当成成功。 */
export async function readBrowserRecoveryDraft(page, identity) {
  return page.evaluate(async ({ projectId, applicationId, sceneId }) => {
    const database = await new Promise((resolveDatabase, reject) => {
      const request = indexedDB.open("bim-studio-recovery", 1);
      request.onsuccess = () => resolveDatabase(request.result);
      request.onerror = () => reject(request.error);
    });
    return new Promise((resolveDraft, reject) => {
      const transaction = database.transaction("workspace-drafts", "readonly");
      const request = transaction.objectStore("workspace-drafts").get(`${projectId}:${applicationId}:${sceneId}`);
      request.onsuccess = () => { database.close(); resolveDraft(request.result); };
      request.onerror = () => reject(request.error);
    });
  }, identity);
}

/**
 * 在真实浏览器里切断网络后保存一次场景，随后恢复网络、保存并撤销临时修改。
 * 最终服务端仍回到原场景，测试不会把故障注入状态遗留给后续发布流程。
 */
export async function verifyOfflineWorkspaceRecovery({ page, report, identity }) {
  const deviceRows = page.locator(".scene-object-row").filter({ hasText: "基础元素" });
  const originalObjects = await deviceRows.count();
  const originalLabels = await page.locator(".scene-object-row .annotation-badge").count();
  const firstDevice = page.locator(".scene-object-row").filter({ hasText: "设备 001" }).filter({ hasText: "基础元素" }).first();
  await firstDevice.getByTitle("删除基础元素").click();
  await waitForSceneCounts(page, originalObjects - 1, originalLabels - 1);

  await page.context().setOffline(true);
  try {
    await page.getByRole("button", { name: "保存项目" }).click();
    await page.locator(".toast.error").last().waitFor({ state: "visible", timeout: 15_000 });
    await page.waitForTimeout(100);
    const draft = await readBrowserRecoveryDraft(page, identity);
    if ((draft?.scene?.primitives?.length ?? -1) !== originalObjects - 1) {
      throw new Error(`断网保存未保留最新场景副本：${draft?.scene?.primitives?.length ?? "missing"}`);
    }
  } finally {
    await page.context().setOffline(false);
  }

  await waitForOnline(page);
  const reconnectSave = page.waitForResponse((response) => response.url().endsWith("/workspace") && response.request().method() === "PUT" && response.status() === 200);
  await page.getByRole("button", { name: "保存项目" }).click();
  await reconnectSave;

  const undo = page.locator(".scene-history-controls button").nth(0);
  await page.waitForFunction(() => !(document.querySelector(".scene-history-controls button")?.disabled));
  const undoHitTarget = await undo.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const target = document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2);
    const rect = (selector) => {
      const selected = document.querySelector(selector)?.getBoundingClientRect();
      return selected ? { left: selected.left, right: selected.right, width: selected.width } : undefined;
    };
    return {
      undo: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom },
      target: target ? `${target.tagName.toLowerCase()}.${String(target.className || "").split(" ")[0]}` : "none",
      reachable: Boolean(target && element.contains(target)),
      regions: {
        topbar: rect(".topbar"),
        mode: rect(".workspace-mode-switch"),
        title: rect(".scene-title-wrap"),
        actions: rect(".topbar-actions"),
      },
    };
  });
  if (!undoHitTarget.reachable) {
    throw new Error(`撤销按钮被其他界面元素遮挡：${JSON.stringify(undoHitTarget)}`);
  }
  await undo.click();
  await waitForSceneCounts(page, originalObjects, originalLabels);
  const restoreSave = page.waitForResponse((response) => response.url().endsWith("/workspace") && response.request().method() === "PUT" && response.status() === 200);
  await page.getByRole("button", { name: "保存项目" }).click();
  await restoreSave;
  const remaining = await readBrowserRecoveryDraft(page, identity);
  if (remaining) throw new Error("断网恢复后正式保存未清理本地副本");
  report.faultChecks.push({ id: "offline-reconnect-workspace-recovery", expected: "local draft + reconnect save", actual: "passed" });
}

async function waitForOnline(page) {
  await page.waitForFunction(async () => {
    try {
      return (await fetch("/health", { cache: "no-store" })).ok;
    } catch {
      return false;
    }
  }, undefined, { timeout: 15_000 });
}

async function waitForSceneCounts(page, objects, labels) {
  await page.waitForFunction(({ objects: expectedObjects, labels: expectedLabels }) => {
    const currentObjects = [...document.querySelectorAll(".scene-object-row")].filter((element) => element.textContent?.includes("基础元素")).length;
    return currentObjects === expectedObjects && document.querySelectorAll(".scene-object-row .annotation-badge").length === expectedLabels;
  }, { objects, labels });
}
