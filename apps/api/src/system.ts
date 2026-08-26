import { createHmac, randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import { Socket } from "node:net";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { AiAssistantResponse, AiProviderSettings, AuditLogRecord, SceneDashboardState, ServiceHealthRecord, ServiceLogRecord, StoredSystemUserRecord, SystemBrandingSettings, SystemUserRecord, SystemUserRole } from "@bim-studio/contracts";
import type { MetadataStore } from "./store.js";

declare module "fastify" {
  interface FastifyRequest { systemUser?: SystemUserRecord; }
}

const sessions = new Map<string, { userId: string; expiresAt: number }>();
const SESSION_LIFETIME = 12 * 60 * 60 * 1_000;
const REMEMBER_SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1_000;

export async function registerSystemRoutes(app: FastifyInstance, store: MetadataStore, dataDir: string): Promise<void> {
  const brandingDirectory = path.join(dataDir, "branding");
  if (store.listUsers().length === 0) {
    const now = new Date().toISOString();
    await store.saveUser({ id: randomUUID(), username: "admin", displayName: "系统管理员", role: "admin", projectIds: [], enabled: true, passwordHash: hashPassword(process.env.BIM_STUDIO_ADMIN_PASSWORD ?? "admin"), createdAt: now, updatedAt: now });
  }

  app.addHook("preHandler", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname === "/health" || pathname === "/api/meta" || pathname === "/api/auth/login" || pathname.startsWith("/api/public/") || pathname.startsWith("/assets/")) return;
    if (!pathname.startsWith("/api/")) return;
    const token = authToken(request);
    const session = token ? resolveSession(token) : undefined;
    if (!session || session.expiresAt <= Date.now()) {
      if (token) sessions.delete(token);
      return reply.code(401).send({ message: "请先登录 iTwin Studio" });
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
    const aiReadAction = pathname === "/api/ai/assistant" || pathname === "/api/ai/assistant/stream";
    if (stored.role === "viewer" && !["GET", "HEAD"].includes(request.method) && !aiReadAction) return reply.code(403).send({ message: "浏览者不能修改数据" });
  });

  app.addHook("onResponse", async (request, reply) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (!pathname.startsWith("/api/") || pathname.startsWith("/api/admin/audit")) return;
    if (["GET", "HEAD"].includes(request.method) && reply.statusCode < 400) return;
    const record: AuditLogRecord = {
      id: randomUUID(), ...(request.systemUser ? { userId: request.systemUser.id, username: request.systemUser.username } : {}),
      action: reply.statusCode >= 400 ? "error" : actionName(request.method), resource: pathname,
      method: request.method, statusCode: reply.statusCode, ip: request.ip,
      ...(reply.statusCode >= 400 ? { detail: `HTTP ${reply.statusCode}` } : {}), createdAt: new Date().toISOString()
    };
    await store.addAuditLog(record).catch((error) => request.log.error(error));
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
    const user: StoredSystemUserRecord = { id: randomUUID(), username, displayName: request.body.displayName?.trim() || username, role: normalizeRole(request.body.role), projectIds: request.body.projectIds ?? [], enabled: true, passwordHash: hashPassword(request.body.password), createdAt: now, updatedAt: now };
    return reply.code(201).send(publicUser(await store.saveUser(user)));
  });
  app.patch<{ Params: { userId: string }; Body: Partial<SystemUserRecord> & { password?: string } }>("/api/admin/users/:userId", async (request, reply) => {
    const current = store.getUser(request.params.userId);
    if (!current) return reply.code(404).send({ message: "用户不存在" });
    const updated: StoredSystemUserRecord = { ...current, ...(request.body.displayName !== undefined ? { displayName: request.body.displayName.trim() || current.username } : {}), ...(request.body.role ? { role: normalizeRole(request.body.role) } : {}), ...(request.body.projectIds ? { projectIds: request.body.projectIds } : {}), ...(request.body.enabled !== undefined ? { enabled: request.body.enabled } : {}), ...(request.body.password ? { passwordHash: hashPassword(request.body.password) } : {}), updatedAt: new Date().toISOString() };
    return publicUser(await store.saveUser(updated));
  });
  app.delete<{ Params: { userId: string } }>("/api/admin/users/:userId", async (request, reply) => {
    if (request.systemUser?.id === request.params.userId) return reply.code(400).send({ message: "不能删除当前登录用户" });
    const target = store.getUser(request.params.userId);
    if (!target) return reply.code(404).send({ message: "用户不存在" });
    if (target.role === "admin" && store.listUsers().filter((item) => item.role === "admin" && item.enabled).length <= 1) return reply.code(400).send({ message: "至少保留一个管理员" });
    await store.removeUser(request.params.userId);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { limit?: string } }>("/api/admin/audit", async (request) => store.listAuditLogs(Math.min(500, Number(request.query.limit ?? 200))));
  app.get("/api/admin/logs", async () => readServiceLogs(path.join(dataDir, "logs")));
  app.get("/api/admin/health", async () => Promise.all([
    healthyApi(), healthyVision(), checkTcp("web", "Web 前端", 5173, "https://localhost:5173"),
    checkTcp("media", "实时视频", 9997, "HLS :8888 · WebRTC :8889"), checkTcp("postgres", "PostgreSQL", 5432, "127.0.0.1:5432"), checkTcp("minio", "对象存储", 9000, "127.0.0.1:9000")
  ]));

  app.get("/api/public/branding", async () => resolveBrandingSettings(store));
  app.get<{ Params: { fileName: string } }>("/api/public/branding/assets/:fileName", async (request, reply) => {
    const fileName = path.basename(request.params.fileName);
    const filePath = path.join(brandingDirectory, fileName);
    try {
      const content = await readFile(filePath);
      reply.type(contentTypeFor(fileName));
      return content;
    } catch { return reply.code(404).send({ message: "品牌资源不存在" }); }
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
    const baseUrl = request.body.baseUrl?.trim() ?? current.baseUrl;
    try { new URL(baseUrl); } catch { return reply.code(400).send({ message: "大模型 URL 无效" }); }
    const next = { baseUrl: baseUrl.replace(/\/$/, ""), model: request.body.model?.trim() || current.model, protocol: normalizeAiProtocol(request.body.protocol ?? current.protocol), apiKey: request.body.apiKey?.trim() || current.apiKey, temperature: clamp(Number(request.body.temperature ?? current.temperature), 0, 2), updatedAt: new Date().toISOString() };
    return store.saveAiSettings(next);
  });
  app.post("/api/admin/ai-settings/test", async (_request, reply) => {
    try { const result = await callAssistant(store, "scene", "只回复：连接成功", {}); return { ok: true, model: result.model }; }
    catch (reason) { return reply.code(502).send({ message: reason instanceof Error ? reason.message : String(reason) }); }
  });

  app.post<{ Body: { mode?: "bim" | "scene" | "component" | "dashboard" | "sql"; question?: string; context?: unknown } }>("/api/ai/assistant", async (request, reply) => {
    const question = request.body?.question?.trim();
    if (!question) return reply.code(400).send({ message: "请输入问题或生成要求" });
    try { return await callAssistant(store, request.body.mode ?? "scene", question, request.body.context ?? {}); }
    catch (reason) { return reply.code(502).send({ message: reason instanceof Error ? reason.message : String(reason) }); }
  });
  app.post<{ Body: { mode?: "bim" | "scene" | "component" | "dashboard" | "sql"; question?: string; context?: unknown } }>("/api/ai/assistant/stream", async (request, reply) => {
    const question = request.body?.question?.trim();
    if (!question) return reply.code(400).send({ message: "请输入问题或生成要求" });
    try {
      await streamAssistant(reply.raw, store, request.body.mode ?? "scene", question, request.body.context ?? {});
      return reply.hijack();
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason);
      if (reply.raw.headersSent) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        reply.raw.end();
        return reply.hijack();
      }
      return reply.code(502).send({ message });
    }
  });
}

