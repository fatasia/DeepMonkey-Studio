import { describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { CloudRenderWorkerClient, CloudRenderWorkerHealth, CloudRenderWorkerSession } from "@bim-studio/server-sdk";
import { CloudRenderControlPlane, MemoryCloudRenderRegistry } from "./cloudRenderControl.js";

const NOW = new Date("2026-08-25T12:00:10.000Z");

describe("CloudRenderControlPlane", () => {
  it("requires enablement, real GPU capacity and outbound media evidence before streaming", async () => {
    const worker = workerClient(session("media-ready"));
    const control = await createControl(worker);
    const publication = publishedScene();

    await expect(control.startSession(publication, "admin-1")).rejects.toMatchObject({ code: "scene_disabled" });
    await control.setEnabled(publication, true);
    const started = await control.startSession(publication, "admin-1");

    expect(started).toMatchObject({ state: "streaming", workerSessionId: "worker-session-1", mediaEvidence: { framesEncoded: 120 } });
    expect(worker.createSession).toHaveBeenCalledWith(expect.objectContaining({
      scope: expect.objectContaining({
        sceneId: publication.sceneId,
        publishedAt: publication.publishedAt,
        publicationUrl: `https://studio.example.test/api/public/scenes/${publication.sceneId}`,
        renderUrl: `https://studio.example.test/published/${publication.sceneId}`
      })
    }));
  });

  it("keeps signaling when the worker has not produced media", async () => {
    const control = await createControl(workerClient(session("starting")));
    const publication = publishedScene();
    await control.setEnabled(publication, true);

    const started = await control.startSession(publication, "admin-1");
    expect(started.state).toBe("signaling");
    expect(started.mediaEvidence).toBeUndefined();
  });

  it("fails instead of streaming on stale RTP evidence", async () => {
    const stale = session("media-ready");
    stale.mediaEvidence = { ...stale.mediaEvidence!, observedAt: "2026-08-25T11:00:00.000Z" };
    const control = await createControl(workerClient(stale));
    const publication = publishedScene();
    await control.setEnabled(publication, true);

    await expect(control.startSession(publication, "admin-1")).rejects.toMatchObject({ code: "media_not_ready" });
    const overview = await control.overview([publication]);
    expect(overview.scenes[0]?.session?.state).toBe("failed");
    expect(overview.scenes[0]?.session?.failureCode).toBe("stale_or_missing_media_evidence");
  });

  it("rejects stale worker health and full capacity before allocation", async () => {
    const staleWorker = workerClient(session("starting"), { ...health(), observedAt: "2026-08-25T11:00:00.000Z" });
    const staleControl = await createControl(staleWorker);
    await staleControl.setEnabled(publishedScene(), true);
    await expect(staleControl.startSession(publishedScene(), "admin-1")).rejects.toMatchObject({ code: "stale_worker_health" });
    expect(staleWorker.createSession).not.toHaveBeenCalled();

    const fullWorker = workerClient(session("starting"), { ...health(), capacity: { maxSessions: 2, activeSessions: 2 } });
    const fullControl = await createControl(fullWorker);
    await fullControl.setEnabled(publishedScene(), true);
    await expect(fullControl.startSession(publishedScene(), "admin-1")).rejects.toMatchObject({ code: "gpu_capacity" });
    expect(fullWorker.createSession).not.toHaveBeenCalled();
  });

  it("persists the policy and worker identity, and only closes after Worker acknowledgement", async () => {
    const registry = new MemoryCloudRenderRegistry();
    const worker = workerClient(session("starting"));
    const first = await createControl(worker, registry);
    const publication = publishedScene();
    await first.setEnabled(publication, true);
    await first.startSession(publication, "admin-1");

    const restored = await createControl(worker, registry);
    expect((await restored.overview([publication])).scenes[0]).toMatchObject({ enabled: true, session: { state: "signaling", workerSessionId: "worker-session-1" } });
    await expect(restored.setEnabled(publication, false)).resolves.toMatchObject({ enabled: false });
    expect(worker.stopSession).toHaveBeenCalledWith("worker-session-1");
    expect((await restored.overview([publication])).scenes[0]?.session?.state).toBe("closed");
  });

  it("does not claim shutdown when the Worker stop request fails", async () => {
    const worker = workerClient(session("starting"));
    worker.stopSession.mockRejectedValue(new Error("timeout"));
    const control = await createControl(worker);
    const publication = publishedScene();
    await control.setEnabled(publication, true);
    await control.startSession(publication, "admin-1");

    await expect(control.setEnabled(publication, false)).rejects.toMatchObject({ code: "worker_stop_failed" });
    expect((await control.overview([publication])).scenes[0]).toMatchObject({ enabled: true, session: { state: "failed", failureCode: "worker_stop_failed" } });
  });
});

async function createControl(worker: ReturnType<typeof workerClient>, registry = new MemoryCloudRenderRegistry()) {
  const control = new CloudRenderControlPlane(registry, {
    worker,
    publicOrigin: "https://studio.example.test",
    now: () => new Date(NOW),
    healthMaxAgeMs: 15_000,
    mediaEvidenceMaxAgeMs: 15_000
  });
  await control.init();
  return control;
}

function workerClient(result: CloudRenderWorkerSession, workerHealth = health()) {
  return {
    health: vi.fn<CloudRenderWorkerClient["health"]>().mockResolvedValue(workerHealth),
    createSession: vi.fn<CloudRenderWorkerClient["createSession"]>().mockResolvedValue(result),
    getSession: vi.fn<CloudRenderWorkerClient["getSession"]>().mockResolvedValue(result),
    stopSession: vi.fn<CloudRenderWorkerClient["stopSession"]>().mockResolvedValue(undefined)
  };
}

function health(): CloudRenderWorkerHealth {
  return {
    contractVersion: 1,
    workerId: "worker-1",
    status: "ready",
    observedAt: "2026-08-25T12:00:05.000Z",
    capacity: { maxSessions: 4, activeSessions: 1 },
    gpu: { vendor: "NVIDIA", model: "L40S", memoryMiB: 48_000, encoder: { hardware: true, codecs: ["h264", "av1"] } }
  };
}

function session(state: CloudRenderWorkerSession["state"]): CloudRenderWorkerSession {
  return {
    contractVersion: 1,
    workerSessionId: "worker-session-1",
    sceneId: "scene-1",
    publishedAt: "2026-08-25T12:00:00.000Z",
    state,
    viewerUrl: "https://worker.example.test/watch/worker-session-1",
    ...(state === "media-ready" ? { mediaEvidence: {
      kind: "webrtc-outbound-rtp",
      observedAt: "2026-08-25T12:00:08.000Z",
      peerConnectionId: "peer-1",
      videoTrackId: "track-1",
      codec: "h264",
      hardwareEncoder: true,
      encoderImplementation: "NVIDIA NVENC",
      encoderEvidence: "runtime-stats",
      width: 1920,
      height: 1080,
      framesEncoded: 120,
      packetsSent: 480,
      bytesSent: 1_200_000
    } } : {}),
    ...(state === "failed" ? { failureCode: "worker_failed" } : {})
  };
}

function publishedScene(): PublishedSceneRecord {
  return {
    sceneId: "scene-1",
    projectId: "default",
    name: "工厂总览",
    publishedAt: "2026-08-25T12:00:00.000Z",
    snapshot: {
      schemaVersion: 1,
      id: "scene-1",
      projectId: "default",
      name: "工厂总览",
      models: [],
      camera: { position: { x: 1, y: 1, z: 1 }, target: { x: 0, y: 0, z: 0 } },
      environment: { backgroundColor: "#000000", backgroundOpacity: 1, skybox: "none", exposure: 1, fog: { enabled: false, color: "#000000", near: 1, far: 100 } },
      lighting: { enabled: true, color: "#ffffff", intensity: 1 },
      clipping: { enabled: false, mode: "axis", axis: "x", offset: 0, inverted: false },
      weather: "sunny",
      createdAt: "2026-08-25T11:00:00.000Z",
      updatedAt: "2026-08-25T12:00:00.000Z",
      publishedAt: "2026-08-25T12:00:00.000Z"
    } as SceneSnapshot
  };
}
