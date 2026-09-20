import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CapabilityDescriptor, CapabilityRequest } from "@bim-studio/plugin-runtime";
import type { IndustrialCapabilityHost } from "./industrialCapabilities.js";
import type { MetadataStore } from "./store.js";
import type { EditorPresence, EditorPresenceRegistry } from "./editorPresence.js";
import { listEditorSceneResources, parseEditorSceneResourceUri, readEditorSceneResource,
  listEditorDiagnosticsResources, readEditorDiagnosticsResource } from "./mcpEditorSceneResources.js";
import { EDITOR_SCENE_TRANSACTION_TOOL, callEditorSceneTransactionTool, editorTransactionToolDefinition, type EditorSceneTransactionBridge } from "./mcpEditorSceneTransactionBridge.js";

const MODERN_VERSION = "2026-07-28";
const SUPPORTED_VERSIONS = [MODERN_VERSION, "2025-11-25", "2025-06-18"] as const;

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface McpDependencies { host: IndustrialCapabilityHost; store: MetadataStore; editorPresence?: EditorPresenceRegistry; editorSceneTransactions?: EditorSceneTransactionBridge }

/**
 * 无状态 MCP 适配层。登录身份、项目权限、超时和证据全部复用宿主治理，
 * 客户端不能通过 arguments 自报 principal 或绕过 Capability Registry。
 */
export async function registerMcpCapabilityRoute(app: FastifyInstance, dependencies: McpDependencies): Promise<void> {
  app.post<{ Body: JsonRpcRequest }>("/api/mcp", async (request, reply) => {
    const body = request.body ?? {};
    const id = body.id ?? null;
    const protocolIssue = validateProtocol(request, body);
    if (protocolIssue) return reply.code(400).send(rpcError(id, -32600, protocolIssue));
    const modern = request.headers["mcp-protocol-version"] === MODERN_VERSION;

    if (body.method === "server/discover") return rpcResult(id, {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: { listChanged: false }, ...(dependencies.editorPresence ? { resources: { subscribe: false, listChanged: false } } : {}) },
      instructions: "工具按当前登录用户与项目权限过滤；能力目录不是执行证据，调用结果包含决策状态、trace 和证据。",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "bim-industrial-core", version: "1.1.0" } },
      ttlMs: 0,
      cacheScope: "private",
      resultType: "complete"
    });
    // 保留旧客户端握手兼容；现代 2026 协议不需要 initialize。
    if (body.method === "initialize") return rpcResult(id, {
      protocolVersion: legacyProtocol(body.params),
      capabilities: { tools: { listChanged: false }, ...(dependencies.editorPresence ? { resources: { subscribe: false, listChanged: false } } : {}) },
      serverInfo: { name: "bim-industrial-core", version: "1.1.0" }
    });
    if (body.method === "notifications/initialized") return reply.code(204).send();
    if (body.method === "tools/list") {
      const tools: Array<Record<string, unknown>> = toolDefinitions(dependencies.host, request);
      if (dependencies.editorSceneTransactions) tools.push(editorTransactionToolDefinition());
      return rpcResult(id, {
        tools,
        ...(modern ? { ttlMs: 0, cacheScope: "private", resultType: "complete" } : {})
      });
    }
    if (body.method === "resources/list") return listEditorResources(body.params, dependencies, request, id, reply);
    if (body.method === "resources/read") return readEditorResource(body.params, dependencies, request, id, reply);
    if (body.method === "tools/call" && body.params?.name === EDITOR_SCENE_TRANSACTION_TOOL && dependencies.editorSceneTransactions) {
      return callEditorSceneTransactionTool(body.params, dependencies.editorSceneTransactions, request, id, reply, modern);
    }
    if (body.method === "tools/call") return callTool(body.params, dependencies, request, id, reply, modern);
    return reply.code(400).send(rpcError(id, -32601, `未知 MCP 方法：${body.method ?? ""}`));
  });
}

function listEditorResources(params: Record<string, unknown> | undefined, dependencies: McpDependencies,
  request: FastifyRequest, id: string | number | null, reply: FastifyReply) {
  const user = request.systemUser;
  if (!user) return reply.code(401).send(rpcError(id, -32001, "请先登录"));
  const offset = resourceCursor(params?.cursor);
  if (offset === undefined) return reply.code(400).send(rpcError(id, -32602, "resources/list cursor 无效"));
  const entries = dependencies.editorPresence?.listFor(user) ?? [];
  const resources = entries.flatMap(entry => [editorResource(entry), ...listEditorSceneResources(entry, dependencies.store),
    ...listEditorDiagnosticsResources(entry)]);
  const page = resources.slice(offset, offset + 20);
  return rpcResult(id, {
    resources: page,
    ...(offset + page.length < resources.length ? { nextCursor: String(offset + page.length) } : {}),
  });
}

