import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "./config.js";
import { registerRoutes } from "./routes.js";
import { createApiServer } from "./serverOptions.js";
import { JsonStore } from "./store.js";

const directories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((item) => rm(item, { recursive: true, force: true })));
});

describe("live monitor gateway route", () => {
  it("registers the real ingest source and returns browser playback URLs", async () => {
    const app = await createTestServer();
    const gatewayFetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", gatewayFetch);
    vi.stubEnv("MEDIA_GATEWAY_CONTROL_URL", "http://media-control:9997");
    vi.stubEnv("MEDIA_GATEWAY_HLS_URL", "https://media.example:8888");
    vi.stubEnv("MEDIA_GATEWAY_WEBRTC_URL", "https://media.example:8889");

    const response = await app.inject({ method: "POST", url: "/api/live-monitor/resolve", payload: { sourceUrl: "rtsp://camera.local/line-1", playback: "hls" } });

    expect(response.statusCode).toBe(200);
    expect(gatewayFetch).toHaveBeenCalledTimes(1);
    expect(gatewayFetch.mock.calls[0]![0]).toMatch(/^http:\/\/media-control:9997\/v3\/config\/paths\/add\/bim-/);
    expect(JSON.parse(String(gatewayFetch.mock.calls[0]![1]?.body))).toEqual({ source: "rtsp://camera.local/line-1", sourceOnDemand: true });
    expect(response.json()).toMatchObject({
      hlsUrl: expect.stringMatching(/^https:\/\/media\.example:8888\/bim-[a-f0-9]{16}\/index\.m3u8$/),
      webRtcUrl: expect.stringMatching(/^https:\/\/media\.example:8889\/bim-[a-f0-9]{16}$/)
    });
    await app.close();
  });

  it("rejects browser-executable input before contacting the gateway", async () => {
    const app = await createTestServer();
    const gatewayFetch = vi.fn();
    vi.stubGlobal("fetch", gatewayFetch);

    const response = await app.inject({ method: "POST", url: "/api/live-monitor/resolve", payload: { sourceUrl: "javascript:alert(1)", playback: "hls" } });

    expect(response.statusCode).toBe(400);
    expect(gatewayFetch).not.toHaveBeenCalled();
    await app.close();
  });
});

async function createTestServer() {
  const dataDir = await mkdtemp(path.join(tmpdir(), "bim-live-monitor-"));
  directories.push(dataDir);
  const store = new JsonStore(dataDir);
  await store.init();
  const app = createApiServer();
  await registerRoutes(app, { store, queue: undefined as never, objects: undefined as never, dataDir, config: loadConfig() });
  return app;
}
