import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplicationDocument, SceneSnapshot, SystemUserRecord } from "@bim-studio/contracts";
import { migrateSceneSnapshotV1 } from "@bim-studio/contracts";
import { registerApplicationRoutes } from "./applicationRoutes.js";
import { JsonStore } from "./store.js";
import { createApiServer } from "./serverOptions.js";
import { EditorPresenceRegistry, registerEditorPresenceRoutes } from "./editorPresence.js";
import { EditorSceneTransactionBridge, registerEditorSceneDriverRoutes } from "./mcpEditorSceneTransactionBridge.js";
import { EDITOR_SNAPSHOT_FETCH_TOOL, EditorSnapshotFetchBridge } from "./editorSnapshotFetchBridge.js";
import { registerMcpCapabilityRoute } from "./mcpCapabilityAdapter.js";
// H-C7-P1：模板产物直接作为 MCP 视觉循环输入——01-starter 的 scene.ts 为纯数据构造
//（import 全部 type-only），此处运行时仅消费其场景数据，无 deep-engine 运行时依赖。
import { createScene } from "../../../templates/deep-engine-3d/templates/01-starter/scene.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => Promise.all(cleanups.splice(0).map(cleanup => cleanup())));

const PROJECT = "default";
const SESSION = "session-tpl-1";
const LEASE = "lease-tpl-1";
// migrateSceneSnapshotV1 以 snapshot.id 同时充当应用 ID 与场景 ID（迁移场景同规）。
const SCENE_ID = "template-01-starter";
const APPLICATION_ID = SCENE_ID;
const DRAFT_REVISION = 5;
const MCP_VERSION = "2026-07-28";

const user = {
  id: "editor-1", username: "editor", displayName: "Editor", role: "editor" as const,
  projectIds: [PROJECT], enabled: true, createdAt: "now", updatedAt: "now",
};
const viewerUser = { ...user, id: "viewer-1", username: "viewer", role: "viewer" as const };

/** 模板场景产物：01-starter 的 RenderPacket/相机/实例变换，作为本闭环的唯一场景输入。 */
const template = createScene();
const TEMPLATE_INSTANCE_IDS = template.packet.instances.map(instance => instance.id);

/** 模拟浏览器渲染模板帧后的 readback 字节：rgba16float（8 字节/像素），并把模板实例名
 * 签名写入字节头——字节可复现且源自模板产物，往返一致性可精确断言。 */
const FRAME = { resourceId: "present-color", frameId: "tpl-frame-1", width: 64, height: 48, format: "rgba16float" } as const;
const frameBytes = (() => {
  const bytes = new Uint8Array(FRAME.width * FRAME.height * 8);
  template.packet.instances.forEach((instance, index) => {
    let signature = index + 1;
    for (const character of instance.id) signature = (signature * 31 + character.charCodeAt(0)) >>> 0;
    for (let offset = 0; offset < 8; offset += 1) bytes[index * 8 + offset] = (signature >>> (offset * 4)) & 0xff;
  });
  return bytes;
})();
const frameDataBase64 = Buffer.from(frameBytes).toString("base64");
const framePayload = { status: "ok", ...FRAME, byteLength: frameBytes.byteLength, dataBase64: frameDataBase64 };
const diagnosticsResource = { ...FRAME, byteLength: frameBytes.byteLength };

function vec3(value: readonly number[]) { return { x: value[0]!, y: value[1]!, z: value[2]! }; }

/** 列主序 mat4 → 模型 TRS：位置/缩放取自模板实例变换，构成"模板→studio 场景文档"的映射证据。 */
function templateTransform(matrix: ArrayLike<number>) {
  const columnLength = (offset: number) => Math.hypot(matrix[offset]!, matrix[offset + 1]!, matrix[offset + 2]!);
  return {
    position: { x: matrix[12]!, y: matrix[13]!, z: matrix[14]! },
    rotation: { x: 0, y: 0, z: 0 },
    scale: { x: columnLength(0), y: columnLength(4), z: columnLength(8) },
  };
}

function templateApplicationDocument(): ApplicationDocument {
  const snapshot: SceneSnapshot = {
    schemaVersion: 1,
    id: APPLICATION_ID,
    projectId: PROJECT,
    name: "模板 01-starter",
    camera: { position: vec3(template.eye(0)), target: vec3(template.target), mode: "orbit" },
    models: template.packet.instances.map(instance => ({
      modelId: instance.id,
      // 模板实例是 RenderPacket 生成件，不引用上传资源；assetModelId 留空走镜像侧 modelId 回退。
      name: instance.id,
      visible: true,
      opacity: 1,
      transform: templateTransform(instance.transform),
    })),
    primitives: [],
    measurements: [],
    createdAt: "2026-10-03T08:00:00.000Z",
    updatedAt: "2026-10-03T08:00:00.000Z",
  };
  return migrateSceneSnapshotV1(snapshot);
}

