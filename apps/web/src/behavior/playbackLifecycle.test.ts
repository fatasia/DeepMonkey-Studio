import { afterEach, describe, expect, it, vi } from "vitest";
import type { SceneBehaviorModule, SceneBehaviorWorkerRequest, SceneBehaviorWorkerResponse } from "@bim-studio/scene-sdk";
import type { ScriptModule, SceneSnapshot } from "@bim-studio/contracts";
import { migrateSceneSnapshotV1 } from "@bim-studio/contracts";
import fixture from "../../../../test-fixtures/scene-v1-pure-3d.json";
import { SceneBehaviorHost, type SceneBehaviorWorkerPort } from "./SceneBehaviorHost";
import { ApplicationPlaybackSession } from "./ApplicationPlaybackSession";
import type { SceneCommandPort } from "./SceneCommandExecutor";
import { assertBehaviorSourceAccess } from "../workers/sceneBehaviorSandbox";

class WorkerPort implements SceneBehaviorWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  posted: SceneBehaviorWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(value: SceneBehaviorWorkerRequest) { this.posted.push(value); }
  emit(value: SceneBehaviorWorkerResponse) { this.onmessage?.({ data: value } as MessageEvent); }
  ready() {
    const init = this.posted.find((item) => item.type === "behavior.initialize")!;
    this.emit({ type: "behavior.ready", moduleId: init.module.id, lifecycle: init.module.lifecycle });
  }
  result(commands: Extract<SceneBehaviorWorkerResponse, { type: "behavior.result" }>["commands"] = [], lifecycle = "onStart") {
    const invocation = this.posted.find((item) => item.type === "behavior.invoke" && item.lifecycle === lifecycle);
    if (!invocation || invocation.type !== "behavior.invoke") throw new Error("No invocation");
    this.emit({ type: "behavior.result", invocationId: invocation.invocationId, durationMs: 1, commands });
  }
}
const script = (id: string, target?: ScriptModule["target"]): ScriptModule => ({ id, name: id, code: "function onStart() {}", apiVersion: "1.0", entrypoint: "behavior", runtime: "worker-sandbox", enabled: true, lifecycle: ["onStart", "onEvent", "onStop", "onDispose"], capabilities: ["studio.runtime", "studio.component"], permissions: ["scene.write", "data.read", "data.write"], ...(target ? { target } : {}) });
const module = (): SceneBehaviorModule => ({ ...script("module"), capabilities: ["studio.component"], permissions: ["scene.write", "network.connect"] });
function source() {
  const app = migrateSceneSnapshotV1(fixture as SceneSnapshot);
  app.pages = ["one", "two"].map((id) => ({ id, name: id, width: 1000, height: 700, viewportFit: "contain", nodes: [{ id, kind: "data-widget", name: id, zIndex: 1, frame: { x: 0, y: 0, width: 200, height: 100 }, widget: { type: "text", title: "author", key: "", unit: "" } }] }));
  app.scripts = [script("global"), script("a", { kind: "component", id: "one" }), script("b", { kind: "component", id: "two" }), { ...script("disabled"), enabled: false }];
  return app;
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("playback lifecycle ownership", () => {
  it("does not leak author-test navigation onto the editor event bus", async () => {
    vi.useFakeTimers();
    const browser = new EventTarget(); vi.stubGlobal("window", browser);
    const app = source(); app.scripts = [];
    app.interactions = [{ id: "go", name: "go", source: { kind: "widget", id: "one" }, trigger: "click", enabled: true,
      actions: [{ id: "page", type: "dashboard", dashboardPageId: "two", enabled: true }, { id: "url", type: "openUrl", url: "https://example.test", enabled: true }] }];
    const original = structuredClone(app);
    const session = new ApplicationPlaybackSession(app, "one", { isolateNavigation: true });
    const globalEffect = vi.fn(); const privateEffect = vi.fn();
    browser.addEventListener("bim-studio:application-interaction-effect", globalEffect);
    session.effects.addEventListener("bim-studio:application-interaction-effect", privateEffect);
    await session.start(); session.interact({ source: { kind: "widget", id: "one" }, trigger: "click", timestamp: new Date().toISOString() });
    expect(privateEffect).toHaveBeenCalledTimes(2); expect(globalEffect).not.toHaveBeenCalled(); expect(app).toEqual(original);
    session.dispose(); vi.runAllTimers();
  });
  it("ignores an obsolete dependency failure after a newer start succeeded", async () => {
    vi.useFakeTimers();
    const app = source(); app.scripts = [];
    const session = new ApplicationPlaybackSession(app, "one");
    let reject!: (error: Error) => void;
    const first = session.start(() => new Promise((_, fail) => { reject = fail; }));
    await session.start(); reject(new Error("stale dependency failure")); await first;
    expect(session.loading).toBe(false); expect(session.logs).toEqual([]); session.dispose();
  });
  it("steps one paused frame, waits for outstanding work, and remains paused", async () => {
    vi.useFakeTimers();
    const app = source();
    app.scripts = [{ ...script("frame"), lifecycle: ["onUpdate", "onFixedUpdate"] }];
    const port = new WorkerPort();
    const session = new ApplicationPlaybackSession(app, "one", { workerFactory: () => port });
    await session.start(); port.ready();
    expect(session.step()).toBe(false);
    session.togglePause();
    expect(session.step()).toBe(true);
    expect(session.step()).toBe(false);
    expect(port.posted.filter(item => item.type === "behavior.invoke").map(item => item.lifecycle)).toEqual(["onUpdate", "onFixedUpdate"]);
    port.result([], "onUpdate"); port.result([], "onFixedUpdate");
    expect(session.entries[0]!.diagnostics.status).toBe("paused");
    expect(session.entries[0]!.diagnostics.scheduler.frame).toBe(1);
    session.advance(1000);
    expect(session.entries[0]!.diagnostics.scheduler.frame).toBe(1);
    expect(session.step()).toBe(true);
    session.dispose(); vi.runAllTimers();
    expect(session.step()).toBe(false);
    expect(port.terminate).toHaveBeenCalledOnce();
  });
  it("queues onStop before onDispose once, discards cleanup writes and ignores late messages", () => {
    vi.useFakeTimers();
    const port = new WorkerPort();
    const host = new SceneBehaviorHost(port);
    host.start(module(), "scene"); port.ready(); port.result();
    const change = vi.fn(); host.onDataUpdates = change;
    host.dispose(); host.dispose();
    expect(port.posted.slice(-2).map((item) => item.type === "behavior.invoke" ? item.lifecycle : item.type)).toEqual(["onStop", "behavior.dispose"]);
    const dispose = port.posted.find((item) => item.type === "behavior.dispose")!;
    port.emit({ type: "behavior.result", invocationId: dispose.invocationId, durationMs: 1, commands: [], dataUpdates: { leak: true } });
    port.emit({ type: "behavior.error", message: "late crash" });
    vi.runAllTimers();
    expect(change).not.toHaveBeenCalled(); expect(port.terminate).toHaveBeenCalledOnce();
    expect(host.diagnostics().status).toBe("disposed");
  });
  it("terminates idle Workers and bounded stuck cleanup", () => {
    vi.useFakeTimers();
    const idle = new WorkerPort(); new SceneBehaviorHost(idle).dispose();
    expect(idle.terminate).toHaveBeenCalledOnce();
    const port = new WorkerPort(); const host = new SceneBehaviorHost(port, { executionBudgetMs: 10 });
    host.start(module(), "scene"); port.ready(); host.dispose(); vi.advanceTimersByTime(10);
    expect(port.terminate).toHaveBeenCalledOnce(); expect(host.diagnostics().status).toBe("disposed");
  });
  it("does not post an awaited network result after disposal", async () => {
    vi.useFakeTimers();
    let resolve!: (value: { ok: true; status: number; data: null; value: null }) => void;
    const port = new WorkerPort();
    const host = new SceneBehaviorHost(port, { executeNetworkRequest: () => new Promise((done) => { resolve = done; }) });
    host.start(module(), "scene"); port.ready();
    const invocation = port.posted.find((item) => item.type === "behavior.invoke")!;
    port.emit({ type: "behavior.network.request", requestId: "net", invocationId: invocation.invocationId, binding: { version: 1, gateway: "server", transport: "http", endpoint: "https://example.com", http: { method: "GET", refresh: { intervalMs: 60000 } } }, variables: {} });
    host.dispose(); resolve({ ok: true, status: 200, data: null, value: null }); await Promise.resolve();
    expect(port.posted.some((item) => item.type === "behavior.network.result")).toBe(false);
    vi.runAllTimers();
  });
  it("allows the documented self handle, retains global checks and maps ESM errors", () => {
    expect(() => assertBehaviorSourceAccess("ctx.self.update({name: 'test'}); context?.self.hide();", false)).not.toThrow();
    for (const code of ["self.postMessage({})", "globalThis.fetch('x')", "fetch('x')"]) expect(() => assertBehaviorSourceAccess(code, false)).toThrow();
    const port = new WorkerPort(); const host = new SceneBehaviorHost(port);
    host.start(module(), "scene"); port.ready();
    port.emit({ type: "behavior.error", message: "boom", stack: "at onStart (industrial-studio-behavior-module.mjs:5:7)" });
    expect(host.diagnostics().lastErrorLocation).toEqual({ line: 4, column: 7 });
  });
  it("automounts only enabled current-page modules and preserves global state on page changes", async () => {
    vi.useFakeTimers();
    const workers: WorkerPort[] = [];
    const app = source(); const original = structuredClone(app);
    const session = new ApplicationPlaybackSession(app, "one", { workerFactory: () => { const port = new WorkerPort(); workers.push(port); return port; } });
    await session.start(); workers.forEach((port) => { port.ready(); port.result(); });
    expect(session.loading).toBe(false); expect(session.entries.map((entry) => entry.module.id)).toEqual(["global", "a"]);
    session.state.updateComponent("one", { widget: { title: "runtime only" } }); session.setVariables({ count: 3 });
    expect(app).toEqual(original);
    session.selectPage("two");
    expect(workers).toHaveLength(3); expect(session.entries.map((entry) => entry.module.id)).toEqual(["global", "b"]);
    expect(workers[0]!.posted.some((item) => item.type === "behavior.dispose")).toBe(false);
    expect(workers[1]!.posted.some((item) => item.type === "behavior.dispose")).toBe(true);
    expect(session.state.variables.count).toBe(3);
    session.dispose(); vi.runAllTimers(); expect(workers.every((port) => port.terminate.mock.calls.length === 1)).toBe(true);
  });
  it("cancels dependency initialization on exit and rejects queued commands from a retired page", async () => {
    vi.useFakeTimers();
    const workerFactory = vi.fn(() => new WorkerPort());
    const pending = new ApplicationPlaybackSession(source(), "one", { workerFactory });
    let finish!: (value: []) => void;
    const loading = pending.start(() => new Promise((resolve) => { finish = resolve; }));
    pending.dispose(); finish([]); await loading;
    expect(workerFactory).not.toHaveBeenCalled();
    const session = new ApplicationPlaybackSession(source(), "one", { workerFactory });
    await session.start(); const port = workerFactory.mock.results[1]!.value; port.ready();
    port.result([{ type: "component.update", id: "late", componentId: "one", patch: { name: "leaked" } }]);
    session.selectPage("two"); await Promise.resolve();
    expect(session.state.document.pages[0]!.nodes[0]!.name).toBe("one"); session.dispose(); vi.runAllTimers();
  });
  it("waits for a real scene port before starting object scripts, then retires them on unload", async () => {
    vi.useFakeTimers();
    const app = source(); const scene = app.scenes[0]!;
    const object = { modelId: "pump", name: "pump", kind: "box" as const, color: "#ffffff", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } } };
    scene.primitives.push(object);
    app.pages[0]!.nodes.push({ id: "viewport", kind: "scene-viewport", name: "3D", zIndex: 2, frame: { x: 0, y: 0, width: 300, height: 300 }, sceneId: scene.id, renderMode: "realtime", interactionPolicy: "click-select", overlaySlot: "page" });
    app.scripts = [script("object", { kind: "object", id: object.modelId })];
    const workers: WorkerPort[] = [];
    const session = new ApplicationPlaybackSession(app, "one", { workerFactory: () => { const port = new WorkerPort(); workers.push(port); return port; } });
    await session.start(); expect(workers).toHaveLength(0);
    const remove = session.registerScene(scene.id, {} as SceneCommandPort);
    expect(workers).toHaveLength(1); remove(); expect(session.entries).toEqual([]);
    session.dispose(); vi.runAllTimers();
  });
  it("routes component events to their own mount and scene-wide listeners only", async () => {
    vi.useFakeTimers();
    const app = source(); app.pages[0]!.nodes.push(structuredClone(app.pages[1]!.nodes[0]!));
    const workers: WorkerPort[] = [];
    const session = new ApplicationPlaybackSession(app, "one", { workerFactory: () => { const port = new WorkerPort(); workers.push(port); return port; } });
    await session.start(); workers.forEach((port) => { port.ready(); port.result(); });
    session.interact({ source: { kind: "widget", id: "one" }, trigger: "click", timestamp: new Date().toISOString() });
    expect(workers.map((port) => port.posted.filter((item) => item.type === "behavior.invoke" && item.lifecycle === "onEvent").length)).toEqual([1, 1, 0]);
    session.dispose(); vi.runAllTimers();
  });
});
