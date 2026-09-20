import type { FastifyInstance } from "fastify";
import type { SystemUserRecord } from "@bim-studio/contracts";
import { parseEditorSceneDraftMirror, type EditorSceneDraftMirror } from "./editorSceneDraftMirror.js";

export type EditorSurface = "scene" | "dashboard" | "topology";

export interface EditorPresenceInput {
  leaseId: string;
  projectId: string;
  applicationId: string;
  applicationName: string;
  surface: EditorSurface;
  targetId?: string;
  targetName?: string;
  persistedRevision: number;
  draftRevision: number;
  dirty: boolean;
  selectionCount: number;
  /** 可选的活跃场景草稿镜像；无效或越界时被整体丢弃，不影响 presence 摘要。 */
  draftMirror?: EditorSceneDraftMirror;
}

export interface EditorPresence extends EditorPresenceInput {
  sessionId: string;
  userId: string;
  username: string;
  updatedAt: string;
  expiresAt: number;
}

const DEFAULT_TTL_MS = 45_000;

/** Process-local editor presence. It is ephemeral by design and never becomes project data. */
export class EditorPresenceRegistry {
  private readonly entries = new Map<string, EditorPresence>();
  constructor(private readonly now = () => Date.now(), private readonly ttlMs = DEFAULT_TTL_MS) {}

  upsert(sessionId: string, user: SystemUserRecord, input: EditorPresenceInput): EditorPresence {
    this.prune();
    const current = this.entries.get(sessionId);
    if (current && current.userId !== user.id) throw new Error("编辑器会话属于其他用户");
    const timestamp = this.now();
    const next = Object.freeze({ ...input, sessionId, userId: user.id, username: user.username,
      updatedAt: new Date(timestamp).toISOString(), expiresAt: timestamp + this.ttlMs });
    this.entries.set(sessionId, next);
    return next;
  }

  remove(sessionId: string, userId: string, leaseId: string): boolean {
    const current = this.entries.get(sessionId);
    if (!current || current.userId !== userId || current.leaseId !== leaseId) return false;
    return this.entries.delete(sessionId);
  }

  listFor(user: SystemUserRecord): EditorPresence[] {
    this.prune();
    return [...this.entries.values()].filter(entry => entry.userId === user.id && canAccess(user, entry.projectId))
      .sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  }

  readFor(user: SystemUserRecord, sessionId: string, draftRevision: number): EditorPresence | undefined {
    this.prune();
    const entry = this.entries.get(sessionId);
    return entry?.userId === user.id && canAccess(user, entry.projectId) && entry.draftRevision === draftRevision ? entry : undefined;
  }

  /** 不绑定 draftRevision 的会话读取；写事务桥在提交时用它校验会话归属与活跃场景。 */
  readOwned(user: SystemUserRecord, sessionId: string): EditorPresence | undefined {
    this.prune();
    const entry = this.entries.get(sessionId);
    return entry?.userId === user.id && canAccess(user, entry.projectId) ? entry : undefined;
  }

  /** 浏览器 driver 轮询用：leaseId 即会话凭证，会话过期或租约更换都读不到。 */
  readByLease(sessionId: string, leaseId: string): EditorPresence | undefined {
    this.prune();
    const entry = this.entries.get(sessionId);
    return entry?.leaseId === leaseId ? entry : undefined;
  }

  private prune(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(id);
  }
}

export async function registerEditorPresenceRoutes(app: FastifyInstance, registry: EditorPresenceRegistry): Promise<void> {
  app.put<{ Params: { sessionId: string }; Body: Partial<EditorPresenceInput> }>("/api/editor-presence/:sessionId", async (request, reply) => {
    const user = request.systemUser;
    if (!user) return reply.code(401).send({ message: "请先登录" });
    const input = parsePresence(request.body);
    if (!input) return reply.code(400).send({ message: "编辑器会话摘要无效" });
    if (!canAccess(user, input.projectId)) return reply.code(403).send({ message: "没有该项目的访问权限" });
    try { return registry.upsert(request.params.sessionId, user, input); }
    catch (error) { return reply.code(409).send({ message: error instanceof Error ? error.message : String(error) }); }
  });
  app.delete<{ Params: { sessionId: string }; Querystring: { leaseId?: string } }>("/api/editor-presence/:sessionId", async (request, reply) => {
    const user = request.systemUser;
    if (!user) return reply.code(401).send({ message: "请先登录" });
    const leaseId = request.query.leaseId;
    if (!identifier(leaseId)) return reply.code(400).send({ message: "leaseId 无效" });
    registry.remove(request.params.sessionId, user.id, leaseId);
    return reply.code(204).send();
  });
}

function parsePresence(value: Partial<EditorPresenceInput> | undefined): EditorPresenceInput | undefined {
  if (!value || !identifier(value.leaseId) || !identifier(value.projectId) || !identifier(value.applicationId)
    || !label(value.applicationName) || !["scene", "dashboard", "topology"].includes(value.surface ?? "")
    || !revision(value.persistedRevision) || !revision(value.draftRevision)
    || typeof value.dirty !== "boolean" || !count(value.selectionCount)
    || (value.targetId !== undefined && !identifier(value.targetId)) || (value.targetName !== undefined && !label(value.targetName))) return undefined;
  // 镜像不可信时整体丢弃（fail-closed 到 unavailable），presence 摘要照常更新。
  const { draftMirror: rawMirror, ...rest } = value as EditorPresenceInput;
  const draftMirror = parseEditorSceneDraftMirror(rawMirror);
  return draftMirror ? { ...rest, draftMirror } : rest as EditorPresenceInput;
}

function canAccess(user: SystemUserRecord, projectId: string): boolean {
  return user.role === "admin" || user.projectIds.includes(projectId);
}
function identifier(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 160; }
function label(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= 240; }
function revision(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0; }
function count(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100_000; }
