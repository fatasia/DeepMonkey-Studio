import { assertRemoteRenderMediaEvidence, type RemoteRenderMediaEvidence, type RemoteRenderSessionSnapshot } from "./remoteRenderSession.js";

export const CLOUD_RENDER_WORKER_CONTRACT_VERSION = 1 as const;

export interface CloudRenderWorkerHealth {
  contractVersion: typeof CLOUD_RENDER_WORKER_CONTRACT_VERSION;
  workerId: string;
  status: "ready" | "draining" | "unavailable";
  observedAt: string;
  capacity: { maxSessions: number; activeSessions: number };
  gpu: {
    vendor: string;
    model: string;
    memoryMiB: number;
    encoder: {
      hardware: boolean;
      codecs: Array<"h264" | "h265" | "av1">;
      evidenceSource?: "runtime-loopback" | "operator-attested" | "none";
      evidenceDetail?: string;
    };
  };
}

export interface CloudRenderPublishedSceneScope {
  projectId: string;
  sceneId: string;
  publishedAt: string;
  /** Immutable JSON publication consumed for identity validation. */
  publicationUrl: string;
  /** Public Studio page that renders the immutable published snapshot. */
  renderUrl: string;
}

export interface CloudRenderWorkerSessionRequest {
  contractVersion: typeof CLOUD_RENDER_WORKER_CONTRACT_VERSION;
  scope: CloudRenderPublishedSceneScope;
  render: {
    width: number;
    height: number;
    framesPerSecond: number;
    codecPreferences: Array<"h264" | "h265" | "av1">;
  };
}

export interface CloudRenderWorkerSession {
  contractVersion: typeof CLOUD_RENDER_WORKER_CONTRACT_VERSION;
  workerSessionId: string;
  sceneId: string;
  publishedAt: string;
  state: "starting" | "media-ready" | "failed" | "stopped";
  viewerUrl?: string;
  mediaEvidence?: RemoteRenderMediaEvidence;
  roundTripLatencyMs?: number;
  failureCode?: string;
}

export interface CloudRenderWorkerClient {
  health(): Promise<CloudRenderWorkerHealth>;
  createSession(request: CloudRenderWorkerSessionRequest): Promise<CloudRenderWorkerSession>;
  getSession(workerSessionId: string): Promise<CloudRenderWorkerSession>;
  stopSession(workerSessionId: string): Promise<void>;
}

export interface CloudRenderScenePolicy {
  sceneId: string;
  projectId: string;
  enabled: boolean;
  updatedAt: string;
}

export interface CloudRenderSceneControl {
  sceneId: string;
  projectId: string;
  name: string;
  publishedAt: string;
  enabled: boolean;
  publicationChanged: boolean;
  session?: RemoteRenderSessionSnapshot;
}

export interface CloudRenderControlOverview {
  configured: boolean;
  missingRequirements: string[];
  worker?: CloudRenderWorkerHealth;
  workerError?: string;
  scenes: CloudRenderSceneControl[];
}

/** 登录用户可读的云渲染能力快照；不含 Worker 地址、令牌或会话明细。 */
export interface CloudRenderCapability {
  configured: boolean;
  missingRequirements: string[];
  workerReady?: boolean;
  workerError?: string;
}

export interface HttpCloudRenderWorkerClientOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/** Strict client for an independently deployed GPU/WebRTC worker. */
export class HttpCloudRenderWorkerClient implements CloudRenderWorkerClient {
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly token: string;

  constructor(options: HttpCloudRenderWorkerClientOptions) {
    this.baseUrl = parseHttpUrl(options.baseUrl, "云渲染 Worker 地址");
    this.baseUrl.pathname = `${this.baseUrl.pathname.replace(/\/$/, "")}/`;
    this.baseUrl.search = "";
    this.baseUrl.hash = "";
    this.token = options.token.trim();
    if (!this.token) throw new TypeError("云渲染 Worker 令牌不能为空");
    this.timeoutMs = finiteInteger(options.timeoutMs ?? 5_000, 250, 30_000, "云渲染 Worker 超时");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async health(): Promise<CloudRenderWorkerHealth> {
    return assertCloudRenderWorkerHealth(await this.json("v1/health"));
  }

  async createSession(request: CloudRenderWorkerSessionRequest): Promise<CloudRenderWorkerSession> {
    assertCloudRenderWorkerSessionRequest(request);
    return assertCloudRenderWorkerSession(await this.json("v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request)
    }));
  }

  async getSession(workerSessionId: string): Promise<CloudRenderWorkerSession> {
    return assertCloudRenderWorkerSession(await this.json(`v1/sessions/${safeId(workerSessionId)}`));
  }

  async stopSession(workerSessionId: string): Promise<void> {
    const response = await this.fetch(`v1/sessions/${safeId(workerSessionId)}`, { method: "DELETE" });
    if (response.status === 404 || response.status === 204) return;
    if (!response.ok) throw await workerResponseError(response);
  }

  private async json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await this.fetch(path, init);
    if (!response.ok) throw await workerResponseError(response);
    try { return await response.json() as unknown; }
    catch { throw new Error("云渲染 Worker 返回了无效 JSON"); }
  }

  private fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = new URL(path, this.baseUrl);
    if (url.origin !== this.baseUrl.origin || !url.pathname.startsWith(this.baseUrl.pathname)) {
      throw new TypeError("云渲染 Worker 路径越界");
    }
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${this.token}`);
    headers.set("accept", "application/json");
    return this.fetchImpl(url, { ...init, headers, signal: AbortSignal.timeout(this.timeoutMs) });
  }
}

export function assertCloudRenderWorkerHealth(value: unknown): CloudRenderWorkerHealth {
  const object = record(value, "云渲染 Worker 健康响应");
  if (object.contractVersion !== CLOUD_RENDER_WORKER_CONTRACT_VERSION) throw new TypeError("云渲染 Worker 合同版本不兼容");
  const workerId = text(object.workerId, "Worker ID");
  const status = literal(object.status, ["ready", "draining", "unavailable"] as const, "Worker 状态");
  const observedAt = timestamp(object.observedAt, "Worker 观测时间");
  const capacity = record(object.capacity, "Worker 容量");
  const maxSessions = finiteInteger(capacity.maxSessions, 1, 100_000, "最大会话数");
  const activeSessions = finiteInteger(capacity.activeSessions, 0, maxSessions, "活动会话数");
  const gpu = record(object.gpu, "GPU 信息");
  const encoder = record(gpu.encoder, "GPU 编码器");
  const codecs = array(encoder.codecs, "GPU 编码器列表").map((codec) => literal(codec, ["h264", "h265", "av1"] as const, "GPU 编码器"));
  const hardware = boolean(encoder.hardware, "GPU 硬件编码");
  const evidenceSource = encoder.evidenceSource === undefined ? undefined : literal(encoder.evidenceSource, ["runtime-loopback", "operator-attested", "none"] as const, "硬件编码证据来源");
  const evidenceDetail = encoder.evidenceDetail === undefined ? undefined : text(encoder.evidenceDetail, "硬件编码证据说明");
  if (status === "ready" && (!hardware || codecs.length === 0)) throw new TypeError("就绪 GPU Worker 必须提供硬件编码器");
  return {
    contractVersion: CLOUD_RENDER_WORKER_CONTRACT_VERSION,
    workerId,
    status,
    observedAt,
    capacity: { maxSessions, activeSessions },
    gpu: {
      vendor: text(gpu.vendor, "GPU 厂商"),
      model: text(gpu.model, "GPU 型号"),
      memoryMiB: finiteInteger(gpu.memoryMiB, 0, Number.MAX_SAFE_INTEGER, "GPU 显存"),
      encoder: {
        hardware,
        codecs: [...new Set(codecs)],
        ...(evidenceSource ? { evidenceSource } : {}),
        ...(evidenceDetail ? { evidenceDetail } : {})
      }
    }
  };
}

export function assertCloudRenderWorkerSession(value: unknown): CloudRenderWorkerSession {
  const object = record(value, "云渲染 Worker 会话响应");
  if (object.contractVersion !== CLOUD_RENDER_WORKER_CONTRACT_VERSION) throw new TypeError("云渲染 Worker 合同版本不兼容");
  const state = literal(object.state, ["starting", "media-ready", "failed", "stopped"] as const, "Worker 会话状态");
  const session: CloudRenderWorkerSession = {
    contractVersion: CLOUD_RENDER_WORKER_CONTRACT_VERSION,
    workerSessionId: text(object.workerSessionId, "Worker 会话 ID"),
    sceneId: text(object.sceneId, "场景 ID"),
    publishedAt: timestamp(object.publishedAt, "场景发布时间"),
    state
  };
  if (object.viewerUrl !== undefined) session.viewerUrl = parseHttpUrl(text(object.viewerUrl, "观看地址"), "观看地址").toString();
  if (object.mediaEvidence !== undefined) {
    const evidence = object.mediaEvidence as RemoteRenderMediaEvidence;
    assertRemoteRenderMediaEvidence(evidence);
    session.mediaEvidence = structuredClone(evidence);
  }
  if (state === "media-ready" && !session.mediaEvidence) throw new TypeError("Worker 声称媒体就绪但未提供 RTP 证据");
  if (object.roundTripLatencyMs !== undefined) session.roundTripLatencyMs = finiteNumber(object.roundTripLatencyMs, 0, 60_000, "往返延迟");
  if (object.failureCode !== undefined) session.failureCode = text(object.failureCode, "Worker 失败码");
  if (state === "failed" && !session.failureCode) throw new TypeError("Worker 失败会话缺少失败码");
  return session;
}

export function assertCloudRenderWorkerSessionRequest(value: unknown): asserts value is CloudRenderWorkerSessionRequest {
  const request = record(value, "云渲染 Worker 会话请求");
  if (request.contractVersion !== CLOUD_RENDER_WORKER_CONTRACT_VERSION) throw new TypeError("云渲染 Worker 合同版本不兼容");
  const scope = record(request.scope, "发布场景作用域");
  text(scope.projectId, "项目 ID");
  text(scope.sceneId, "场景 ID");
  timestamp(scope.publishedAt, "场景发布时间");
  parseHttpUrl(text(scope.publicationUrl, "场景发布地址"), "场景发布地址");
  parseHttpUrl(text(scope.renderUrl, "场景渲染地址"), "场景渲染地址");
  const render = record(request.render, "云渲染参数");
  finiteInteger(render.width, 320, 16_384, "渲染宽度");
  finiteInteger(render.height, 240, 16_384, "渲染高度");
  finiteInteger(render.framesPerSecond, 1, 240, "渲染帧率");
  const codecs = array(render.codecPreferences, "云渲染编码器");
  if (codecs.length === 0) throw new TypeError("至少声明一种云渲染编码器");
  codecs.forEach((codec) => literal(codec, ["h264", "h265", "av1"] as const, "云渲染编码器"));
}

async function workerResponseError(response: Response): Promise<Error> {
  const body = await response.clone().json().catch(() => undefined) as { message?: unknown; code?: unknown } | undefined;
  const message = typeof body?.message === "string" ? body.message : `HTTP ${response.status}`;
  const code = typeof body?.code === "string" ? ` (${body.code})` : "";
  return new Error(`云渲染 Worker 请求失败：${message}${code}`);
}

function safeId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128 || !/^[A-Za-z0-9._~-]+$/.test(normalized)) throw new TypeError("云渲染 Worker 会话 ID 无效");
  return encodeURIComponent(normalized);
}

function parseHttpUrl(value: string, label: string): URL {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new TypeError(`${label}必须是完整 HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new TypeError(`${label}必须是完整 HTTP(S) URL`);
  return parsed;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}格式无效`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${label}格式无效`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label}不能为空`);
  return value.trim();
}

function timestamp(value: unknown, label: string): string {
  const normalized = text(value, label);
  if (!Number.isFinite(Date.parse(normalized))) throw new TypeError(`${label}无效`);
  return normalized;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label}格式无效`);
  return value;
}

function literal<const T extends readonly string[]>(value: unknown, choices: T, label: string): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new TypeError(`${label}无效`);
  return value as T[number];
}

function finiteInteger(value: unknown, minimum: number, maximum: number, label: string): number {
  const result = finiteNumber(value, minimum, maximum, label);
  if (!Number.isInteger(result)) throw new TypeError(`${label}必须是整数`);
  return result;
}

function finiteNumber(value: unknown, minimum: number, maximum: number, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${label}无效`);
  return value;
}
