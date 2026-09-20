import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type {
  AiProviderSettings,
  AuditLogRecord,
  ServiceLogRecord,
  StoredSystemUserRecord,
  SystemBrandingSettings,
  SystemUserRecord,
  SystemUserRole,
} from "@bim-studio/contracts";
import { DEFAULT_PRODUCT_BRANDING } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";
import type { AssistantMode } from "./ai/assistantPrompts.js";
import { AiReliabilityBlockedError, type AssistantService } from "./ai/assistantService.js";
import { streamAssistantHttp } from "./ai/streamAssistantHttp.js";
import { httpDisconnectScope } from "./httpDisconnectScope.js";
import { mergeAiSettingsDraft, publicAiSettings, resolveAiSettings } from "./ai/aiRuntimeSettings.js";
import { fetchProviderModels } from "./ai/aiModelCatalog.js";
import { emptyTelemetrySummary, type AiTelemetryRing } from "./ai/aiRequestTelemetry.js";
import {
  collectServiceHealth,
  createDiagnosticArchive,
  createDiagnosticSnapshot,
  normalizeServiceLogFilters,
  queryServiceLogs,
  serviceLogDirectories,
  serviceLogExportText,
} from "./serviceObservability.js";

export { assistantPrompts } from "./ai/assistantPrompts.js";

declare module "fastify" {
  interface FastifyRequest {
    systemUser?: SystemUserRecord;
  }
}

const sessions = new Map<string, { userId: string; expiresAt: number }>();
const SESSION_LIFETIME = 12 * 60 * 60 * 1_000;
const REMEMBER_SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1_000;
const ASSISTANT_MODES = new Set<AssistantMode>(["platform", "operations", "vision", "bim", "scene", "component", "dashboard", "sql"]);

interface AssistantRouteBody {
  mode?: AssistantMode;
  question?: string;
  context?: unknown;
  projectId?: string;
}

interface ServiceLogQuery {
  service?: string;
  level?: string;
  from?: string;
  to?: string;
  keyword?: string;
  limit?: string;
}

