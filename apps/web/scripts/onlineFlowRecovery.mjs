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
  // 行级操作已收纳进行内"更多操作"菜单;先展开再删(force 跳过悬停预检以免弹层提前收起)。
  await firstDevice.locator(".scene-row-menu > summary").click();
  await firstDevice.getByTitle("删除基础元素").click({ force: true });
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
  // PUT 响应到达与 IndexedDB 副本删除之间存在毫秒级窗口(saveScene 在 PUT 后的同步链里
  // 才执行 deleteWorkspaceRecoveryDraft);断言必须读"清理完成"的稳态,读到清理中的瞬间
  // 不是缺陷。有界轮询 3 秒,仍残留才判失败——残留=真实产品竞态(saveScene 守卫提前
  // return/saveScene 异常/500ms 副本 effect 复活),由 toast 证据归因。
  let remaining = await readBrowserRecoveryDraft(page, identity);
  for (let attempt = 0; attempt < 20 && remaining; attempt += 1) {
    await page.waitForTimeout(150);
    remaining = await readBrowserRecoveryDraft(page, identity);
  }
  if (remaining) {
    // 竞态归因:正式保存成功后副本仍残留,只有三类来源——saveScene 在 PUT 后的守卫
    // 提前 return(不 delete)/saveScene catch(错误 toast)/保存-删除后 500ms 副本
    // effect 复活。toast 文本能区分三者,不盲改产品。
    const toasts = await page.locator(".toast").allInnerTexts().catch(() => []);
    throw new Error(`断网恢复后正式保存未清理本地副本(remaining.savedAt=${remaining.savedAt}, scene.prims=${remaining.scene?.primitives?.length}, toasts=${JSON.stringify(toasts)})`);
  }
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
