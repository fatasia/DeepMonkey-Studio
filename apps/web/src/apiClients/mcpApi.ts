import type { CapabilityDescriptor } from "./industrialApi.js";
import type { EditorSceneDraftMirrorPayload } from "../studio/editorSceneDraftSnapshot.js";
import type { EditorDriverTransactionRequest, EditorDriverTransactionResult } from "../studio/editorSceneWriteDriver.js";

type ApiRequest = <T>(url: string, init?: RequestInit) => Promise<T>;

interface RpcEnvelope<T> { jsonrpc: "2.0"; id: string | number | null; result: T }

export interface McpToolDescriptor {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}
export interface McpResourceDescriptor { uri: string; name: string; title?: string; description?: string; mimeType?: string }
export interface EditorPresenceUpdate {
  leaseId: string;
  projectId: string;
  applicationId: string;
  applicationName: string;
  surface: "scene" | "dashboard" | "topology";
  targetId?: string;
  targetName?: string;
  persistedRevision: number;
  draftRevision: number;
  dirty: boolean;
  selectionCount: number;
  /** 活跃场景未保存草稿的有界语义快照；仅 scene 面且 dirty 时附带。 */
  draftMirror?: EditorSceneDraftMirrorPayload;
  /** 渲染诊断快照的有界元数据摘要（字节留在浏览器 readback 存储）。 */
  diagnosticsSnapshot?: {
    sceneId: string;
    revision: number;
    capturedAtMs: number;
    resources: readonly { resourceId: string; frameId: string; width: number; height: number;
      format: string; byteLength: number }[];
  };
}

export interface McpInspection {
  endpoint: string;
  authenticated: boolean;
  protocolVersion: string;
  serverName: string;
  serverVersion: string;
  tools: McpToolDescriptor[];
  resources: McpResourceDescriptor[];
  capabilities: CapabilityDescriptor[];
  resourcesSupported: boolean;
}

const PROTOCOL_VERSION = "2026-07-28";

export function createMcpApi(request: ApiRequest, endpoint: () => string, authenticated: () => boolean) {
  const call = <T>(method: string, signal?: AbortSignal) => request<RpcEnvelope<T>>("/api/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "mcp-protocol-version": PROTOCOL_VERSION,
      "mcp-method": method,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method }),
    ...(signal ? { signal } : {}),
  }).then(response => response.result);

  return {
    inspectMcp: async (signal?: AbortSignal): Promise<McpInspection> => {
      const discovery = await call<{ supportedVersions: string[]; capabilities: Record<string, unknown>; _meta?: Record<string, { name?: string; version?: string }> }>("server/discover", signal);
      const resourcesSupported = Object.hasOwn(discovery.capabilities, "resources");
      const [listed, catalog, resourcePage] = await Promise.all([
        call<{ tools: McpToolDescriptor[] }>("tools/list", signal),
        request<{ capabilities: CapabilityDescriptor[] }>("/api/capabilities", signal ? { signal } : undefined),
        resourcesSupported ? call<{ resources: McpResourceDescriptor[] }>("resources/list", signal) : Promise.resolve({ resources: [] }),
      ]);
      const server = discovery._meta?.["io.modelcontextprotocol/serverInfo"];
      return {
        endpoint: endpoint(), authenticated: authenticated(), protocolVersion: discovery.supportedVersions[0] ?? PROTOCOL_VERSION,
        serverName: server?.name ?? "bim-industrial-core", serverVersion: server?.version ?? "unknown",
        tools: listed.tools, resources: resourcePage.resources, capabilities: catalog.capabilities, resourcesSupported,
      };
    },
    updateEditorPresence: (sessionId: string, input: EditorPresenceUpdate, signal?: AbortSignal) => request<void>(
      `/api/editor-presence/${encodeURIComponent(sessionId)}`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(input), ...(signal ? { signal } : {}) },
    ),
    releaseEditorPresence: (sessionId: string, leaseId: string, keepalive = false) => request<void>(
      `/api/editor-presence/${encodeURIComponent(sessionId)}?leaseId=${encodeURIComponent(leaseId)}`,
      { method: "DELETE", keepalive },
    ),
    /** 浏览器写事务轮询：拉取下一个待执行事务；无在途事务时服务端返回 204 → undefined。 */
    nextEditorDriverRequest: (sessionId: string, leaseId: string, signal?: AbortSignal) => request<EditorDriverTransactionRequest | undefined>(
      `/api/editor-scene-driver/${encodeURIComponent(sessionId)}/next`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseId }), ...(signal ? { signal } : {}) },
    ),
    postEditorDriverResult: (sessionId: string, leaseId: string, requestId: string, result: EditorDriverTransactionResult, signal?: AbortSignal) => request<void>(
      `/api/editor-scene-driver/${encodeURIComponent(sessionId)}/result`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ leaseId, requestId, result }), ...(signal ? { signal } : {}),
      },
    ),
    nextEditorSnapshotRequest: (sessionId: string, leaseId: string, signal?: AbortSignal) => request<
      { requestId: string; resourceId: string; frameId?: string } | undefined
    >(
      `/api/editor-scene-driver/${encodeURIComponent(sessionId)}/snapshot-request`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ leaseId }), ...(signal ? { signal } : {}) },
    ),
    postEditorSnapshotResult: (sessionId: string, requestId: string, payload: unknown, signal?: AbortSignal) => request<void>(
      `/api/editor-scene-driver/${encodeURIComponent(sessionId)}/snapshot-result`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId, payload }), ...(signal ? { signal } : {}) },
    ),
  };
}
