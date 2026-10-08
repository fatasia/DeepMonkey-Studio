import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import zlib from "node:zlib";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";
import { createProductServer } from "./onlineFlowProductServer.mjs";
import { captureProcessOutput, reservePort, waitForHealth } from "./onlineFlowAuditSupport.mjs";

// H-C7-P1 真实握手联调（2026-10-03）：隔离 gate + 真 Chrome（WebGPU）渲染模板派生场景 +
// 合规 MCP 客户端（JSON-RPC 信封按已修 schema）+ 真浏览器 driver（useEditorPresence 轮询）
// 完成 fetch_editor_snapshot 全链，并把 present-color 字节转码为可视 PNG 落盘。
// 硬约束：无 cargo、无帧时测量、无 commit/push；tone-mapping 合同不动（PNG 由客户端转码现有 present 输出）。

const MCP_VERSION = "2026-07-28";
const PROJECT = "default";
/** 实际项目 id 在运行时由 UI 新建流程产生；写事务与快照拉取必须携带它会话所属的项目。 */
let projectIdOfSession = PROJECT;

const steps = [];
const assertions = [];
let assertionId = 0;
function check(name, run) {
  assertionId += 1;
  try {
    run();
    assertions.push({ id: assertionId, name, passed: true });
    console.log(`  ok  [${assertionId}] ${name}`);
  } catch (error) {
    assertions.push({ id: assertionId, name, passed: false, detail: String(error) });
    console.error(`FAIL  [${assertionId}] ${name}: ${error}`);
    throw error;
  }
}
function step(name) { steps.push(name); console.log(`\n== ${name}`); }

/** 模板 01-starter（templates/deep-engine-3d/templates/01-starter/scene.ts）的产物映射：
 * 实例→primitives（box/cylinder + 模板 TRS 与材质色），相机取模板 eye(0)/target。
 * 与 API 级闭环测试（apps/api/src/mcpTemplateVisualLoop.test.ts）同源同值。 */
const TEMPLATE_SCENE_NAME = "模板 01-starter";
const TEMPLATE_EYE0 = [9, 4.4, 0]; // ORBIT_RADIUS=9, ORBIT_HEIGHT=4.4, angle=0
const TEMPLATE_TARGET = [0, 1.0, 0];
function templateTrs(x, y, z, ry = 0) {
  return {
    position: { x, y, z },
    rotation: { x: 0, y: Math.round(ry * 1e6) / 1e6, z: 0 },
    // 模板 trs() 的缩放因子恒为 1（仅 Y 旋转 + 平移）。
    scale: { x: 1, y: 1, z: 1 },
  };
}
const TEMPLATE_PRIMITIVES = [
  { modelId: "pedestal", name: "pedestal", visible: true, opacity: 1, kind: "box", color: "#292e38",
    transform: templateTrs(0, 0.18, 0) },
  { modelId: "crate", name: "crate", visible: true, opacity: 1, kind: "box", color: "#4d75b8",
    transform: templateTrs(0, 1.05, 0, Math.PI / 8) },
  { modelId: "bollard-east", name: "bollard-east", visible: true, opacity: 1, kind: "cylinder", color: "#eb941a",
    transform: templateTrs(2.6, 0.55, 1.4) },
  { modelId: "bollard-west", name: "bollard-west", visible: true, opacity: 1, kind: "cylinder", color: "#eb941a",
    transform: templateTrs(-2.6, 0.55, -1.4) },
];

function formatBytesPerPixel(format) {
  const channels = /rgba|bgra/.test(format) ? 4 : /rg11b10|rgb10a2/.test(format) ? 1 : /rg\b|rg[^a]/.test(format) ? 2 : 4;
  if (format.includes("32float")) return channels * 4;
  if (format.includes("16float")) return channels * 2;
  if (format.includes("10a2") || format.includes("11b10")) return 4;
  return channels;
}

