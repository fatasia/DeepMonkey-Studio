import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerCloudRenderViewerRoutes } from "./cloudRenderViewerRoutes.js";

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

describe("cloud viewer public gateway", () => {
  it("serves HTML and authenticated signaling through the same public origin", async () => {
    const worker = Fastify(); apps.push(worker);
    worker.get("/viewer/:id", async (_request, reply) => reply.type("text/html").header("content-security-policy", "default-src 'none'").send("<!doctype html><video></video>"));
    worker.get("/v1/viewer/:id/offer", async (request, reply) => {
      expect(request.headers.authorization).toBeUndefined();
      expect(request.headers.cookie).toBeUndefined();
      if (request.headers["x-cloud-render-viewer-token"] !== "viewer-secret") return reply.code(403).send({ code: "invalid_viewer_token" });
      return { type: "offer", sdp: "offer-sdp" };
    });
    worker.post("/v1/viewer/:id/answer", async (request, reply) => {
      expect(request.headers["x-cloud-render-viewer-token"]).toBe("viewer-secret");
      expect(request.body).toEqual({ type: "answer", sdp: "answer-sdp" });
      return reply.code(204).send();
    });
    await worker.listen({ host: "127.0.0.1", port: 0 });
    const address = worker.server.address();
    if (!address || typeof address === "string") throw new Error("missing server address");
    const api = Fastify(); apps.push(api);
    registerCloudRenderViewerRoutes(api, { workerUrl: `http://127.0.0.1:${address.port}` });
    const html = await api.inject("/viewer/session-1");
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain("<video>");
    expect(html.headers["content-security-policy"]).toBe("default-src 'none'");
    expect(html.headers["cache-control"]).toBe("no-store");
    expect((await api.inject("/v1/viewer/session-1/offer")).statusCode).toBe(403);
    const headers = { "x-cloud-render-viewer-token": "viewer-secret", authorization: "Bearer admin-secret", cookie: "session=private" };
    expect((await api.inject({ url: "/v1/viewer/session-1/offer", headers })).json()).toEqual({ type: "offer", sdp: "offer-sdp" });
    expect((await api.inject({ method: "POST", url: "/v1/viewer/session-1/answer", headers, payload: { type: "answer", sdp: "answer-sdp" } })).statusCode).toBe(204);
    expect((await api.inject("/v1/sessions/session-1")).statusCode).toBe(404);
  });

  it("handles missing configuration without contacting any host", async () => {
    const api = Fastify(); apps.push(api);
    const fetch = vi.fn();
    registerCloudRenderViewerRoutes(api, { fetch });
    expect((await api.inject("/viewer/session-1")).statusCode).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds upstream failures and never exposes internal error text", async () => {
    const api = Fastify(); apps.push(api);
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error("internal-host:token"));
    registerCloudRenderViewerRoutes(api, { workerUrl: "http://worker.internal", fetch });
    const result = await api.inject("/viewer/session-1");
    expect(result.statusCode).toBe(502);
    expect(result.body).not.toContain("internal-host");
    expect(fetch.mock.calls[0]?.[1]?.redirect).toBe("error");
  });

  it("rejects excessive responses and invalid session paths", async () => {
    const api = Fastify(); apps.push(api);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response("x".repeat(1024 * 1024 + 1)));
    registerCloudRenderViewerRoutes(api, { workerUrl: "http://worker.internal", fetch });
    expect((await api.inject("/viewer/session-1")).statusCode).toBe(502);
    expect((await api.inject("/viewer/bad%2Fid")).statusCode).toBe(400);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
