import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import multipart from "@fastify/multipart";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalObjectStore } from "./objects.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";
import { registerVisionRoutes, VisionEngine } from "./vision.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("vision source routes", () => {
  it("creates a live source with browser playback and a server frame URL", async () => {
    const { app, projectId } = await createTestServer();
    vi.stubEnv("MEDIA_GATEWAY_HLS_URL", "https://media.local:8888");
    vi.stubEnv("MEDIA_GATEWAY_WEBRTC_URL", "https://media.local:8889");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/vision/sources`,
      payload: {
        name: "Assembly camera",
        kind: "video",
        protocol: "rtsp",
        sourceUrl: "rtsp://camera.local/live",
        playbackProtocol: "webrtc",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      protocol: "rtsp",
      playbackProtocol: "webrtc",
      playbackUrl: expect.stringContaining("https://media.local:8889/vision-"),
      frameUrl: expect.stringContaining("https://media.local:8888/vision-"),
    });
    await app.close();
  });

  it("uploads a video source into durable vision storage", async () => {
    const { app, dataDir, projectId } = await createTestServer();
    const boundary = "vision-source-test";
    const payload = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="line.mp4"\r\nContent-Type: video/mp4\r\n\r\nvideo-bytes\r\n--${boundary}--\r\n`,
    );

    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/vision/sources/upload?name=Line%20recording`,
      headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
      payload,
    });

    expect(response.statusCode).toBe(201);
    const source = response.json();
    expect(source).toMatchObject({ name: "Line recording", kind: "video", protocol: "upload", playbackProtocol: "file", mimeType: "video/mp4" });
    expect(await readFile(path.join(dataDir, "projects", projectId, "vision", "sources", source.id, "line.mp4"), "utf8")).toBe("video-bytes");
    await app.close();
  });
});

async function createTestServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-vision-routes-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const project = await store.createProject("Vision test");
  const objects = new LocalObjectStore(dataDir);
  await objects.init();
  const app = createApiServer();
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  const engine = new VisionEngine({ store, objects, dataDir });
  await registerVisionRoutes(app, engine, { store, objects, dataDir });
  return { app, dataDir, projectId: project.id };
}
