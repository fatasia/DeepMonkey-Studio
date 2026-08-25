import { randomBytes, randomUUID } from "node:crypto";
import {
  CLOUD_RENDER_WORKER_CONTRACT_VERSION,
  assertCloudRenderWorkerSessionRequest,
  type CloudRenderWorkerHealth,
  type CloudRenderWorkerSession,
  type CloudRenderWorkerSessionRequest
} from "@bim-studio/server-sdk";
import type { CloudRenderWorkerConfig } from "./config.js";
import type { RenderRuntime, RenderRuntimeSession } from "./chromiumRuntime.js";

interface ManagedSession {
  id: string;
  viewerToken: string;
  request: CloudRenderWorkerSessionRequest;
  runtime: RenderRuntimeSession | undefined;
  initializing: Promise<void>;
  closing: boolean;
  state: "starting" | "failed";
  failureCode?: string;
}

export class WorkerRequestError extends Error {
  constructor(message: string, readonly statusCode: number, readonly code: string) {
    super(message);
    this.name = "WorkerRequestError";
  }
}

export class CloudRenderSessionManager {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(private readonly config: CloudRenderWorkerConfig, private readonly runtime: RenderRuntime) {}

  health(): CloudRenderWorkerHealth {
    return this.runtime.health(this.sessions.size);
  }

  async create(request: CloudRenderWorkerSessionRequest): Promise<CloudRenderWorkerSession> {
    try { assertCloudRenderWorkerSessionRequest(request); }
    catch (reason) { throw new WorkerRequestError(message(reason), 400, "invalid_session_request"); }
    const health = this.health();
    if (health.status !== "ready" || !health.gpu.encoder.hardware) throw new WorkerRequestError("GPU 硬件编码器不可用", 503, "hardware_encoder_unavailable");
    if (health.capacity.activeSessions >= health.capacity.maxSessions) throw new WorkerRequestError("GPU Worker 容量已满", 503, "gpu_capacity");
    if (!request.render.codecPreferences.some((codec) => health.gpu.encoder.codecs.includes(codec))) {
      throw new WorkerRequestError("请求编码与 GPU 硬件编码能力不匹配", 422, "codec_unavailable");
    }
    const id = randomUUID();
    const viewerToken = randomBytes(24).toString("base64url");
    const session: ManagedSession = {
      id,
      viewerToken,
      request: structuredClone(request),
      runtime: undefined,
      initializing: Promise.resolve(),
      closing: false,
      state: "starting"
    };
    this.sessions.set(id, session);
    session.initializing = this.runtime.create(request).then((runtime) => {
      session.runtime = runtime;
    }).catch((reason) => {
      session.state = "failed";
      session.failureCode = `render_boot_failed:${safeFailureDetail(reason)}`;
    });
    return this.snapshot(session);
  }

  async get(id: string): Promise<CloudRenderWorkerSession> {
    const session = this.require(id);
    if (session.state === "failed") return this.snapshot(session);
    if (!session.runtime) return this.snapshot(session);
    try {
      const result = await session.runtime.mediaEvidence();
      if (result.state === "failed") {
        session.state = "failed";
        session.failureCode = result.code;
        return this.snapshot(session);
      }
      if (result.state === "media-ready") return { ...this.snapshot(session), state: "media-ready", mediaEvidence: result.evidence };
      return this.snapshot(session);
    } catch (reason) {
      session.state = "failed";
      session.failureCode = "media_stats_failed";
      return this.snapshot(session);
    }
  }

  async offer(id: string, viewerToken: string): Promise<RTCSessionDescriptionInit> {
    const session = this.requireViewer(id, viewerToken);
    await session.initializing;
    if (!session.runtime) throw new WorkerRequestError("渲染页仍未就绪", 409, session.failureCode ?? "render_starting");
    return structuredClone(session.runtime.offer);
  }

  async answer(id: string, viewerToken: string, answer: RTCSessionDescriptionInit): Promise<void> {
    const session = this.requireViewer(id, viewerToken);
    await session.initializing;
    if (!session.runtime) throw new WorkerRequestError("渲染页仍未就绪", 409, session.failureCode ?? "render_starting");
    try { await session.runtime.applyAnswer(answer); }
    catch (reason) { throw new WorkerRequestError(`WebRTC answer 应用失败：${message(reason)}`, 400, "invalid_webrtc_answer"); }
  }

  async stop(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.closing = true;
    await session.initializing;
    await session.runtime?.close();
    this.sessions.delete(id);
    return true;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.sessions.values()].map(async (session) => {
      session.closing = true;
      await session.initializing;
      await session.runtime?.close();
    }));
    this.sessions.clear();
    await this.runtime.close();
  }

  private snapshot(session: ManagedSession): CloudRenderWorkerSession {
    return {
      contractVersion: CLOUD_RENDER_WORKER_CONTRACT_VERSION,
      workerSessionId: session.id,
      sceneId: session.request.scope.sceneId,
      publishedAt: session.request.scope.publishedAt,
      state: session.state,
      viewerUrl: `${new URL(`/viewer/${encodeURIComponent(session.id)}`, this.config.publicOrigin).toString()}#token=${encodeURIComponent(session.viewerToken)}`,
      ...(session.failureCode ? { failureCode: session.failureCode } : {})
    };
  }

  private require(id: string): ManagedSession {
    const session = this.sessions.get(id);
    if (!session) throw new WorkerRequestError("云渲染 Worker 会话不存在", 404, "session_not_found");
    return session;
  }

  private requireViewer(id: string, token: string): ManagedSession {
    const session = this.require(id);
    if (!timingSafeEqual(session.viewerToken, token)) throw new WorkerRequestError("观看令牌无效", 403, "viewer_forbidden");
    return session;
  }
}

function timingSafeEqual(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let mismatch = 0;
  for (let index = 0; index < expected.length; index += 1) mismatch |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  return mismatch === 0;
}

function message(reason: unknown): string { return reason instanceof Error ? reason.message : String(reason); }
function safeFailureDetail(reason: unknown): string { return message(reason).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 80) || "unknown"; }
