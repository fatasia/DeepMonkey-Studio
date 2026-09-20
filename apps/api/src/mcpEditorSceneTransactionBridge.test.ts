import { afterEach, describe, expect, it } from "vitest";
import { EditorPresenceRegistry } from "./editorPresence.js";
import { registerMcpCapabilityRoute } from "./mcpCapabilityAdapter.js";
import { EDITOR_SCENE_TRANSACTION_TOOL, EditorSceneTransactionBridge, registerEditorSceneDriverRoutes } from "./mcpEditorSceneTransactionBridge.js";
import { createApiServer } from "./serverOptions.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map(cleanup => cleanup())));

const user = {
  id: "editor-1", username: "editor", displayName: "Editor", role: "editor" as const,
  projectIds: ["project-1"], enabled: true, createdAt: "now", updatedAt: "now",
};
const viewerUser = { ...user, id: "viewer-1", username: "viewer", role: "viewer" as const };
const transaction = {
  id: "tx-mcp-1", sceneId: "scene-1", baseRevision: 11,
  commands: [{ id: "cmd-1", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "pump" }, visible: false }],
};

function createServer(options: { pendingTtlMs?: number } = {}) {
  const store = { getApplication: () => undefined, getProject: () => ({ id: "project-1" }) } as never;
  const presence = new EditorPresenceRegistry();
  presence.upsert("session-1", user, {
    leaseId: "lease-1", projectId: "project-1", applicationId: "app-1", applicationName: "Plant",
    surface: "scene", targetId: "scene-1", targetName: "Line", persistedRevision: 7,
    draftRevision: 11, dirty: true, selectionCount: 1,
  });
  const bridge = new EditorSceneTransactionBridge(presence, store, { pendingTtlMs: options.pendingTtlMs ?? 5_000 });
  const app = createApiServer();
  cleanups.push(() => app.close());
  app.addHook("preHandler", async request => { request.systemUser = user; });
  void registerEditorSceneDriverRoutes(app, bridge);
  void registerMcpCapabilityRoute(app, {
    host: { registry: { listCapabilities: () => [] } } as never, store, editorPresence: presence, editorSceneTransactions: bridge,
  });
  return { app, presence, bridge };
}

async function driveBrowser(app: Awaited<ReturnType<typeof createApiServer>>, result: unknown, leaseId = "lease-1") {
  // MCP handler 与轮询是并发的两条 inject；light-my-request 的分派是异步的，这里短重试等 pending 出现。
  let next;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    next = await app.inject({ method: "POST", url: "/api/editor-scene-driver/session-1/next", payload: { leaseId } });
    if (next.statusCode === 200) break;
    expect(next.statusCode).toBe(204);
  }
  expect(next!.statusCode).toBe(200);
  const request = next!.json();
  const completed = await app.inject({
    method: "POST", url: "/api/editor-scene-driver/session-1/result",
    payload: { leaseId, requestId: request.requestId, result },
  });
  expect(completed.statusCode).toBe(204);
  return request;
}