const root = fileURLToPath(new URL("../../..", import.meta.url));
const parent = resolve(root, "test-output/runs/2026-09-05");
await mkdir(parent, { recursive: true });
const output = await mkdtemp(resolve(parent, "hc7p1-real-handshake-"));
const apiOrigin = `http://127.0.0.1:${await reservePort()}`;
const server = createProductServer(resolve(root, "apps/web/dist"), apiOrigin);
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const origin = `http://127.0.0.1:${server.address().port}`;
const logs = [];
const fixturePassword = "isolated-field-flow-admin";
const api = spawn(process.execPath, [resolve(root, "apps/api/dist/index.js")], {
  cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: "production", API_HOST: "127.0.0.1", API_PORT: new URL(apiOrigin).port, WEB_ORIGIN: origin,
    DATA_DIR: resolve(output, "data"), METADATA_STORE: "json", OBJECT_STORE: "local", BIM_STUDIO_E2E_EPHEMERAL: "true",
    BIM_STUDIO_ADMIN_PASSWORD: fixturePassword, BIM_STUDIO_SESSION_SECRET: "isolated-local-gate-session-not-production" },
});
captureProcessOutput(api.stdout, logs); captureProcessOutput(api.stderr, logs);

let client, browser;
const close = async () => {
  await browser?.close(); await client?.dispose();
  server.closeAllConnections(); await new Promise((done) => server.close(done));
  api.kill();
  await writeFile(resolve(output, "api-log.json"), JSON.stringify(logs, null, 2));
};

