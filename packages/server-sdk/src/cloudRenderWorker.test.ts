import { describe, expect, it, vi } from "vitest";
import { HttpCloudRenderWorkerClient, assertCloudRenderWorkerHealth, assertCloudRenderWorkerSession, assertCloudRenderWorkerSessionRequest, type CloudRenderWorkerSessionRequest } from "./cloudRenderWorker.js";

describe("HttpCloudRenderWorkerClient", () => {
  it("authenticates and validates real GPU health and capacity", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(health()));
    const client = new HttpCloudRenderWorkerClient({ baseUrl: "https://worker.example.test/control", token: "secret", fetch });

    await expect(client.health()).resolves.toMatchObject({ status: "ready", capacity: { maxSessions: 4, activeSessions: 1 } });
    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://worker.example.test/control/v1/health");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret");
  });

  it("rejects media-ready claims without outbound RTP counters", () => {
    expect(() => assertCloudRenderWorkerSession({ ...workerSession(), mediaEvidence: undefined })).toThrow("未提供 RTP 证据");
    expect(() => assertCloudRenderWorkerSession({ ...workerSession(), mediaEvidence: { ...evidence(), bytesSent: 0 } })).toThrow("bytesSent 必须为正数");
  });

  it("accepts a worker-created session only with the exact published scope", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(workerSession()));
    const client = new HttpCloudRenderWorkerClient({ baseUrl: "https://worker.example.test", token: "secret", fetch });
    await expect(client.createSession(request())).resolves.toMatchObject({ state: "media-ready", mediaEvidence: { framesEncoded: 90 } });
    expect(JSON.parse(String(fetch.mock.calls[0]![1]?.body))).toEqual(request());
  });

  it("permits an unavailable probe without inventing a codec but rejects fake ready hardware", () => {
    expect(assertCloudRenderWorkerHealth({ ...health(), status: "unavailable", gpu: { ...health().gpu, memoryMiB: 0, encoder: { hardware: false, codecs: [] } } })).toMatchObject({ status: "unavailable", gpu: { memoryMiB: 0 } });
    expect(() => assertCloudRenderWorkerHealth({ ...health(), gpu: { ...health().gpu, encoder: { hardware: false, codecs: ["h264"] } } })).toThrow("必须提供硬件编码器");
  });

  it("strictly validates render URL and codec preferences", () => {
    expect(() => assertCloudRenderWorkerSessionRequest({ ...request(), scope: { ...request().scope, renderUrl: undefined } })).toThrow("渲染地址");
    expect(() => assertCloudRenderWorkerSessionRequest({ ...request(), render: { ...request().render, codecPreferences: ["vp9"] } })).toThrow("编码器无效");
  });
});

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
    render: { width: 1920, height: 1080, framesPerSecond: 60, codecPreferences: ["h264", "av1"] }
  };
}

function health() {
  return {
    contractVersion: 1,
    workerId: "worker-1",
    status: "ready",
    observedAt: "2026-08-25T12:00:00.000Z",
    capacity: { maxSessions: 4, activeSessions: 1 },
    gpu: { vendor: "NVIDIA", model: "L40S", memoryMiB: 48_000, encoder: { hardware: true, codecs: ["h264", "av1"] } }
  };
}

function workerSession() {
  return {
    contractVersion: 1,
    workerSessionId: "worker-session-1",
    sceneId: "scene-1",
    publishedAt: "2026-08-25T12:00:00.000Z",
    state: "media-ready",
    viewerUrl: "https://worker.example.test/watch/worker-session-1",
    mediaEvidence: evidence()
  };
}

function evidence() {
  return {
    kind: "webrtc-outbound-rtp",
    observedAt: "2026-08-25T12:00:01.000Z",
    peerConnectionId: "peer-1",
    videoTrackId: "video-1",
    codec: "h264",
    hardwareEncoder: true,
    encoderImplementation: "NVIDIA NVENC",
    encoderEvidence: "runtime-stats",
    width: 1920,
    height: 1080,
    framesEncoded: 90,
    packetsSent: 360,
    bytesSent: 900_000
  };
}
