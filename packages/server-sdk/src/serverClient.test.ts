import { describe, expect, it, vi } from "vitest";
import { ServerClient, type AuthStore } from "./serverClient.js";

const emptyAuthStore: AuthStore = {
  getAccessToken: () => undefined,
  setAccessToken: () => undefined,
  clearAccessToken: () => undefined
};

describe("ServerClient", () => {
  it.each([
    "https://bim.example.test",
    "https://bim.example.test/",
    "https://bim.example.test/base",
    "https://bim.example.test/base/"
  ])("resolves a root-relative path against profile %s", async (baseUrl) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ serverInstanceId: "s1" }));
    const client = new ServerClient({ profile: { baseUrl }, authStore: emptyAuthStore, fetch });

    await client.request("/api/meta");

    expect(fetch).toHaveBeenCalledWith(new URL("https://bim.example.test/api/meta"), expect.any(Object));
  });

  it.each([
    ["synchronous", (): string => "token-1"],
    ["asynchronous", async (): Promise<string> => "token-1"]
  ] as const)("supports an %s auth store and merges authorization with existing headers", async (_kind, getAccessToken) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ok: true }));
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test/base/" },
      authStore: { ...emptyAuthStore, getAccessToken },
      fetch
    });

    await client.request("/api/meta", { headers: { accept: "application/json", authorization: "Basic old" } });

    const [, init] = fetch.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer token-1");
  });

  it("does not mutate the caller's RequestInit or Headers", async () => {
    const sourceHeaders = new Headers({ accept: "application/json" });
    const sourceInit: RequestInit = { method: "POST", headers: sourceHeaders, body: "payload" };
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ok: true }));
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: { ...emptyAuthStore, getAccessToken: () => "token-1" },
      fetch
    });

    await client.request("/api/meta", sourceInit);

    const [, forwardedInit] = fetch.mock.calls[0]!;
    expect(sourceInit).toEqual({ method: "POST", headers: sourceHeaders, body: "payload" });
    expect(sourceInit.headers).toBe(sourceHeaders);
    expect(sourceHeaders.get("authorization")).toBeNull();
    expect(forwardedInit).not.toBe(sourceInit);
    expect(forwardedInit?.headers).not.toBe(sourceHeaders);
  });

  it("returns undefined for a 204 response", async () => {
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: emptyAuthStore,
      fetch: async () => new Response(null, { status: 204 })
    });

    await expect(client.request<void>("/api/projects/p1/applications/a1", { method: "DELETE" })).resolves.toBeUndefined();
  });

  it("throws the JSON error message", async () => {
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: emptyAuthStore,
      fetch: async () => new Response(JSON.stringify({ message: "保存失败" }), { status: 400 })
    });

    await expect(client.request("/api/projects")).rejects.toThrow("保存失败");
  });

  it("falls back to status text for a non-JSON error", async () => {
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: emptyAuthStore,
      fetch: async () => new Response("gateway unavailable", { status: 502, statusText: "Bad Gateway" })
    });

    await expect(client.request("/api/projects")).rejects.toThrow("Bad Gateway");
  });

  it("notifies exactly once and throws the server message on each failed 401 request", async () => {
    const onUnauthorized = vi.fn();
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: { ...emptyAuthStore, getAccessToken: () => "expired" },
      fetch: async () => new Response(JSON.stringify({ message: "登录失效" }), { status: 401 }),
      onUnauthorized
    });

    await expect(client.request("/api/projects")).rejects.toThrow("登录失效");
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