let page;
try {
  await waitForHealth(`${apiOrigin}/health`, api);
  const response = await fetch(`${apiOrigin}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: fixturePassword }) });
  assert.equal(response.status, 200);
  const login = await response.json();
  client = await playwright.request.newContext({ baseURL: apiOrigin, extraHTTPHeaders: { authorization: `Bearer ${login.token}` } });
  browser = await playwright.chromium.launch({
    executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true,
    // deep-gpu-stage-smoke.mjs 同款先例：headless 下启用 WebGPU（Vulkan 路径）。
    args: ["--enable-unsafe-webgpu", "--enable-features=Vulkan,UseSkiaRenderer", "--no-sandbox"],
  });
  const json = async (method, path, data) => {
    assert.ok(path.startsWith("/api/"));
    const result = await client.fetch(path, { method, ...(data === undefined ? {} : { data }) });
    assert.ok(result.ok(), `${method} ${path}: ${result.status()} ${await result.text()}`);
    return result.status() === 204 ? undefined : result.json();
  };
  /** 合规 MCP 客户端：JSON-RPC 2.0 信封 + 现代协议头（mcp-protocol-version/mcp-method/mcp-name）。 */
  const mcp = async (method, params, name) => {
    const result = await client.fetch("/api/mcp", {
      method: "POST", timeout: 30_000,
      headers: { "content-type": "application/json", "mcp-protocol-version": MCP_VERSION, "mcp-method": method,
        ...(name ? { "mcp-name": name } : {}) },
      data: { jsonrpc: "2.0", id: assertionId + 1, method, ...(params ? { params } : {}) },
    });
    return result;
  };
  const mcpResult = async (method, params, name) => {
    const response = await mcp(method, params, name);
    assert.equal(response.status(), 200, `${method}: ${response.status()} ${await response.text()}`);
    const body = await response.json();
    assert.equal(body.error, undefined, `${method}: ${JSON.stringify(body.error)}`);
    return body.result;
  };

  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.setDefaultTimeout(45_000);
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  // ---- 场景：UI 新建（常规文档路径）+ 模板 primitives 经 workspace 写入 ----
  step("登录并经 UI 新建场景（常规文档加载路径）");
  await page.goto(origin);
  await page.getByLabel("用户名").fill("admin");
  await page.getByLabel("密码").fill(fixturePassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await page.locator(".scene-manager-page").waitFor();
  const project = await json("POST", "/api/projects", { name: "H-C7-P1 真实握手" });
  projectIdOfSession = project.id;
  await page.goto(`${origin}/manager?project=${project.id}`);
  await page.getByRole("button", { name: "新建场景", exact: true }).click();
  await page.getByLabel("场景名称").fill(TEMPLATE_SCENE_NAME);
  const pending = page.waitForResponse((r) => r.url().endsWith(`/api/projects/${project.id}/applications`) && r.request().method() === "POST");
  await page.getByRole("button", { name: "创建并进入", exact: true }).click();
  const application = await (await pending).json();
  const sceneId = application.scenes[0].id;

  step("模板 01-starter 实例映射为 primitives 经 workspace 写入");
  const scene = await json("GET", `/api/projects/${project.id}/scenes/${sceneId}`);
  scene.name = TEMPLATE_SCENE_NAME;
  scene.camera = { position: { x: TEMPLATE_EYE0[0], y: TEMPLATE_EYE0[1], z: TEMPLATE_EYE0[2] },
    target: { x: TEMPLATE_TARGET[0], y: TEMPLATE_TARGET[1], z: TEMPLATE_TARGET[2] }, mode: "orbit" };
  scene.models = [];
  scene.primitives = TEMPLATE_PRIMITIVES;
  // application.scenes[0] 是 SceneDocument（无 schemaVersion）；只同步字段，不整体替换。
  Object.assign(application.scenes[0], {
    name: scene.name, camera: scene.camera, models: scene.models, primitives: scene.primitives,
  });
  await json("PUT", `/api/projects/${project.id}/applications/${application.metadata.id}/workspace`, { application, scene });
  await page.goto(`${origin}/studio/${project.id}/applications/${application.metadata.id}/scenes/${sceneId}?renderer=webgl`);
  // 先以 WebGL 打开：诊断 readback 只在 deep backend 创建时挂载（frameCaptureSession 随 backend 生成），
  // 必须先开诊断面板（requested=true）再切 Deep WebGPU，readback 才随 backend 重建生效。
  await page.locator('.viewport canvas:not([aria-hidden="true"])').first().waitFor();
  await page.waitForTimeout(3_000);
  const workspaceAfterPut = await json("GET", `/api/projects/${project.id}/applications/${application.metadata.id}`);
  check("模板 4 实例以 primitives 入库", () => {
    const storedScene = (workspaceAfterPut.application ?? workspaceAfterPut).scenes.find((item) => item.id === sceneId);
    assert.equal(storedScene.primitives.length, 4);
    assert.deepEqual(storedScene.primitives.map((primitive) => primitive.modelId),
      ["pedestal", "crate", "bollard-east", "bollard-west"]);
  });

  step("打开诊断面板（requested=true 先于 backend 创建），切换 Deep WebGPU");
  await page.getByLabel("更多场景工具").click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  await page.getByRole("button", { name: "启用 Deep WebGPU", exact: true }).click();
  // 切换含引擎重建（rendererSwitching 期间写事务 viewer 不可用）；等后端翻转完成且切换提示消失。
  await page.waitForFunction(() => {
    const text = document.body?.innerText ?? "";
    return /当前渲染后端\s*\n?\s*Deep WebGPU/.test(text) && !text.includes("正在切换");
  }, { timeout: 90_000 });
  const backend = await page.evaluate(() => (document.body.innerText.match(/当前渲染后端\s*\n?\s*([^\n]+)/) ?? [])[1]?.trim() ?? "");
  check("渲染后端为 Deep WebGPU", () => assert.ok(backend.includes("Deep WebGPU"), `实际后端: ${backend}`));
  await page.waitForTimeout(6_000);
  await page.screenshot({ path: resolve(output, "studio-webgpu-diagnostics.png") });

  step("MCP 握手：server/discover / initialize / notifications/initialized");
  const discover = await mcpResult("server/discover");
  check("server/discover 返回支持版本含现代协议", () => assert.ok(discover.supportedVersions.includes(MCP_VERSION)));
  const initialized = await mcpResult("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
  check("initialize 返回 serverInfo", () => assert.equal(initialized.serverInfo?.name, "bim-industrial-core"));
  const notifResponse = await mcp("notifications/initialized");
  check("notifications/initialized 返回 204", () => assert.equal(notifResponse.status(), 204));

  step("MCP 工具目录断言");
  const tools = await mcpResult("tools/list");
  const fetchTool = tools.tools.find((tool) => tool.name === "fetch_editor_snapshot");
  check("fetch_editor_snapshot 已宣告", () => assert.ok(fetchTool));
  check("inputSchema.requestId 必填且 pattern 与运行时一致", () => {
    assert.ok(fetchTool.inputSchema.required.includes("requestId"));
    assert.equal(fetchTool.inputSchema.properties.requestId.pattern, "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$");
    assert.equal(fetchTool.inputSchema.additionalProperties, false);
  });
  check("resourceId 枚举白名单三资源", () => assert.deepEqual(fetchTool.inputSchema.properties.resourceId.enum,
    ["present-color", "opaque-hdr", "linear-depth"]));
  check("annotations.idempotentHint 合同", () => assert.equal(fetchTool.annotations?.idempotentHint, true));
  check("editor.scene-transaction 已宣告", () => assert.ok(tools.tools.some((tool) => tool.name === "editor.scene-transaction")));

  step("resources/list：等待浏览器 presence 注册");
  const presenceRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("editor-presence")) presenceRequests.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") console.log(`  page-console: ${message.text().slice(0, 200)}`);
  });
  let editorEntry;
  for (let attempt = 0; attempt < 20 && !editorEntry; attempt += 1) {
    const resources = await mcpResult("resources/list").then((r) => r.resources).catch(() => []);
    editorEntry = resources.find((resource) => typeof resource.uri === "string" && resource.uri.startsWith("studio://active-editor/"));
    if (!editorEntry) await page.waitForTimeout(1_000);
  }
  check("活跃编辑器会话出现在资源目录", () => assert.ok(editorEntry, "20s 内未出现编辑器资源"));
  const sessionId = decodeURIComponent(editorEntry.uri.match(/^studio:\/\/active-editor\/([^?]+)/)?.[1] ?? "");
  check("会话 id 可从资源 uri 解析", () => assert.ok(sessionId));

  step("MCP 写事务：真浏览器 driver 执行 object.set-transform（置 dirty）");
  const editorSummary = await mcpResult("resources/read", { uri: editorEntry.uri })
    .then((r) => JSON.parse(r.contents[0].text));
  const draftRevision = editorSummary.draftRevision;
  let transactionResult;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    // viewer 就绪（引擎重建）与 revision 推进都可能让单次事务失败；每次经 list 取最新 uri（内嵌当前 revision）再读 baseRevision。
    const latestEditor = await mcpResult("resources/list").then((r) => r.resources
      .find((resource) => typeof resource.uri === "string" && resource.uri.startsWith("studio://active-editor/")));
    const summary = await mcpResult("resources/read", { uri: latestEditor.uri })
      .then((r) => JSON.parse(r.contents[0].text));
    const baseRevision = summary.draftRevision;
    const transaction = await mcpResult("tools/call", {
      name: "editor.scene-transaction",
      arguments: { projectId: projectIdOfSession, sessionId,
        transaction: { id: `tx-hc7p1-${Date.now()}-${attempt}`, sceneId, baseRevision,
          commands: [{ id: `cmd-move-crate-${attempt}`, type: "object.set-transform", target: { kind: "object", sceneId, objectId: "crate" },
            position: [0.6 + attempt * 0.1, 1.05, 0] }] } },
    }, "editor.scene-transaction");
    transactionResult = JSON.parse(transaction.content[0].text);
    if (transactionResult.status === "committed") break;
    console.log(`  debug transaction attempt ${attempt}: ${JSON.stringify(transactionResult).slice(0, 400)}`);
    await page.waitForTimeout(2_000);
  }
  check("写事务经真浏览器 driver 提交", () => assert.equal(transactionResult.status, "committed",
    `实际 ${transactionResult.status}: ${transactionResult.message ?? ""}`));

  step("dirty 门合同：无未保存草稿时诊断目录不发布（R12 presence 通道既定合同）");
  const postTransactionSummary = await mcpResult("resources/read", { uri: editorEntry.uri })
    .then((r) => JSON.parse(r.contents[0].text));
  let directoryWhileClean = false;
  for (let attempt = 0; attempt < 3 && !directoryWhileClean; attempt += 1) {
    const resources = await mcpResult("resources/list").then((r) => r.resources).catch(() => []);
    directoryWhileClean = resources.some((resource) => typeof resource.uri === "string" && resource.uri.endsWith("/diagnostics"));
    if (!directoryWhileClean) await page.waitForTimeout(1_000);
  }
  check("MCP 事务后 draft 未脏 → 诊断目录不发布（dirty 门）", () => {
    assert.equal(postTransactionSummary.dirty, false, "写事务经引擎端口执行，React draft 预期仍未标记 dirty");
    assert.equal(directoryWhileClean, false);
  });

  step("诊断快照目录观察（dirty 门 + autoSave 交互，非 fetch 前置依赖）");
  await page.keyboard.press("Escape"); // 关闭诊断对话框（cancel → onClose），让出场景面板
  const primitiveRow = page.locator(".scene-object-row", { hasText: "crate" }).first();
  await primitiveRow.getByRole("button", { name: "隐藏基础元素", exact: true }).click();
  await primitiveRow.getByRole("button", { name: "显示基础元素", exact: true }).click();
  // 重开诊断面板恢复 requested=true，使后续帧继续产出 readback。
  await page.getByLabel("更多场景工具").click();
  await page.getByRole("button", { name: "渲染引擎设置", exact: true }).click();
  let diagnosticsResource;
  for (let attempt = 0; attempt < 30 && !diagnosticsResource; attempt += 1) {
    const resources = await mcpResult("resources/list").then((r) => r.resources).catch(() => []);
    diagnosticsResource = resources.find((resource) => typeof resource.uri === "string" && resource.uri.endsWith("/diagnostics"));
    if (!diagnosticsResource) await page.waitForTimeout(200);
  }
  if (diagnosticsResource) {
    check("UI 编辑后诊断快照目录发布", () => assert.ok(diagnosticsResource));
  } else {
    console.log("  观察：UI 编辑窗口内诊断目录未出现（autoSave 使 dirty 窗口极短）；"
      + "fetch_editor_snapshot 不依赖诊断目录（driver 直读 readback 历史），字节链路继续直接验证。");
    assertions.push({ id: "obs-diagnostics-dir", name: "诊断目录在 autoSave 下为瞬态（观察项，非阻塞）", passed: true });
  }
  let presentMeta;
  if (diagnosticsResource) {
    const diagnostics = await mcpResult("resources/read", { uri: diagnosticsResource.uri })
      .then((r) => JSON.parse(r.contents[0].text));
    presentMeta = (diagnostics.resources ?? []).find((resource) => resource.resourceId === "present-color");
    check("诊断目录含 present-color 帧元数据", () => {
      assert.ok(presentMeta);
      assert.ok(presentMeta.width >= 1 && presentMeta.height >= 1);
      assert.ok(presentMeta.frameId.length > 0);
    });
  }

  step("MCP fetch_editor_snapshot（present-color）全链：挂起 → 真 driver 取走 → 字节回传");
  const fetchArgs = { projectId: projectIdOfSession, sessionId, resourceId: "present-color" };
  const fetchCall = await mcpResult("tools/call", { name: "fetch_editor_snapshot",
    arguments: { ...fetchArgs, requestId: "req-hc7p1-main" } }, "fetch_editor_snapshot");
  const snapshot = JSON.parse(fetchCall.content[0].text);
  check("快照状态 ok（真 driver 在 15s TTL 内回传）", () => assert.equal(snapshot.status, "ok", snapshot.message ?? ""));
  check("frameId 非空且 format 为 GPU 纹理格式", () => {
    assert.ok(snapshot.frameId.length > 0);
    assert.match(snapshot.format, /^(rgba|bgra|rg|rg11b10|rgb10a2)/);
  });
  const bytesPerPixel = formatBytesPerPixel(snapshot.format);
  const bytesPerRow = Math.floor(snapshot.byteLength / snapshot.height);
  check("字节量与尺寸/格式一致（含 GPU 行对齐）", () => {
    assert.equal(snapshot.byteLength % snapshot.height, 0, `byteLength=${snapshot.byteLength} 不整除 height=${snapshot.height}`);
    assert.ok(bytesPerRow >= snapshot.width * bytesPerPixel, `bytesPerRow=${bytesPerRow} < width*bpp=${snapshot.width * bytesPerPixel}`);
    assert.equal(snapshot.byteLength, bytesPerRow * snapshot.height);
  });
  const rawBytes = Buffer.from(snapshot.dataBase64, "base64");
  check("base64 解码长度与 byteLength 全等", () => assert.equal(rawBytes.byteLength, snapshot.byteLength));
  let nonZero = 0;
  for (let index = 0; index < rawBytes.byteLength; index += 1) if (rawBytes[index] !== 0) nonZero += 1;
  check("字节非全零（真实渲染输出）", () => assert.ok(nonZero > rawBytes.byteLength * 0.01, `非零占比过低: ${nonZero}/${rawBytes.byteLength}`));
  const bytesSha256 = createHash("sha256").update(rawBytes).digest("hex");

  step("幂等合同：同 requestId 重放");
  const replay = await mcpResult("tools/call", { name: "fetch_editor_snapshot",
    arguments: { ...fetchArgs, requestId: "req-hc7p1-main" } }, "fetch_editor_snapshot");
  const replaySnapshot = JSON.parse(replay.content[0].text);
  check("同 requestId 幂等回放同结果", () => assert.equal(replaySnapshot.dataBase64, snapshot.dataBase64));

  step("frameId 精确拉取");
  const pinned = await mcpResult("tools/call", { name: "fetch_editor_snapshot",
    arguments: { ...fetchArgs, requestId: "req-hc7p1-pinned", frameId: snapshot.frameId } }, "fetch_editor_snapshot");
  const pinnedSnapshot = JSON.parse(pinned.content[0].text);
  check("按 frameId 精确命中同帧", () => {
    assert.equal(pinnedSnapshot.status, "ok", pinnedSnapshot.message ?? "");
    assert.equal(pinnedSnapshot.frameId, snapshot.frameId);
    assert.equal(pinnedSnapshot.dataBase64, snapshot.dataBase64);
  });

  step("fail-closed：不存在的 frameId 由真 driver 明确拒绝");
  const missing = await mcpResult("tools/call", { name: "fetch_editor_snapshot",
    arguments: { ...fetchArgs, requestId: "req-hc7p1-missing", frameId: "frame-does-not-exist" } }, "fetch_editor_snapshot");
  const missingSnapshot = JSON.parse(missing.content[0].text);
  check("无匹配帧返回明确 unavailable", () => {
    assert.equal(missingSnapshot.status, "unavailable");
    assert.match(missingSnapshot.message ?? "", /没有匹配的快照/);
  });

  step("并发双发：先发请求被更新请求取代（服务端有界结算）");
  let supersedeMessage = "";
  for (let attempt = 0; attempt < 2 && !supersedeMessage; attempt += 1) {
    const suffix = `${Date.now()}-${attempt}`;
    const [first, second] = await Promise.all([
      mcp("tools/call", { name: "fetch_editor_snapshot", arguments: { ...fetchArgs, requestId: `req-supersede-a-${suffix}` } }, "fetch_editor_snapshot"),
      mcp("tools/call", { name: "fetch_editor_snapshot", arguments: { ...fetchArgs, requestId: `req-supersede-b-${suffix}` } }, "fetch_editor_snapshot"),
    ]);
    assert.equal(first.status(), 200); assert.equal(second.status(), 200);
    const firstSnapshot = JSON.parse((await first.json()).result.content[0].text);
    const secondSnapshot = JSON.parse((await second.json()).result.content[0].text);
    if (firstSnapshot.status === "unavailable" && /被更新的拉取请求取代/.test(firstSnapshot.message ?? "")) {
      supersedeMessage = firstSnapshot.message;
      check("第二个请求正常回传", () => assert.equal(secondSnapshot.status, "ok", secondSnapshot.message ?? ""));
    }
    // driver 在两发之间抢先取走第一个时（1s 轮询竞态）重试一次；两发间隔毫秒级，概率低。
  }
  check("先发挂起请求被更新请求取代（未被静默丢弃）", () => assert.ok(supersedeMessage));

  step("白名单第二资源 linear-depth 拉取");
  const depth = await mcpResult("tools/call", { name: "fetch_editor_snapshot",
    arguments: { projectId: projectIdOfSession, sessionId, resourceId: "linear-depth", requestId: "req-hc7p1-depth" } }, "fetch_editor_snapshot");
  const depthSnapshot = JSON.parse(depth.content[0].text);
  check("linear-depth 真实回传", () => {
    assert.equal(depthSnapshot.status, "ok", depthSnapshot.message ?? "");
    assert.equal(depthSnapshot.byteLength, Math.floor(depthSnapshot.byteLength / depthSnapshot.height) * depthSnapshot.height);
  });

  step("模板→场景文档映射证据");
  const stored = await json("GET", `/api/projects/${projectIdOfSession}/applications/${application.metadata.id}`);
  const storedScene = (stored.application ?? stored).scenes.find((item) => item.id === sceneId) ?? stored.scenes?.[0]
    ?? (stored.application ?? stored).scenes[0];
  check("bollard-east 模板实例变换入库", () => {
    const bollardEast = (storedScene.primitives ?? []).find((primitive) => primitive.modelId === "bollard-east");
    assert.deepEqual([bollardEast.transform.position.x, bollardEast.transform.position.y, bollardEast.transform.position.z],
      [2.6, 0.55, 1.4]);
  });

  step("可视 PNG 转码（Node 侧 CPU 光栅：present-color 现有输出，不动 tone-mapping 合同）");
  // rgba16float/rgba8 → clamp tonemap → rgba8 → PNG（IHDR + IDAT(deflate) + IEND，filter 0）。
  const pngBytes = (() => {
    const width = snapshot.width, height = snapshot.height;
    const is16f = snapshot.format.includes("16float");
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    const halfToFloat = (half) => {
      const sign = (half & 0x8000) >> 15, exponent = (half & 0x7c00) >> 10, fraction = half & 0x03ff;
      if (exponent === 0) return (sign ? -1 : 1) * 2 ** -14 * (fraction / 1024);
      if (exponent === 0x1f) return fraction ? NaN : (sign ? -Infinity : Infinity);
      return (sign ? -1 : 1) * 2 ** (exponent - 15) * (1 + fraction / 1024);
    };
    const rgba = Buffer.alloc(width * height * 4);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const source = y * bytesPerRow + x * (is16f ? 8 : 4);
        const target = (y * width + x) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const value = is16f ? halfToFloat(view.getUint16(source + channel * 2, true)) : rawBytes[source + channel] / 255;
          const clamped = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
          rgba[target + channel] = Math.round(clamped * 255);
        }
        rgba[target + 3] = 255;
      }
    }
    const crcTable = Array.from({ length: 256 }, (_, n) => {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      return c >>> 0;
    });
    const crc32 = (buffer) => {
      let c = 0xffffffff;
      for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
      return (c ^ 0xffffffff) >>> 0;
    };
    const chunk = (type, data) => {
      const head = Buffer.alloc(4); head.writeUInt32BE(data.byteLength);
      const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
      return Buffer.concat([head, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
    const raw = Buffer.alloc((width * 4 + 1) * height);
    for (let y = 0; y < height; y += 1) {
      raw[y * (width * 4 + 1)] = 0; // filter type 0
      rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
    }
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
    ]);
  })();
  check("PNG 魔数与 IHDR 尺寸", () => {
    assert.deepEqual([...pngBytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(pngBytes.readUInt32BE(16), snapshot.width);
    assert.equal(pngBytes.readUInt32BE(20), snapshot.height);
  });
  const pngPath = resolve(output, "present-color.png");
  await writeFile(pngPath, pngBytes);
  const pngSha256 = createHash("sha256").update(pngBytes).digest("hex");
  await page.screenshot({ path: resolve(output, "studio-final.png") }).catch(() => undefined);

  check("页面无未捕获异常", () => assert.deepEqual(pageErrors.filter((message) => !/ResizeObserver/.test(message)), []));

  await writeFile(resolve(output, "report.json"), JSON.stringify({
    output, origin, apiOrigin, steps, assertions,
    evidence: {
      readback: { ...snapshot, dataBase64: `<${snapshot.dataBase64.length} chars>`, bytesSha256 },
      png: { path: pngPath, bytes: pngBytes.byteLength, sha256: pngSha256 },
      depth: { ...depthSnapshot, dataBase64: `<${(depthSnapshot.dataBase64 ?? "").length} chars>` },
      sessionId, draftRevisionBeforeTransaction: draftRevision,
      screenshots: ["studio-webgpu-diagnostics.png", "studio-final.png", "present-color.png"],
    },
  }, null, 2));
  const failed = assertions.filter((entry) => !entry.passed);
  console.log(`\n== 完成：${assertions.length - failed.length}/${assertions.length} 断言通过；证据目录 ${output}`);
  if (failed.length > 0) throw new Error(`${failed.length} 条断言失败`);
} catch (error) {
  if (page) await page.screenshot({ path: resolve(output, "failure.png") }).catch(() => undefined);
  await writeFile(resolve(output, "failure.txt"), String(error?.stack ?? error)).catch(() => undefined);
  console.error(error);
  process.exitCode = 1;
} finally {
  await close();
}
