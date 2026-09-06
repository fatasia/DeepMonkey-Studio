import { describe, expect, it, vi } from "vitest";
import { createDirectoryRequest, directoryStateForKey, EMPTY_DIRECTORY_STATE, type DirectoryLoadState } from "./managerDirectoryRequest";

function deferred<T>() {
  let resolve!: (data: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("manager directory requests", () => {
  it("publishes loading immediately and treats a successful empty array as ready", async () => {
    const publish = vi.fn(), accept = vi.fn(), result = deferred<string[]>();
    const request = createDirectoryRequest<string[]>(publish);
    const pending = request.load("user:project", () => result.promise, accept, () => true);
    expect(publish).toHaveBeenLastCalledWith({ key: "user:project", phase: "loading", hasData: false });
    result.resolve([]); await pending;
    expect(accept).toHaveBeenCalledWith([]);
    expect(publish).toHaveBeenLastCalledWith({ key: "user:project", phase: "ready", hasData: true });
  });

  it("keeps exhausted errors persistent without publishing empty data or automatic retries", async () => {
    const publish = vi.fn(), accept = vi.fn();
    const read = vi.fn().mockRejectedValue({ status: 503, message: "internal stack details" });
    const request = createDirectoryRequest<string[]>(publish);
    await request.load("project", read, accept, () => true);
    expect(read).toHaveBeenCalledOnce();
    expect(accept).not.toHaveBeenCalled();
    expect(publish).toHaveBeenLastCalledWith({ key: "project", phase: "error", hasData: false, httpStatus: 503 });
    expect(JSON.stringify(publish.mock.calls)).not.toContain("internal stack");
  });

  it("coalesces repeated retry clicks and then accepts a successful recovery", async () => {
    const result = deferred<string[]>(), read = vi.fn(() => result.promise), accept = vi.fn();
    const request = createDirectoryRequest<string[]>(vi.fn());
    await request.load("project", () => Promise.reject(new Error("offline")), accept, () => true);
    const first = request.load("project", read, accept, () => true);
    expect(request.load("project", read, accept, () => true)).toBe(first);
    result.resolve(["restored"]); await first;
    expect(read).toHaveBeenCalledOnce(); expect(accept).toHaveBeenCalledWith(["restored"]);
  });

  it.each(["resolve", "reject"] as const)("aborts superseded requests and ignores their late %s", async outcome => {
    const previous = deferred<string[]>(), current = deferred<string[]>();
    const publish = vi.fn(), accept = vi.fn();
    let previousSignal: AbortSignal | undefined;
    const request = createDirectoryRequest<string[]>(publish);
    const oldRun = request.load("old-user:old-project", signal => { previousSignal = signal; return previous.promise; }, accept, () => true);
    await Promise.resolve();
    const nextRun = request.load("new-user:new-project", () => current.promise, accept, () => true);
    expect(previousSignal?.aborted).toBe(true);
    current.resolve(["current"]); await nextRun;
    if (outcome === "resolve") previous.resolve(["stale"]);
    else previous.reject(new Error("stale failure"));
    await oldRun;
    expect(accept).toHaveBeenCalledExactlyOnceWith(["current"]);
    expect(publish).toHaveBeenLastCalledWith({ key: "new-user:new-project", phase: "ready", hasData: true });
  });

  it("rejects a changed identity before effect cleanup runs", async () => {
    const result = deferred<string[]>(), accept = vi.fn(), publish = vi.fn();
    let current = true;
    const request = createDirectoryRequest<string[]>(publish);
    const pending = request.load("scope", () => result.promise, accept, () => current);
    current = false; result.resolve(["old user"]); await pending;
    expect(accept).not.toHaveBeenCalled(); expect(publish).toHaveBeenCalledOnce();
  });

  it("unmount cancellation never publishes an error or accepts data", async () => {
    const result = deferred<string[]>(), accept = vi.fn(), publish = vi.fn();
    const request = createDirectoryRequest<string[]>(publish);
    const pending = request.load("scope", () => result.promise, accept, () => true);
    request.cancel(); result.reject(new DOMException("canceled", "AbortError")); await pending;
    expect(accept).not.toHaveBeenCalled(); expect(publish).toHaveBeenCalledOnce();
  });

  it("marks retained successful content as possibly stale during same-scope refresh failure", async () => {
    const states: DirectoryLoadState[] = [], accept = vi.fn();
    const request = createDirectoryRequest<string[]>(state => states.push(state));
    await request.load("a", () => Promise.resolve(["saved"]), accept, () => true);
    await request.load("a", () => Promise.reject({ status: 500 }), accept, () => true);
    expect(states.at(-1)).toEqual({ key: "a", phase: "error", hasData: true, httpStatus: 500 });
    await request.load("b", () => Promise.reject(new Error("offline")), accept, () => true);
    expect(states.at(-1)).toEqual({ key: "b", phase: "error", hasData: false });
  });

  it("never treats an old project snapshot as a ready new directory", () => {
    expect(directoryStateForKey(EMPTY_DIRECTORY_STATE, "new")).toEqual({ key: "new", phase: "loading", hasData: false });
    const ready: DirectoryLoadState = { key: "old", phase: "ready", hasData: true };
    expect(directoryStateForKey(ready, "new").phase).toBe("loading");
    expect(directoryStateForKey(ready, "old")).toBe(ready);
  });
});