async function harness(options: { maxBase64Chars?: number; pendingTtlMs?: number; actingUser?: SystemUserRecord } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-mcp-tpl-loop-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const store = new JsonStore(directory);
  await store.init();
  const presence = new EditorPresenceRegistry();
  const transactions = new EditorSceneTransactionBridge(presence, store);
  const snapshots = new EditorSnapshotFetchBridge(presence, options);
  const app = createApiServer();
  cleanups.push(() => app.close());
  app.addHook("preHandler", async request => { request.systemUser = options.actingUser ?? user; });
  await registerApplicationRoutes(app, store);
  await registerEditorPresenceRoutes(app, presence);
  await registerEditorSceneDriverRoutes(app, transactions, snapshots);
  await registerMcpCapabilityRoute(app, {
    host: { registry: { listCapabilities: () => [] } } as never, store,
    editorPresence: presence, editorSceneTransactions: transactions, editorSnapshotFetch: snapshots,
  });
  return { app };
}

/** 持久化模板派生应用，并模拟浏览器 driver 打开该场景后发布 presence（含诊断快照镜像）。 */
async function openTemplateScene(app: Awaited<ReturnType<typeof harness>>["app"]) {
  const created = await app.inject({
    method: "POST", url: `/api/projects/${PROJECT}/applications`, payload: templateApplicationDocument(),
  });
  expect(created.statusCode).toBe(201);
  const published = await app.inject({
    method: "PUT", url: `/api/editor-presence/${SESSION}`,
    payload: {
      leaseId: LEASE, projectId: PROJECT, applicationId: APPLICATION_ID, applicationName: "模板 01-starter 应用",
      surface: "scene", targetId: SCENE_ID, targetName: "模板 01-starter",
      persistedRevision: 1, draftRevision: DRAFT_REVISION, dirty: true, selectionCount: 0,
      diagnosticsSnapshot: { sceneId: SCENE_ID, revision: DRAFT_REVISION, capturedAtMs: 1_000, resources: [diagnosticsResource] },
    },
  });
  expect(published.statusCode).toBe(200);
}

function mcpCall(app: Awaited<ReturnType<typeof harness>>["app"], method: string,
  params?: Record<string, unknown>, name?: string) {
  return app.inject({
    method: "POST", url: "/api/mcp",
    headers: { "content-type": "application/json", "mcp-protocol-version": MCP_VERSION,
      "mcp-method": method, ...(name ? { "mcp-name": name } : {}) },
    payload: { jsonrpc: "2.0", id: 7, method, ...(params ? { params } : {}) },
  });
}

function callFetch(app: Awaited<ReturnType<typeof harness>>["app"], requestId: string, sessionId = SESSION) {
  return mcpCall(app, "tools/call", {
    name: EDITOR_SNAPSHOT_FETCH_TOOL,
    arguments: { projectId: PROJECT, sessionId, resourceId: FRAME.resourceId, requestId },
  }, EDITOR_SNAPSHOT_FETCH_TOOL);
}

function fetchResultText(response: Awaited<ReturnType<typeof callFetch>>): string {
  expect(response.statusCode).toBe(200);
  const result = response.json().result as { content: { type: string; text: string }[] };
  return result.content[0]!.text;
}

/** 模拟浏览器 driver：短重试轮询快照请求（无请求 204），取到后按 useEditorPresence 同形回传。 */
async function driveSnapshot(app: Awaited<ReturnType<typeof harness>>["app"], payload: unknown) {
  let next;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 5));
    next = await app.inject({ method: "POST", url: `/api/editor-scene-driver/${SESSION}/snapshot-request`, payload: { leaseId: LEASE } });
    if (next.statusCode === 200) break;
    expect(next.statusCode).toBe(204);
  }
  expect(next!.statusCode).toBe(200);
  const request = next!.json() as { requestId: string; resourceId: string };
  const posted = await app.inject({
    method: "POST", url: `/api/editor-scene-driver/${SESSION}/snapshot-result`,
    payload: { requestId: request.requestId, payload },
  });
  expect(posted.statusCode).toBe(204);
  return request;
}

