import { createServer } from "node:http";
import { resolve } from "node:path";

/**
 * 用真实跨源 iframe 验证 Unity Bridge 的可靠性状态机。
 * 测试运行时故意漏掉一次 action ACK，随后发健康包，覆盖降级和自动恢复。
 */
export async function verifyUnityRuntimeReliability({ page, report, outputRoot }) {
  const runtime = createServer((_request, response) => {
    response.setHeader("content-type", "text/html; charset=utf-8");
    response.end(runtimeDocument());
  });
  await new Promise((resolveReady) => runtime.listen(0, "127.0.0.1", resolveReady));
  const address = runtime.address();
  if (!address || typeof address === "string") throw new Error("无法创建 Unity Bridge 验收运行时");
  const runtimeOrigin = `http://127.0.0.1:${address.port}`;

  try {
    await page.evaluate(() => {
      window.__onlineFlowUnityStatuses = [];
      window.addEventListener("bim-studio:unity-status", (event) => {
        window.__onlineFlowUnityStatuses.push(event.detail);
      });
    });

    const librarySearch = page.locator(".dashboard-library-search input");
    await librarySearch.fill("Unity");
    await page.getByRole("button", { name: /Unity 场景/ }).click();
    const inspector = page.locator(".unity-resource-inspector");
    await inspector.waitFor({ state: "visible" });
    await inspector.locator(".unity-resource-advanced summary").click();
    await inspector.getByLabel("Unity Web URL").fill(`${runtimeOrigin}/player.html`);
    await inspector.getByLabel("允许的消息来源").fill(runtimeOrigin);

    const statusPanel = inspector.locator(".unity-contract-debug");
    await statusPanel.locator("strong", { hasText: "外部运行时" }).waitFor({ state: "visible" });
    await statusPanel.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector(".unity-contract-debug")?.classList.contains("ready"), undefined, { timeout: 10_000 });
    await page.waitForTimeout(150);
    const widgetId = await latestUnityWidgetId(page);
    const runtimeBounds = await page.locator(`iframe[src^="${runtimeOrigin}"]`).boundingBox();
    if (!runtimeBounds || runtimeBounds.width < 200 || runtimeBounds.height < 100) {
      throw new Error(`Unity 默认视口过小：${JSON.stringify(runtimeBounds)}`);
    }

    await page.evaluate((targetWidgetId) => {
      window.dispatchEvent(new CustomEvent("bim-studio:unity-action", {
        detail: { widgetId: targetWidgetId, action: "focus", objectId: "pump-1" },
      }));
    }, widgetId);
    await page.waitForFunction(() => document.querySelector(".unity-contract-debug")?.classList.contains("degraded"), undefined, { timeout: 6_000 });
    const degradedText = await statusPanel.innerText();
    if (!degradedText.includes("消息确认超时")) throw new Error(`Unity 降级原因不可理解：${degradedText}`);
    await page.waitForFunction(() => document.querySelector(".unity-contract-debug")?.classList.contains("ready"), undefined, { timeout: 8_000 });
    await statusPanel.getByText(/60 FPS/).waitFor({ state: "visible" });

    const statuses = await page.evaluate(() => window.__onlineFlowUnityStatuses);
    const states = statuses.map((item) => item.state);
    if (!states.includes("degraded") || states.at(-1) !== "ready") {
      throw new Error(`Unity 状态证据不完整：${JSON.stringify(states)}`);
    }
    report.steps.push({
      name: "unity-runtime-degrade-and-recover",
      evidence: { runtimeOrigin, widgetId, runtimeBounds, states, final: statuses.at(-1) },
      completedAt: new Date().toISOString(),
    });
    await page.screenshot({ path: resolve(outputRoot, "02aa-unity-runtime-recovered.png"), fullPage: true });
    // 后续门禁会离开二维工作区；先移除测试组件，避免把正常的 iframe 导航取消误判为产品请求失败。
    await page.waitForTimeout(200);
    await page.locator(".dashboard-delete-node").click();
    await page.locator(`iframe[src^="${runtimeOrigin}"]`).waitFor({ state: "detached" });
    await librarySearch.fill("");
    return () => closeRuntime(runtime);
  } catch (reason) {
    await closeRuntime(runtime);
    throw reason;
  }
}

function closeRuntime(runtime) {
  return new Promise((resolveClosed, reject) => runtime.close((error) => error ? reject(error) : resolveClosed()));
}

async function latestUnityWidgetId(page) {
  const widgetId = await page.evaluate(() => window.__onlineFlowUnityStatuses.at(-1)?.widgetId);
  if (typeof widgetId !== "string" || !widgetId) throw new Error("Unity 运行状态缺少组件标识");
  return widgetId;
}

function runtimeDocument() {
  return `<!doctype html><html><body><main>Unity Bridge browser fixture</main><script>
    const send = (message) => parent.postMessage({ source: "unity-webgl", version: 1, ...message }, "*");
    let skippedAction = false;
    setTimeout(() => {
      send({ type: "capabilities", capabilities: ["ack", "heartbeat", "actions", "unknown"] });
      send({ type: "ready" });
    }, 80);
    addEventListener("message", (event) => {
      const message = event.data;
      if (!message || message.source !== "bim-studio" || message.version !== 1) return;
      if (message.type === "action" && !skippedAction) {
        skippedAction = true;
        setTimeout(() => send({ type: "health", fps: 60, scene: "Factory-Recovered" }), 4700);
        return;
      }
      send({ type: "ack", messageId: message.messageId, messageType: message.type });
    });
  <\/script></body></html>`;
}
