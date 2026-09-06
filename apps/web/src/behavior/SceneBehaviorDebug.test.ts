import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneBehaviorModule, SceneBehaviorWorkerRequest, SceneBehaviorWorkerResponse } from "@bim-studio/scene-sdk";
import { SceneBehaviorHost, type SceneBehaviorHostOptions, type SceneBehaviorWorkerPort } from "./SceneBehaviorHost";
import { behaviorScriptSource } from "./behaviorScriptSource";

class WorkerPort implements SceneBehaviorWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: SceneBehaviorWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(message: SceneBehaviorWorkerRequest) { this.posted.push(message); }
  emit(message: SceneBehaviorWorkerResponse) { this.onmessage?.({ data: message } as MessageEvent<unknown>); }
  invocations() { return this.posted.filter(item => item.type === "behavior.invoke"); }
}
const module: SceneBehaviorModule = {
  id: "debug:test", name: "debug test", apiVersion: "1.0", code: "function onStart(ctx) {}",
  lifecycle: ["onStart", "onUpdate", "onFixedUpdate", "onData", "onEvent"],
  permissions: ["scene.read", "network.connect", "ai.invoke"], capabilities: ["studio.runtime", "studio.ai"],
};
function setup(options: SceneBehaviorHostOptions = {}) {
  const worker = new WorkerPort();
  const host = new SceneBehaviorHost(worker, { authorDebug: true, ...options });
  host.start(module, "scene");
  const ready = () => worker.emit({ type: "behavior.ready", moduleId: module.id, lifecycle: module.lifecycle });
  const complete = () => {
    for (const request of worker.invocations()) worker.emit({ type: "behavior.result", invocationId: request.invocationId, commands: [], durationMs: 1 });
  };
  return { worker, host, ready, complete };
}
afterEach(() => vi.useRealTimers());

