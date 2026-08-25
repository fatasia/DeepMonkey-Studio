import { describe, expect, it } from "vitest";
import { RemoteRenderSession } from "./remoteRenderSession.js";

describe("RemoteRenderSession", () => {
  it("models allocation, signaling, streaming, degradation and clean close", () => {
    const session = createSession();

    expect(session.dispatch({ type: "allocate" }).state).toBe("allocating");
    expect(session.dispatch({ type: "allocated", workerSessionId: "worker-session-1", viewerUrl: "https://render.example.test/watch/1" }).state).toBe("signaling");
    expect(session.dispatch({ type: "media-ready", evidence: mediaEvidence() }).state).toBe("streaming");
    expect(session.dispatch({ type: "latency", roundTripLatencyMs: 180, degradedAboveMs: 150 }).state).toBe("degraded");
    expect(session.dispatch({ type: "recover" }).state).toBe("signaling");
    expect(session.dispatch({ type: "media-ready", evidence: mediaEvidence() }).state).toBe("streaming");
    expect(session.dispatch({ type: "close" }).state).toBe("closing");
    expect(session.dispatch({ type: "closed" }).state).toBe("closed");
  });

  it("keeps the local renderer fallback in a failed session", () => {
    const session = createSession();
    session.dispatch({ type: "allocate" });

    expect(session.dispatch({ type: "fail", code: "gpu-capacity" })).toEqual(expect.objectContaining({
      state: "failed",
      failureCode: "gpu-capacity",
      fallback: "local-webgpu"
    }));
  });

  it("rejects invalid transitions instead of hiding protocol errors", () => {
    const session = createSession();
    expect(() => session.dispatch({ type: "media-ready", evidence: mediaEvidence() })).toThrow("不能从 idle");
    expect(() => session.dispatch({ type: "latency", roundTripLatencyMs: -1, degradedAboveMs: 150 })).toThrow("不能从 idle");
  });

  it("never enters streaming for signaling alone or empty media counters", () => {
    const session = createSession();
    session.dispatch({ type: "allocate" });
    expect(session.dispatch({ type: "allocated", workerSessionId: "worker-session-1" }).state).toBe("signaling");
    expect(() => session.dispatch({ type: "media-ready", evidence: { ...mediaEvidence(), framesEncoded: 0 } })).toThrow("framesEncoded 必须为正数");
    expect(session.snapshot().state).toBe("signaling");
  });

  it("restores persisted active sessions only when their media evidence is complete", () => {
    const session = createSession();
    session.dispatch({ type: "allocate" });
    session.dispatch({ type: "allocated", workerSessionId: "worker-session-1" });
    const snapshot = session.dispatch({ type: "media-ready", evidence: mediaEvidence() });
    expect(RemoteRenderSession.restore(snapshot).snapshot()).toEqual(snapshot);
    expect(() => RemoteRenderSession.restore({ ...snapshot, mediaEvidence: undefined })).toThrow("缺少媒体就绪证据");
  });
});

function createSession(): RemoteRenderSession {
  return new RemoteRenderSession({
    sessionId: "session-1",
    userId: "user-1",
    projectId: "project-1",
    publicationId: "publication-1"
  }, "local-webgpu");
}

function mediaEvidence() {
  return {
    kind: "webrtc-outbound-rtp" as const,
    observedAt: "2026-08-25T12:00:00.000Z",
    peerConnectionId: "peer-1",
    videoTrackId: "video-1",
    codec: "h264" as const,
    hardwareEncoder: true as const,
    encoderImplementation: "NVIDIA NVENC",
    encoderEvidence: "runtime-stats" as const,
    width: 1920,
    height: 1080,
    framesEncoded: 120,
    packetsSent: 480,
    bytesSent: 1_024_000
  };
}
