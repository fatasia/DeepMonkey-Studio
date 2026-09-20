import { afterEach, describe, expect, it, vi } from "vitest";
import { clearModelCatalogCacheForTests, fetchProviderModels } from "./aiModelCatalog.js";

afterEach(() => {
  vi.unstubAllGlobals();
  clearModelCatalogCacheForTests();
});

const input = { baseUrl: "https://models.test/v1", apiKey: "secret-key" };

describe("AI model catalog", () => {
  it("normalizes the OpenAI model list payload and caches the result", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: [{ id: "gpt-5.5" }, { id: "gpt-4.1-mini" }, { id: "gpt-5.5" }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchProviderModels(input);
    expect(first).toMatchObject({ ok: true, models: ["gpt-4.1-mini", "gpt-5.5"] });
    const second = await fetchProviderModels(input);
    expect(second).toMatchObject({ ok: true, models: ["gpt-4.1-mini", "gpt-5.5"] });
    expect(second.cachedAt).toBeDefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bypasses the cache on explicit refresh", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    await fetchProviderModels(input);
    const refreshed = await fetchProviderModels({ ...input, refresh: true });
    expect(refreshed).toMatchObject({ ok: true, models: ["m"] });
    expect(refreshed.cachedAt).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("categorizes auth failures without exposing the API key", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("denied", { status: 401 })));
    const result = await fetchProviderModels(input);
    expect(result).toMatchObject({ ok: false, category: "auth" });
    expect(JSON.stringify(result)).not.toContain("secret-key");
  });

  it("categorizes a missing /models endpoint as unsupported with manual-entry guidance", async () => {
    for (const status of [404, 405, 501]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
      expect(await fetchProviderModels(input)).toMatchObject({ ok: false, category: "unsupported" });
    }
  });

  it("categorizes connection and timeout failures as network", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    expect(await fetchProviderModels(input)).toMatchObject({ ok: false, category: "network" });
  });

  it("categorizes server errors distinctly and rejects invalid drafts up front", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("boom", { status: 502 })));
    expect(await fetchProviderModels(input)).toMatchObject({ ok: false, category: "server" });
    expect(await fetchProviderModels({ baseUrl: "https://models.test/v1", apiKey: "" })).toMatchObject({ ok: false, category: "invalid" });
    expect(await fetchProviderModels({ baseUrl: "file:///tmp", apiKey: "k" })).toMatchObject({ ok: false, category: "invalid" });
  });

  it("parses alternate list shapes and rejects unknown payloads as unsupported", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "gpt-5.6-sol" }] }), { status: 200 })));
    expect(await fetchProviderModels(input)).toMatchObject({ ok: true, models: ["gpt-5.6-sol"] });
    clearModelCatalogCacheForTests();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), { status: 200 })));
    expect(await fetchProviderModels(input)).toMatchObject({ ok: false, category: "unsupported" });
  });
});