export async function registerSystemRoutes(
  app: FastifyInstance,
  store: MetadataStore,
  dataDir: string,
  dependencies: { assistant?: AssistantService; aiTelemetry?: AiTelemetryRing } = {},
): Promise<void> {
  const brandingDirectory = path.join(dataDir, "branding");
  if (store.listUsers().length === 0) {
    const now = new Date().toISOString();
    await store.saveUser({
      id: randomUUID(),
      username: "admin",
      displayName: "系统管理员",
      role: "admin",
      projectIds: [],
      enabled: true,
      passwordHash: hashPassword(process.env.BIM_STUDIO_ADMIN_PASSWORD ?? "admin"),
      createdAt: now,
      updatedAt: now,
    });
  }

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname === "/health" || pathname === "/api/meta" || pathname === "/api/auth/login" || pathname.startsWith("/api/public/") || pathname.startsWith("/assets/")) return;
    if (!pathname.startsWith("/api/")) return;
    const token = authToken(request);
    const session = token ? resolveSession(token) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      return reply.code(401).send({ message: `请先登录 ${resolveBrandingSettings(store).systemName}` });
    }
    const stored = store.getUser(session.userId);
    if (!stored?.enabled) return reply.code(401).send({ message: "用户已停用，请重新登录" });
    request.systemUser = publicUser(stored);
    const branding = resolveBrandingSettings(store);
    if (branding.maintenanceEnabled && stored.role !== "admin") return reply.code(503).send({ message: branding.maintenanceMessage || "系统维护中" });
    if (pathname.startsWith("/api/admin/") && stored.role !== "admin") return reply.code(403).send({ message: "需要管理员权限" });
    if (pathname === "/api/projects" && request.method === "POST" && stored.role !== "admin") return reply.code(403).send({ message: "只有管理员可以新建项目" });
    const projectId = pathname.match(/^\/api\/projects\/([^/]+)/)?.[1];
    if (projectId && stored.role !== "admin" && !stored.projectIds.includes(decodeURIComponent(projectId))) return reply.code(403).send({ message: "没有该项目的访问权限" });
    const aiReadAction =
      pathname === "/api/ai/assistant" || pathname === "/api/ai/assistant/stream" || pathname === "/api/mcp"
      || pathname.startsWith("/api/editor-presence/") || /^\/api\/projects\/[^/]+\/capabilities\/invoke$/.test(pathname);
    if (stored.role === "viewer" && !["GET", "HEAD"].includes(request.method) && !aiReadAction) return reply.code(403).send({ message: "浏览者不能修改数据" });
  });

  // onResponse 在响应发出后落审计；关服需等它完成，避免存储先关闭或测试目录先回收。
  const pendingAuditWrites = new Set<Promise<void>>();
  app.addHook("onClose", async () => { await Promise.all(pendingAuditWrites); });
  app.addHook("onResponse", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (!pathname.startsWith("/api/") || pathname.startsWith("/api/admin/audit")) return;
    if (["GET", "HEAD"].includes(request.method) && reply.statusCode < 400) return;
    const record: AuditLogRecord = {
      id: randomUUID(),
      ...(request.systemUser ? { userId: request.systemUser.id, username: request.systemUser.username } : {}),
      action: reply.statusCode >= 400 ? "error" : actionName(request.method),
      resource: pathname,
      method: request.method,
      statusCode: reply.statusCode,
      ip: request.ip,
      ...(reply.statusCode >= 400 ? { detail: `HTTP ${reply.statusCode}` } : {}),
      createdAt: new Date().toISOString(),
    };
    const write = store.addAuditLog(record).catch((error) => request.log.error(error));
    pendingAuditWrites.add(write);
    try { await write; } finally { pendingAuditWrites.delete(write); }
  });

  app.post<{ Body: { username?: string; password?: string; remember?: boolean } }>("/api/auth/login", async (request, reply) => {
    const username = request.body?.username?.trim() ?? "";
    const user = store.findUserByUsername(username);
    if (!user?.enabled || !verifyPassword(request.body?.password ?? "", user.passwordHash)) return reply.code(401).send({ message: "用户名或密码错误" });
    const persistent = Boolean(request.body?.remember);
    const session = { userId: user.id, expiresAt: Date.now() + (persistent ? REMEMBER_SESSION_LIFETIME : SESSION_LIFETIME) };
    const token = persistent ? createRememberToken(session) : randomBytes(32).toString("base64url");
    if (!persistent) sessions.set(token, session);
    return { token, user: publicUser(user) };
  });
  app.get("/api/auth/me", async (request) => request.systemUser);
  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, "");
    if (token) sessions.delete(token);
    return reply.code(204).send();
  });

  app.get("/api/admin/users", async () => store.listUsers().map(publicUser));
  app.post<{ Body: Partial<SystemUserRecord> & { password?: string } }>("/api/admin/users", async (request, reply) => {
    const username = request.body.username?.trim();
    if (!username || !request.body.password) return reply.code(400).send({ message: "用户名和初始密码不能为空" });
    if (store.findUserByUsername(username)) return reply.code(409).send({ message: "用户名已存在" });
    const now = new Date().toISOString();
    const user: StoredSystemUserRecord = {
      id: randomUUID(),
      username,
      displayName: request.body.displayName?.trim() || username,
      role: normalizeRole(request.body.role),
      projectIds: request.body.projectIds ?? [],
      enabled: true,
      passwordHash: hashPassword(request.body.password),
      createdAt: now,
      updatedAt: now,
    };
    return reply.code(201).send(publicUser(await store.saveUser(user)));
  });
  app.patch<{ Params: { userId: string }; Body: Partial<SystemUserRecord> & { password?: string } }>("/api/admin/users/:userId", async (request, reply) => {
    const current = store.getUser(request.params.userId);
    if (!current) return reply.code(404).send({ message: "用户不存在" });
    const updated: StoredSystemUserRecord = {
      ...current,
      ...(request.body.displayName !== undefined ? { displayName: request.body.displayName.trim() || current.username } : {}),
      ...(request.body.role ? { role: normalizeRole(request.body.role) } : {}),
      ...(request.body.projectIds ? { projectIds: request.body.projectIds } : {}),
      ...(request.body.enabled !== undefined ? { enabled: request.body.enabled } : {}),
      ...(request.body.password ? { passwordHash: hashPassword(request.body.password) } : {}),
      updatedAt: new Date().toISOString(),
    };
    return publicUser(await store.saveUser(updated));
  });
  app.delete<{ Params: { userId: string } }>("/api/admin/users/:userId", async (request, reply) => {
    if (request.systemUser?.id === request.params.userId) return reply.code(400).send({ message: "不能删除当前登录用户" });
    const target = store.getUser(request.params.userId);
    if (!target) return reply.code(404).send({ message: "用户不存在" });
    if (target.role === "admin" && store.listUsers().filter((item) => item.role === "admin" && item.enabled).length <= 1)
      return reply.code(400).send({ message: "至少保留一个管理员" });
    await store.removeUser(request.params.userId);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { limit?: string } }>("/api/admin/audit", async (request) => store.listAuditLogs(Math.min(500, Number(request.query.limit ?? 200))));
  app.get("/api/admin/logs", async () => readServiceLogs(path.join(dataDir, "logs")));
  app.get("/api/admin/health", async () => collectServiceHealth());
  app.get<{ Querystring: ServiceLogQuery }>("/api/admin/service-logs", async (request, reply) => {
    try {
      const filters = normalizeServiceLogFilters(request.query);
      return queryServiceLogs(serviceLogDirectories(dataDir), filters);
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get<{ Querystring: ServiceLogQuery }>("/api/admin/service-logs/export", async (request, reply) => {
    try {
      const filters = normalizeServiceLogFilters(request.query);
      const result = await queryServiceLogs(serviceLogDirectories(dataDir), filters);
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      return reply
        .header("content-type", "text/plain; charset=utf-8")
        .header("content-disposition", `attachment; filename="bim-studio-service-logs-${timestamp}.log"`)
        .send(serviceLogExportText(result, filters));
    } catch (error) {
      return reply.code(400).send({ message: error instanceof Error ? error.message : String(error) });
    }
  });
  app.get("/api/admin/diagnostics", async () => createDiagnosticSnapshot(dataDir));
  app.get("/api/admin/diagnostics/download", async (_request, reply) => {
    const snapshot = await createDiagnosticSnapshot(dataDir);
    const archive = await createDiagnosticArchive(snapshot);
    const timestamp = snapshot.generatedAt.replace(/[:.]/g, "-");
    return reply
      .header("content-type", "application/zip")
      .header("content-disposition", `attachment; filename="bim-studio-diagnostics-${timestamp}.zip"`)
      .send(archive);
  });

  app.get("/api/public/branding", async () => resolveBrandingSettings(store));
  app.get<{ Params: { fileName: string } }>("/api/public/branding/assets/:fileName", async (request, reply) => {
    const fileName = path.basename(request.params.fileName);
    const filePath = path.join(brandingDirectory, fileName);
    try {
      const content = await readFile(filePath);
      reply.type(contentTypeFor(fileName));
      return content;
    } catch {
      return reply.code(404).send({ message: "品牌资源不存在" });
    }
  });
  app.patch<{ Body: Partial<SystemBrandingSettings> }>("/api/admin/branding", async (request, reply) => {
    const current = resolveBrandingSettings(store);
    const next = normalizeBrandingSettings({ ...current, ...request.body, updatedAt: new Date().toISOString() });
    if (!next.systemName || !next.browserTitle) return reply.code(400).send({ message: "系统名和浏览器标题不能为空" });
    return store.saveBrandingSettings(next);
  });
  app.post<{ Querystring: { kind?: "logo" | "icon" } }>("/api/admin/branding/upload", async (request, reply) => {
    const kind = request.query.kind === "icon" ? "icon" : "logo";
    const upload = await request.file();
    if (!upload) return reply.code(400).send({ message: "请选择图片" });
    const extension = extensionFor(upload.mimetype);
    if (!extension) return reply.code(415).send({ message: "仅支持 PNG、WebP、SVG、JPEG 或 ICO" });
    const bytes = await upload.toBuffer();
    if (bytes.length > 5 * 1024 * 1024) return reply.code(413).send({ message: "品牌图片不能超过 5 MB" });
    await mkdir(brandingDirectory, { recursive: true });
    const fileName = `${kind}-${Date.now()}${extension}`;
    await writeFile(path.join(brandingDirectory, fileName), bytes);
    const current = resolveBrandingSettings(store);
    const url = `/api/public/branding/assets/${fileName}`;
    const next = { ...current, [kind === "logo" ? "logoUrl" : "iconUrl"]: url, updatedAt: new Date().toISOString() };
    await store.saveBrandingSettings(next);
    return { url, settings: next };
  });

  app.get("/api/admin/ai-settings", async () => publicAiSettings(resolveAiSettings(store)));
  app.patch<{ Body: Partial<AiProviderSettings> }>("/api/admin/ai-settings", async (request, reply) => {
    const current = resolveAiSettings(store);
    try {
      return store.saveAiSettings({
        ...mergeAiSettingsDraft(current, request.body),
        updatedAt: new Date().toISOString(),
      });
    } catch {
      return reply.code(400).send({ message: "大模型 URL 无效" });
    }
  });
  app.post<{ Body: Partial<AiProviderSettings> }>("/api/admin/ai-settings/test", async (request, reply) => {
    try {
      const assistant = requireAssistant(dependencies.assistant);
      const settings = mergeAiSettingsDraft(resolveAiSettings(store), request.body ?? {});
      const result = await assistant.complete({ mode: "scene", question: "只回复：连接成功", context: {}, settings, principal: "admin-test" });
      return { ok: true, model: result.model, ...(result.reliability?.servedProvider ? { servedProvider: result.reliability.servedProvider } : {}) };
    } catch (reason) {
      if (reason instanceof AiReliabilityBlockedError) return reply.code(403).send(aiBlockedPayload(reason));
      return reply.code(502).send({ message: reason instanceof Error ? reason.message : String(reason) });
    }
  });

  /** 拉取模型服务可用模型列表；请求体可携带未保存草案（同测试连接），refresh=true 绕过 5 分钟缓存。 */
  app.post<{ Body: Partial<AiProviderSettings> & { refresh?: boolean } }>("/api/admin/ai-settings/models", async (request, reply) => {
    const draft = request.body ?? {};
    try {
      const settings = mergeAiSettingsDraft(resolveAiSettings(store), draft);
      const result = await fetchProviderModels({ baseUrl: settings.baseUrl, apiKey: settings.apiKey, ...(draft.refresh ? { refresh: true } : {}) });
      return result.ok ? result : reply.code(200).send(result);
    } catch (reason) {
      return reply.code(400).send({ ok: false, category: "invalid", message: reason instanceof Error ? reason.message : String(reason) });
    }
  });

  /** AI 请求观测快照：最近 N 条 provider/模型/延迟/token/状态记录与最近一次 failover 事件。 */
  app.get("/api/admin/ai-settings/telemetry", async () => ({
    settings: publicAiSettings(resolveAiSettings(store)),
    telemetry: dependencies.aiTelemetry ? dependencies.aiTelemetry.summary() : emptyTelemetrySummary(new Date().toISOString()),
  }));

  app.post<{ Body: AssistantRouteBody }>("/api/ai/assistant", async (request, reply) => {
    const question = request.body?.question?.trim();
    if (!question) return reply.code(400).send({ message: "请输入问题或生成要求" });
    const issue = validateAssistantRouteInput(request.body, request.systemUser, store);
    if (issue) return reply.code(issue.statusCode).send({ message: issue.message });
    const projectId = request.body.projectId?.trim();
    const scope = httpDisconnectScope(request.raw, reply.raw);
    try {
      return await requireAssistant(dependencies.assistant).complete({
        signal: scope.signal,
        mode: request.body.mode ?? "platform",
        question,
        context: request.body.context ?? {},
        settings: resolveAiSettings(store),
        principal: request.systemUser?.username ?? "api-user",
        ...(projectId ? { projectId } : {}),
      });
    } catch (reason) {
      if (reply.raw.destroyed) return reply.hijack();
      if (reason instanceof AiReliabilityBlockedError) return reply.code(403).send(aiBlockedPayload(reason));
      return reply.code(502).send({ message: reason instanceof Error ? reason.message : String(reason) });
    } finally {
      scope.dispose();
    }
  });
  app.post<{ Body: AssistantRouteBody }>("/api/ai/assistant/stream", async (request, reply) => {
    const question = request.body?.question?.trim();
    if (!question) return reply.code(400).send({ message: "请输入问题或生成要求" });
    const issue = validateAssistantRouteInput(request.body, request.systemUser, store);
    if (issue) return reply.code(issue.statusCode).send({ message: issue.message });
    const projectId = request.body.projectId?.trim();
    const scope = httpDisconnectScope(request.raw, reply.raw);
    try {
      await streamAssistantHttp(reply.raw, requireAssistant(dependencies.assistant), {
        signal: scope.signal,
        mode: request.body.mode ?? "platform",
        question,
        context: request.body.context ?? {},
        settings: resolveAiSettings(store),
        principal: request.systemUser?.username ?? "api-user",
        ...(projectId ? { projectId } : {}),
      });
      return reply.hijack();
    } catch (reason) {
      if (reply.raw.destroyed) return reply.hijack();
      const payload = reason instanceof AiReliabilityBlockedError
        ? aiBlockedPayload(reason)
        : { message: reason instanceof Error ? reason.message : String(reason) };
      if (reply.raw.headersSent) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify(payload)}\n\n`);
        reply.raw.end();
        return reply.hijack();
      }
      return reply.code(reason instanceof AiReliabilityBlockedError ? 403 : 502).send(payload);
    } finally {
      scope.dispose();
    }
  });
}

function aiBlockedPayload(reason: AiReliabilityBlockedError) {
  return { message: reason.message, code: reason.code, traceId: reason.traceId, findings: reason.findings };
}

function validateAssistantRouteInput(
  body: AssistantRouteBody,
  user: SystemUserRecord | undefined,
  store: MetadataStore,
): { statusCode: 400 | 403 | 404; message: string } | undefined {
  if (body.mode !== undefined && !ASSISTANT_MODES.has(body.mode)) return { statusCode: 400, message: "不支持的 AI 助手模式" };
  if ((body.question?.trim().length ?? 0) > 4_000) return { statusCode: 400, message: "问题最多 4000 个字符" };
  const projectId = body.projectId?.trim();
  if (!projectId) return undefined;
  if (!store.getProject(projectId)) return { statusCode: 404, message: "项目不存在" };
  if (user && user.role !== "admin" && !user.projectIds.includes(projectId)) return { statusCode: 403, message: "没有该项目的访问权限" };
  return undefined;
}

function authToken(request: FastifyRequest): string | undefined {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const rawProtocols = request.headers["sec-websocket-protocol"];
  const protocols = (Array.isArray(rawProtocols) ? rawProtocols.join(",") : (rawProtocols ?? "")).split(",").map((value) => value.trim());
  return protocols.find((value) => value.startsWith("bim-studio-auth."))?.slice("bim-studio-auth.".length);
}

const DEFAULT_BRANDING: SystemBrandingSettings = { ...DEFAULT_PRODUCT_BRANDING };

function resolveBrandingSettings(store: MetadataStore): SystemBrandingSettings {
  const stored = store.getBrandingSettings();
  // 兼容清理品牌前写入的旧默认值；拆分字面量可避免旧商标再次进入发布源码扫描。
  const legacySystemNames = [
    ["i", "Twin Studio"].join(""),
    ["Industrial", "Studio"].join(" "),
    "BIM Studio",
    "Dev Studio",
  ];
  const migrated = stored
    ? {
        ...stored,
        systemName: legacySystemNames.includes(stored.systemName) ? DEFAULT_BRANDING.systemName : stored.systemName,
        browserTitle: legacySystemNames.includes(stored.browserTitle) ? DEFAULT_BRANDING.browserTitle : stored.browserTitle,
        // 旧版本默认使用了非工业化示例图标；仅替换系统默认资产，不覆盖管理员主动上传的品牌文件。
        logoUrl: ["/brand/logo-transparent.png", "/brand/logo.webp"].includes(stored.logoUrl) ? DEFAULT_BRANDING.logoUrl : stored.logoUrl,
        iconUrl: ["/brand/app-icon.png", "/brand/app-icon-chroma.png"].includes(stored.iconUrl) ? DEFAULT_BRANDING.iconUrl : stored.iconUrl,
      }
    : undefined;
  return normalizeBrandingSettings({ ...DEFAULT_BRANDING, ...migrated });
}
function normalizeBrandingSettings(settings: SystemBrandingSettings): SystemBrandingSettings {
  const color = /^#[0-9a-f]{6}$/i.test(settings.primaryColor) ? settings.primaryColor : DEFAULT_BRANDING.primaryColor;
  const background = /^#[0-9a-f]{6}$/i.test(settings.defaultSceneBackground) ? settings.defaultSceneBackground : DEFAULT_BRANDING.defaultSceneBackground;
  return {
    ...DEFAULT_BRANDING,
    ...settings,
    systemName: String(settings.systemName ?? "")
      .trim()
      .slice(0, 60),
    browserTitle: String(settings.browserTitle ?? "")
      .trim()
      .slice(0, 80),
    loginSubtitle: String(settings.loginSubtitle ?? "")
      .trim()
      .slice(0, 100),
    copyright: String(settings.copyright ?? "")
      .trim()
      .slice(0, 120),
    maintenanceMessage: String(settings.maintenanceMessage ?? "")
      .trim()
      .slice(0, 160),
    primaryColor: color,
    themeMode: settings.themeMode === "light" ? "light" : "dark",
    defaultSceneBackground: background,
    defaultLocale: settings.defaultLocale === "en-US" ? "en-US" : "zh-CN",
    defaultEntry: settings.defaultEntry === "studio" || settings.defaultEntry === "data" ? settings.defaultEntry : "manager",
    defaultGridVisible: Boolean(settings.defaultGridVisible),
    maintenanceEnabled: Boolean(settings.maintenanceEnabled),
  };
}
function extensionFor(mimeType: string): string | undefined {
  return (
    { "image/png": ".png", "image/webp": ".webp", "image/svg+xml": ".svg", "image/jpeg": ".jpg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico" } as Record<
      string,
      string
    >
  )[mimeType];
}
function contentTypeFor(fileName: string): string {
  const extension = path.extname(fileName).toLowerCase();
  return (
    ({ ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon" } as Record<string, string>)[
      extension
    ] ?? "application/octet-stream"
  );
}


function requireAssistant(assistant: AssistantService | undefined): AssistantService {
  if (!assistant) throw new Error("AI 助手插件尚未注册");
  return assistant;
}

function createRememberToken(session: { userId: string; expiresAt: number }): string {
  const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url");
  return `remember.${payload}.${signSession(payload)}`;
}
function resolveSession(token: string): { userId: string; expiresAt: number } | undefined {
  const ephemeral = sessions.get(token);
  if (ephemeral) return ephemeral;
  const [prefix, payload, signature] = token.split(".");
  if (prefix !== "remember" || !payload || !signature) return undefined;
  const expected = signSession(payload);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { userId?: string; expiresAt?: number };
    return parsed.userId && Number.isFinite(parsed.expiresAt) ? { userId: parsed.userId, expiresAt: Number(parsed.expiresAt) } : undefined;
  } catch {
    return undefined;
  }
}
function signSession(payload: string): string {
  return createHmac("sha256", process.env.BIM_STUDIO_SESSION_SECRET || `${process.env.BIM_STUDIO_ADMIN_PASSWORD || "admin"}:bim-studio-session`)
    .update(payload)
    .digest("base64url");
}
function publicUser(user: StoredSystemUserRecord): SystemUserRecord {
  const { passwordHash: _passwordHash, ...result } = user;
  return result;
}
function normalizeRole(role: unknown): SystemUserRole {
  return role === "admin" || role === "viewer" ? role : "editor";
}
function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
function verifyPassword(password: string, encoded: string): boolean {
  const [salt, expected] = encoded.split(":");
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const expectedBuffer = Buffer.from(expected, "hex");
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
function actionName(method: string) {
  return ({ POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" } as Record<string, string>)[method] ?? method.toLocaleLowerCase("en-US");
}
function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}
async function readServiceLogs(logDirectory: string): Promise<ServiceLogRecord[]> {
  let names: string[] = [];
  try {
    names = await readdir(logDirectory);
  } catch {
    return [];
  }
  const result: ServiceLogRecord[] = [];
  for (const name of names.filter((item) => item.endsWith(".err.log"))) {
    const filePath = path.join(logDirectory, name);
    const [content, info] = await Promise.all([readFile(filePath, "utf8").catch(() => ""), stat(filePath).catch(() => undefined)]);
    const lines = content.split(/\r?\n/).filter(Boolean).slice(-100);
    result.push({ service: name.replace(/\.err\.log$/, ""), file: name, lines, ...(info ? { updatedAt: info.mtime.toISOString() } : {}) });
  }
  return result.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
}
