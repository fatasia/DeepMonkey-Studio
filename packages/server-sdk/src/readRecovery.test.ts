import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ServerClient, ServerRequestError } from "./serverClient.js";

function setup(enabled = true) {
  let token: string | undefined = "fixture-token";
  let baseUrl = "https://fixture.test";
  const fetch = vi.fn<typeof globalThis.fetch>();
  const onUnauthorized = vi.fn();
  const client = new ServerClient({
    profile: () => ({ baseUrl }),
    authStore: { getAccessToken: () => token, setAccessToken: () => {}, clearAccessToken: () => {} },
    fetch, onUnauthorized,
    ...(enabled ? { retryRead: (path: string) => path === "/api/projects" } : {}),
  });
  return { client, fetch, onUnauthorized, token: (value?: string) => { token = value; },
    profile: (value: string) => { baseUrl = value; } };
}
const ok = () => new Response('{"ok":true}', { status: 200 });
const fail = (status: number, headers?: HeadersInit) => new Response('{"message":"fixture unavailable"}', { status, headers });

describe("opt-in safe read recovery", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("supports cancellation on the application directory convenience method", async () => {
    const { client, fetch } = setup();
    const controller = new AbortController(); controller.abort();
    await expect(client.listApplications("project-1", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([502, 503, 504])("recovers one transient HTTP %s, without changing request identity", async status => {
    const context = setup();
    context.fetch.mockResolvedValueOnce(fail(status)).mockResolvedValueOnce(ok());
    const pending = context.client.request("/api/projects");
    await vi.advanceTimersByTimeAsync(499);
    expect(context.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ ok: true });
    expect(context.fetch).toHaveBeenCalledTimes(2);
    expect(context.fetch.mock.calls[1]).toEqual(context.fetch.mock.calls[0]);
    expect(context.onUnauthorized).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retries a fetch transport failure once, never a failed automatic retry", async () => {
    const { client, fetch } = setup();
    fetch.mockRejectedValue(new TypeError("Failed to fetch"));
    const pending = client.request("/api/projects").catch(error => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(TypeError);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves the final HTTP error evidence", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(fail(504));
    const pending = client.request("/api/projects").catch(error => error);
    await vi.runAllTimersAsync();
    expect(await pending).toBeInstanceOf(ServerRequestError);
    expect(await pending).toMatchObject({ status: 504, body: { message: "fixture unavailable" } });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([400, 401, 403, 404, 409, 429, 500])("never retries HTTP %s", async status => {
    const { client, fetch, onUnauthorized } = setup(); fetch.mockResolvedValueOnce(fail(status));
    await expect(client.request("/api/projects")).rejects.toMatchObject({ status });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onUnauthorized).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"])("never replays %s even on an opted-in path", async method => {
    const { client, fetch } = setup(); fetch.mockResolvedValueOnce(fail(503));
    await expect(client.request("/api/projects", { method })).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("requires SDK opt-in and a matching path (enabled=%s)", async enabled => {
    const { client, fetch } = setup(enabled); fetch.mockResolvedValueOnce(fail(503));
    await expect(client.request(enabled ? "/api/auth/me" : "/api/projects")).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("honors a bounded Retry-After and returns long cooldowns for manual recovery", async () => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(fail(503, { "retry-after": "1" })).mockResolvedValueOnce(ok());
    const pending = client.request("/api/projects");
    await vi.advanceTimersByTimeAsync(999); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await expect(pending).resolves.toEqual({ ok: true });
    fetch.mockReset().mockResolvedValueOnce(fail(503, { "retry-after": "120" }));
    await expect(client.request("/api/projects")).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts pending backoff immediately and clears its timer", async () => {
    const { client, fetch } = setup(); const controller = new AbortController();
    fetch.mockResolvedValueOnce(fail(503));
    const pending = client.request("/api/projects", { signal: controller.signal }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["abort", "timeout", "other"])("does not treat %s failures as a reconnect", async kind => {
    const { client, fetch } = setup();
    const reason = kind === "other" ? new Error("adapter failed") : new DOMException("stopped", kind === "abort" ? "AbortError" : "TimeoutError");
    fetch.mockRejectedValueOnce(reason);
    await expect(client.request("/api/projects")).rejects.toBe(reason);
    expect(fetch).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["token", "logout", "profile"])("stops before retry when %s changes", async kind => {
    const context = setup(); context.fetch.mockResolvedValueOnce(fail(503));
    const pending = context.client.request("/api/projects").catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    if (kind === "token") context.token("new-fixture-token");
    if (kind === "logout") context.token();
    if (kind === "profile") context.profile("https://different-fixture.test");
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ name: "AbortError" });
    expect(context.fetch).toHaveBeenCalledTimes(1);
    expect(context.onUnauthorized).not.toHaveBeenCalled();
  });

  it("does not fetch an already canceled request", async () => {
    const { client, fetch } = setup();
    await expect(client.request("/api/projects", { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never replays a success with invalid JSON", async () => {
    const { client, fetch } = setup(); fetch.mockResolvedValueOnce(new Response("invalid"));
    await expect(client.request("/api/projects")).rejects.toMatchObject({ status: 200 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("snapshots the original method, signal and headers before backoff", async () => {
    const { client, fetch } = setup();
    const headers = new Headers({ accept: "application/json" });
    const init: RequestInit = { method: "GET", headers };
    fetch.mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(ok());
    const pending = client.request("/api/projects", init);
    await vi.advanceTimersByTimeAsync(100);
    init.method = "POST"; init.body = "must-not-write"; init.signal = AbortSignal.abort(); headers.set("accept", "text/html");
    await vi.runAllTimersAsync(); await expect(pending).resolves.toEqual({ ok: true });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "GET" });
    expect(fetch.mock.calls[1]?.[1]?.body).toBeUndefined();
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get("accept")).toBe("application/json");
  });

  it.each([null, 42, [], { message: 4 }, { error: null }])("preserves nonstandard HTTP error bodies: %j", async body => {
    const { client, fetch } = setup();
    fetch.mockResolvedValueOnce(fail(503)).mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 503 }));
    const pending = client.request("/api/projects").catch(error => error);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ name: "ServerRequestError", status: 503, body });
  });
});