function authToken(request: FastifyRequest): string | undefined {
  const bearer = request.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (bearer) return bearer;
  const rawProtocols = request.headers["sec-websocket-protocol"];
  const protocols = (Array.isArray(rawProtocols) ? rawProtocols.join(",") : rawProtocols ?? "").split(",").map((value) => value.trim());
  return protocols.find((value) => value.startsWith("bim-studio-auth."))?.slice("bim-studio-auth.".length);
}

const DEFAULT_BRANDING: SystemBrandingSettings = {
  systemName: "iTwin Studio",
  browserTitle: "iTwin Studio",
  loginSubtitle: "数字孪生场景平台",
  copyright: "Copyright © 张文鹏 Charlie",
  logoUrl: "/brand/logo-transparent.png",
  iconUrl: "/brand/app-icon.png",
  primaryColor: "#d6aa4d",
  defaultLocale: "zh-CN",
  defaultEntry: "manager",
  defaultSceneBackground: "#202a31",
  defaultGridVisible: true,
  maintenanceEnabled: false,
  maintenanceMessage: "系统维护中，请稍后再试"
};

function resolveBrandingSettings(store: MetadataStore): SystemBrandingSettings {
  const stored = store.getBrandingSettings();
  const migrated = stored
    ? {
        ...stored,
        systemName: stored.systemName === "BIM Studio" || stored.systemName === "Dev Studio" ? DEFAULT_BRANDING.systemName : stored.systemName,
        browserTitle: stored.browserTitle === "BIM Studio" || stored.browserTitle === "Dev Studio" ? DEFAULT_BRANDING.browserTitle : stored.browserTitle
      }
    : undefined;
  return normalizeBrandingSettings({ ...DEFAULT_BRANDING, ...migrated });
}
function normalizeBrandingSettings(settings: SystemBrandingSettings): SystemBrandingSettings {
  const color = /^#[0-9a-f]{6}$/i.test(settings.primaryColor) ? settings.primaryColor : DEFAULT_BRANDING.primaryColor;
  const background = /^#[0-9a-f]{6}$/i.test(settings.defaultSceneBackground) ? settings.defaultSceneBackground : DEFAULT_BRANDING.defaultSceneBackground;
  return { ...DEFAULT_BRANDING, ...settings, systemName: String(settings.systemName ?? "").trim().slice(0, 60), browserTitle: String(settings.browserTitle ?? "").trim().slice(0, 80), loginSubtitle: String(settings.loginSubtitle ?? "").trim().slice(0, 100), copyright: String(settings.copyright ?? "").trim().slice(0, 120), maintenanceMessage: String(settings.maintenanceMessage ?? "").trim().slice(0, 160), primaryColor: color, defaultSceneBackground: background, defaultLocale: settings.defaultLocale === "en-US" ? "en-US" : "zh-CN", defaultEntry: settings.defaultEntry === "studio" || settings.defaultEntry === "data" ? settings.defaultEntry : "manager", defaultGridVisible: Boolean(settings.defaultGridVisible), maintenanceEnabled: Boolean(settings.maintenanceEnabled) };
}
function extensionFor(mimeType: string): string | undefined { return ({ "image/png": ".png", "image/webp": ".webp", "image/svg+xml": ".svg", "image/jpeg": ".jpg", "image/x-icon": ".ico", "image/vnd.microsoft.icon": ".ico" } as Record<string, string>)[mimeType]; }
function contentTypeFor(fileName: string): string { const extension = path.extname(fileName).toLowerCase(); return ({ ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon" } as Record<string, string>)[extension] ?? "application/octet-stream"; }

async function callAssistant(store: MetadataStore, mode: "bim" | "scene" | "component" | "dashboard" | "sql", question: string, context: unknown): Promise<AiAssistantResponse> {
  const settings = resolveAiSettings(store);
  if (!settings.apiKey) throw new Error("尚未配置大模型 API Key");
  const { systemPrompt, userPrompt } = assistantPrompts(mode, question, context);
  let content = "";
  if (settings.protocol === "responses") {
    content = await callResponsesApi(settings, systemPrompt, userPrompt, outputLimit(mode));
  } else {
    const chatResponse = await fetch(`${settings.baseUrl}/chat/completions`, { method: "POST", headers: aiHeaders(settings.apiKey), body: JSON.stringify({ model: settings.model, temperature: settings.temperature, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] }), signal: AbortSignal.timeout(90_000) });
    const chatBody = await chatResponse.json().catch(() => undefined) as { choices?: Array<{ message?: { content?: string } }>; error?: { code?: string; message?: string } } | undefined;
    content = chatBody?.choices?.[0]?.message?.content?.trim() ?? "";
    if (!chatResponse.ok && settings.protocol === "auto" && shouldUseResponses(chatResponse.status, chatBody?.error)) {
      content = await callResponsesApi(settings, systemPrompt, userPrompt, outputLimit(mode));
    } else if (!chatResponse.ok) {
      throw new Error(chatBody?.error?.message ?? `大模型请求失败：HTTP ${chatResponse.status}`);
    }
  }
  if (!content) throw new Error("大模型没有返回内容");
  return parseAssistantContent(mode, content, settings.model);
}

function assistantPrompts(mode: "bim" | "scene" | "component" | "dashboard" | "sql", question: string, context: unknown) {
  const modeInstruction = mode === "bim"
    ? "你是可验证的 BIM 工程问答助手，服务 BIM 工程师、工厂甲方、土建厂务和电气/机电人员。只可依据上下文的 bimEvidence 回答：构件与系统统计、设备台账及位置、楼层/房间/区域、材料与参数、几何尺寸/标高/净空、设备试放、供配电与回路、给排水/HVAC/消防/工艺管线等模型中已有信息。必须区分：元数据中的精确值、由几何包围盒计算的值、名称或类别推断、信息不足。禁止补造工程量、属性、系统拓扑、构件或空间。回答先给一针见血的结论，再列关键证据（构件名称及 stableId）；涉及尺寸统一使用米并可附毫米；placement 是轴对齐包围盒初筛，必须说明不是施工级碰撞、规范或检修空间结论。matchCount 是全量匹配数，matches 只是用于展示的前若干条。若用户询问规范符合性、负荷计算、压降、短路电流、结构承载、消防疏散等，模型证据不足时只能列出已知参数与仍需的输入，不能替代专业计算。信息不足时明确告诉用户应选择构件、补充编号或导入相应元数据。"
    : mode === "dashboard"
    ? "输出严格 JSON：{\"text\":\"说明\",\"dashboard\":{\"enabled\":true,\"dock\":\"right\",\"width\":410,\"collapsed\":false,\"widgets\":[]}}。widgets 仅使用 value、gauge、line、area、bar、pie、table、status，必须包含 id,title,key,type,unit,x,y,w,h,color。"
    : mode === "sql"
      ? "你是 SQL 助手。根据上下文中的数据库类型、数据连接和数据集字段生成 SQL。默认只生成 SELECT/CTE/EXPLAIN 等只读语句，禁止 INSERT、UPDATE、DELETE、DROP、ALTER、TRUNCATE。回答先给可直接复制的 SQL 代码块，再简要解释字段、参数和性能注意事项；信息不足时明确列出需要补充的表或字段。不要虚构不存在的表和字段。"
      : "用中文简洁回答，并优先给出可执行操作建议。";
  const systemPrompt = `你是 iTwin Studio 数字孪生助手。当前模式：${mode}。${modeInstruction}`;
  const userPrompt = `${question}\n\n当前上下文：${JSON.stringify(context).slice(0, 80_000)}`;
  return { systemPrompt, userPrompt };
}

function parseAssistantContent(mode: "bim" | "scene" | "component" | "dashboard" | "sql", content: string, model: string): AiAssistantResponse {
  if (mode !== "dashboard") return { text: content, model };
  try {
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { text?: string; dashboard?: SceneDashboardState };
    return { text: parsed.text ?? "已生成看板方案", ...(parsed.dashboard ? { dashboard: parsed.dashboard } : {}), model };
  } catch { return { text: content, model }; }
}

async function streamAssistant(raw: import("node:http").ServerResponse, store: MetadataStore, mode: "bim" | "scene" | "component" | "dashboard" | "sql", question: string, context: unknown): Promise<void> {
  const settings = resolveAiSettings(store);
  if (!settings.apiKey) throw new Error("尚未配置大模型 API Key");
  const { systemPrompt, userPrompt } = assistantPrompts(mode, question, context);
  const responsesBody = { model: settings.model, instructions: systemPrompt, input: userPrompt, stream: true, max_output_tokens: outputLimit(mode), ...(settings.model.toLowerCase().startsWith("gpt-5") ? { reasoning: { effort: "low" } } : {}) };
  const chatBody = { model: settings.model, temperature: settings.temperature, stream: true, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }] };
  let useResponses = settings.protocol === "responses";
  let upstream = await fetch(`${settings.baseUrl}/${useResponses ? "responses" : "chat/completions"}`, { method: "POST", headers: aiHeaders(settings.apiKey), body: JSON.stringify(useResponses ? responsesBody : chatBody), signal: AbortSignal.timeout(90_000) });
  if (!upstream.ok && settings.protocol === "auto") {
    const failed = await upstream.json().catch(() => undefined) as { error?: { code?: string; message?: string } } | undefined;
    if (shouldUseResponses(upstream.status, failed?.error)) {
      useResponses = true;
      upstream = await fetch(`${settings.baseUrl}/responses`, { method: "POST", headers: aiHeaders(settings.apiKey), body: JSON.stringify(responsesBody), signal: AbortSignal.timeout(90_000) });
    } else {
      throw new Error(failed?.error?.message ?? `大模型请求失败：HTTP ${upstream.status}`);
    }
  }
  if (!upstream.ok) {
    const failed = await upstream.json().catch(() => undefined) as { error?: { message?: string } } | undefined;
    throw new Error(failed?.error?.message ?? `大模型请求失败：HTTP ${upstream.status}`);
  }
  if (!upstream.body) throw new Error("大模型未返回流式响应");
  raw.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
  raw.flushHeaders();
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = events.pop() ?? "";
    for (const event of events) {
      const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (!data || data === "[DONE]") continue;
      const parsed = JSON.parse(data) as { type?: string; delta?: string; choices?: Array<{ delta?: { content?: string } }> };
      const delta = parsed.type === "response.output_text.delta" ? parsed.delta : parsed.choices?.[0]?.delta?.content;
      if (!delta) continue;
      content += delta;
      raw.write(`event: delta\ndata: ${JSON.stringify({ delta })}\n\n`);
    }
    if (done) break;
  }
  if (!content) throw new Error("大模型没有返回内容");
  raw.write(`event: done\ndata: ${JSON.stringify(parseAssistantContent(mode, content, settings.model))}\n\n`);
  raw.end();
}

