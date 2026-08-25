import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PublishedSceneRecord, SceneSnapshot, SystemUserRecord } from "@bim-studio/contracts";
import type { CloudRenderWorkerClient, CloudRenderWorkerHealth, CloudRenderWorkerSession } from "@bim-studio/server-sdk";
import { CloudRenderControlPlane, MemoryCloudRenderRegistry } from "./cloudRenderControl.js";
import { registerCloudRenderRoutes } from "./cloudRenderRoutes.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true }))));

describe("cloud render admin routes", () => {
  it("requires an administrator even when registered without the global auth hook", async () => {
    const { app } = await harness("editor");
    const response = await app.inject({ method: "GET", url: "/api/admin/cloud-render" });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: "admin_required" });
    await app.close();
  });

  it("only creates a session for a published enabled scene and exposes real media evidence", async () => {
    const { app, publication, worker } = await harness("admin", true);
    expect((await app.inject({ method: "POST", url: `/api/admin/cloud-render/scenes/${publication.sceneId}/sessions` })).statusCode).toBe(409);
    expect((await app.inject({ method: "PATCH", url: `/api/admin/cloud-render/scenes/${publication.sceneId}`, payload: { enabled: true } })).statusCode).toBe(200);

    const started = await app.inject({ method: "POST", url: `/api/admin/cloud-render/scenes/${publication.sceneId}/sessions` });
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ state: "streaming", mediaEvidence: { kind: "webrtc-outbound-rtp", framesEncoded: 60 } });
    expect(worker.createSession).toHaveBeenCalledOnce();

    expect((await app.inject({ method: "DELETE", url: `/api/admin/cloud-render/scenes/${publication.sceneId}/sessions/current` })).statusCode).toBe(204);
    expect(worker.stopSession).toHaveBeenCalledWith("worker-session-1");
    await app.close();
  });

  it("rejects unpublished scopes before contacting the Worker", async () => {
    const { app, worker } = await harness("admin", false);
    const response = await app.inject({ method: "PATCH", url: "/api/admin/cloud-render/scenes/scene-1", payload: { enabled: true } });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: "publication_not_found" });
    expect(worker.createSession).not.toHaveBeenCalled();
    await app.close();
  });
});

async function harness(role: SystemUserRecord["role"], publish = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-cloud-routes-"));
  directories.push(directory);
  const store = new JsonStore(directory);
  await store.init();
  const publication = publishedScene();
  await store.saveScene(publication.snapshot);
  if (publish) await store.savePublication(publication);
  const worker = fakeWorker();
  const control = new CloudRenderControlPlane(new MemoryCloudRenderRegistry(), {
    worker,
    publicOrigin: "https://studio.example.test",
    now: () => new Date("2026-08-25T12:00:10.000Z")
  });
  await control.init();
  const app = createApiServer();
  app.addHook("preHandler", async (request) => {
    request.systemUser = {
      id: "user-1", username: "user", displayName: "User", role, projectIds: [], enabled: true,
      createdAt: "2026-08-25T00:00:00.000Z", updatedAt: "2026-08-25T00:00:00.000Z"
    };
  });
  await registerCloudRenderRoutes(app, { store, control });
  return { app, publication, worker };
}

function fakeWorker() {
  const response: CloudRenderWorkerSession = {
    contractVersion: 1,
    workerSessionId: "worker-session-1",
    sceneId: "scene-1",
    publishedAt: "2026-08-25T12:00:00.000Z",
    state: "media-ready",
    viewerUrl: "https://worker.example.test/watch/worker-session-1",
    mediaEvidence: {
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
      framesEncoded: 60,
      packetsSent: 240,
      bytesSent: 600_000
    }
  };
  const health: CloudRenderWorkerHealth = {
    contractVersion: 1,
    workerId: "worker-1",
    status: "ready",
    observedAt: "2026-08-25T12:00:05.000Z",
    capacity: { maxSessions: 4, activeSessions: 0 },
    gpu: { vendor: "NVIDIA", model: "L40S", memoryMiB: 48_000, encoder: { hardware: true, codecs: ["h264"] } }
  };
  return {
    health: vi.fn<CloudRenderWorkerClient["health"]>().mockResolvedValue(health),
    createSession: vi.fn<CloudRenderWorkerClient["createSession"]>().mockResolvedValue(response),
    getSession: vi.fn<CloudRenderWorkerClient["getSession"]>().mockResolvedValue(response),
    stopSession: vi.fn<CloudRenderWorkerClient["stopSession"]>().mockResolvedValue(undefined)
  };
}

function publishedScene(): PublishedSceneRecord {
  const publishedAt = "2026-08-25T12:00:00.000Z";
  return {
    sceneId: "scene-1",
    projectId: "default",
    name: "工厂总览",
    publishedAt,
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
      publishedAt,
      createdAt: "2026-08-25T11:00:00.000Z",
      updatedAt: publishedAt
    } as SceneSnapshot
  };
}
