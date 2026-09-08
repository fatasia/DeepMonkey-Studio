import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { preferredPublicationRenderer, type PublishedSceneRecord } from "@bim-studio/contracts";
import {
  CLOUD_RENDER_WORKER_CONTRACT_VERSION,
  RemoteRenderSession,
  type CloudRenderCapability,
  type CloudRenderControlOverview,
  type CloudRenderPublishedSceneScope,
  type CloudRenderScenePolicy,
  type CloudRenderWorkerClient,
  type CloudRenderWorkerHealth,
  type CloudRenderWorkerSession,
  type RemoteRenderSessionSnapshot
} from "@bim-studio/server-sdk";

interface PersistedCloudRenderSession {
  sceneId: string;
  snapshot: RemoteRenderSessionSnapshot;
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
  private initialized = false;

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
    this.sessions = new Map(document.sessions.map((record) => [record.sceneId, RemoteRenderSession.restore(record.snapshot)]));
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
            publicationChanged: Boolean(session && session.publicationId !== publication.publishedAt),
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

  async setEnabled(publication: PublishedSceneRecord, enabled: boolean): Promise<CloudRenderScenePolicy> {
    this.requireInitialized();
    if (!enabled) await this.stopSession(publication.sceneId);
    const policy: CloudRenderScenePolicy = {
      sceneId: publication.sceneId,
      projectId: publication.projectId,
      enabled,
      updatedAt: this.now().toISOString()
    };
    this.policies.set(publication.sceneId, policy);
    await this.persist();
    return structuredClone(policy);
  }

  async startSession(publication: PublishedSceneRecord, userId: string): Promise<RemoteRenderSessionSnapshot> {
    this.requireInitialized();
    if (!this.policies.get(publication.sceneId)?.enabled) {
      throw new CloudRenderControlError("请先启用该发布场景的云渲染", 409, "scene_disabled");
    }
    const current = this.sessions.get(publication.sceneId)?.snapshot();
    if (current && current.state !== "closed") {
      throw new CloudRenderControlError("该场景仍有云渲染会话，请先停止或处理失败会话", 409, "session_exists");
    }
    const health = await this.requireHealthyWorker(true);
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

    try {
      const response = await this.requireWorker().createSession({
        contractVersion: CLOUD_RENDER_WORKER_CONTRACT_VERSION,
        scope: this.publicationScope(publication),
        render: {
          width: 1920,
          height: 1080,
          framesPerSecond: 60,
          codecPreferences: preferredCodecs(health)
        }
      });
      this.assertWorkerScope(publication, response);
      session.dispatch({ type: "allocated", workerSessionId: response.workerSessionId, ...(response.viewerUrl ? { viewerUrl: response.viewerUrl } : {}) });
      this.applyWorkerState(session, response);
      await this.persist();
      return session.snapshot();
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
    const snapshot = session.snapshot();
    if (snapshot.publicationId !== publication.publishedAt) {
      if (snapshot.state !== "failed" && snapshot.state !== "closed") session.dispatch({ type: "fail", code: "publication_changed" });
      await this.persist();
      throw new CloudRenderControlError("场景已重新发布，旧云渲染会话必须停止后重建", 409, "publication_changed");
    }
    if (!snapshot.workerSessionId || snapshot.state === "closed") return snapshot;
    try {
      const response = await this.requireWorker().getSession(snapshot.workerSessionId);
      this.assertWorkerScope(publication, response);
      this.applyWorkerState(session, response);
      await this.persist();
      return session.snapshot();
    } catch (reason) {
      if (session.snapshot().state !== "failed") session.dispatch({ type: "fail", code: failureCode(reason, "worker_status_failed") });
      await this.persist();
      throw controlError(reason, "无法验证云渲染媒体状态", 502, "worker_status_failed");
    }
  }

  async stopSession(sceneId: string): Promise<RemoteRenderSessionSnapshot | undefined> {
    this.requireInitialized();
    const session = this.sessions.get(sceneId);
    if (!session) return undefined;
    const before = session.snapshot();
    if (before.state === "closed") return before;
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
    await this.registry.save({
      version: 1,
      policies: [...this.policies.values()].map((policy) => structuredClone(policy)),
      sessions: [...this.sessions.entries()].map(([sceneId, session]) => ({ sceneId, snapshot: session.snapshot() }))
    });
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
