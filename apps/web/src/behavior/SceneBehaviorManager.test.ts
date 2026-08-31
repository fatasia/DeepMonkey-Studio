import type { SceneBehaviorModule, SceneBehaviorWorkerRequest, SceneBehaviorWorkerResponse } from "@bim-studio/scene-sdk";
import { describe, expect, it, vi } from "vitest";
import type { SceneBehaviorWorkerPort } from "./SceneBehaviorHost";
import { SceneBehaviorManager } from "./SceneBehaviorManager";

class FakeWorker implements SceneBehaviorWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: SceneBehaviorWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(message: SceneBehaviorWorkerRequest): void { this.posted.push(structuredClone(message)); }
  emit(message: SceneBehaviorWorkerResponse): void { this.onmessage?.({ data: message } as MessageEvent<unknown>); }
  crash(message = "worker crashed"): void { this.onerror?.({ message } as ErrorEvent); }
}

describe("SceneBehaviorManager", () => {
  it("runs multiple modules, advances them, and forwards commands with module identity", () => {
    const workers: FakeWorker[] = [];
    const manager = new SceneBehaviorManager({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const onCommands = vi.fn();
    const onDataUpdates = vi.fn();
    const onEvent = vi.fn();
    manager.onCommands = onCommands;
    manager.onDataUpdates = onDataUpdates;
    manager.onEvent = onEvent;
    manager.start([module("a"), module("b")], "scene-1");
    workers.forEach((worker, index) => worker.emit({ type: "behavior.ready", moduleId: index === 0 ? "a" : "b", lifecycle: ["onUpdate"] }));

    manager.advance(16);
    const invocation = workers[1]!.posted.find((message) => message.type === "behavior.invoke")!;
    workers[1]!.emit({
      type: "behavior.result",
      invocationId: invocation.invocationId,
      durationMs: 2,
      commands: [{ id: "hide", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "robot" }, visible: false }],
      dataUpdates: { "robot.online": true },
      events: [{ name: "robot-ready" }]
    });

    expect(onCommands).toHaveBeenCalledWith("b", [expect.objectContaining({ id: "hide" })]);
    expect(onDataUpdates).toHaveBeenCalledWith("b", { "robot.online": true });
    expect(onEvent).toHaveBeenCalledWith("b", { name: "robot-ready" });
    expect(manager.entries()).toHaveLength(2);
  });

  it("isolates duplicate module failures and disposes every running worker", () => {
    const workers: FakeWorker[] = [];
    const manager = new SceneBehaviorManager({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const onLog = vi.fn();
    manager.onLog = onLog;
    manager.start([module("same"), module("same"), module("other")], "scene-1");

    expect(workers).toHaveLength(2);
    expect(onLog).toHaveBeenCalledWith("same", expect.objectContaining({ level: "error", message: expect.stringContaining("重复") }));
    manager.dispose();
    expect(workers.every((worker) => worker.posted.some((message) => message.type === "behavior.dispose"))).toBe(true);
    expect(() => manager.start([module("later")], "scene-1")).toThrow("已销毁");
  });

  it("delivers object interactions to onEvent with stable scene object references", () => {
    const worker = new FakeWorker();
    const manager = new SceneBehaviorManager({ workerFactory: () => worker });
    manager.start([{ ...module("events"), lifecycle: ["onEvent"] }], "scene-1");
    worker.emit({ type: "behavior.ready", moduleId: "events", lifecycle: ["onEvent"] });

    manager.dispatchEvent({ type: "object.event", name: "click", target: { kind: "object", sceneId: "scene-1", objectId: "pump-01" }, timestamp: "2026-08-27T00:00:00.000Z" });

    expect(worker.posted).toContainEqual(expect.objectContaining({
      type: "behavior.invoke",
      lifecycle: "onEvent",
      event: expect.objectContaining({ type: "object.event", name: "click", target: expect.objectContaining({ objectId: "pump-01" }) })
    }));
  });

  it("routes object events only to behavior modules attached to that object", () => {
    const workers: FakeWorker[] = [];
    const manager = new SceneBehaviorManager({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    manager.start([
      { ...module("pump"), lifecycle: ["onEvent"], target: { kind: "object", id: "pump-01" } },
      { ...module("valve"), lifecycle: ["onEvent"], target: { kind: "object", id: "valve-01" } }
    ], "scene-1");
    workers.forEach((worker, index) => worker.emit({ type: "behavior.ready", moduleId: index === 0 ? "pump" : "valve", lifecycle: ["onEvent"] }));

    manager.dispatchEvent({ type: "object.event", name: "click", target: { kind: "object", sceneId: "scene-1", objectId: "pump-01" }, timestamp: "2026-08-29T00:00:00.000Z" });

    expect(workers[0]!.posted.some((message) => message.type === "behavior.invoke" && message.lifecycle === "onEvent")).toBe(true);
    expect(workers[1]!.posted.some((message) => message.type === "behavior.invoke" && message.lifecycle === "onEvent")).toBe(false);
  });

  it("fans emitted business events out to other behavior modules without echoing the source", () => {
    const workers: FakeWorker[] = [];
    const manager = new SceneBehaviorManager({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    manager.start([{ ...module("source"), lifecycle: ["onEvent"] }, { ...module("listener"), lifecycle: ["onEvent"] }], "scene-1");
    workers[0]!.emit({ type: "behavior.ready", moduleId: "source", lifecycle: ["onEvent"] });
    workers[1]!.emit({ type: "behavior.ready", moduleId: "listener", lifecycle: ["onEvent"] });
    manager.dispatchEvent({ type: "scene.ready", sceneId: "scene-1", timestamp: "2026-08-27T00:00:00.000Z" });
    const invocation = workers[0]!.posted.find((message) => message.type === "behavior.invoke")!;
    workers[0]!.emit({ type: "behavior.result", invocationId: invocation.invocationId, durationMs: 1, commands: [], events: [{ name: "alarm.raised", payload: { level: 3 } }] });

    expect(workers[0]!.posted.some((message) => message.type === "behavior.invoke" && message.event?.type === "business.event")).toBe(false);
    expect(workers[1]!.posted).toContainEqual(expect.objectContaining({
      type: "behavior.invoke",
      lifecycle: "onEvent",
      event: expect.objectContaining({ type: "business.event", name: "alarm.raised", sourceModuleId: "source", data: { level: 3 } })
    }));
  });

  it("isolates a crashed Worker so other scene behaviors keep running", () => {
    const workers: FakeWorker[] = [];
    const manager = new SceneBehaviorManager({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    manager.start([module("failed"), module("healthy")], "scene-1");
    workers.forEach((worker, index) => worker.emit({ type: "behavior.ready", moduleId: index === 0 ? "failed" : "healthy", lifecycle: ["onUpdate"] }));

    workers[0]!.crash("故障注入");
    manager.advance(16);

    expect(manager.entries().find((entry) => entry.module.id === "failed")?.diagnostics).toMatchObject({ status: "error", lastError: expect.stringContaining("故障注入") });
    expect(manager.entries().find((entry) => entry.module.id === "healthy")?.diagnostics.status).toBe("running");
    expect(workers[1]!.posted.some((message) => message.type === "behavior.invoke" && message.lifecycle === "onUpdate")).toBe(true);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
  });
});

function module(id: string): SceneBehaviorModule {
  return {
    id,
    name: id,
    apiVersion: "1.0",
    code: "function onUpdate(ctx) {}",
    lifecycle: ["onUpdate"],
    capabilities: ["studio.runtime"],
    permissions: ["scene.write"]
  };
}
