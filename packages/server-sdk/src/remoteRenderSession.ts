export type LocalRenderFallback = "local-webgpu" | "local-webgl2" | "blocked";
export type RemoteRenderSessionState =
  | "idle"
  | "allocating"
  | "signaling"
  | "streaming"
  | "degraded"
  | "closing"
  | "closed"
  | "failed";

export interface RemoteRenderSessionIdentity {
  sessionId: string;
  userId: string;
  projectId: string;
  publicationId: string;
}

export interface RemoteRenderSessionSnapshot extends RemoteRenderSessionIdentity {
  state: RemoteRenderSessionState;
  fallback: LocalRenderFallback;
  workerSessionId?: string;
  viewerUrl?: string;
  mediaEvidence?: RemoteRenderMediaEvidence | undefined;
  failureCode?: string | undefined;
  roundTripLatencyMs?: number;
}

/**
 * Proof emitted by a real render worker after its WebRTC sender has encoded
 * and transmitted video. Signaling success or a connected peer alone is not
 * media readiness.
 */
export interface RemoteRenderMediaEvidence {
  kind: "webrtc-outbound-rtp";
  observedAt: string;
  peerConnectionId: string;
  videoTrackId: string;
  codec: "h264" | "h265" | "av1";
  hardwareEncoder: true;
  encoderImplementation: string;
  encoderEvidence: "runtime-stats" | "operator-attested";
  width: number;
  height: number;
  framesEncoded: number;
  packetsSent: number;
  bytesSent: number;
}

export type RemoteRenderSessionEvent =
  | { type: "allocate" }
  | { type: "allocated"; workerSessionId: string; viewerUrl?: string }
  | { type: "media-ready"; evidence: RemoteRenderMediaEvidence; viewerUrl?: string }
  | { type: "latency"; roundTripLatencyMs: number; degradedAboveMs: number }
  | { type: "recover" }
  | { type: "close" }
  | { type: "closed" }
  | { type: "fail"; code: string };

export class RemoteRenderSession {
  private snapshotValue: RemoteRenderSessionSnapshot;

  constructor(identity: RemoteRenderSessionIdentity, fallback: LocalRenderFallback) {
    for (const [field, value] of Object.entries(identity)) {
      if (!value.trim()) throw new TypeError(`RemoteRenderSession ${field} 不能为空`);
    }
    this.snapshotValue = { ...identity, state: "idle", fallback };
  }

  snapshot(): RemoteRenderSessionSnapshot {
    return structuredClone(this.snapshotValue);
  }

  static restore(snapshot: RemoteRenderSessionSnapshot): RemoteRenderSession {
    validateSnapshot(snapshot);
    const session = new RemoteRenderSession({
      sessionId: snapshot.sessionId,
      userId: snapshot.userId,
      projectId: snapshot.projectId,
      publicationId: snapshot.publicationId
    }, snapshot.fallback);
    session.snapshotValue = structuredClone(snapshot);
    return session;
  }

  dispatch(event: RemoteRenderSessionEvent): RemoteRenderSessionSnapshot {
    const state = this.snapshotValue.state;
    switch (event.type) {
      case "allocate":
        this.expect(state, ["idle"]);
        return this.update({ state: "allocating" });
      case "allocated":
        this.expect(state, ["allocating"]);
        if (!event.workerSessionId.trim()) throw new TypeError("云渲染 Worker 会话 ID 不能为空");
        if (event.viewerUrl !== undefined) assertHttpUrl(event.viewerUrl, "云渲染观看地址");
        return this.update({
          state: "signaling",
          workerSessionId: event.workerSessionId.trim(),
          ...(event.viewerUrl ? { viewerUrl: event.viewerUrl } : {})
        });
      case "media-ready":
        this.expect(state, ["signaling", "streaming", "degraded"]);
        assertRemoteRenderMediaEvidence(event.evidence);
        if (event.viewerUrl !== undefined) assertHttpUrl(event.viewerUrl, "云渲染观看地址");
        return this.update({
          state: "streaming",
          mediaEvidence: structuredClone(event.evidence),
          ...(event.viewerUrl ? { viewerUrl: event.viewerUrl } : {}),
          failureCode: undefined
        });
      case "latency": {
        this.expect(state, ["streaming", "degraded"]);
        if (!Number.isFinite(event.roundTripLatencyMs) || event.roundTripLatencyMs < 0) throw new TypeError("延迟必须是非负有限数");
        if (!Number.isFinite(event.degradedAboveMs) || event.degradedAboveMs <= 0) throw new TypeError("降级阈值必须是正有限数");
        return this.update({
          state: event.roundTripLatencyMs > event.degradedAboveMs ? "degraded" : "streaming",
          roundTripLatencyMs: event.roundTripLatencyMs
        });
      }
      case "recover":
        this.expect(state, ["degraded"]);
        return this.update({ state: "signaling", mediaEvidence: undefined });
      case "close":
        this.expect(state, ["allocating", "signaling", "streaming", "degraded", "failed"]);
        return this.update({ state: "closing" });
      case "closed":
        this.expect(state, ["closing"]);
        return this.update({ state: "closed" });
      case "fail":
        this.expect(state, ["allocating", "signaling", "streaming", "degraded", "closing", "failed"]);
        if (!event.code.trim()) throw new TypeError("云渲染失败码不能为空");
        return this.update({ state: "failed", failureCode: event.code.trim() });
    }
  }