function readEditorResource(params: Record<string, unknown> | undefined, dependencies: McpDependencies,
  request: FastifyRequest, id: string | number | null, reply: FastifyReply) {
  const user = request.systemUser;
  if (!user) return reply.code(401).send(rpcError(id, -32001, "请先登录"));
  const sceneAddress = parseEditorSceneResourceUri(params?.uri);
  if (sceneAddress) {
    const entry = dependencies.editorPresence?.readFor(user, sceneAddress.sessionId, sceneAddress.draftRevision);
    const content = entry && readEditorSceneResource(sceneAddress, entry, dependencies.store);
    if (!content) return reply.code(404).send(rpcError(id, -32004, "场景资源不存在、已过期或 editor/persisted revision 已变化"));
    return rpcResult(id, { contents: [content] });
  }
  const diagnosticsUri = typeof params?.uri === "string" && params.uri.endsWith("/diagnostics") ? params.uri : undefined;
  if (diagnosticsUri) {
    const sessionId = diagnosticsUri.match(/editor:\/\/session\/([^/]+)\//)?.[1];
    const entry = sessionId ? dependencies.editorPresence?.readFor(user, sessionId, Number(diagnosticsUri.match(/rev\/(-?\d+)\//)?.[1])) : undefined;
    const content = entry && readEditorDiagnosticsResource(entry);
    if (!content) return reply.code(404).send(rpcError(id, -32004, "诊断快照目录不存在、已过期或 editor revision 已变化"));
    return rpcResult(id, { contents: [content] });
  }
  const parsed = parseEditorResourceUri(params?.uri);
  if (!parsed) return reply.code(400).send(rpcError(id, -32602, "resources/read uri 无效"));
  const entry = dependencies.editorPresence?.readFor(user, parsed.sessionId, parsed.draftRevision);
  if (!entry) return reply.code(404).send(rpcError(id, -32004, "活跃编辑器会话不存在、已过期或 revision 已变化"));
  const resource = editorResource(entry);
  return rpcResult(id, { contents: [{ uri: resource.uri, mimeType: resource.mimeType, text: JSON.stringify(editorSummary(entry)) }] });
}

function editorResource(entry: EditorPresence) {
  const target = entry.targetName ? ` · ${entry.targetName}` : "";
  return {
    uri: editorResourceUri(entry), name: `editor-${entry.sessionId}`,
    title: `${entry.applicationName}${target}`,
    description: `当前用户的活跃 ${entry.surface} 编辑器；草稿 revision ${entry.draftRevision}${entry.dirty ? "，有未保存修改" : ""}`,
    mimeType: "application/json",
  };
}

function editorSummary(entry: EditorPresence) {
  return {
    schema: "deep-monkey.active-editor.v1", sessionId: entry.sessionId, projectId: entry.projectId,
    applicationId: entry.applicationId, applicationName: entry.applicationName, surface: entry.surface,
    ...(entry.targetId ? { targetId: entry.targetId } : {}), ...(entry.targetName ? { targetName: entry.targetName } : {}),
    persistedRevision: entry.persistedRevision, draftRevision: entry.draftRevision, dirty: entry.dirty,
    selectionCount: entry.selectionCount, updatedAt: entry.updatedAt,
    writeSemantics: "Use the existing governed SceneCommandTransaction path; this resource is read-only.",
  };
}

function editorResourceUri(entry: Pick<EditorPresence, "sessionId" | "draftRevision">): string {
  return `studio://active-editor/${encodeURIComponent(entry.sessionId)}?revision=${entry.draftRevision}`;
}
function parseEditorResourceUri(value: unknown): { sessionId: string; draftRevision: number } | undefined {
  if (typeof value !== "string") return undefined;
  let parsed: URL;
  try { parsed = new URL(value); } catch { return undefined; }
  const revision = Number(parsed.searchParams.get("revision"));
  let sessionId: string;
  try { sessionId = decodeURIComponent(parsed.pathname.replace(/^\//, "")); } catch { return undefined; }
  return parsed.protocol === "studio:" && parsed.hostname === "active-editor" && sessionId && Number.isSafeInteger(revision) && revision >= 0
    ? { sessionId, draftRevision: revision } : undefined;
}
function resourceCursor(value: unknown): number | undefined {
  if (value === undefined) return 0;
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined;
  const offset = Number(value);
  return Number.isSafeInteger(offset) && offset >= 0 ? offset : undefined;
}

function toolDefinitions(host: IndustrialCapabilityHost, request: FastifyRequest) {
  return host.registry.listCapabilities().filter((descriptor) => canInvoke(request, descriptor)).map((descriptor) => ({
    name: toolName(descriptor.id),
    title: descriptor.label,
    description: `${descriptor.label}（能力版本 ${descriptor.version}；返回结构化状态、trace 与证据）`,
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      properties: { projectId: { type: "string", minLength: 1 }, input: descriptor.inputSchema },
      required: ["projectId", "input"]
    },
    outputSchema: capabilityResultSchema(descriptor),
    annotations: {
      readOnlyHint: isReadOnly(descriptor),
      destructiveHint: false,
      idempotentHint: isReadOnly(descriptor),
      openWorldHint: false
    }
  }));
}

async function callTool(
  params: Record<string, unknown> | undefined,
  dependencies: McpDependencies,
  request: FastifyRequest,
  id: string | number | null,
  reply: FastifyReply,
  modern: boolean
) {
  const name = typeof params?.name === "string" ? params.name : "";
  const capabilityId = name.startsWith("industrial.") ? name.slice("industrial.".length) : "";
  const descriptor = dependencies.host.registry.getCapability(capabilityId);
  const args = asRecord(params?.arguments);
  const projectId = typeof args?.projectId === "string" ? args.projectId : "";
  if (!descriptor || !projectId || !args || !isRecord(args.input)) return reply.code(400).send(rpcError(id, -32602, "tools/call 需要合法的 name、projectId 和对象 input"));
  if (!canInvoke(request, descriptor)) return reply.code(403).send(rpcError(id, -32003, "当前用户无权调用该工具"));
  const project = dependencies.store.getProject(projectId);
  if (!project) return reply.code(404).send(rpcError(id, -32004, "项目不存在"));
  if (!canAccessProject(request, projectId)) return reply.code(403).send(rpcError(id, -32003, "当前用户无权访问该项目"));

  const result = await dependencies.host.invoke(capabilityId, {
    requestId: randomUUID(),
    projectId,
    principal: request.systemUser ? `${request.systemUser.username}:${request.systemUser.id}` : "internal-mcp-test",
    ...(request.systemUser ? { role: request.systemUser.role } : {}),
    input: args.input
  } satisfies CapabilityRequest);
  return rpcResult(id, {
    isError: result.status === "failed" || result.status === "blocked" || result.status === "unavailable",
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    ...(modern ? { resultType: "complete" } : {})
  });
}

function validateProtocol(request: FastifyRequest, body: JsonRpcRequest): string | undefined {
  if (body.jsonrpc !== undefined && body.jsonrpc !== "2.0") return "jsonrpc 必须为 2.0";
  const version = request.headers["mcp-protocol-version"];
  if (typeof version === "string" && !SUPPORTED_VERSIONS.includes(version as typeof SUPPORTED_VERSIONS[number])) return `不支持 MCP 协议版本：${version}`;
  if (version !== MODERN_VERSION) return undefined;
  const methodHeader = request.headers["mcp-method"];
  if (methodHeader !== body.method) return "Mcp-Method 必须与 JSON-RPC method 一致";
  if (body.method === "tools/call" && request.headers["mcp-name"] !== body.params?.name) return "Mcp-Name 必须与工具名一致";
  return undefined;
}

function canInvoke(request: FastifyRequest, descriptor: CapabilityDescriptor): boolean {
  if (!request.systemUser || request.systemUser.role !== "viewer") return true;
  return isReadOnly(descriptor);
}

function isReadOnly(descriptor: CapabilityDescriptor): boolean {
  return descriptor.kind === "query" && descriptor.permissions.every((permission) => permission.endsWith(".read") || permission === "ai.invoke");
}

function canAccessProject(request: FastifyRequest, projectId: string): boolean {
  return !request.systemUser || request.systemUser.role === "admin" || request.systemUser.projectIds.includes(projectId);
}

function legacyProtocol(params: Record<string, unknown> | undefined): string {
  const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
  return requested === "2025-06-18" ? requested : "2025-11-25";
}

function asRecord(value: unknown): Record<string, unknown> | undefined { return isRecord(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function toolName(capabilityId: string): string { return `industrial.${capabilityId}`; }
function capabilityResultSchema(descriptor: CapabilityDescriptor) {
  return {
    type: "object",
    additionalProperties: true,
    properties: {
      status: { type: "string", enum: ["completed", "needs-input", "blocked", "unavailable", "failed"] },
      capabilityId: { type: "string", enum: [descriptor.id] },
      traceId: { type: "string", minLength: 1 },
      decisionStatus: { type: "string", enum: ["production", "shadow", "research-candidate", "insufficient-data"] },
      output: descriptor.outputSchema,
      evidence: { type: "array", items: { type: "object", additionalProperties: true } }
    },
    required: ["status", "capabilityId", "traceId", "decisionStatus", "evidence"]
  };
}
function rpcResult(id: string | number | null, result: Record<string, unknown>) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: string | number | null, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }
