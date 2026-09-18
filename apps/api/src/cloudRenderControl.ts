import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { cloudRenderPublicationIdentity } from "./cloudRenderPublicationIdentity.js";
import { preferredPublicationRenderer, type PublishedSceneRecord } from "@bim-studio/contracts";
import {
  CLOUD_RENDER_WORKER_CONTRACT_VERSION,
  CLOUD_RENDER_RESOLUTIONS,
  RemoteRenderSession,
  type CloudRenderCapability,
  type CloudRenderControlOverview,
  type CloudRenderPublishedSceneScope,
  type CloudRenderScenePolicy,
  type CloudRenderResolution,
  type CloudRenderWorkerClient,
  type CloudRenderWorkerHealth,
  type CloudRenderWorkerSession,
  type RemoteRenderSessionSnapshot
} from "@bim-studio/server-sdk";

interface PersistedCloudRenderSession {
  sceneId: string;
  snapshot: RemoteRenderSessionSnapshot;
  publicationIdentity?: string;
}

interface CloudRenderRegistryDocument {
  version: 1;
  policies: CloudRenderScenePolicy[];
  sessions: PersistedCloudRenderSession[];
}

export interface CloudRenderRegistry {
  load(): Promise<CloudRenderRegistryDocument>;
  save(document: CloudRenderRegistryDocument): Promise<void>;
}

export interface CloudRenderControlOptions {
  worker?: CloudRenderWorkerClient;
  publicOrigin?: string;
  healthMaxAgeMs?: number;
  mediaEvidenceMaxAgeMs?: number;
  now?: () => Date;
}

export class CloudRenderControlError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
    this.name = "CloudRenderControlError";
  }
}

/**
 * Durable control-plane state. The actual renderer, encoder, WebRTC peer and
 * media counters remain owned by an external GPU worker.
 */
export class CloudRenderControlPlane {
  private readonly worker: CloudRenderWorkerClient | undefined;
  private readonly publicOrigin: string | undefined;
  private readonly healthMaxAgeMs: number;
  private readonly mediaEvidenceMaxAgeMs: number;
  private readonly now: () => Date;
  private policies = new Map<string, CloudRenderScenePolicy>();
  private sessions = new Map<string, RemoteRenderSession>();
  private readonly publicationIdentities = new WeakMap<RemoteRenderSession, string>();
  private initialized = false;
  private readonly startingScenes = new Set<string>();
  private readonly allocatingSessions = new Map<RemoteRenderSession, Promise<void>>();
  private readonly stoppingScenes = new Map<string, { session: RemoteRenderSession; operation: Promise<RemoteRenderSessionSnapshot> }>();
  private readonly policyVersions = new Map<string, number>();
  private persistence: Promise<void> = Promise.resolve();

  constructor(private readonly registry: CloudRenderRegistry, options: CloudRenderControlOptions) {
    this.worker = options.worker;
    this.publicOrigin = options.publicOrigin ? normalizeOrigin(options.publicOrigin) : undefined;
    this.healthMaxAgeMs = bounded(options.healthMaxAgeMs ?? 15_000, 1_000, 120_000);
    this.mediaEvidenceMaxAgeMs = bounded(options.mediaEvidenceMaxAgeMs ?? 15_000, 1_000, 120_000);
    this.now = options.now ?? (() => new Date());
  }