  private update(patch: Partial<RemoteRenderSessionSnapshot>): RemoteRenderSessionSnapshot {
    const next = { ...this.snapshotValue, ...patch };
    if (patch.failureCode === undefined && "failureCode" in patch) delete next.failureCode;
    this.snapshotValue = next;
    return this.snapshot();
  }

  private expect(actual: RemoteRenderSessionState, allowed: readonly RemoteRenderSessionState[]): void {
    if (!allowed.includes(actual)) throw new Error(`云渲染会话不能从 ${actual} 执行该事件`);
  }
}

export function assertRemoteRenderMediaEvidence(value: RemoteRenderMediaEvidence): void {
  if (value.kind !== "webrtc-outbound-rtp") throw new TypeError("云渲染媒体证据类型无效");
  if (!value.peerConnectionId.trim() || !value.videoTrackId.trim()) throw new TypeError("云渲染媒体证据缺少连接或视频轨道");
  if (!Number.isFinite(Date.parse(value.observedAt))) throw new TypeError("云渲染媒体证据时间无效");
  if (!["h264", "h265", "av1"].includes(value.codec)) throw new TypeError("云渲染媒体编码无效");
  if (value.hardwareEncoder !== true) throw new TypeError("云渲染媒体证据未确认硬件编码");
  if (typeof value.encoderImplementation !== "string" || !value.encoderImplementation.trim()) throw new TypeError("云渲染媒体证据缺少编码器实现");
  if (!["runtime-stats", "operator-attested"].includes(value.encoderEvidence)) throw new TypeError("云渲染硬件编码证据来源无效");
  for (const [field, amount] of Object.entries({
    width: value.width,
    height: value.height,
    framesEncoded: value.framesEncoded,
    packetsSent: value.packetsSent,
    bytesSent: value.bytesSent
  })) {
    if (!Number.isFinite(amount) || amount <= 0) throw new TypeError(`云渲染媒体证据 ${field} 必须为正数`);
  }
}

function validateSnapshot(snapshot: RemoteRenderSessionSnapshot): void {
  for (const [field, value] of Object.entries({
    sessionId: snapshot.sessionId,
    userId: snapshot.userId,
    projectId: snapshot.projectId,
    publicationId: snapshot.publicationId
  })) {
    if (!value.trim()) throw new TypeError(`RemoteRenderSession ${field} 不能为空`);
  }
  if (!["idle", "allocating", "signaling", "streaming", "degraded", "closing", "closed", "failed"].includes(snapshot.state)) {
    throw new TypeError("云渲染会话状态无效");
  }
  if ((snapshot.state === "signaling" || snapshot.state === "streaming" || snapshot.state === "degraded" || snapshot.state === "closing")
    && !snapshot.workerSessionId?.trim()) {
    throw new TypeError("活动云渲染会话缺少 Worker 会话 ID");
  }
  if ((snapshot.state === "streaming" || snapshot.state === "degraded") && !snapshot.mediaEvidence) {
    throw new TypeError("运行中的云渲染会话缺少媒体就绪证据");
  }
  if (snapshot.mediaEvidence) assertRemoteRenderMediaEvidence(snapshot.mediaEvidence);
  if (snapshot.viewerUrl) assertHttpUrl(snapshot.viewerUrl, "云渲染观看地址");
}

function assertHttpUrl(value: string, label: string): void {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new TypeError(`${label}必须是完整 HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new TypeError(`${label}必须是完整 HTTP(S) URL`);
  }
}
