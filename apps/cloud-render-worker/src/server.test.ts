import { describe, expect, it } from "vitest";
import type {
  CloudRenderWorkerHealth,
  CloudRenderWorkerSessionRequest,
  RemoteRenderMediaEvidence
} from "@bim-studio/server-sdk";
import type { CloudRenderWorkerConfig } from "./config.js";
import type { RenderRuntime, RenderRuntimeSession } from "./chromiumRuntime.js";
import { buildWorkerApp } from "./server.js";

describe("reference cloud render worker HTTP integration", () => {
  it("keeps starting until the real runtime supplies outbound RTP evidence", async () => {
    const runtime = new EvidenceRuntime();
    const app = buildWorkerApp(config(), runtime);
    expect((await app.inject({ method: "GET", url: "/v1/health" })).statusCode).toBe(401);
    const health = await app.inject({ method: "GET", url: "/v1/health", headers: authorization() });
    expect(health.json()).toMatchObject({ status: "ready", gpu: { encoder: { hardware: true } } });

    const created = await app.inject({ method: "POST", url: "/v1/sessions", headers: authorization(), payload: request() });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { workerSessionId: string; viewerUrl: string; state: string };
    expect(session.state).toBe("starting");
    const viewer = new URL(session.viewerUrl);
    const viewerToken = new URLSearchParams(viewer.hash.slice(1)).get("token")!;
    expect((await app.inject({ method: "GET", url: `/viewer/${session.workerSessionId}` })).body).toContain("RTCPeerConnection");

    const beforeAnswer = await app.inject({ method: "GET", url: `/v1/sessions/${session.workerSessionId}`, headers: authorization() });
    expect(beforeAnswer.json()).toMatchObject({ state: "starting" });
    expect((await app.inject({ method: "GET", url: `/v1/viewer/${session.workerSessionId}/offer`, headers: { "x-cloud-render-viewer-token": "wrong" } })).statusCode).toBe(403);
    const offer = await app.inject({ method: "GET", url: `/v1/viewer/${session.workerSessionId}/offer`, headers: { "x-cloud-render-viewer-token": viewerToken } });
    expect(offer.json()).toEqual({ type: "offer", sdp: "real-offer" });
    expect((await app.inject({ method: "POST", url: `/v1/viewer/${session.workerSessionId}/answer`, headers: { "x-cloud-render-viewer-token": viewerToken }, payload: { type: "answer", sdp: "real-answer" } })).statusCode).toBe(204);

    const mediaReady = await app.inject({ method: "GET", url: `/v1/sessions/${session.workerSessionId}`, headers: authorization() });
    expect(mediaReady.json()).toMatchObject({
      state: "media-ready",
      mediaEvidence: { kind: "webrtc-outbound-rtp", framesEncoded: 4, packetsSent: 3, bytesSent: 4096 }
    });
    expect((await app.inject({ method: "DELETE", url: `/v1/sessions/${session.workerSessionId}`, headers: authorization() })).statusCode).toBe(204);
    expect(runtime.session.closed).toBe(true);
    await app.close();
  });

  it("rejects allocation when Chromium did not report hardware encoding", async () => {
    const runtime = new EvidenceRuntime(false);
    const app = buildWorkerApp(config(), runtime);
    const response = await app.inject({ method: "POST", url: "/v1/sessions", headers: authorization(), payload: request() });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ code: "hardware_encoder_unavailable" });
    expect(runtime.createCalls).toBe(0);
    await app.close();
  });

  it("validates the immutable render and publication URLs before allocation", async () => {
    const runtime = new EvidenceRuntime();
    const app = buildWorkerApp(config(), runtime);
    const invalid = request();
    delete (invalid.scope as Partial<typeof invalid.scope>).renderUrl;
    const response = await app.inject({ method: "POST", url: "/v1/sessions", headers: authorization(), payload: invalid });
    expect(response.statusCode).toBe(400);
    expect(runtime.createCalls).toBe(0);
    await app.close();
  });

  it("returns a real session id immediately but records Chromium boot failure instead of media-ready", async () => {
    const runtime = new EvidenceRuntime(true, true);
    const app = buildWorkerApp(config(), runtime);
    const created = await app.inject({ method: "POST", url: "/v1/sessions", headers: authorization(), payload: request() });
    expect(created.statusCode).toBe(201);
    const session = created.json() as { workerSessionId: string };
    await Promise.resolve();
    const status = await app.inject({ method: "GET", url: `/v1/sessions/${session.workerSessionId}`, headers: authorization() });
    expect(status.json()).toMatchObject({ state: "failed" });
    expect(String(status.json().failureCode)).toContain("render_boot_failed");
    await app.close();
  });
});

class EvidenceRuntime implements RenderRuntime {
  readonly session = new EvidenceSession();
  createCalls = 0;
  constructor(private readonly hardware = true, private readonly failCreate = false) {}
  async start() {}
  health(activeSessions: number): CloudRenderWorkerHealth {
    return {
      contractVersion: 1,
      workerId: "gpu-test-1",
      status: this.hardware ? "ready" : "unavailable",
      observedAt: new Date().toISOString(),
      capacity: { maxSessions: 1, activeSessions },
      gpu: { vendor: "NVIDIA", model: "Test GPU", memoryMiB: 8192, encoder: { hardware: this.hardware, codecs: this.hardware ? ["h264"] : [], evidenceSource: this.hardware ? "runtime-loopback" : "none" } }
    };
  }
  async create() { this.createCalls += 1; if (this.failCreate) throw new Error("canvas missing"); return this.session; }
  async close() {}
}

class EvidenceSession implements RenderRuntimeSession {
  readonly offer = { type: "offer" as const, sdp: "real-offer" };
  answered = false;
  closed = false;
  async applyAnswer(answer: RTCSessionDescriptionInit) { this.answered = answer.type === "answer" && answer.sdp === "real-answer"; }
  async mediaEvidence() {
    if (!this.answered) return { state: "starting" as const };
    return { state: "media-ready" as const, evidence: evidence() };
  }
  async close() { this.closed = true; }
}

function evidence(): RemoteRenderMediaEvidence {
  return {
    kind: "webrtc-outbound-rtp",
    observedAt: new Date().toISOString(),
    peerConnectionId: "pc-real",
    videoTrackId: "track-real",
    codec: "h264",
    hardwareEncoder: true,
    encoderImplementation: "NVIDIA NVENC",
    encoderEvidence: "runtime-stats",
    width: 1920,
    height: 1080,
    framesEncoded: 4,
    packetsSent: 3,
    bytesSent: 4096
  };
}

function request(): CloudRenderWorkerSessionRequest {
  return {
    contractVersion: 1,
    scope: {
      projectId: "project-1",
      sceneId: "scene-1",
      publishedAt: "2026-08-25T12:00:00.000Z",
      publicationUrl: "https://studio.example.test/api/public/scenes/scene-1",
      renderUrl: "https://studio.example.test/published/scene-1"
    },
    render: { width: 1920, height: 1080, framesPerSecond: 60, codecPreferences: ["h264"] }
  };
}

function config(): CloudRenderWorkerConfig {
  return {
    workerId: "gpu-test-1",
    host: "127.0.0.1",
    port: 4200,
    token: "worker-secret",
    publicOrigin: "https://worker.example.test",
    chromiumPath: "chromium",
    headless: true,
    maxSessions: 1,
    navigationTimeoutMs: 10_000,
    canvasTimeoutMs: 10_000,
    iceGatheringTimeoutMs: 10_000,
    iceServers: [],
    verifiedHardwareCodecs: []
  };
}

function authorization() { return { authorization: "Bearer worker-secret" }; }
