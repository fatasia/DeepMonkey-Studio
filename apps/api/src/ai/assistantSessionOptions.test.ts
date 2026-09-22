import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StoredSystemUserRecord } from "@bim-studio/contracts";
import { createApiServer } from "../serverOptions.js";
import { registerSystemRoutes } from "../system.js";
import type { MetadataStore } from "../store.js";
import type { AiRuntimeSettings, AssistantRequest, AssistantService } from "./assistantService.js";
import { assistantSessionCatalog, resolveAssistantSessionOptions } from "./assistantSessionOptions.js";
import { clearModelCatalogCacheForTests } from "./aiModelCatalog.js";

const settings: AiRuntimeSettings = { providerId: "ai.openai-compatible", baseUrl: "https://models.test/v1", apiKey: "secret-key", model: "primary", protocol: "responses", temperature: .2, reasoningEffort: "deep" };
afterEach(() => { vi.unstubAllGlobals(); clearModelCatalogCacheForTests(); });
function catalog() { vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "primary" }, { id: "other" }] })))); }

describe("assistant session overrides", () => {
  it("returns only public model identity and configured capabilities", async () => {
    catalog();
    const result = await assistantSessionCatalog(settings);
    expect(result.models).toEqual([{ id: "primary", reasoningEfforts: ["minimal", "standard", "deep"] }, { id: "other", reasoningEfforts: [] }]);
    expect(JSON.stringify(result)).not.toMatch(/secret-key|models.test|apiKey|baseUrl/);
  });
  it("does not mutate global settings or leak primary reasoning to a different model", async () => {
    catalog();
    const selected = await resolveAssistantSessionOptions(settings, { model: "other" });
    expect(selected.model).toBe("other"); expect(selected.reasoningEffort).toBeUndefined();
    expect(settings).toMatchObject({ model: "primary", reasoningEffort: "deep" });
    expect((await resolveAssistantSessionOptions(settings, { reasoningEffort: "minimal" })).reasoningEffort).toBe("minimal");
  });
  it("rejects unknown models, unsupported efforts, malformed input and SQL overrides", async () => {
    catalog();
    for (const input of [{ model: "missing" }, { model: "other", reasoningEffort: "deep" }, { model: 3 }, { reasoningEffort: "ultra" }]) {
      await expect(resolveAssistantSessionOptions(settings, input as never)).rejects.toThrow();
    }
    await expect(resolveAssistantSessionOptions(settings, { model: "primary" }, "sql")).rejects.toThrow("受控查询");
    expect(await resolveAssistantSessionOptions(settings, {})).toBe(settings);
  });
  it("retains configured model when catalog is unavailable without exposing provider errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("private-url secret-key"); }));
    const result = await assistantSessionCatalog(settings);
    expect(result.catalogAvailable).toBe(false); expect(result.models).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private-url");
  });
  it("authenticates catalog and validates stream overrides before SSE headers for a viewer", async () => {
    catalog();
    const users = new Map<string, StoredSystemUserRecord>();
    const store = { listUsers: () => [...users.values()], getUser: (id: string) => users.get(id),
      findUserByUsername: (name: string) => [...users.values()].find(user => user.username === name),
      saveUser: async (user: StoredSystemUserRecord) => { users.set(user.id, user); return user; },
      addAuditLog: async () => undefined, getAiSettings: () => settings, getBrandingSettings: () => undefined,
    } as unknown as MetadataStore;
    let observed: AssistantRequest | undefined;
    const assistant: AssistantService = { complete: async request => { observed = request; return { text: "ok", model: request.settings.model }; },
      async *stream(request) { observed = request; yield { type: "done", result: { text: "ok", model: request.settings.model } }; } };
    const app = createApiServer();
    await registerSystemRoutes(app, store, tmpdir(), { assistant });
    try {
      expect((await app.inject({ url: "/api/ai/assistant/models" })).statusCode).toBe(401);
      const login = await app.inject({ method: "POST", url: "/api/auth/login", payload: { username: "admin", password: "admin" } });
      const headers = { authorization: `Bearer ${login.json().token}` };
      for (const user of users.values()) user.role = "viewer";
      expect((await app.inject({ url: "/api/admin/ai-settings", headers })).statusCode).toBe(403);
      const publicCatalog = await app.inject({ url: "/api/ai/assistant/models", headers });
      expect(publicCatalog.statusCode).toBe(200);
      expect(publicCatalog.headers["cache-control"]).toBe("private, no-store");
      expect(publicCatalog.body).not.toMatch(/secret-key|models.test|apiKey|baseUrl/);
      const good = await app.inject({ method: "POST", url: "/api/ai/assistant/stream", headers, payload: { question: "检查", model: "other" } });
      expect(good.statusCode).toBe(200); expect(good.body).toContain('"model":"other"');
      expect(observed?.settings.reasoningEffort).toBeUndefined();
      const bad = await app.inject({ method: "POST", url: "/api/ai/assistant/stream", headers, payload: { question: "检查", model: "other", reasoningEffort: "deep" } });
      expect(bad.statusCode).toBe(400); expect(bad.headers["content-type"]).toContain("application/json");
      for (const url of ["/api/ai/assistant", "/api/ai/assistant/stream"]) {
        for (const payload of [{ question: 123 }, { question: "检查", projectId: [] }, { question: "检查", model: 3 }, { question: "检查", reasoningEffort: "ultra" }]) {
          observed = undefined;
          const invalid = await app.inject({ method: "POST", url, headers, payload });
          expect(invalid.statusCode).toBe(400);
          expect(invalid.headers["content-type"]).toContain("application/json");
          expect(observed).toBeUndefined();
        }
      }
    } finally { await app.close(); }
  });
});
