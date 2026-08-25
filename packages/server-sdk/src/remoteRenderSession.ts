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
  failureCode?: string | undefined;
  roundTripLatencyMs?: number;
}

export type RemoteRenderSessionEvent =
  | { type: "allocate" }
  | { type: "allocated" }
  | { type: "connected" }
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
    return { ...this.snapshotValue };
  }

  dispatch(event: RemoteRenderSessionEvent): RemoteRenderSessionSnapshot {
    const state = this.snapshotValue.state;
    switch (event.type) {
      case "allocate":
        this.expect(state, ["idle"]);
        return this.update({ state: "allocating" });
      case "allocated":
        this.expect(state, ["allocating"]);
        return this.update({ state: "signaling" });
      case "connected":
        this.expect(state, ["signaling", "degraded"]);
        return this.update({ state: "streaming", failureCode: undefined });
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
        return this.update({ state: "signaling" });
      case "close":
        this.expect(state, ["allocating", "signaling", "streaming", "degraded", "failed"]);
        return this.update({ state: "closing" });
      case "closed":
        this.expect(state, ["closing"]);
        return this.update({ state: "closed" });
      case "fail":
        this.expect(state, ["allocating", "signaling", "streaming", "degraded"]);
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
