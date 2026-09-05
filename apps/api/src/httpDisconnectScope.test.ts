import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { httpDisconnectScope } from "./httpDisconnectScope.js";
import { registerIndustrialCapabilityRoutes, type IndustrialCapabilityHost } from "./industrialCapabilities.js";
import { createApiServer } from "./serverOptions.js";

describe("HTTP disconnect ownership", () => {
  it("does not mistake a normal completed response for cancellation, and cleans listeners", () => {
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), { writableFinished: true });
    const scope = httpDisconnectScope(request, response);
    response.emit("close");
    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
  });

  it("honours an already closed response even when the request body completed normally", () => {
    const scope = httpDisconnectScope(new EventEmitter(), Object.assign(new EventEmitter(), { destroyed: true, writableFinished: false }));
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
  });

  it("forwards a real post-upload socket close through the capability HTTP route", async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const host = {
      registry: { getCapability: () => ({ id: "data.query.draft", kind: "query", permissions: ["data.read"] }) },
      invoke: async (_id: string, request: { signal: AbortSignal }) => {
        signal = request.signal;
        signal.addEventListener("abort", release, { once: true });
        await waiting;
        return { status: "failed", error: { code: "aborted" }, warnings: [], evidence: [] };
      },
    } as unknown as IndustrialCapabilityHost;
    const app = createApiServer();
    await registerIndustrialCapabilityRoutes(app, { host, store: { getProject: () => ({ id: "project-1" }) } as never });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const controller = new AbortController();
    try {
      const response = fetch(`${address}/api/projects/project-1/capabilities/invoke`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ capabilityId: "data.query.draft", input: { prompt: "温度" } }),
      }).catch(error => error);
      await vi.waitFor(() => expect(signal).toBeDefined());
      controller.abort();
      await vi.waitFor(() => expect(signal?.aborted).toBe(true));
      await response;
    } finally {
      controller.abort();
      release();
      await app.close();
    }
  });
});
