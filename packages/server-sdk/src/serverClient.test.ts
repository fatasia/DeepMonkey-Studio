import { describe, expect, it, vi } from "vitest";
import { ServerClient, ServerRequestError, type AuthStore } from "./serverClient.js";

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

  it("resolves a fresh asynchronous profile for every request", async () => {
    let baseUrl = "https://old.example.test";
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ ok: true }));
    const client = new ServerClient({
      profile: async () => ({ baseUrl }),
      authStore: emptyAuthStore,
      fetch
    });

    await client.request("/api/meta");
    baseUrl = "https://new.example.test:8443";
    await client.request("/api/meta");

    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://old.example.test/api/meta",
      "https://new.example.test:8443/api/meta"
    ]);
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

  it("preserves revision-conflict evidence for a recoverable save experience", async () => {
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: emptyAuthStore,
      fetch: async () => new Response(JSON.stringify({ message: "应用已被其他修改更新", currentRevision: 8 }), { status: 409 })
    });

    const error = await client.request("/api/projects/default/applications/app-1").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ServerRequestError);
    expect(error).toMatchObject({ status: 409, body: { currentRevision: 8 } });
  });

  it("surfaces a unified gateway error envelope", async () => {
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: emptyAuthStore,
      fetch: async () => new Response(JSON.stringify({ error: { code: "OUTBOUND_DENIED", message: "目标主机不在出站白名单中" } }), { status: 403 })
    });

    await expect(client.request("/api/direct-bindings/http")).rejects.toThrow("目标主机不在出站白名单中");
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

  it("submits governed conversion tasks without leaking projectId into the body", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse({ id: "task-1" }));
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test" },
      authStore: emptyAuthStore,
      fetch,
    });

    await client.submitConversion({
      projectId: "project-1",
      pluginId: "industrial.jt-exchange",
      input: {
        objectKey: "projects/project-1/imports/line.jt",
        fileName: "line.jt",
        format: "jt",
        size: 128,
      },
    });

    const [url, init] = fetch.mock.calls[0]!;
    expect(String(url)).toBe("https://bim.example.test/api/projects/project-1/conversion-tasks");
    expect(JSON.parse(String(init?.body))).toEqual({
      pluginId: "industrial.jt-exchange",
      input: {
        objectKey: "projects/project-1/imports/line.jt",
        fileName: "line.jt",
        format: "jt",
        size: 128,
      },
    });
  });

  it.each([
    "https://evil.example/api/meta",
    "//evil.example/api/meta",
    "///evil.example/api/meta",
    "api/meta",
    "/\\evil.example/api/meta",
    "/api\\meta",
    "/assets/model.glb",
    "/api/meta#fragment"
  ])("rejects unsafe API path %j before reading auth or fetching", async (path) => {
    const getAccessToken = vi.fn(() => "token-1");
    const fetch = vi.fn<typeof globalThis.fetch>();
    const client = new ServerClient({
      profile: { baseUrl: "https://bim.example.test/base/" },
      authStore: { ...emptyAuthStore, getAccessToken },
      fetch
    });

    await expect(client.request(path)).rejects.toThrow("root-relative same-origin API path");
    expect(getAccessToken).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["", ".", "..", "bad/id", "bad\\id", "bad?query", "bad#fragment", "a".repeat(129)])
    ("rejects unsafe typed-client resource ID %j before reading auth or fetching", async (id) => {
      const getAccessToken = vi.fn(() => "token-1");
      const fetch = vi.fn<typeof globalThis.fetch>();
      const client = new ServerClient({
        profile: { baseUrl: "https://bim.example.test" },
        authStore: { ...emptyAuthStore, getAccessToken },
        fetch
      });

      expect(() => client.getApplication("default", id)).toThrow("applicationId");
      expect(getAccessToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}
