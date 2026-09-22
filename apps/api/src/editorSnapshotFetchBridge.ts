import type { SystemUserRecord } from "@bim-studio/contracts";
import type { EditorPresenceRegistry } from "./editorPresence.js";

/**
 * MCP 诊断快照字节的按需拉取桥（第二半）：资源目录（元数据）已在 presence 通道，
 * 字节仍在浏览器 readback 存储。MCP 发起拉取 → 挂起 → 浏览器 driver 轮询取走 →
 * 回传 base64（预算内）→ 短 TTL 缓存供幂等重放。无副作用只读操作，治理从简：
 * viewer 拒绝、会话归属、字节预算、TTL，不做事务级排队。
 */

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RESOURCE_ID = /^[a-z][a-z0-9-]{0,31}$/;
/** 与 deep-engine PBR_FRAME_READBACK_RESOURCES 及镜像侧白名单一致。 */
const READBACK_RESOURCE_WHITELIST = new Set(["present-color", "opaque-hdr", "linear-depth"]);
const MAX_BASE64_CHARS = 96 * 1024 * 1024;

export interface DriverSnapshotFetchRequest {
  requestId: string;
  resourceId: string;
  frameId: string | undefined;
}

export interface DriverSnapshotFetchResult {
  status: "ok" | "unavailable";
  resourceId: string;
  frameId?: string;
  format?: string;
  width?: number;
  height?: number;
  byteLength?: number;
  dataBase64?: string;
  message?: string;
}

interface PendingSnapshot {
  requestId: string;
  leaseId: string;
  expiresAt: number;
  request: DriverSnapshotFetchRequest;
  resolve: (result: DriverSnapshotFetchResult) => void;
}

export interface EditorSnapshotFetchBridgeOptions {
  now?: () => number;
  pendingTtlMs?: number;
  completedTtlMs?: number;
  /** 测试注入用；生产默认 96MB base64（≈72MB 原始字节）。 */
  maxBase64Chars?: number;
}

export class EditorSnapshotFetchBridge {
  private readonly pending = new Map<string, PendingSnapshot>();
  private readonly completed = new Map<string, Map<string, { result: DriverSnapshotFetchResult; at: number }>>();
  private readonly now: () => number;
  private readonly pendingTtlMs: number;
  private readonly completedTtlMs: number;
  private readonly maxBase64Chars: number;

  constructor(private readonly editorPresence: EditorPresenceRegistry, options: EditorSnapshotFetchBridgeOptions = {}) {
    this.now = options.now ?? Date.now;
    this.pendingTtlMs = options.pendingTtlMs ?? 15_000;
    this.completedTtlMs = options.completedTtlMs ?? 60_000;
    this.maxBase64Chars = options.maxBase64Chars ?? MAX_BASE64_CHARS;
    if (!Number.isSafeInteger(this.maxBase64Chars) || this.maxBase64Chars < 4) {
      throw new RangeError("maxBase64Chars must be a positive safe integer of at least 4.");
    }
  }

  /** MCP 侧发起：返回缓存的幂等结果，或挂起等浏览器回传。 */
  async request(user: SystemUserRecord, sessionId: string, input: unknown): Promise<DriverSnapshotFetchResult> {
    const parsed = parseFetchRequest(input);
    if (user.role === "viewer") {
      return { status: "unavailable", resourceId: parsed?.resourceId ?? "", message: "viewer 角色无诊断快照读取权限" };
    }
    if (!parsed) return { status: "unavailable", resourceId: "", message: "拉取输入不合法：需要 requestId 与白名单 resourceId" };
    const entry = this.editorPresence.readOwned(user, sessionId);
    if (!entry || entry.surface !== "scene" || !entry.targetId) {
      return { status: "unavailable", resourceId: parsed.resourceId, message: "活跃编辑器会话不存在、已过期或不在场景编辑面" };
    }
    this.prune();
    const sessionCache = this.completed.get(entry.sessionId);
    const cached = sessionCache?.get(parsed.requestId);
    if (cached && this.now() - cached.at <= this.completedTtlMs) return cached.result;

    return new Promise(resolve => {
      const expiresAt = this.now() + this.pendingTtlMs;
      const previous = this.pending.get(entry.sessionId);
      if (previous) previous.resolve({ status: "unavailable", resourceId: previous.request.resourceId, message: "被更新的拉取请求取代" });
      this.pending.set(entry.sessionId, {
        requestId: parsed.requestId, leaseId: entry.leaseId, expiresAt,
        request: { requestId: parsed.requestId, resourceId: parsed.resourceId, frameId: parsed.frameId },
        resolve: result => {
          const cache = this.completed.get(entry.sessionId) ?? new Map();
          cache.set(parsed.requestId, { result, at: this.now() });
          if (cache.size > 8) cache.delete(cache.keys().next().value as string);
          this.completed.set(entry.sessionId, cache);
          resolve(result);
        },
      });
    });
  }

  /** 浏览器 driver 轮询：只回传本租约的挂起请求；无请求返回 undefined（204 语义）。 */
  takeDriverRequest(sessionId: string, leaseId: string): DriverSnapshotFetchRequest | undefined {
    this.prune();
    const pending = this.pending.get(sessionId);
    if (!pending || pending.leaseId !== leaseId) return undefined;
    return pending.request;
  }

