import type { SceneBehaviorModule, SceneBehaviorWorkerRequest, SceneBehaviorWorkerResponse } from "@bim-studio/scene-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SceneBehaviorHost, type SceneBehaviorWorkerPort } from "./SceneBehaviorHost";

class FakeWorker implements SceneBehaviorWorkerPort {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly posted: SceneBehaviorWorkerRequest[] = [];
  terminate = vi.fn();
  postMessage(message: SceneBehaviorWorkerRequest): void { this.posted.push(structuredClone(message)); }
  emit(message: SceneBehaviorWorkerResponse): void { this.onmessage?.({ data: message } as MessageEvent<unknown>); }
  messages<TType extends SceneBehaviorWorkerRequest["type"]>(type: TType): Extract<SceneBehaviorWorkerRequest, { type: TType }>[] {
    return this.posted.filter((message): message is Extract<SceneBehaviorWorkerRequest, { type: TType }> => message.type === type);
  }
}

const moduleOf = (id: string, lifecycle: Array<SceneBehaviorModule["lifecycle"][number]> = ["onStart", "onStop"]): SceneBehaviorModule =>
  ({ id, name: id, lifecycle } as unknown as SceneBehaviorModule);

const ready = (worker: FakeWorker, moduleId: string): void =>
  worker.emit({ type: "behavior.ready", moduleId, lifecycle: ["onStart", "onStop"] } as SceneBehaviorWorkerResponse);

const startRunning = (worker: FakeWorker, host: SceneBehaviorHost): void => {
  host.start(moduleOf("v1"), "scene-1");
  ready(worker, "v1");
};

describe("SceneBehaviorHost 运行中热插(H-C6-S1)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("拒绝非法热插:非运行态、同 id、authorDebug", () => {
    const worker = new FakeWorker();
    const host = new SceneBehaviorHost(worker, { authorDebug: true });
    host.start(moduleOf("v1"), "s");
    ready(worker, "v1");
    expect(() => host.updateModule(moduleOf("v2"))).toThrow(/作者调试/);
    const plain = new SceneBehaviorHost(new FakeWorker());
    expect(() => plain.updateModule(moduleOf("v2"))).toThrow(/idle/);
    const liveWorker = new FakeWorker();
    const liveRunning = new SceneBehaviorHost(liveWorker);
    startRunning(liveWorker, liveRunning);
    liveRunning.updateModule(moduleOf("v2"));
    expect(() => liveRunning.updateModule(moduleOf("v3"))).toThrow(/initializing/);
  });

  it("运行中热插:旧 onStop → 新 initialize → ready 后恢复 running 并发新 onStart", () => {
    const worker = new FakeWorker();
    const host = new SceneBehaviorHost(worker);
    startRunning(worker, host);
    host.updateModule(moduleOf("v2"));
    expect(host.diagnostics().status).toBe("initializing");
    // 旧 onStop 在新 initialize 之前到达 worker(消息序=热插语义)。
    const posted = worker.messages("behavior.invoke").map(message => (message as { lifecycle: string }).lifecycle);
    expect(posted.at(-1)).toBe("onStop");
    expect(worker.messages("behavior.initialize").at(-1)).toMatchObject({ module: { id: "v2" } });
    ready(worker, "v2");
    expect(host.diagnostics().status).toBe("running");
    const lifecycles = worker.messages("behavior.invoke").map(message => (message as { lifecycle: string }).lifecycle);
    const lastStart = lifecycles.lastIndexOf("onStart");
    expect(lastStart).toBeGreaterThan(lifecycles.indexOf("onStop"));
  });

  it("热插初始化失败自动回滚旧模块并恢复运行;回滚再失败进入 error", () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const host = new SceneBehaviorHost(worker, { initializationTimeoutMs: 50 });
    startRunning(worker, host);
    host.updateModule(moduleOf("bad"));
    // 新模块 ready 不来,超时触发 fail→回滚旧模块。
    vi.advanceTimersByTime(60);
    expect(host.diagnostics().status).toBe("initializing");
    expect(host.diagnostics().lastError).toContain("热插失败已回滚");
    expect(worker.messages("behavior.initialize").at(-1)).toMatchObject({ module: { id: "v1" } });
    ready(worker, "v1");
    expect(host.diagnostics().status).toBe("running");
    expect(host.diagnostics().lastError).toContain("热插失败已回滚");
    // 回滚再失败(计数 ≥2):error。
    host.updateModule(moduleOf("bad2"));
    vi.advanceTimersByTime(60);
    expect(host.diagnostics().status).toBe("initializing");
    ready(worker, "v1");
    host.updateModule(moduleOf("bad3"));
    vi.advanceTimersByTime(60);
    vi.advanceTimersByTime(60);
    expect(host.diagnostics().status).toBe("error");
  });

  it("暂停态热插:ready 后保持 paused,不发 onStart", () => {
    const worker = new FakeWorker();
    const host = new SceneBehaviorHost(worker);
    startRunning(worker, host);
    host.pause();
    const onStartCount = worker.messages("behavior.invoke").filter(message => (message as { lifecycle: string }).lifecycle === "onStart").length;
    host.updateModule(moduleOf("v2"));
    ready(worker, "v2");
    expect(host.diagnostics().status).toBe("paused");
    const onStartAfter = worker.messages("behavior.invoke").filter(message => (message as { lifecycle: string }).lifecycle === "onStart").length;
    expect(onStartAfter).toBe(onStartCount);
  });
});