function outputLimit(mode: "bim" | "scene" | "component" | "dashboard" | "sql") { return mode === "dashboard" ? 2_500 : mode === "bim" ? 1_800 : 1_200; }
function shouldUseResponses(status: number, error?: { code?: string; message?: string }) { return error?.code === "protocol_not_supported" || status === 404 || /responses?\s*api|不支持.*chat/i.test(error?.message ?? ""); }

function aiHeaders(apiKey: string): Record<string, string> { return { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` }; }
async function callResponsesApi(settings: ReturnType<typeof resolveAiSettings>, instructions: string, input: string, maxOutputTokens: number): Promise<string> {
  const response = await fetch(`${settings.baseUrl}/responses`, {
    method: "POST",
    headers: aiHeaders(settings.apiKey),
    body: JSON.stringify({
      model: settings.model,
      instructions,
      input,
      max_output_tokens: maxOutputTokens,
      ...(settings.model.toLowerCase().startsWith("gpt-5") ? { reasoning: { effort: "low" } } : {})
    }),
    signal: AbortSignal.timeout(90_000)
  });
  const body = await response.json().catch(() => undefined) as { output_text?: string; output?: Array<{ content?: Array<{ type?: string; text?: string }> }>; error?: { message?: string } } | undefined;
  if (!response.ok) throw new Error(body?.error?.message ?? `大模型请求失败：HTTP ${response.status}`);
  return body?.output_text?.trim() ?? body?.output?.flatMap((item) => item.content ?? []).find((item) => item.type === "output_text")?.text?.trim() ?? "";
}

function resolveAiSettings(store: MetadataStore) {
  const saved = store.getAiSettings();
  return { baseUrl: saved?.baseUrl || process.env.AI_BASE_URL || "https://api.openai.com/v1", model: saved?.model || process.env.AI_MODEL || "gpt-4.1-mini", protocol: normalizeAiProtocol(saved?.protocol || process.env.AI_PROTOCOL), apiKey: saved?.apiKey || process.env.AI_API_KEY || "", temperature: saved?.temperature ?? Number(process.env.AI_TEMPERATURE ?? 0.2), updatedAt: saved?.updatedAt };
}
function publicAiSettings(settings: ReturnType<typeof resolveAiSettings>): AiProviderSettings { return { baseUrl: settings.baseUrl, model: settings.model, protocol: settings.protocol, temperature: settings.temperature, apiKeyConfigured: Boolean(settings.apiKey), ...(settings.updatedAt ? { updatedAt: settings.updatedAt } : {}) }; }
function normalizeAiProtocol(value: unknown): AiProviderSettings["protocol"] { return value === "responses" || value === "chat-completions" ? value : "auto"; }
function createRememberToken(session: { userId: string; expiresAt: number }): string { const payload = Buffer.from(JSON.stringify(session), "utf8").toString("base64url"); return `remember.${payload}.${signSession(payload)}`; }
function resolveSession(token: string): { userId: string; expiresAt: number } | undefined { const ephemeral = sessions.get(token); if (ephemeral) return ephemeral; const [prefix, payload, signature] = token.split("."); if (prefix !== "remember" || !payload || !signature) return undefined; const expected = signSession(payload); const actualBytes = Buffer.from(signature); const expectedBytes = Buffer.from(expected); if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return undefined; try { const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { userId?: string; expiresAt?: number }; return parsed.userId && Number.isFinite(parsed.expiresAt) ? { userId: parsed.userId, expiresAt: Number(parsed.expiresAt) } : undefined; } catch { return undefined; } }
function signSession(payload: string): string { return createHmac("sha256", process.env.BIM_STUDIO_SESSION_SECRET || `${process.env.BIM_STUDIO_ADMIN_PASSWORD || "admin"}:bim-studio-session`).update(payload).digest("base64url"); }
function publicUser(user: StoredSystemUserRecord): SystemUserRecord { const { passwordHash: _passwordHash, ...result } = user; return result; }
function normalizeRole(role: unknown): SystemUserRole { return role === "admin" || role === "viewer" ? role : "editor"; }
function hashPassword(password: string): string { const salt = randomBytes(16).toString("hex"); return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`; }
function verifyPassword(password: string, encoded: string): boolean { const [salt, expected] = encoded.split(":"); if (!salt || !expected) return false; const actual = scryptSync(password, salt, 64); const expectedBuffer = Buffer.from(expected, "hex"); return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer); }
function actionName(method: string) { return ({ POST: "create", PUT: "update", PATCH: "update", DELETE: "delete" } as Record<string, string>)[method] ?? method.toLocaleLowerCase("en-US"); }
function clamp(value: number, min: number, max: number) { return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min)); }
function healthyApi(): ServiceHealthRecord { return { id: "api", name: "API 服务", status: "healthy", endpoint: "http://127.0.0.1:4100", latencyMs: 0, checkedAt: new Date().toISOString() }; }
function healthyVision(): ServiceHealthRecord { return { id: "vision", name: "视觉推理", status: "healthy", endpoint: "ONNX Runtime", latencyMs: 0, checkedAt: new Date().toISOString() }; }
async function checkTcp(id: ServiceHealthRecord["id"], name: string, port: number, endpoint: string): Promise<ServiceHealthRecord> { const started = performance.now(); const ok = await new Promise<boolean>((resolve) => { const socket = new Socket(); const done = (value: boolean) => { socket.destroy(); resolve(value); }; socket.setTimeout(800); socket.once("connect", () => done(true)); socket.once("timeout", () => done(false)); socket.once("error", () => done(false)); socket.connect(port, "127.0.0.1"); }); return { id, name, status: ok ? "healthy" : "offline", endpoint, latencyMs: Math.round(performance.now() - started), ...(ok ? {} : { message: "服务未监听" }), checkedAt: new Date().toISOString() }; }
async function readServiceLogs(logDirectory: string): Promise<ServiceLogRecord[]> { let names: string[] = []; try { names = await readdir(logDirectory); } catch { return []; } const result: ServiceLogRecord[] = []; for (const name of names.filter((item) => item.endsWith(".err.log"))) { const filePath = path.join(logDirectory, name); const [content, info] = await Promise.all([readFile(filePath, "utf8").catch(() => ""), stat(filePath).catch(() => undefined)]); const lines = content.split(/\r?\n/).filter(Boolean).slice(-100); result.push({ service: name.replace(/\.err\.log$/, ""), file: name, lines, ...(info ? { updatedAt: info.mtime.toISOString() } : {}) }); } return result.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt))); }