  /** 浏览器 driver 回传；预算内才结算，超预算按 unavailable 落账（fail-closed 不静默截断）。 */
  submitDriverResult(sessionId: string, requestId: string, payload: unknown): boolean {
    const pending = this.pending.get(sessionId);
    if (!pending || pending.requestId !== requestId) return false;
    const parsed = parseResultPayload(payload, this.maxBase64Chars);
    this.pending.delete(sessionId);
    pending.resolve(parsed ?? { status: "unavailable", resourceId: pending.request.resourceId,
      message: "回传载荷不合法或超出预算" });
    return true;
  }

  private prune(): void {
    const now = this.now();
    for (const [sessionId, pending] of this.pending) {
      if (pending.expiresAt <= now) {
        this.pending.delete(sessionId);
        pending.resolve({ status: "unavailable", resourceId: pending.request.resourceId, message: "拉取等待超时" });
      }
    }
    for (const [sessionId, cache] of this.completed) {
      for (const [requestId, entry] of cache) {
        if (this.now() - entry.at > this.completedTtlMs) cache.delete(requestId);
      }
      if (cache.size === 0) this.completed.delete(sessionId);
    }
  }
}

function parseFetchRequest(input: unknown): { requestId: string; resourceId: string; frameId?: string } | undefined {
  if (typeof input !== "object" || input === null) return undefined;
  const record = input as Record<string, unknown>;
  if (typeof record.requestId !== "string" || !REQUEST_ID.test(record.requestId)) return undefined;
  if (typeof record.resourceId !== "string" || !RESOURCE_ID.test(record.resourceId)
    || !READBACK_RESOURCE_WHITELIST.has(record.resourceId)) return undefined;
  if (record.frameId !== undefined && (typeof record.frameId !== "string" || record.frameId.length === 0
    || record.frameId.length > 160)) return undefined;
  return { requestId: record.requestId, resourceId: record.resourceId,
    ...(record.frameId !== undefined ? { frameId: record.frameId as string } : {}) };
}

function parseResultPayload(payload: unknown, maxBase64Chars: number): DriverSnapshotFetchResult | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const record = payload as Record<string, unknown>;
  if (record.status === "unavailable") {
    return { status: "unavailable", resourceId: typeof record.resourceId === "string" ? record.resourceId : "",
      ...(typeof record.message === "string" ? { message: record.message } : {}) };
  }
  if (record.status !== "ok") return undefined;
  const dataBase64 = record.dataBase64;
  if (typeof dataBase64 !== "string" || dataBase64.length === 0 || dataBase64.length > maxBase64Chars) return undefined;
  if (typeof record.resourceId !== "string" || !RESOURCE_ID.test(record.resourceId)
    || typeof record.format !== "string" || record.format.length === 0 || record.format.length > 32
    || typeof record.frameId !== "string" || record.frameId.length === 0 || record.frameId.length > 160
    || typeof record.width !== "number" || !Number.isSafeInteger(record.width) || record.width < 1
    || typeof record.height !== "number" || !Number.isSafeInteger(record.height) || record.height < 1
    || typeof record.byteLength !== "number" || !Number.isSafeInteger(record.byteLength) || record.byteLength < 0) return undefined;
  return { status: "ok", resourceId: record.resourceId, frameId: record.frameId, format: record.format,
    width: record.width, height: record.height, byteLength: record.byteLength, dataBase64 };
}


export const EDITOR_SNAPSHOT_FETCH_TOOL = "fetch_editor_snapshot";

export function editorSnapshotFetchToolDefinition() {
  return {
    name: EDITOR_SNAPSHOT_FETCH_TOOL,
    title: "拉取渲染诊断快照",
    description: "从当前用户的活跃浏览器编辑器 readback 存储按需拉取一张诊断快照字节（base64）。"
      + "资源限于白名单（present-color/opaque-hdr/linear-depth）；可选指定 frameId，缺省取该资源最新帧。"
      + "字节不落盘、不出用户会话；超预算或无匹配帧返回明确的 unavailable 原因。",
    inputSchema: {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      required: ["projectId", "sessionId", "resourceId"],
      properties: {
        projectId: { type: "string", minLength: 1 },
        sessionId: { type: "string", minLength: 1 },
        resourceId: { type: "string", enum: ["present-color", "opaque-hdr", "linear-depth"] },
        frameId: { type: "string", maxLength: 160 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotent: true, openWorldHint: false },
  };
}

/** MCP tools/call 入口：治理走 request()，结果以 JSON 文本返回。 */
export async function callEditorSnapshotFetchTool(
  params: Record<string, unknown>, bridge: EditorSnapshotFetchBridge, user: SystemUserRecord,
): Promise<{ text: string }> {
  const input = (params as { input?: unknown }).input;
  const sessionId = typeof (input as { sessionId?: unknown })?.sessionId === "string"
    ? (input as { sessionId: string }).sessionId : "";
  const result = await bridge.request(user, sessionId, input);
  return { text: JSON.stringify(result) };
}