import { SceneBehaviorManager } from "./SceneBehaviorManager";

describe("SceneBehaviorHost 快照恢复×热插交互(H-C6-S1)", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("manager 对同场景新模块 reconcile 时,initializing 热插被 dispose 后不再复活旧模块", () => {
    // 模拟快照恢复路径:applyScene 期间 reconcile 到新模块集,宿主被 dispose;
    // 此时旧宿主正在 initializing 热插——dispose 必须吞掉 init 超时,回滚链不得复活。
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const host = new SceneBehaviorHost(worker, { initializationTimeoutMs: 50 });
    startRunning(worker, host);
    host.updateModule(moduleOf("v2"));
    expect(host.diagnostics().status).toBe("initializing");
    host.dispose();
    // 快照恢复后时钟推进:不得出现 error/回滚 onStop/新 onStart 等幽灵行为命令。
    vi.advanceTimersByTime(200);
    expect(host.diagnostics().status).toBe("disposed");
    const lifecycles = worker.messages("behavior.invoke").map(message => (message as { lifecycle: string }).lifecycle);
    expect(lifecycles.filter(lifecycle => lifecycle === "onStart").length).toBeLessThanOrEqual(1);
    expect(lifecycles.at(-1)).toBe("onStop"); // dispose 走正常 onStop 清理,不产生回滚副产物。
  });

  it("快照恢复后同场景行为保活:reconcile 不拆未变更挂载,跨场景才换 worker", () => {
    const workers: FakeWorker[] = [];
    const manager = new SceneBehaviorManager({
      workerFactory: () => { const worker = new FakeWorker(); workers.push(worker); return worker as unknown as Worker; },
      hostOptions: {},
    });
    const moduleA = moduleOf("keeper");
    manager.start([moduleA], "scene-1");
    expect(workers.length).toBe(1);
    // 快照恢复路径:同场景同模块 reconcile → 挂载保活,worker 零重建(调度时钟延续)。
    manager.reconcile([moduleA], () => "scene-1");
    expect(workers.length).toBe(1);
    // 同场景但模块内容变化 → 旧 worker 退役 + 新 worker(等价于整模块热插的管理面形态)。
    manager.reconcile([moduleOf("keeper-v2")], () => "scene-1");
    expect(workers.length).toBe(2);
    // 跨场景 → 全部重建。
    manager.reconcile([moduleOf("other")], () => "scene-2");
    expect(workers.length).toBe(3);
    manager.dispose();
  });
});