  async init(): Promise<void> {
    const document = await this.registry.load();
    if (document.version !== 1) throw new Error("云渲染控制面数据版本不兼容");
    this.policies = new Map(document.policies.map((policy) => [policy.sceneId, structuredClone(policy)]));
    this.sessions = new Map(document.sessions.map((record) => {
      const session = RemoteRenderSession.restore(record.snapshot);
      if (record.publicationIdentity !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(record.publicationIdentity)) throw new Error("云渲染发布身份损坏");
        this.publicationIdentities.set(session, record.publicationIdentity);
      }
      return [record.sceneId, session];
    }));
    this.initialized = true;
  }

  async overview(publications: readonly PublishedSceneRecord[]): Promise<CloudRenderControlOverview> {
    this.requireInitialized();
    const missingRequirements = this.missingRequirements();
    let worker: CloudRenderWorkerHealth | undefined;
    let workerError: string | undefined;
    if (missingRequirements.length === 0) {
      try { worker = await this.requireHealthyWorker(false); }
      catch (reason) { workerError = errorMessage(reason); }
    }

    await Promise.all(publications.map(async (publication) => {
      const session = this.sessions.get(publication.sceneId);
      if (!session?.snapshot().workerSessionId || !this.worker) return;
      try { await this.refreshSession(publication); }
      catch { /* Overview exposes the persisted failed/signaling state and workerError. */ }
    }));

    return {
      configured: missingRequirements.length === 0,
      missingRequirements,
      ...(worker ? { worker } : {}),
      ...(workerError ? { workerError } : {}),
      scenes: publications
        .map((publication) => {
          const policy = this.policies.get(publication.sceneId);
          const session = this.sessions.get(publication.sceneId)?.snapshot();
          return {
            sceneId: publication.sceneId,
            projectId: publication.projectId,
            name: publication.name,
            publishedAt: publication.publishedAt,
            enabled: policy?.enabled === true,
            resolution: policy?.resolution ?? 1080,
            publicationChanged: Boolean(session && this.publicationIdentities.get(this.sessions.get(publication.sceneId)!) !== cloudRenderPublicationIdentity(publication)),
            ...(session ? { session } : {})
          };
        })
        .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    };
  }

  /** 登录用户（含 viewer）可读的能力快照：只暴露配置状态与 Worker 就绪度，不暴露地址、令牌或会话。 */
  async capability(): Promise<CloudRenderCapability> {
    this.requireInitialized();
    const missingRequirements = this.missingRequirements();
    if (missingRequirements.length > 0) return { configured: false, missingRequirements };
    try {
      const worker = await this.requireHealthyWorker(false);
      return { configured: true, missingRequirements, workerReady: worker.status === "ready" };
    } catch (reason) {
      return { configured: true, missingRequirements, workerReady: false, workerError: errorMessage(reason) };
    }
  }

  async setResolution(publication: PublishedSceneRecord, resolution: unknown): Promise<CloudRenderScenePolicy> {
    if (!CLOUD_RENDER_RESOLUTIONS.includes(resolution as CloudRenderResolution)) {
      throw new CloudRenderControlError("分辨率仅支持 720P、1080P、1440P、2160P", 400, "invalid_resolution");
    }
    return this.setEnabled(publication, this.policies.get(publication.sceneId)?.enabled ?? false, resolution as CloudRenderResolution);
  }

  async setEnabled(publication: PublishedSceneRecord, enabled: boolean, resolution?: CloudRenderResolution): Promise<CloudRenderScenePolicy> {
    this.requireInitialized();
    publication = structuredClone(publication);
    this.assertSessionPublication(publication);
    const version = (this.policyVersions.get(publication.sceneId) ?? 0) + 1;
    this.policyVersions.set(publication.sceneId, version);
    if (!enabled) await this.stopSession(publication.sceneId, publication);
    if (this.policyVersions.get(publication.sceneId) !== version) {
      throw new CloudRenderControlError("云渲染设置已变化，请刷新后重试", 409, "policy_changed");
    }
    const policy: CloudRenderScenePolicy = {
      sceneId: publication.sceneId,
      projectId: publication.projectId,
      enabled,
      resolution: resolution ?? this.policies.get(publication.sceneId)?.resolution ?? 1080,
      updatedAt: this.now().toISOString()
    };
    this.policies.set(publication.sceneId, policy);
    await this.persist();
    return structuredClone(policy);
  }

  async startSession(publication: PublishedSceneRecord, userId: string): Promise<RemoteRenderSessionSnapshot> {
    this.requireInitialized();
    publication = structuredClone(publication);
    cloudRenderPublicationIdentity(publication);
    this.assertSessionPublication(publication);
    if (this.startingScenes.has(publication.sceneId)) throw new CloudRenderControlError("云渲染会话正在启动", 409, "session_exists");
    this.startingScenes.add(publication.sceneId);
    try { return await this.allocateSession(publication, userId); }
    finally { this.startingScenes.delete(publication.sceneId); }
  }

  private async allocateSession(publication: PublishedSceneRecord, userId: string): Promise<RemoteRenderSessionSnapshot> {
    if (!this.policies.get(publication.sceneId)?.enabled) {
      throw new CloudRenderControlError("请先启用该发布场景的云渲染", 409, "scene_disabled");
    }
    const current = this.sessions.get(publication.sceneId)?.snapshot();
    if (current && current.state !== "closed") {
      throw new CloudRenderControlError("该场景仍有云渲染会话，请先停止或处理失败会话", 409, "session_exists");
    }
    const policyVersion = this.policyVersions.get(publication.sceneId) ?? 0;
    const health = await this.requireHealthyWorker(true);
    if (!this.policies.get(publication.sceneId)?.enabled || (this.policyVersions.get(publication.sceneId) ?? 0) !== policyVersion) {
      throw new CloudRenderControlError("启动期间云渲染设置已变化，请重新启动", 409, "policy_changed");
    }
    if (health.capacity.activeSessions >= health.capacity.maxSessions) {
      throw new CloudRenderControlError("GPU Worker 容量已满", 503, "gpu_capacity");
    }
    if (!health.gpu.encoder.hardware) {
      throw new CloudRenderControlError("GPU Worker 未提供硬件编码器", 503, "hardware_encoder_unavailable");
    }
    const session = new RemoteRenderSession({
      sessionId: randomUUID(),
      userId: userId.trim(),
      projectId: publication.projectId,
      publicationId: publication.publishedAt
    }, "local-webgpu");
    session.dispatch({ type: "allocate" });
    this.sessions.set(publication.sceneId, session);
    this.publicationIdentities.set(session, cloudRenderPublicationIdentity(publication));

    // 停止请求必须等创建阶段交付 Worker 身份，不能把 allocating 当成身份丢失。
    const allocation = Promise.resolve().then(() => this.initializeWorkerSession(publication, session, health));
    this.allocatingSessions.set(session, allocation);
    try { await allocation; }
    finally { this.allocatingSessions.delete(session); }
    const stopping = this.stoppingScenes.get(publication.sceneId);
    if (stopping?.session === session) {
      await stopping.operation;
      throw new CloudRenderControlError("启动期间会话已被停止", 409, "session_cancelled");
    }
    return session.snapshot();
  }

  private async initializeWorkerSession(publication: PublishedSceneRecord, session: RemoteRenderSession, health: CloudRenderWorkerHealth): Promise<void> {
    try {
      const response = await this.requireWorker().createSession({
        contractVersion: CLOUD_RENDER_WORKER_CONTRACT_VERSION,
        scope: this.publicationScope(publication),
        render: {
          width: (this.policies.get(publication.sceneId)?.resolution ?? 1080) * 16 / 9,
          height: this.policies.get(publication.sceneId)?.resolution ?? 1080,
          framesPerSecond: 60,
          codecPreferences: preferredCodecs(health)
        }
      });
      this.assertWorkerScope(publication, response);
      session.dispatch({ type: "allocated", workerSessionId: response.workerSessionId, ...(response.viewerUrl ? { viewerUrl: response.viewerUrl } : {}) });
      if (this.stoppingScenes.get(publication.sceneId)?.session !== session) this.applyWorkerState(session, response);
      await this.persist();
    } catch (reason) {
      if (session.snapshot().state !== "failed") session.dispatch({ type: "fail", code: failureCode(reason, "worker_create_failed") });
      await this.persist();
      throw controlError(reason, "GPU Worker 创建会话失败", 502, "worker_create_failed");
    }
  }

  async refreshSession(publication: PublishedSceneRecord): Promise<RemoteRenderSessionSnapshot | undefined> {
    this.requireInitialized();
    const session = this.sessions.get(publication.sceneId);
    if (!session) return undefined;
    publication = structuredClone(publication);
    this.assertSessionIdentity(session, publication);
    const snapshot = session.snapshot();
    if (snapshot.publicationId !== publication.publishedAt) {
      throw new CloudRenderControlError("场景已重新发布，旧云渲染会话必须停止后重建", 409, "publication_changed");
    }
    if (snapshot.projectId !== publication.projectId) throw new CloudRenderControlError("云渲染会话项目不匹配", 409, "publication_changed");
    if (!snapshot.workerSessionId || snapshot.state === "closed" || snapshot.state === "closing") return snapshot;
    try {
      const response = await this.requireWorker().getSession(snapshot.workerSessionId);
      if (this.sessions.get(publication.sceneId) !== session || ["closed", "closing"].includes(session.snapshot().state)) return this.sessions.get(publication.sceneId)?.snapshot();
      this.assertWorkerScope(publication, response);
      this.applyWorkerState(session, response);
      await this.persist();
      return session.snapshot();
    } catch (reason) {
      if (this.sessions.get(publication.sceneId) !== session || ["closed", "closing"].includes(session.snapshot().state)) return this.sessions.get(publication.sceneId)?.snapshot();
      if (session.snapshot().state !== "failed") session.dispatch({ type: "fail", code: failureCode(reason, "worker_status_failed") });
      await this.persist();
      throw controlError(reason, "无法验证云渲染媒体状态", 502, "worker_status_failed");
    }
  }

  async stopSession(sceneId: string, expected?: PublishedSceneRecord): Promise<RemoteRenderSessionSnapshot | undefined> {
    this.requireInitialized();
    const session = this.sessions.get(sceneId);
    if (!session) return undefined;
    const before = session.snapshot();
    if (before.state === "closed") return before;
    if (expected) this.assertSessionIdentity(session, expected);
    if (expected && (before.projectId !== expected.projectId || before.publicationId !== expected.publishedAt)) {
      throw new CloudRenderControlError("云渲染会话已变化，请刷新后重试", 409, "publication_changed");
    }
    const pending = this.stoppingScenes.get(sceneId);
    if (pending?.session === session) return pending.operation;
    const operation = this.closeSession(session);
    this.stoppingScenes.set(sceneId, { session, operation });
    try { return await operation; }
    finally { if (this.stoppingScenes.get(sceneId)?.operation === operation) this.stoppingScenes.delete(sceneId); }
  }

  private async closeSession(session: RemoteRenderSession): Promise<RemoteRenderSessionSnapshot> {
    await this.allocatingSessions.get(session);
    const before = session.snapshot();
    if (!before.workerSessionId) {
      if (before.state !== "failed") session.dispatch({ type: "fail", code: "worker_session_missing" });
      await this.persist();
      throw new CloudRenderControlError("云渲染会话缺少 Worker 标识，无法确认媒体已停止", 502, "worker_session_missing");
    }
    try {
      if (before.state !== "closing") session.dispatch({ type: "close" });
      await this.requireWorker().stopSession(before.workerSessionId);
      session.dispatch({ type: "closed" });
      await this.persist();
      return session.snapshot();
    } catch (reason) {
      session.dispatch({ type: "fail", code: failureCode(reason, "worker_stop_failed") });
      await this.persist();
      throw controlError(reason, "GPU Worker 停止会话失败；不能确认媒体已关闭", 502, "worker_stop_failed");
    }
  }

  private applyWorkerState(session: RemoteRenderSession, response: CloudRenderWorkerSession): void {
    if (response.state === "starting") return;
    if (response.state === "failed") {
      session.dispatch({ type: "fail", code: response.failureCode ?? "worker_failed" });
      return;
    }
    if (response.state === "stopped") {
      if (session.snapshot().state !== "closing") session.dispatch({ type: "close" });
      session.dispatch({ type: "closed" });
      return;
    }
    if (!response.mediaEvidence || !this.isFresh(response.mediaEvidence.observedAt, this.mediaEvidenceMaxAgeMs)) {
      session.dispatch({ type: "fail", code: "stale_or_missing_media_evidence" });
      throw new CloudRenderControlError("Worker 未提供新鲜的 WebRTC outbound-RTP 媒体证据", 502, "media_not_ready");
    }
    session.dispatch({
      type: "media-ready",
      evidence: response.mediaEvidence,
      ...(response.viewerUrl ? { viewerUrl: response.viewerUrl } : {})
    });
    if (response.roundTripLatencyMs !== undefined) {
      session.dispatch({ type: "latency", roundTripLatencyMs: response.roundTripLatencyMs, degradedAboveMs: 180 });
    }
  }

  private assertSessionPublication(publication: PublishedSceneRecord): void {
    const session = this.sessions.get(publication.sceneId);
    if (session && session.snapshot().state !== "closed") this.assertSessionIdentity(session, publication);
  }

  private assertSessionIdentity(session: RemoteRenderSession, publication: PublishedSceneRecord): void {
    const identity = this.publicationIdentities.get(session);
    if (!identity) throw new CloudRenderControlError("旧云渲染会话缺少完整发布身份；请由管理员停止旧会话后重新启动", 409, "publication_identity_missing");
    const snapshot = session.snapshot();
    if (snapshot.projectId !== publication.projectId || snapshot.publicationId !== publication.publishedAt
      || identity !== cloudRenderPublicationIdentity(publication)) {
      throw new CloudRenderControlError("云渲染会话与发布版本不匹配，请刷新后处理", 409, "publication_changed");
    }
  }

  private async requireHealthyWorker(requireCapacity: boolean): Promise<CloudRenderWorkerHealth> {
    const health = await this.requireWorker().health().catch((reason) => {
      throw controlError(reason, "GPU Worker 健康检查失败", 502, "worker_unhealthy");
    });
    if (!this.isFresh(health.observedAt, this.healthMaxAgeMs)) throw new CloudRenderControlError("GPU Worker 健康证据已过期", 503, "stale_worker_health");
    if (health.status !== "ready") throw new CloudRenderControlError(`GPU Worker 当前状态为 ${health.status}`, 503, "worker_not_ready");
    if (requireCapacity && health.capacity.activeSessions >= health.capacity.maxSessions) throw new CloudRenderControlError("GPU Worker 容量已满", 503, "gpu_capacity");
    return health;
  }

  private publicationScope(publication: PublishedSceneRecord): CloudRenderPublishedSceneScope {
    const origin = this.requirePublicOrigin();
    const renderer = preferredPublicationRenderer(publication.snapshot);
    return {
      projectId: publication.projectId,
      sceneId: publication.sceneId,
      publishedAt: publication.publishedAt,
      publicationUrl: new URL(`/api/public/scenes/${encodeURIComponent(publication.sceneId)}`, origin).toString(),
      // 在 Worker 打开页面前读取权威发布快照，避免初始化错误后端后再回切。
      renderUrl: new URL(`/published/${encodeURIComponent(publication.sceneId)}?renderer=${renderer}`, origin).toString()
    };
  }

  private assertWorkerScope(publication: PublishedSceneRecord, response: CloudRenderWorkerSession): void {
    if (response.sceneId !== publication.sceneId || response.publishedAt !== publication.publishedAt) {
      throw new CloudRenderControlError("GPU Worker 返回的发布场景作用域不匹配", 502, "worker_scope_mismatch");
    }
  }

  private missingRequirements(): string[] {
    return [
      ...(!this.worker ? ["CLOUD_RENDER_WORKER_URL / CLOUD_RENDER_WORKER_TOKEN"] : []),
      ...(!this.publicOrigin ? ["CLOUD_RENDER_PUBLIC_ORIGIN"] : [])
    ];
  }

  private requireWorker(): CloudRenderWorkerClient {
    if (!this.worker) throw new CloudRenderControlError("尚未配置真实 GPU Worker 与访问令牌", 503, "worker_not_configured");
    return this.worker;
  }

  private requirePublicOrigin(): string {
    if (!this.publicOrigin) throw new CloudRenderControlError("尚未配置 Worker 可访问的服务器公网地址", 503, "public_origin_not_configured");
    return this.publicOrigin;
  }

  private isFresh(timestamp: string, maximumAgeMs: number): boolean {
    const age = this.now().getTime() - Date.parse(timestamp);
    return Number.isFinite(age) && age >= -5_000 && age <= maximumAgeMs;
  }

  private async persist(): Promise<void> {
    const document: CloudRenderRegistryDocument = {
      version: 1,
      policies: [...this.policies.values()].map((policy) => structuredClone(policy)),
      sessions: [...this.sessions.entries()].map(([sceneId, session]) => {
        const publicationIdentity = this.publicationIdentities.get(session);
        return { sceneId, snapshot: session.snapshot(), ...(publicationIdentity === undefined ? {} : { publicationIdentity }) };
      })
    };
    // 多场景写入共享一个注册表文件，按捕获顺序落盘，避免临时文件碰撞或旧状态覆盖。
    const save = () => this.registry.save(document);
    const operation = this.persistence.then(save, save);
    this.persistence = operation.then(() => undefined, () => undefined);
    await operation;
  }

  private requireInitialized(): void {
    if (!this.initialized) throw new Error("云渲染控制面尚未初始化");
  }
}