describe("explicit author DevTools sessions", () => {
  it("allows an initialization breakpoint to wait and requires a separate start after source readiness", () => {
    vi.useFakeTimers();
    const { worker, host, ready } = setup();
    vi.advanceTimersByTime(60_000);
    expect(host.diagnostics().status).toBe("initializing");
    host.dispatchData({ latest: 4 });
    ready();
    expect(host.diagnostics()).toMatchObject({ status: "paused", authorDebug: { awaitingStart: true, sourceUrl: "industrial-studio-behavior-debug%3Atest.js", lineOffset: 3 } });
    host.advance(1000);
    expect(host.step()).toBe(false);
    expect(worker.invocations()).toEqual([]);
    host.resume();
    expect(worker.invocations().map(item => item.lifecycle)).toEqual(["onStart", "onData"]);
    expect(worker.invocations()[0]).toMatchObject({ elapsedMs: 0, data: { latest: 4 } });
    vi.advanceTimersByTime(60_000);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(host.diagnostics().status).toBe("running"); // The page does not claim a debugger pause.
    host.dispose();
  });

  it("freezes scheduler time and drops incoming events/data during an in-flight frame without starving fixed update", () => {
    const { worker, host, ready, complete } = setup();
    ready(); host.resume(); complete();
    host.advance(25);
    const posted = worker.invocations().length;
    const scheduler = host.diagnostics().scheduler;
    expect(worker.invocations().map(item => item.lifecycle)).toContain("onFixedUpdate");
    for (let index = 0; index < 100; index++) {
      host.advance(1000);
      host.dispatchData({ index });
      host.dispatchEvent({ type: "scene.ready", sceneId: "scene", timestamp: "2026-09-06T00:00:00Z" });
    }
    expect(worker.invocations()).toHaveLength(posted);
    expect(host.diagnostics().scheduler).toEqual(scheduler);
    complete();
    host.advance(5);
    expect(host.diagnostics().scheduler.elapsedMs).toBe(30);
    expect(worker.invocations().filter(item => item.lifecycle === "onEvent" || item.lifecycle === "onData")).toEqual([]);
    host.dispose();
  });

  it.each([false, true])("terminates immediately during initialization or real breakpoint wait (ready=%s), rejecting captured late callbacks", isReady => {
    const { worker, host, ready } = setup();
    const commands = vi.fn(), data = vi.fn(), events = vi.fn(), logs = vi.fn();
    host.onCommands = commands; host.onDataUpdates = data; host.onEvent = events; host.onLog = logs;
    if (isReady) { ready(); host.resume(); }
    const stale = worker.onmessage!;
    if (isReady) host.stop(); else host.dispose();
    host.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(worker.posted.some(item => item.type === "behavior.dispose")).toBe(false);
    expect(worker.onmessage).toBeNull();
    const invocationId = worker.invocations()[0]?.invocationId ?? "old";
    stale({ data: { type: "behavior.result", invocationId, commands: [], durationMs: 2, dataUpdates: { late: true }, events: [{ name: "late" }] } } as MessageEvent);
    stale({ data: { type: "behavior.log", level: "info", message: "late" } } as MessageEvent);
    for (const callback of [commands, data, events, logs]) expect(callback).not.toHaveBeenCalled();
    expect(host.diagnostics()).toMatchObject({ status: "disposed", pendingInvocations: 0 });
  });

  it("retains the normal initialization and 25 ms execution watchdogs", () => {
    vi.useFakeTimers();
    const loading = setup({ authorDebug: false });
    vi.advanceTimersByTime(2000);
    expect(loading.host.diagnostics()).toMatchObject({ status: "error", lastError: expect.stringContaining("初始化超过 2000 ms") });
    const running = setup({ authorDebug: false });
    running.ready();
    vi.advanceTimersByTime(25);
    expect(running.host.diagnostics()).toMatchObject({ status: "error", lastError: expect.stringContaining("超过 25 ms") });
    expect(running.worker.terminate).toHaveBeenCalledOnce();
  });

  it("keeps network waiting bounded, then permits a breakpoint after the resolved response", async () => {
    vi.useFakeTimers();
    const binding = { version: 1 as const, gateway: "server" as const, transport: "http" as const, endpoint: "https://example.test", http: { method: "GET" as const, refresh: { intervalMs: 1000 } } };
    const { worker, host, ready } = setup({ networkTimeoutMs: 100, executeNetworkRequest: async () => ({ ok: true, status: 200, data: null, value: null }) });
    ready(); host.resume();
    worker.emit({ type: "behavior.network.request", invocationId: worker.invocations()[0]!.invocationId, requestId: "net", binding, variables: {} });
    await Promise.resolve();
    expect(worker.posted.some(item => item.type === "behavior.network.result")).toBe(true);
    vi.advanceTimersByTime(60_000);
    expect(host.diagnostics().status).toBe("running");
    host.dispose();
    const hung = setup({ networkTimeoutMs: 100, executeNetworkRequest: () => new Promise(() => undefined) });
    hung.ready(); hung.host.resume();
    hung.worker.emit({ type: "behavior.network.request", invocationId: hung.worker.invocations()[0]!.invocationId, requestId: "hung", binding, variables: {} });
    vi.advanceTimersByTime(100);
    expect(hung.host.diagnostics()).toMatchObject({ status: "error", lastError: expect.stringContaining("网络请求超过 100 ms") });
  });

  it("clears a resolved AI wait and ignores a response arriving after stop", async () => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const { worker, host, ready } = setup({ capabilityTimeoutMs: 100, executeCapabilityRequest: () => new Promise(done => { resolve = done; }) });
    ready(); host.resume();
    const request = { type: "behavior.capability.request" as const, invocationId: worker.invocations()[0]!.invocationId, requestId: "ai", capabilityId: "test", input: {} };
    worker.emit(request);
    resolve("resolved"); await Promise.resolve();
    vi.advanceTimersByTime(500);
    expect(host.diagnostics().status).toBe("running");
    worker.emit({ ...request, requestId: "late" });
    host.dispose(); resolve("late"); await Promise.resolve();
    expect(worker.posted.filter(item => item.type === "behavior.capability.result")).toHaveLength(1);
  });

  it("maps encoded module identities and preserves source identity across re-runs", () => {
    const source = behaviorScriptSource({ id: "line\nbreak/测试", code: "export function onStart() {}" });
    expect(source).toEqual({ url: "industrial-studio-behavior-line%0Abreak%2F%E6%B5%8B%E8%AF%95.mjs", lineOffset: 1 });
    expect(behaviorScriptSource({ id: "line\nbreak/测试", code: "export function onStart() { return 2; }" })).toEqual(source);
    const { worker, host, ready } = setup(); ready(); host.resume();
    worker.emit({ type: "behavior.error", message: "test", stack: "at onStart (industrial-studio-behavior-debug%3Atest.js:6:7)" });
    expect(host.diagnostics().lastErrorLocation).toEqual({ line: 3, column: 7 });
  });
});
