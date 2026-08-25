import type {
  SceneBehaviorModule,
  SceneBehaviorWorkerRequest,
  SceneBehaviorWorkerResponse,
  SceneCommand
} from "@bim-studio/scene-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneBehaviorHost, type SceneBehaviorHostOptions, type SceneBehaviorWorkerPort } from "./SceneBehaviorHost";

class FakeWorker implements SceneBehaviorWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: SceneBehaviorWorkerRequest[] = [];
  terminate = vi.fn();

  postMessage(message: SceneBehaviorWorkerRequest): void {
    this.posted.push(structuredClone(message));
  }

  emit(message: SceneBehaviorWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<unknown>);
  }

  messages<TType extends SceneBehaviorWorkerRequest["type"]>(type: TType): Extract<SceneBehaviorWorkerRequest, { type: TType }>[] {
    return this.posted.filter((message): message is Extract<SceneBehaviorWorkerRequest, { type: TType }> => message.type === type);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SceneBehaviorHost", () => {
  it("initializes the worker and invokes onStart only after the matching ready message", () => {
    const worker = new FakeWorker();
    const host = new SceneBehaviorHost(worker);
    const module = behaviorModule(["onStart"]);

    host.start(module, "scene-1");

    expect(host.diagnostics()).toMatchObject({ status: "initializing", moduleId: module.id, pendingInvocations: 0 });
    expect(worker.messages("behavior.initialize")).toEqual([{ type: "behavior.initialize", module, sceneId: "scene-1" }]);

    worker.emit({ type: "behavior.ready", moduleId: "another-module", lifecycle: ["onStart"] });
    expect(worker.messages("behavior.invoke")).toHaveLength(0);

    worker.emit({ type: "behavior.ready", moduleId: module.id, lifecycle: module.lifecycle });

    expect(host.diagnostics()).toMatchObject({ status: "running", pendingInvocations: 1 });
    expect(worker.messages("behavior.invoke")[0]).toMatchObject({ type: "behavior.invoke", lifecycle: "onStart", elapsedMs: 0 });
  });

  it("advances update and deterministic fixed-step lifecycles", () => {
    const worker = readyHostWorker(["onUpdate", "onFixedUpdate"], { fixedStepMs: 10, maxFixedStepsPerFrame: 4 });

    worker.host.advance(25);

    expect(worker.port.messages("behavior.invoke").map(({ lifecycle, deltaMs, elapsedMs }) => ({ lifecycle, deltaMs, elapsedMs }))).toEqual([
      { lifecycle: "onUpdate", deltaMs: 25, elapsedMs: 25 },
      { lifecycle: "onFixedUpdate", deltaMs: 10, elapsedMs: 10 },
      { lifecycle: "onFixedUpdate", deltaMs: 10, elapsedMs: 20 }
    ]);
    expect(worker.host.diagnostics().scheduler).toMatchObject({ elapsedMs: 25, frame: 1, pendingFixedMs: 5 });
  });

  it("forwards validated commands and records completed invocation timing", () => {
    const worker = readyHostWorker(["onUpdate"]);
    const onCommands = vi.fn();
    worker.host.onCommands = onCommands;
    worker.host.advance(16);
    const invocation = worker.port.messages("behavior.invoke")[0]!;
    const command: SceneCommand = {
      id: "hide-machine",
      type: "object.set-visibility",
      target: { kind: "object", sceneId: "scene-1", objectId: "machine-1" },
      visible: false
    };

    const malformed = { id: "escape", type: "camera.set", sceneId: "scene-1", position: [0, 0, Number.NaN] } as unknown as SceneCommand;
    worker.port.emit({ type: "behavior.result", invocationId: invocation.invocationId, durationMs: 3.5, commands: [command, malformed] });

    expect(onCommands).toHaveBeenCalledOnce();
    expect(onCommands).toHaveBeenCalledWith([command]);
    expect(onCommands.mock.calls[0]![0]![0]).not.toBe(command);
    expect(worker.host.diagnostics()).toMatchObject({ pendingInvocations: 0, completedInvocations: 1, rejectedCommands: 1, lastExecutionMs: 3.5, averageExecutionMs: 3.5 });
  });

  it("pauses without accumulating ticks and resumes from the same deterministic clock", () => {
    const worker = readyHostWorker(["onUpdate", "onFixedUpdate"], { fixedStepMs: 10 });

    worker.host.advance(5);
    worker.host.pause();
    worker.host.advance(100);
    expect(worker.host.diagnostics()).toMatchObject({ status: "paused", scheduler: { elapsedMs: 5 } });
    expect(worker.port.messages("behavior.invoke")).toHaveLength(1);

    worker.host.resume();
    worker.host.advance(5);

    expect(worker.host.diagnostics()).toMatchObject({ status: "running", scheduler: { elapsedMs: 10 } });
    expect(worker.port.messages("behavior.invoke").map((message) => message.lifecycle)).toEqual(["onUpdate", "onUpdate", "onFixedUpdate"]);
  });

  it("terminates the worker when a lifecycle invocation exceeds its budget", () => {
    vi.useFakeTimers();
    const worker = readyHostWorker(["onStart"], undefined, { executionBudgetMs: 10 });

    vi.advanceTimersByTime(10);

    expect(worker.host.diagnostics()).toMatchObject({ status: "error", pendingInvocations: 0 });
    expect(worker.host.diagnostics().lastError).toContain("onStart 超过 10 ms");
    expect(worker.port.terminate).toHaveBeenCalledOnce();
  });

  it("sends dispose, accepts its completion, and terminates exactly once", () => {
    vi.useFakeTimers();
    const worker = readyHostWorker([]);

    worker.host.dispose();
    const dispose = worker.port.messages("behavior.dispose")[0]!;
    expect(worker.host.diagnostics()).toMatchObject({ status: "disposing", pendingInvocations: 1 });

    worker.port.emit({ type: "behavior.result", invocationId: dispose.invocationId, durationMs: 1, commands: [] });

    expect(worker.host.diagnostics()).toMatchObject({ status: "disposed", pendingInvocations: 0, completedInvocations: 1 });
    expect(worker.host.diagnostics().scheduler.state).toBe("disposed");
    expect(worker.port.terminate).toHaveBeenCalledOnce();
    worker.host.dispose();
    expect(worker.port.terminate).toHaveBeenCalledOnce();
  });
});

function behaviorModule(lifecycle: SceneBehaviorModule["lifecycle"]): SceneBehaviorModule {
  return {
    id: "behavior.test",
    name: "测试行为",
    apiVersion: "1.0",
    code: "export function onStart() {}",
    lifecycle,
    capabilities: ["studio.scene"],
    permissions: ["scene.read"]
  };
}

function readyHostWorker(
  lifecycle: SceneBehaviorModule["lifecycle"],
  runtime?: SceneBehaviorHostOptions["runtime"],
  options: SceneBehaviorHostOptions = {}
): { host: SceneBehaviorHost; port: FakeWorker } {
  const port = new FakeWorker();
  const host = new SceneBehaviorHost(port, { ...options, ...(runtime ? { runtime } : {}) });
  const module = behaviorModule(lifecycle);
  host.start(module, "scene-1");
  port.emit({ type: "behavior.ready", moduleId: module.id, lifecycle: module.lifecycle });
  return { host, port };
}