export class JsonCloudRenderRegistry implements CloudRenderRegistry {
  private readonly filePath: string;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, "cloud-render-control.json");
  }

  async load(): Promise<CloudRenderRegistryDocument> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as CloudRenderRegistryDocument;
      if (value.version !== 1 || !Array.isArray(value.policies) || !Array.isArray(value.sessions)) throw new Error("云渲染控制面数据损坏");
      return value;
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, policies: [], sessions: [] };
      throw reason;
    }
  }

  async save(document: CloudRenderRegistryDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    await writeFile(temporary, JSON.stringify(document, null, 2), "utf8");
    await rename(temporary, this.filePath);
  }
}

export class MemoryCloudRenderRegistry implements CloudRenderRegistry {
  private document: CloudRenderRegistryDocument = { version: 1, policies: [], sessions: [] };
  async load() { return structuredClone(this.document); }
  async save(document: CloudRenderRegistryDocument) { this.document = structuredClone(document); }
}

function normalizeOrigin(value: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new TypeError("CLOUD_RENDER_PUBLIC_ORIGIN 必须是完整 HTTP(S) URL"); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new TypeError("CLOUD_RENDER_PUBLIC_ORIGIN 必须是无凭据、查询和片段的 HTTP(S) URL");
  }
  return parsed.origin;
}

function preferredCodecs(health: CloudRenderWorkerHealth): Array<"h264" | "h265" | "av1"> {
  const supported = new Set(health.gpu.encoder.codecs);
  return (["h264", "av1", "h265"] as const).filter((codec) => supported.has(codec));
}

function bounded(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.round(Math.min(maximum, Math.max(minimum, value)));
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function failureCode(reason: unknown, fallback: string): string {
  return reason instanceof CloudRenderControlError ? reason.code : fallback;
}

function controlError(reason: unknown, fallbackMessage: string, statusCode: number, code: string): CloudRenderControlError {
  if (reason instanceof CloudRenderControlError) return reason;
  return new CloudRenderControlError(`${fallbackMessage}：${errorMessage(reason)}`, statusCode, code);
}