describe("MCP editor scene transaction bridge", () => {
  it("lists the transaction tool, executes committed receipts through the browser driver, and replays by transaction id", async () => {
    const { app } = createServer();
    const listed = await app.inject({ method: "POST", url: "/api/mcp", payload: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect(listed.json().result.tools.some((tool: { name: string }) => tool.name === EDITOR_SCENE_TRANSACTION_TOOL)).toBe(true);

    const call = app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: EDITOR_SCENE_TRANSACTION_TOOL, arguments: {
        projectId: "project-1", sessionId: "session-1", transaction,
      } } },
    });
    const request = await driveBrowser(app, {
      status: "committed",
      receipt: { schemaVersion: 1, id: transaction.id, sceneId: "scene-1", moduleId: "mcp-editor-bridge", baseRevision: 11, finalRevision: 12, commandIds: ["cmd-1"], diff: [], results: [], status: "committed" },
    });
    expect(request.transaction.module).toMatchObject({ id: "mcp-editor-bridge", permissions: ["scene.read", "scene.write"] });
    expect(request.transaction.baseRevision).toBe(11);

    const response = await call;
    expect(response.json().result.isError).toBe(false);
    expect(response.json().result.structuredContent).toMatchObject({ status: "committed" });

    const replay = await app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: EDITOR_SCENE_TRANSACTION_TOOL, arguments: {
        projectId: "project-1", sessionId: "session-1", transaction,
      } } },
    });
    expect(replay.json().result.structuredContent).toMatchObject({ status: "committed" });
    const drained = await app.inject({ method: "POST", url: "/api/editor-scene-driver/session-1/next", payload: { leaseId: "lease-1" } });
    expect(drained.statusCode).toBe(204);
  });

  it("passes prepare rejections and rolled-back receipts through as tool errors", async () => {
    const { app } = createServer();
    const call = app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: EDITOR_SCENE_TRANSACTION_TOOL, arguments: {
        projectId: "project-1", sessionId: "session-1",
        transaction: { ...transaction, id: "tx-rejected-1", commands: [{ id: "cmd-bad", type: "object.nope" }] },
      } } },
    });
    await driveBrowser(app, { status: "rejected", issues: [{ index: 0, reason: "parse-error", message: "type: unknown command type" }] });
    const response = await call;
    expect(response.json().result.isError).toBe(true);
    expect(response.json().result.structuredContent).toMatchObject({ status: "rejected" });

    const call2 = app.inject({
      method: "POST", url: "/api/mcp",
      payload: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: EDITOR_SCENE_TRANSACTION_TOOL, arguments: {
        projectId: "project-1", sessionId: "session-1",
        transaction: { ...transaction, id: "tx-rollback-1", commands: [{ id: "cmd-2", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "pump" }, visible: false }] },
      } } },
    });
    await driveBrowser(app, {
      status: "rolled-back",
      receipt: { id: "tx-rollback-1", sceneId: "scene-1", baseRevision: 11, finalRevision: 11, commandIds: ["cmd-2"], diff: [], results: [], status: "rolled-back" },
      issue: { index: -1, reason: "driver-error", message: "Scene transaction command failed." },
    });
    const rolledBack = await call2;
    expect(rolledBack.json().result.isError).toBe(true);
    expect(rolledBack.json().result.structuredContent).toMatchObject({ status: "rolled-back" });
  });

  it("fail-closed: wrong lease invalidates the pending transaction and timeouts are bounded", async () => {
    const { app, bridge } = createServer({ pendingTtlMs: 40 });
    const submit = bridge.submit(user, "session-1", "project-1", transaction);
    const wrongLease = await app.inject({ method: "POST", url: "/api/editor-scene-driver/session-1/next", payload: { leaseId: "lease-rogue" } });
    expect(wrongLease.statusCode).toBe(204);
    expect(await submit).toMatchObject({ status: "unavailable" });
    const drained = await app.inject({ method: "POST", url: "/api/editor-scene-driver/session-1/next", payload: { leaseId: "lease-1" } });
    expect(drained.statusCode).toBe(204);

    const timeoutOutcome = await bridge.submit(user, "session-1", "project-1", { ...transaction, id: "tx-timeout-1" });
    expect(timeoutOutcome).toMatchObject({ status: "timeout" });
  });

  it("gates concurrency, viewer role, and foreign scenes before the browser is involved", async () => {
    const { app, bridge, presence } = createServer();
    const first = bridge.submit(user, "session-1", "project-1", transaction);
    await expect(bridge.submit(user, "session-1", "project-1", { ...transaction, id: "tx-busy-1" })).resolves.toMatchObject({ status: "busy" });
    await expect(bridge.submit(user, "session-1", "project-1", { ...transaction, id: "tx-scene-9", sceneId: "scene-9" })).resolves.toMatchObject({ status: "unavailable" });
    await expect(bridge.submit(viewerUser, "session-1", "project-1", { ...transaction, id: "tx-viewer-1" })).resolves.toMatchObject({ status: "unavailable" });

    presence.upsert("session-2", user, {
      leaseId: "lease-2", projectId: "project-1", applicationId: "app-1", applicationName: "Plant",
      surface: "dashboard", targetId: "page-1", targetName: "Page", persistedRevision: 7,
      draftRevision: 2, dirty: false, selectionCount: 0,
    });
    await expect(bridge.submit(user, "session-2", "project-1", { ...transaction, id: "tx-dash-1" })).resolves.toMatchObject({ status: "unavailable" });

    await driveBrowser(app, { status: "committed", receipt: { id: transaction.id, sceneId: "scene-1", finalRevision: 12 } });
    expect(await first).toMatchObject({ status: "committed" });
  });
});
