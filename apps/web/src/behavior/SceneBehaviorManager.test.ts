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
}

describe("SceneBehaviorManager", () => {
  it("runs multiple modules, advances them, and forwards commands with module identity", () => {
    const workers: FakeWorker[] = [];
    const manager = new SceneBehaviorManager({ workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker; } });
    const onCommands = vi.fn();
    manager.onCommands = onCommands;
    manager.start([module("a"), module("b")], "scene-1");
    workers.forEach((worker, index) => worker.emit({ type: "behavior.ready", moduleId: index === 0 ? "a" : "b", lifecycle: ["onUpdate"] }));

    manager.advance(16);
    const invocation = workers[1]!.posted.find((message) => message.type === "behavior.invoke")!;
    workers[1]!.emit({
      type: "behavior.result",
      invocationId: invocation.invocationId,
      durationMs: 2,
      commands: [{ id: "hide", type: "object.set-visibility", target: { kind: "object", sceneId: "scene-1", objectId: "robot" }, visible: false }]
    });

    expect(onCommands).toHaveBeenCalledWith("b", [expect.objectContaining({ id: "hide" })]);
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