describe("MCP template visual loop (H-C7-P1)", () => {
  it("opens a template scene, renders, and round-trips readback bytes through fetch_editor_snapshot", async () => {
    const { app } = await harness();
    await openTemplateScene(app);

    // MCP 客户端视角：握手 → 工具目录 → 资源目录 → 场景对象 → 诊断快照目录。
    const discovery = await mcpCall(app, "server/discover");
    expect(discovery.json().result.capabilities.tools).toBeDefined();
    const tools = (await mcpCall(app, "tools/list")).json().result.tools as Array<Record<string, unknown>>;
    const fetchTool = tools.find(tool => tool.name === EDITOR_SNAPSHOT_FETCH_TOOL) as Record<string, unknown>;
    expect(fetchTool).toBeDefined();
    const schema = fetchTool.inputSchema as { required: string[]; properties: Record<string, { pattern?: string; enum?: string[] }> };
    // 修快照标准 MCP 参数：requestId 必填且在 schema 中声明（与运行时合同一致）。
    expect(schema.required).toEqual(expect.arrayContaining(["projectId", "sessionId", "resourceId", "requestId"]));
    expect(schema.properties.requestId!.pattern).toBeDefined();
    expect(schema.properties.resourceId!.enum).toEqual(["present-color", "opaque-hdr", "linear-depth"]);
    expect(fetchTool.annotations).toMatchObject({ idempotentHint: true, readOnlyHint: true });

    const resources = (await mcpCall(app, "resources/list")).json().result.resources as Array<{ uri: string }>;
    const sceneUri = resources.map(resource => resource.uri)
      .find(uri => uri.includes("/scene-context/scene-objects"));
    const diagnosticsUri = resources.map(resource => resource.uri).find(uri => uri.endsWith("/diagnostics"));
    expect(sceneUri).toBeDefined();
    expect(diagnosticsUri).toBeDefined();

    const sceneObjects = JSON.parse((await mcpCall(app, "resources/read", { uri: sceneUri })).json()
      .result.contents[0].text) as { items: { objectId: string }[] };
    expect(sceneObjects.items.map(item => item.objectId).sort()).toEqual([...TEMPLATE_INSTANCE_IDS].sort());
    const diagnostics = JSON.parse((await mcpCall(app, "resources/read", { uri: diagnosticsUri })).json()
      .result.contents[0].text) as { resources: typeof diagnosticsResource[] };
    expect(diagnostics.resources).toEqual([diagnosticsResource]);

    // 模板→studio 文档映射证据：实例位置取自模板 trs 变换。
    const application = (await app.inject({ method: "GET", url: `/api/projects/${PROJECT}/applications/${APPLICATION_ID}` })).json();
    const bollardEast = application.scenes[0].models.find((model: { modelId: string }) => model.modelId === "bollard-east");
    expect(bollardEast.transform.position).toEqual({ x: 2.6, y: 0.55, z: 1.4 });

    // 闭环主体：MCP tools/call 挂起 → driver 轮询取走 → 模板帧字节回传 → 有界结算。
    const pendingCall = callFetch(app, "tpl-req-1");
    const driverRequest = await driveSnapshot(app, framePayload);
    expect(driverRequest).toMatchObject({ requestId: "tpl-req-1", resourceId: FRAME.resourceId });
    const settled = JSON.parse(fetchResultText(await pendingCall)) as Record<string, unknown>;
    expect(settled).toMatchObject({ status: "ok", resourceId: FRAME.resourceId, frameId: FRAME.frameId,
      format: FRAME.format, width: FRAME.width, height: FRAME.height, byteLength: frameBytes.byteLength });
    expect(settled.dataBase64).toBe(frameDataBase64);

    // 幂等合同：同 requestId 在完成缓存 TTL 内重放同结果，driver 无需再次回传。
    const replay = JSON.parse(fetchResultText(await callFetch(app, "tpl-req-1")));
    expect(replay).toEqual(settled);

    // 未开会话 fail-closed。
    const missing = JSON.parse(fetchResultText(await callFetch(app, "tpl-req-x", "session-unknown")));
    expect(missing).toMatchObject({ status: "unavailable", message: "活跃编辑器会话不存在、已过期或不在场景编辑面" });
  });

  it("fails closed when the driver payload exceeds the byte budget", async () => {
    const { app } = await harness({ maxBase64Chars: 64 });
    await openTemplateScene(app);
    const pendingCall = callFetch(app, "tpl-req-over");
    await driveSnapshot(app, { ...framePayload, dataBase64: "x".repeat(65) });
    await expect(pendingCall.then(response => JSON.parse(fetchResultText(response))))
      .resolves.toMatchObject({ status: "unavailable", message: "回传载荷不合法或超出预算" });
  });

  it("settles a stalled fetch within the pending TTL and recovers on a fresh request", async () => {
    const { app } = await harness({ pendingTtlMs: 25 });
    await openTemplateScene(app);
    // driver 死亡（不轮询）：挂起的 MCP 调用必须有界结算，而不是悬挂到 HTTP 超时（同族缺陷修复验证）。
    const stalled = JSON.parse(fetchResultText(await callFetch(app, "tpl-req-slow")));
    expect(stalled).toMatchObject({ status: "unavailable", message: "拉取等待超时" });
    // 超时后 pending 已清理：driver 轮询 204；同 requestId 幂等回放超时结果。
    const drained = await app.inject({ method: "POST", url: `/api/editor-scene-driver/${SESSION}/snapshot-request`, payload: { leaseId: LEASE } });
    expect(drained.statusCode).toBe(204);
    const replayed = JSON.parse(fetchResultText(await callFetch(app, "tpl-req-slow")));
    expect(replayed).toEqual(stalled);
    // driver 恢复：新 requestId 重新走完整循环并成功。
    const retry = callFetch(app, "tpl-req-retry");
    await driveSnapshot(app, framePayload);
    await expect(retry.then(response => JSON.parse(fetchResultText(response))))
      .resolves.toMatchObject({ status: "ok", dataBase64: frameDataBase64 });
  });

  it("denies viewer role through the MCP route path", async () => {
    const { app } = await harness({ actingUser: viewerUser });
    await openTemplateScene(app);
    const denied = JSON.parse(fetchResultText(await callFetch(app, "tpl-req-viewer")));
    expect(denied).toMatchObject({ status: "unavailable", message: "viewer 角色无诊断快照读取权限" });
  });
});
